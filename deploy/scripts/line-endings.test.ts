import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
};

/** Files a container runs or reads as text: scripts, the runtime package and the mounted config. */
const inContainers = (path: string) =>
  /\.(sh|py)$/.test(path) ||
  /(^|\/)Dockerfile[^/]*$/.test(path) ||
  path.startsWith('packages/runtime-hermes/') ||
  path.startsWith('deploy/config/') ||
  path === 'deploy/.env.example';

/** Scripts must be text outright; the directories may leave detection to Git. */
const mustBeText = (path: string) =>
  /\.(sh|py)$/.test(path) || /(^|\/)Dockerfile[^/]*$/.test(path) || path === 'deploy/.env.example';

/** `git check-attr -z` prints path, attribute, value triples. */
function attributes(paths: string[]) {
  const fields = git('check-attr', '-z', 'text', 'eol', '--', ...paths).split('\0');
  const byPath = new Map<string, Record<string, string>>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path = '', attribute = '', value = ''] = fields.slice(index, index + 3);
    byPath.set(path, { ...byPath.get(path), [attribute]: value });
  }
  return byPath;
}

test('what containers execute checks out with LF endings on every system', () => {
  const files = git('ls-files', '-z').split('\0').filter(Boolean).filter(inContainers);
  expect(files).toContain('packages/runtime-hermes/entrypoint.sh');
  expect(files).toContain('deploy/Dockerfile.melete');
  const loose: string[] = [];
  for (const [path, value] of attributes(files)) {
    const text = mustBeText(path) ? ['set'] : ['set', 'auto'];
    if (!text.includes(value.text ?? '') || value.eol !== 'lf')
      loose.push(`${path}: text=${value.text} eol=${value.eol}`);
  }
  expect(loose).toEqual([]);
  // And none of them is stored with CRLF, which eol=lf would only hide on checkout.
  const stored = git('ls-files', '--eol', '--', ...files)
    .split('\n')
    .filter((line) => /^i\/(crlf|mixed)/.test(line));
  expect(stored).toEqual([]);
});

test('an image added to those directories is still binary, not converted', () => {
  const found = attributes(['packages/runtime-hermes/assets/icon.png', 'deploy/config/logo.jpg']);
  expect(found.size).toBe(2);
  for (const value of found.values()) expect(value.text).toBe('unset');
});
