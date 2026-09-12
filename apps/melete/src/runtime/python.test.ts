import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonNotFoundError, resolvePython } from './python.ts';

test('an explicit interpreter path wins when it exists and fails by name when it does not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'melete-python-'));
  const fake = join(dir, 'python-fake');
  await writeFile(fake, '');
  expect(resolvePython(fake, {})).toBe(fake);
  expect(() => resolvePython(join(dir, 'missing'), {})).toThrow(PythonNotFoundError);
  expect(() => resolvePython(undefined, { MELETE_PYTHON: join(dir, 'missing') })).toThrow(
    /MELETE_PYTHON/,
  );
});

test('with nothing configured the resolver prefers python3 and falls back to python', () => {
  const resolved = resolvePython(undefined, {});
  const python3 = Bun.which('python3');
  expect(resolved).toBe(python3 ?? Bun.which('python') ?? '');
  // Debian ships python3 with no python; Windows ships python with no python3.
  expect(resolved.length).toBeGreaterThan(0);
});
