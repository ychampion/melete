import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stream } from './context.ts';
import { CHANGED_WHILE_READ } from './files.ts';

const bun = process.execPath;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('streaming a backup part', () => {
  test('a file sink is created new and private, and an existing one is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    const file = join(dir, 'deploy.env');
    const first = await stream({ bytes: new TextEncoder().encode('KEY=value\n') }, [{ file }]);
    expect(first).toMatchObject({ ok: true, bytes: 10, sha256: sha('KEY=value\n') });
    expect(readFileSync(file, 'utf8')).toBe('KEY=value\n');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = await stream({ bytes: new TextEncoder().encode('other') }, [{ file }]);
    expect(again.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('KEY=value\n');
  });

  test("a command's output reaches every sink, and a sink that fails fails the stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    const source = { command: [bun, '-e', 'process.stdout.write("dump bytes")'] };
    const check = (want: string) => ({
      command: [
        bun,
        '-e',
        `const text = await Bun.stdin.text(); process.exit(text === ${JSON.stringify(want)} ? 0 : 3)`,
      ],
    });
    const good = await stream(source, [{ file: join(dir, 'a.dump') }, check('dump bytes')]);
    expect(good).toMatchObject({ ok: true, bytes: 10, sha256: sha('dump bytes') });
    expect(readFileSync(join(dir, 'a.dump'), 'utf8')).toBe('dump bytes');
    const bad = await stream(source, [{ file: join(dir, 'b.dump') }, check('something else')]);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('exited 3');
  });

  test('a source that fails fails the stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    const failed = await stream(
      { command: [bun, '-e', 'process.stdout.write("part"); process.exit(4)'] },
      [{ file: join(dir, 'c.dump') }],
    );
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain('exited 4');
  });

  test("a source's last stderr line is kept, however long the lines before it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    // As tar prints a changed file with a long path before the archive says so.
    const line = `tar: ./${'d'.repeat(200)}/${'f'.repeat(120)}: file changed as we read it`;
    const source = {
      command: [
        bun,
        '-e',
        `process.stderr.write(${JSON.stringify(`${line}
${line}
${CHANGED_WHILE_READ}
`)}); process.stdout.write("tar")`,
      ],
    };
    const result = await stream(source, [{ file: join(dir, 'e.tar') }]);
    expect(result).toMatchObject({ ok: true, bytes: 3 });
    expect(result.stderr).toContain(CHANGED_WHILE_READ);
  });

  test('a source that writes a lot to stderr before its output does not stall', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    const noisy = {
      command: [
        bun,
        '-e',
        'await Bun.write(Bun.stderr, "w".repeat(1 << 20)); process.stdout.write("dump")',
      ],
    };
    const result = await stream(noisy, [{ file: join(dir, 'd.dump') }]);
    expect(result).toMatchObject({ ok: true, bytes: 4 });
  }, 20_000);

  test('what a sink says after its input has ended is kept, as `compose run -T` says it', async () => {
    // As a container goes on after the load it was streamed, then reports how it ended.
    const late = await stream({ bytes: new TextEncoder().encode('x'.repeat(100_000)) }, [
      { command: ['sh', '-c', 'cat >/dev/null; sleep 0.3; echo late >&2; exit 3'] },
    ]);
    expect(late).toMatchObject({ ok: false, bytes: 100_000 });
    expect(late.detail).toBe('sh exited 3: late');
  });

  test('a sink that stops reading early fails the stream by its exit, with no stray error', async () => {
    const stray: unknown[] = [];
    const keep = (error: unknown) => stray.push(error);
    process.on('unhandledRejection', keep);
    process.on('uncaughtException', keep);
    try {
      // As pg_restore --exit-on-error stops at the first error while the dump still flows.
      const early = await stream({ bytes: new Uint8Array(4 * 1024 * 1024) }, [
        { command: ['sh', '-c', 'head -c 10 >/dev/null; echo stopped >&2; exit 4'] },
      ]);
      expect(early).toMatchObject({ ok: false, detail: 'sh exited 4: stopped' });
      await Bun.sleep(200);
      expect(stray).toEqual([]);
    } finally {
      process.off('unhandledRejection', keep);
      process.off('uncaughtException', keep);
    }
  }, 20_000);

  test('once a sink has failed, the source is stopped and the failure comes at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    try {
      const pidFile = join(dir, 'pid');
      const chunks = 400;
      // As a large dump decrypted on its way in: 25 MB at about 4 s, while
      // pg_restore --exit-on-error stops at its first error.
      const source = {
        command: [
          bun,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const out = Bun.stdout.writer();
for (let i = 0; i < ${chunks}; i++) { out.write(new Uint8Array(65536)); await out.flush(); await Bun.sleep(10); }`,
        ],
      };
      const started = performance.now();
      const result = await stream(source, [
        {
          command: [
            'sh',
            '-c',
            'head -c 100000 >/dev/null; echo "pg_restore: error: could not execute query" >&2; exit 1',
          ],
        },
      ]);
      const elapsed = performance.now() - started;
      // Only the sink's failure: the source it stopped adds nothing to the detail.
      expect(result).toMatchObject({
        ok: false,
        detail: 'sh exited 1: pg_restore: error: could not execute query',
      });
      expect(elapsed).toBeLessThan(2_000);
      expect(result.bytes).toBeLessThan((chunks * 65536) / 4);
      // The source is not left running behind the result.
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('a source stopped because its sinks failed adds nothing, even when it exits with a code', async () => {
    // As docker run does when stopped: it passes the signal to its container, then exits 1 on
    // the pipe it can no longer write. The detail is the destination's failure alone.
    const source = {
      command: [
        bun,
        '-e',
        `process.on('SIGTERM', () => { process.stderr.write('write /dev/stdout: broken pipe\\n'); process.exit(1); });
const out = Bun.stdout.writer();
for (;;) { out.write(new Uint8Array(65536)); await out.flush(); await Bun.sleep(5); }`,
      ],
    };
    const result = await stream(source, [
      {
        command: [
          'sh',
          '-c',
          'head -c 100000 >/dev/null; echo "client_loop: send disconnect: Broken pipe" >&2; exit 255',
        ],
      },
    ]);
    expect(result).toMatchObject({
      ok: false,
      detail: 'sh exited 255: client_loop: send disconnect: Broken pipe',
    });
  }, 20_000);

  test('a file read for a sink that failed early stops there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    try {
      const file = join(dir, 'database.dump');
      const size = 32 * 1024 * 1024;
      writeFileSync(file, new Uint8Array(size));
      const result = await stream({ file }, [
        { command: ['sh', '-c', 'head -c 10 >/dev/null; echo stopped >&2; exit 1'] },
      ]);
      expect(result).toMatchObject({ ok: false, detail: 'sh exited 1: stopped' });
      expect(result.bytes).toBeLessThan(size / 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('a sink that stops reading early fails the stream even when it exits 0', async () => {
    // A load that stopped part way and still said it succeeded would be a truncated restore.
    const result = await stream({ bytes: new Uint8Array(4 * 1024 * 1024) }, [
      { command: ['sh', '-c', 'head -c 10 >/dev/null; echo done >&2; exit 0'] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('sh exited 0 but stopped reading before the end of its input: done');
  }, 20_000);

  test('a sink that stops part way through a large write is seen to stop short', async () => {
    // The source hands over 2 MB at a time; the sink stops 1 MB before the end.
    const size = 4 * 1024 * 1024;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await stream({ bytes: new Uint8Array(size) }, [
        { command: ['sh', '-c', `head -c ${size - 1024 * 1024} >/dev/null; exit 0`] },
      ]);
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('sh exited 0 but stopped reading before the end of its input');
    }
  }, 20_000);

  test('beside a file, a sink that stops early fails the stream and the file still gets every byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    try {
      const file = join(dir, 'database.dump');
      const size = 4 * 1024 * 1024;
      const result = await stream({ bytes: new Uint8Array(size) }, [
        { file },
        { command: ['sh', '-c', 'head -c 10 >/dev/null; exit 0'] },
      ]);
      expect(result).toMatchObject({ ok: false, bytes: size });
      expect(result.detail).toBe('sh exited 0 but stopped reading before the end of its input');
      expect(statSync(file).size).toBe(size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('a sink that has read every byte may exit before the source closes, as tar does at its end marker', async () => {
    const size = 300_000;
    const source = {
      command: [
        bun,
        '-e',
        `const out = Bun.stdout.writer(); out.write(new Uint8Array(${size})); await out.flush(); await Bun.sleep(400);`,
      ],
    };
    const result = await stream(source, [
      { command: ['sh', '-c', `head -c ${size} >/dev/null; exit 0`] },
    ]);
    expect(result).toMatchObject({ ok: true, bytes: size, detail: '' });
  }, 20_000);

  test('a long stream holds only the bytes on their way, never the whole stream', async () => {
    // A restore streams a dump of many gigabytes; what has gone into the sink is let go.
    const size = 192 * 1024 * 1024;
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    let peak = 0;
    const sample = setInterval(() => {
      Bun.gc(true);
      peak = Math.max(peak, process.memoryUsage().heapUsed - before);
    }, 50);
    try {
      const result = await stream({ command: ['head', '-c', String(size), '/dev/zero'] }, [
        { command: ['sh', '-c', 'cat >/dev/null'] },
      ]);
      expect(result).toMatchObject({ ok: true, bytes: size, detail: '' });
    } finally {
      clearInterval(sample);
    }
    expect(peak).toBeLessThan(48 * 1024 * 1024);
  }, 60_000);
  test('a fast source waits for a slow sink, so what it has written is not held here', async () => {
    // As gpg decrypts a dump faster than pg_restore loads it. The source can be no more than
    // the pipes between them ahead of the sink: while the sink pauses, it cannot finish.
    const dir = mkdtempSync(join(tmpdir(), 'melete-stream-'));
    try {
      const done = join(dir, 'done');
      const size = 32 * 1024 * 1024;
      const result = await stream(
        { command: ['sh', '-c', `head -c ${size} /dev/zero && : > '${done}'`] },
        [
          {
            command: [
              'sh',
              '-c',
              `head -c 1048576 >/dev/null; sleep 1; if [ -e '${done}' ]; then echo "source ran ahead" >&2; exit 5; fi; cat >/dev/null`,
            ],
          },
        ],
      );
      expect(result).toMatchObject({ ok: true, bytes: size, detail: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
