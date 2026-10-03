import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitSmartHttp } from './git-fixture.ts';
import { parseReceivePack, parseReportStatus, refusedPushAnswer } from './git-pktline.ts';

const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
const A = 'ef5e63cd808eddbe9fad81f85b15341188093b1b';
const B = '73cd911b5626ddbf8abd727ac93642f1825cc3e2';
const ZERO = '0'.repeat(40);

describe('reading a push request', () => {
  test('the commands, capabilities and push options are read up to the pack', () => {
    const head = `${pkt(`${A} ${B} refs/heads/x\0 report-status side-band-64k push-options agent=git/2`)}${pkt(`${ZERO} ${B} refs/heads/a`)}0000${pkt('ci.skip')}0000`;
    const read = parseReceivePack(Buffer.from(`${head}PACK....`));
    expect(read).toEqual({
      updates: [
        { ref: 'refs/heads/a', old: ZERO, new: B },
        { ref: 'refs/heads/x', old: A, new: B },
      ],
      capabilities: ['report-status', 'side-band-64k', 'push-options', 'agent=git/2'],
      pushOptions: ['ci.skip'],
      shallow: [],
      length: head.length,
    });
  });

  test('anything not read exactly is refused, so the request asks as itself', () => {
    const line = (text: string) => Buffer.from(`${pkt(text)}0000PACK`);
    // No capabilities, a third field, a bad id, a ref outside refs/, a second NUL.
    expect(parseReceivePack(line(`${A} ${B} refs/heads/x`))).toBeNull();
    expect(parseReceivePack(line(`${A} ${B} refs/heads/x y\0 report-status`))).toBeNull();
    expect(parseReceivePack(line(`${A.slice(1)} ${B} refs/heads/x\0 report-status`))).toBeNull();
    expect(parseReceivePack(line(`${A} ${B} HEAD\0 report-status`))).toBeNull();
    expect(parseReceivePack(line(`${A} ${B} refs/heads/../x\0 report-status`))).toBeNull();
    expect(
      parseReceivePack(
        Buffer.from(
          `${pkt(`${A} ${B} refs/heads/x\0 a`)}${pkt(`${A} ${B} refs/heads/y\0 b`)}0000PACK`,
        ),
      ),
    ).toBeNull();
    // A pack missing after an update, or bytes after a delete-only list.
    expect(parseReceivePack(Buffer.from(`${pkt(`${A} ${B} refs/heads/x\0 a`)}0000`))).toBeNull();
    expect(
      parseReceivePack(Buffer.from(`${pkt(`${A} ${ZERO} refs/heads/x\0 a`)}0000junk`)),
    ).toBeNull();
    // A length past the end, and a signed push certificate.
    expect(parseReceivePack(Buffer.from('00ff'))).toBeNull();
    expect(parseReceivePack(Buffer.from(`${pkt('push-cert\0 report-status\n')}0000`))).toBeNull();
  });

  test('a flush alone is git’s probe and asks for nothing', () => {
    expect(parseReceivePack(Buffer.from('0000'))?.updates).toEqual([]);
    expect(parseReceivePack(Buffer.from('0000PACK'))).toBeNull();
  });

  test('a status report is read plain or inside side-band packets', () => {
    const report = `${pkt('unpack ok\n')}${pkt('ok refs/heads/x\n')}${pkt('ng refs/heads/y stale info\n')}0000`;
    const expected = {
      unpack: 'ok',
      refs: [
        { ref: 'refs/heads/x', ok: true },
        { ref: 'refs/heads/y', ok: false, reason: 'stale info' },
      ],
    };
    expect(parseReportStatus(Buffer.from(report))).toEqual(expected);
    expect(
      parseReportStatus(Buffer.from(`${pkt('\x02progress\n')}${pkt(`\x01${report}`)}0000`)),
    ).toEqual(expected);
    expect(parseReportStatus(Buffer.from('not a report'))).toBeNull();
  });
});

// The real git client, against a server that answers every push with a refusal built here.
const git = await promisify(execFile)('git', ['--version']).then(
  () => true,
  () => false,
);
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(!git)('a refused push as git prints it', () => {
  test('git shows the reason beside the ref and on a remote line, and exits with an error', async () => {
    const run = promisify(execFile);
    const root = await mkdtemp(path.join(tmpdir(), 'melete-pkt-'));
    dirs.push(root);
    const bare = path.join(root, 'alice', 'site.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const work = path.join(root, 'work');
    await run('git', ['init', '-q', '-b', 'main', work]);
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    };
    await run('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'Start'], { env });
    const message =
      'Waiting for your approval in Melete: Push to alice/site (main). Run the same command again once it is approved.';
    const serve = gitSmartHttp({ root });
    const server = createServer((request, response) => {
      if (request.method !== 'POST') return serve(request, response);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const commands = parseReceivePack(Buffer.concat(chunks));
        const body = commands ? refusedPushAnswer(commands, message) : null;
        response.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
        response.end(body ?? Buffer.alloc(0));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/alice/site.git`;
      const pushed = await run('git', ['-C', work, 'push', url, 'main'], { env }).then(
        () => ({ code: 0, stderr: '' }),
        (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
      );
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain(`! [remote rejected] main -> main (${message})`);
      expect(pushed.stderr).toContain(`remote: ${message}`);
    } finally {
      server.close();
    }
  }, 60_000);
});
