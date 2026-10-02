import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stream } from './context.ts';

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
});
