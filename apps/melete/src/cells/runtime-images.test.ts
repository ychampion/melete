import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeImages } from './runtime-images.ts';

const id = (digit: string) => `sha256:${digit.repeat(64)}`;
const NAME = 'ghcr.io/ychampion/melete-runtime:main';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function recordFile() {
  const dir = mkdtempSync(join(tmpdir(), 'melete-runtime-images-'));
  dirs.push(dir);
  return join(dir, 'runtime-images.json');
}

describe('the runtime images the cell service has seen', () => {
  test('are kept across a restart of the cell service', async () => {
    const file = recordFile();
    const before = new RuntimeImages(NAME, file);
    await before.add(id('a'));
    await before.add(id('b'));
    const after = new RuntimeImages(NAME, file);
    expect(after.has(id('a'))).toBe(true);
    expect(after.has(id('b'))).toBe(true);
    expect(after.has(id('c'))).toBe(false);
  });

  test('start afresh when the configured name changes', async () => {
    const file = recordFile();
    await new RuntimeImages(NAME, file).add(id('a'));
    expect(new RuntimeImages('melete-runtime:local', file).has(id('a'))).toBe(false);
  });

  test('keep only the newest few, the one seen again counted as new', async () => {
    const file = recordFile();
    const images = new RuntimeImages(NAME, file, 3);
    for (const digit of ['1', '2', '3']) await images.add(id(digit));
    await images.add(id('1'));
    await images.add(id('4'));
    expect(['1', '2', '3', '4'].filter((digit) => images.has(id(digit)))).toEqual(['1', '3', '4']);
    const reloaded = new RuntimeImages(NAME, file, 3);
    expect(['1', '2', '3', '4'].filter((digit) => reloaded.has(id(digit)))).toEqual([
      '1',
      '3',
      '4',
    ]);
  });

  test('record only image ids, and read nothing else from the file', async () => {
    const file = recordFile();
    const images = new RuntimeImages(NAME, file);
    await images.add('melete-runtime:local');
    await images.add('sha256:short');
    expect(images.has('melete-runtime:local')).toBe(false);
    writeFileSync(file, JSON.stringify({ reference: NAME, ids: [id('a'), 'alpine', 7, null] }));
    const reloaded = new RuntimeImages(NAME, file);
    expect(reloaded.has(id('a'))).toBe(true);
    expect(reloaded.has('alpine')).toBe(false);
  });

  test('a damaged or missing record starts empty, and the next one is written whole', async () => {
    const file = recordFile();
    expect(new RuntimeImages(NAME, file).has(id('a'))).toBe(false);
    writeFileSync(file, '{"reference":');
    const images = new RuntimeImages(NAME, file);
    expect(images.has(id('a'))).toBe(false);
    await images.add(id('a'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ reference: NAME, ids: [id('a')] });
  });

  test('writes that overlap leave every id on disk', async () => {
    const file = recordFile();
    const images = new RuntimeImages(NAME, file);
    await Promise.all(['a', 'b', 'c'].map((digit) => images.add(id(digit))));
    expect(JSON.parse(readFileSync(file, 'utf8')).ids).toEqual([id('a'), id('b'), id('c')]);
  });
});
