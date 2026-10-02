import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_LIMITS } from '@melete/contracts';
import { BundleRefused, manifestFor, manifestHash, readBundle, versionIdFor } from './service.ts';

const JOB = 'job_BUNDLE';

async function workspace(files: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(path.join(tmpdir(), 'melete-apps-'));
  for (const [name, content] of Object.entries(files))
    await Bun.write(path.join(root, JOB, 'app', name), content);
  return root;
}

const refusal = async (root: string, dir = 'app') => {
  try {
    await readBundle(root, JOB, dir);
  } catch (error) {
    if (error instanceof BundleRefused) return error.message;
    throw error;
  }
  throw new Error('expected the bundle to be refused');
};

describe('a bundle', () => {
  test('is read with each file typed by its extension, never by its bytes', async () => {
    const root = await workspace({
      'index.html': '<!doctype html><title>Deals</title>',
      'js/app.mjs': 'export const x = 1;',
      'logo.svg': '<svg/>',
    });
    const files = await readBundle(root, JOB, 'app');
    expect(files.map((file) => [file.path, file.mime])).toEqual([
      ['index.html', 'text/html; charset=utf-8'],
      ['js/app.mjs', 'text/javascript; charset=utf-8'],
      ['logo.svg', 'image/svg+xml'],
    ]);
  });

  test('a bundle with a disallowed file type or over the size limit is refused before asking', async () => {
    expect(
      await refusal(await workspace({ 'index.html': 'x', 'run.sh': 'rm -rf /', 'app.php': '' })),
    ).toContain('run.sh is not an allowed file type');
    expect(
      await refusal(
        await workspace({
          'index.html': 'x',
          'big.png': new Uint8Array(APP_LIMITS.max_file_bytes + 1),
        }),
      ),
    ).toContain('big.png is 8.0 MB');
    const many = Object.fromEntries(
      Array.from({ length: APP_LIMITS.max_files + 1 }, (_, n) => [`f${n}.txt`, 'x']),
    );
    expect(await refusal(await workspace({ 'index.html': 'x', ...many }))).toContain(
      `more than ${APP_LIMITS.max_files} files`,
    );
    const total = Object.fromEntries(
      Array.from({ length: 4 }, (_, n) => [`part${n}.wasm`, new Uint8Array(7 * 1024 * 1024)]),
    );
    expect(await refusal(await workspace({ 'index.html': 'x', ...total }))).toContain(
      'more than 25.0 MB together',
    );
  });

  test('needs an index.html at its top, and a folder in the workspace', async () => {
    expect(await refusal(await workspace({ 'page.html': 'x' }))).toContain('no index.html');
    const root = await workspace({ 'index.html': 'x' });
    expect(await refusal(root, '../other')).toContain('is not a folder');
    expect(await refusal(root, 'missing')).toContain('is not a folder');
  });

  test('refuses a link inside the folder, whatever it points at', async () => {
    const root = await workspace({ 'index.html': 'x', 'real.txt': 'y' });
    try {
      await symlink(path.join(root, JOB, 'app', 'real.txt'), path.join(root, JOB, 'app', 'b.txt'));
    } catch {
      // This machine cannot make links without elevation; the rule is still checked where it can.
      return;
    }
    expect(await refusal(root)).toContain('b.txt is a link');
  });
});

describe('a bundle walk', () => {
  test('is bounded by folders as well as files', async () => {
    const root = await workspace({ 'index.html': 'x' });
    for (let n = 0; n < 1_001; n++) await mkdir(path.join(root, JOB, 'app', `d${n}`));
    expect(await refusal(root)).toContain('more than 1000 files and folders');
  });

  test('refuses a folder that is a link, and a link given as the folder itself', async () => {
    const root = await workspace({ 'index.html': 'x' });
    const outside = await mkdtemp(path.join(tmpdir(), 'melete-apps-outside-'));
    await Bun.write(path.join(outside, 'secret.txt'), 'not yours');
    try {
      await symlink(outside, path.join(root, JOB, 'app', 'linked'), 'dir');
      await symlink(path.join(root, JOB, 'app'), path.join(root, JOB, 'alias'), 'dir');
    } catch {
      // This machine cannot make links without elevation; CI checks the rule.
      return;
    }
    expect(await refusal(root)).toContain('linked is a link');
    expect(await refusal(root, 'alias')).toContain('is not a folder');
  });
});

describe('a version', () => {
  test('is named by its app and its manifest, which changes with any file or binding', async () => {
    const files = await readBundle(await workspace({ 'index.html': 'one' }), JOB, 'app');
    const changed = await readBundle(await workspace({ 'index.html': 'two' }), JOB, 'app');
    const hash = manifestHash(manifestFor(files, {}, {}));
    expect(manifestHash(manifestFor(files, {}, {}))).toBe(hash);
    expect(manifestHash(manifestFor(changed, {}, {}))).not.toBe(hash);
    expect(
      manifestHash(
        manifestFor(files, { deals: { kind: 'artifact', path: 'd.json', source_job_id: JOB } }, {}),
      ),
    ).not.toBe(hash);
    expect(versionIdFor('app_A', hash)).toBe(versionIdFor('app_A', hash));
    expect(versionIdFor('app_A', hash)).not.toBe(versionIdFor('app_B', hash));
  });
});
