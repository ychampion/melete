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

test('what containers execute checks out with LF endings on every system', () => {
  const files = git('ls-files', '-z').split('\0').filter(Boolean).filter(inContainers);
  expect(files).toContain('packages/runtime-hermes/entrypoint.sh');
  expect(files).toContain('deploy/Dockerfile.melete');
  // `git check-attr -z` prints path, attribute, value triples.
  const fields = git('check-attr', '-z', 'text', 'eol', '--', ...files).split('\0');
  const loose: string[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path, attribute, value] = fields.slice(index, index + 3);
    if ((attribute === 'text' && value !== 'set') || (attribute === 'eol' && value !== 'lf'))
      loose.push(`${path}: ${attribute}=${value}`);
  }
  expect(loose).toEqual([]);
  // And none of them is stored with CRLF, which eol=lf would only hide on checkout.
  const stored = git('ls-files', '--eol', '--', ...files)
    .split('\n')
    .filter((line) => /^i\/(crlf|mixed)/.test(line));
  expect(stored).toEqual([]);
});
