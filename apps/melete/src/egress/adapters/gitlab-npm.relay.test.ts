/**
 * GitLab and npm through the real egress relay, with the clients a computer
 * runs: git pushes to a GitLab-shaped git server, and npm publishes to and
 * installs from an npm-shaped registry. Each upstream checks the account it
 * is sent, so a request without the account fails there. The broker's side of
 * a write is faked: the first change waits for approval, and every one after
 * is approved. The real broker has its own tests against Postgres.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EgressWriteInput } from '../../broker/egress-admission.ts';
import { selfSignedPair } from '../../gateway/fixtures/self-signed.ts';
import { SandboxEgressGuard } from '../../sandbox/adapters/docker-egress.ts';
import { memoryCredentialPort } from '../fixtures.ts';
import { type GitRequestSeen, gitSmartHttp } from '../git-fixture.ts';
import { gitlabAdapter } from './gitlab.ts';
import { NPM_RC_LINE, NPM_TOKEN_ENV, NPM_TOKEN_PLACEHOLDER, npmAdapter } from './npm.ts';
import type { CredentialAdapter } from './types.ts';

const run = promisify(execFile);
const available = async (command: string, args: string[]) =>
  run(command, args, { shell: process.platform === 'win32' }).then(
    () => true,
    () => false,
  );
const git = await available('git', ['--version']);
const npm = await available('npm', ['--version']);
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

type Outcome = { code: number; stdout: string; stderr: string };
async function command(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  return run(file, args, {
    ...options,
    shell: process.platform === 'win32',
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  }).then(
    ({ stdout, stderr }): Outcome => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }): Outcome => ({
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  );
}

/** An HTTPS server for `host` with a self-signed certificate the relay is told to trust. */
async function upstream(
  host: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const pair = selfSignedPair(host);
  const server: Server = createHttpsServer({ key: pair.key, cert: pair.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: pair.cert.toString(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The relay in front of one upstream, with one account whose first write
 * waits for approval and whose later writes are approved and sent.
 */
async function relay(input: {
  adapter: CredentialAdapter;
  secret: string;
  host: string;
  upstream: { port: number; ca: string };
}) {
  const writes: EgressWriteInput[] = [];
  const port = memoryCredentialPort({
    secret: input.secret,
    account: { adapter: input.adapter, config: {} },
    admitWrite: async (write) => {
      writes.push(write);
      if (writes.length === 1)
        return {
          kind: 'waiting',
          actionId: 'act_HELD',
          message: `Waiting for your approval in Melete: ${write.write.summary.title}. Run the same command again once it is approved.`,
        };
      return { kind: 'sent', actionId: `act_${writes.length}`, result: await write.forward() };
    },
  });
  const guard = new SandboxEgressGuard({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    credentials: port,
    intercept: {
      upstream: () => ({
        address: { address: '127.0.0.1', family: 4 },
        port: input.upstream.port,
      }),
      upstreamCa: input.upstream.ca,
    },
  });
  const relayPort = await guard.listen(0, '127.0.0.1');
  guard.allow('127.0.0.1', 'melete-sbx-one', { mode: 'open', session: 'sbx_one', space: 'sp_one' });
  const token = guard.mint('melete-sbx-one', {
    kind: 'command',
    sessionId: 'sbx_one',
    jobId: 'job_one',
    attemptId: 'att_one',
    actionId: 'act_one',
    deadlineAt: Date.now() + 300_000,
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'melete-relay-'));
  dirs.push(dir);
  const caFile = path.join(dir, 'egress-ca.pem');
  await writeFile(caFile, (await port.ca.certificate()).pem);
  const proxy = `http://cmd:${token}@127.0.0.1:${relayPort}`;
  return { guard, writes, dir, caFile, proxy };
}

describe.skipIf(!git)('git through the relay to GitLab', () => {
  test('a push asks with its ref updates and push options, then goes through once with the oauth2 account', async () => {
    const secret = `glpat-${randomBytes(12).toString('hex')}`;
    const root = await mkdtemp(path.join(tmpdir(), 'melete-gitlab-'));
    dirs.push(root);
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    };
    const bare = path.join(root, 'alice', 'site.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
    await run('git', ['-C', bare, 'config', 'receive.advertisePushOptions', 'true'], { env });
    const seen: GitRequestSeen[] = [];
    const account = `Basic ${Buffer.from(`oauth2:${secret}`).toString('base64')}`;
    const served = await upstream('gitlab.com', gitSmartHttp({ root, account, seen }));
    const { guard, writes, dir, caFile, proxy } = await relay({
      adapter: gitlabAdapter as CredentialAdapter,
      secret,
      host: 'gitlab.com',
      upstream: served,
    });
    try {
      const work = path.join(dir, 'work');
      await run('git', ['init', '-q', '-b', 'main', work], { env });
      await run('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'Fix login'], { env });
      const through = {
        ...env,
        HTTPS_PROXY: proxy,
        https_proxy: proxy,
        GIT_SSL_CAINFO: caFile,
        GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
        GITLAB_TOKEN: 'melete-proxy-adds-this',
      };
      const pushArgs = [
        '-C',
        work,
        'push',
        '-o',
        'merge_request.create',
        'https://gitlab.com/alice/site.git',
        'main:melete/fix-login',
      ];
      const first = await command('git', pushArgs, { cwd: dir, env: through });
      expect(first.code).not.toBe(0);
      expect(first.stderr).toContain(
        '! [remote rejected] main -> melete/fix-login (Waiting for your approval in Melete: Push to alice/site (melete/fix-login).',
      );
      const second = await command('git', pushArgs, { cwd: dir, env: through });
      expect(second.stderr).toContain('* [new branch]      main -> melete/fix-login');
      expect(second.code).toBe(0);
      const head = (await run('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
      const onServer = await run('git', ['-C', bare, 'rev-parse', 'refs/heads/melete/fix-login']);
      expect(onServer.stdout.trim()).toBe(head);
      // Both runs asked for the same change, push options included.
      expect(writes).toHaveLength(2);
      const [held, sent] = writes;
      expect(held?.write.payload).toMatchObject({
        site: 'gitlab.com',
        resource: 'alice/site',
        updates: [{ ref: 'refs/heads/melete/fix-login', old: '0'.repeat(40), new: head }],
        push_options: ['merge_request.create'],
      });
      expect(JSON.stringify(sent?.write.payload)).toBe(JSON.stringify(held?.write.payload));
      // Every request that reached GitLab carried the account, and none carried the placeholder.
      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(new Set(seen.map((request) => request.authorization))).toEqual(new Set([account]));
      expect(`${first.stderr}${second.stderr}${second.stdout}`).not.toContain(secret);
    } finally {
      await guard.close();
      await served.close();
    }
  }, 120_000);
});

/** A small registry: packuments in memory, publish by PUT, tarballs by GET, and the account checked. */
function registry(secret: string) {
  const packages = new Map<string, Record<string, unknown>>();
  const tarballs = new Map<string, Buffer>();
  const seen: Array<{ method: string; path: string; authorization: string | undefined }> = [];
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'https://registry.npmjs.org');
      seen.push({
        method: request.method ?? '',
        path: url.pathname,
        authorization: request.headers.authorization,
      });
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${secret}`)
        return json(401, { error: 'You must be logged in.' });
      if (url.pathname === '/-/whoami') return json(200, { username: 'alice' });
      if (url.pathname.startsWith('/-/npm/v1/security/')) return json(200, {});
      const tarball = tarballs.get(url.pathname);
      if (tarball) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(tarball);
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      if (request.method === 'GET') {
        const found = packages.get(name);
        return found ? json(200, found) : json(404, { error: 'Not found' });
      }
      if (request.method === 'PUT') {
        const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const versions = doc.versions as Record<string, Record<string, unknown>>;
        for (const [file, attachment] of Object.entries(
          doc._attachments as Record<string, { data: string }>,
        ))
          tarballs.set(`/${name}/-/${file}`, Buffer.from(attachment.data, 'base64'));
        for (const manifest of Object.values(versions)) {
          const dist = manifest.dist as Record<string, unknown>;
          dist.tarball = `https://registry.npmjs.org/${name}/-/${name}-${manifest.version}.tgz`;
        }
        packages.set(name, {
          _id: name,
          name,
          'dist-tags': doc['dist-tags'],
          versions,
        });
        return json(201, { ok: true, success: true });
      }
      json(405, { error: 'Not served here' });
    });
  };
  return { handler, seen, packages };
}

describe.skipIf(!npm)('npm through the relay to the registry', () => {
  test('a publish asks with its package and version, goes through once, and the package then installs', async () => {
    const secret = `npm_${randomBytes(18).toString('hex')}`;
    const served = registry(secret);
    const server = await upstream('registry.npmjs.org', served.handler);
    const { guard, writes, dir, caFile, proxy } = await relay({
      adapter: npmAdapter as CredentialAdapter,
      secret,
      host: 'registry.npmjs.org',
      upstream: server,
    });
    try {
      const pkg = path.join(dir, 'pkg');
      const app = path.join(dir, 'app');
      await mkdir(pkg, { recursive: true });
      await mkdir(app, { recursive: true });
      await writeFile(path.join(dir, 'npmrc'), '');
      // The computer's global settings, as the image has them.
      await writeFile(path.join(dir, 'global-npmrc'), `${NPM_RC_LINE}\n`);
      await writeFile(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'melete-demo', version: '1.0.0', main: 'index.js', license: 'MIT' }),
      );
      await writeFile(path.join(pkg, 'index.js'), 'module.exports = 42;\n');
      await writeFile(
        path.join(app, 'package.json'),
        JSON.stringify({ name: 'app', version: '1.0.0', private: true }),
      );
      await writeFile(path.join(app, 'check.js'), 'console.log(require("melete-demo"));\n');
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: dir,
        USERPROFILE: dir,
        APPDATA: dir,
        LOCALAPPDATA: dir,
        HTTPS_PROXY: proxy,
        https_proxy: proxy,
        NODE_EXTRA_CA_CERTS: caFile,
        [NPM_TOKEN_ENV]: NPM_TOKEN_PLACEHOLDER,
        npm_config_userconfig: path.join(dir, 'npmrc'),
        npm_config_globalconfig: path.join(dir, 'global-npmrc'),
        npm_config_cache: path.join(dir, 'cache'),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
      };
      const first = await command('npm', ['publish'], { cwd: pkg, env });
      expect(first.code).not.toBe(0);
      expect(first.stderr).toContain(
        'Waiting for your approval in Melete: Publish melete-demo@1.0.0 to npm (tag latest).',
      );
      expect(served.packages.size).toBe(0);
      const second = await command('npm', ['publish'], { cwd: pkg, env });
      expect(second.code).toBe(0);
      expect(served.packages.has('melete-demo')).toBe(true);
      expect(writes).toHaveLength(2);
      const [held, sent] = writes;
      expect(held?.write.payload).toMatchObject({
        resource: 'melete-demo',
        publish: { versions: ['1.0.0'], dist_tags: { latest: '1.0.0' } },
      });
      expect(JSON.stringify(sent?.write.payload)).toBe(JSON.stringify(held?.write.payload));
      // Installing it reads, and asks nothing.
      const installed = await command('npm', ['install', 'melete-demo@1.0.0'], { cwd: app, env });
      expect(installed.code).toBe(0);
      expect(writes).toHaveLength(2);
      const loaded = await command('node', ['check.js'], { cwd: app, env });
      expect(loaded.stdout.trim()).toBe('42');
      // Every request that reached the registry carried the account.
      expect(served.seen.length).toBeGreaterThanOrEqual(4);
      expect(new Set(served.seen.map((request) => request.authorization))).toEqual(
        new Set([`Bearer ${secret}`]),
      );
      expect(
        `${first.stdout}${first.stderr}${second.stdout}${second.stderr}${installed.stdout}${installed.stderr}`,
      ).not.toContain(secret);
    } finally {
      await guard.close();
      await server.close();
    }
  }, 180_000);
});
