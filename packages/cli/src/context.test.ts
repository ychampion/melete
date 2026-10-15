import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
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
});
