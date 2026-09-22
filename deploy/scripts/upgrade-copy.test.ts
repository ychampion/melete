/**
 * The upgrade runs as the target release's own script, taken out of the tag
 * into a directory beside the installation. That copy has no installed
 * dependencies, so everything upgrade.ts imports must be Bun or a relative
 * file, and the copy must act on the installation it is pointed at.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\b[^'"]*?\sfrom\s+'([^']+)'|(?:^|\n)\s*import\s+'([^']+)'/g;

/** Every file upgrade.ts loads, and every specifier that is not a relative file. */
async function importClosure(): Promise<{ files: string[]; packages: string[] }> {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [join(root, 'deploy/scripts/upgrade.ts')];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? '';
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return { files: [...files].map((file) => relative(root, file)).sort(), packages: [...packages] };
}

describe('a copy of the release upgrade script', () => {
  test('imports only Bun built-ins and files beside it', async () => {
    const { files, packages } = await importClosure();
    expect(files).toContain(join('deploy', 'scripts', 'upgrade.ts'));
    expect(packages.filter((name) => !name.startsWith('node:'))).toEqual([]);
  });

  test('runs with no dependencies installed, against the installation it is given', async () => {
    const release = await mkdtemp(join(tmpdir(), 'fix-ops-release-'));
    const installation = await mkdtemp(join(tmpdir(), 'fix-ops-installation-'));
    try {
      // What `git archive <tag> | tar -x` would give, limited to what the script loads.
      for (const file of (await importClosure()).files) {
        await mkdir(dirname(join(release, file)), { recursive: true });
        await writeFile(join(release, file), await readFile(join(root, file)));
      }
      await mkdir(join(installation, 'deploy'));
      await writeFile(join(installation, 'deploy/.env'), 'COMPOSE_PROJECT_NAME=assistant\n');
      spawnSync('git', ['init', '-q'], { cwd: installation });
      const result = spawnSync(
        process.execPath,
        [
          join(release, 'deploy/scripts/upgrade.ts'),
          'v9.9.9',
          '--dry-run',
          '--repository',
          installation,
          '--backup-dir',
          installation,
        ],
        { cwd: release, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.stderr).not.toContain('Cannot find');
      // Only a dry run on a host without this stack: the plan prints and the preflight refuses.
      expect(result.status).toBe(1);
      const output = result.stdout.replaceAll('\\', '/');
      expect(output).toContain('Dry run: nothing below was executed.');
      expect(output).toContain('(Compose project assistant)');
      expect(output).toContain('The tag v9.9.9 does not exist in this clone.');
      expect(output).not.toContain(release.replaceAll('\\', '/'));
    } finally {
      await rm(release, { recursive: true, force: true });
      await rm(installation, { recursive: true, force: true });
    }
  }, 90_000);
});
