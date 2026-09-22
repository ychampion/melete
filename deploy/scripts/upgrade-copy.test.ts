/**
 * The upgrade runs as the target release's own script, taken out of the tag
 * into a directory beside the installation. That copy has no installed
 * dependencies, so everything upgrade.ts imports must be Bun or a relative
 * file, and the copy must act on the installation it is pointed at.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { localMachine } from '../../apps/melete/src/runtime/docker-host.ts';
import { gatherPreflight, judgePreflight, readReleaseCommit, spawnRunner } from './upgrade.ts';

/** The machine these tests run on, as the script itself uses it. */
const thisMachine = { ...localMachine, which: (program: string) => Bun.which(program) };

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

describe('the release a copy was taken from', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(
      'git',
      ['-c', 'user.name=melete-test', '-c', 'user.email=test@example.invalid', ...args],
      { cwd, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };

  test('is stamped by git archive, checked against the tag, and absent in a checkout', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'fix-ops-stamp-repo-'));
    const copies = await mkdtemp(join(tmpdir(), 'fix-ops-stamp-copies-'));
    try {
      // The repository's own attribute and placeholder, in a history with two releases.
      await mkdir(join(repository, 'deploy/scripts'), { recursive: true });
      await writeFile(
        join(repository, '.gitattributes'),
        await readFile(join(root, '.gitattributes')),
      );
      await writeFile(
        join(repository, 'deploy/scripts/release-commit.txt'),
        await readFile(join(root, 'deploy/scripts/release-commit.txt')),
      );
      git(repository, 'init', '-q');
      git(repository, 'add', '.');
      git(repository, 'commit', '-q', '-m', 'first');
      git(repository, 'tag', 'v1.0.0');
      await writeFile(join(repository, 'CHANGES'), 'second\n');
      git(repository, 'add', '.');
      git(repository, 'commit', '-q', '-m', 'second');
      // Releases are annotated tags: the stamp is the commit the tag object points at.
      git(repository, 'tag', '-a', 'v1.1.0', '-m', 'release');
      git(repository, 'checkout', '-q', 'v1.0.0');
      const commit = (tag: string) => git(repository, 'rev-parse', `${tag}^{commit}`);
      const copyOf = async (tag: string) => {
        const directory = join(copies, tag);
        await mkdir(directory);
        git(repository, 'archive', '-o', join(copies, `${tag}.tar`), tag);
        // A relative archive path, which no tar reads as a remote host the way it can read C:.
        const tar = spawnSync('tar', ['-xf', `../${tag}.tar`], { cwd: directory });
        if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
        return join(directory, 'deploy/scripts');
      };

      expect(await readReleaseCommit(await copyOf('v1.1.0'))).toBe(commit('v1.1.0'));
      expect(await readReleaseCommit(join(repository, 'deploy/scripts'))).toBeNull();

      const preflight = async (copy: string | null) => {
        const { facts } = await gatherPreflight(
          {
            tag: 'v1.1.0',
            backupDir: join(copies, 'backup/upgrade'),
            repositoryRoot: repository,
            browser: false,
            tailscale: false,
            waitTimeoutSeconds: 300,
          },
          {
            run: spawnRunner(repository),
            environment: async () => ({}),
            machine: thisMachine,
            releaseCommit: () => (copy ? readReleaseCommit(copy) : Promise.resolve(null)),
          },
        );
        return judgePreflight(facts).filter((problem) => problem.includes('copy of the upgrade'));
      };
      expect(await preflight(await copyOf('v1.0.0'))).toEqual([
        `This copy of the upgrade script was taken from commit ${commit('v1.0.0').slice(0, 12)}, but v1.1.0 is ${commit('v1.1.0').slice(0, 12)}. Take the copy from the tag you are upgrading to: git archive v1.1.0.`,
      ]);
      expect(await preflight(join(copies, 'v1.1.0/deploy/scripts'))).toEqual([]);
      // Run from a checkout, there is no stamp and nothing to compare.
      expect(await preflight(join(repository, 'deploy/scripts'))).toEqual([]);
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(copies, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('the installation a copy is pointed at', () => {
  const facts = async (repositoryRoot: string) =>
    (
      await gatherPreflight(
        {
          tag: 'v1.0.0',
          backupDir: join(repositoryRoot, 'backup/upgrade'),
          repositoryRoot,
          browser: false,
          tailscale: false,
          waitTimeoutSeconds: 300,
        },
        { run: spawnRunner(repositoryRoot), environment: async () => ({}), machine: thisMachine },
      )
    ).facts;
  const checkoutProblems = async (repositoryRoot: string) =>
    judgePreflight(await facts(repositoryRoot)).filter((problem) =>
      problem.includes('git checkout'),
    );

  test('git says whether it is the top of a checkout, in whatever case it is spelt', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'fix-ops-checkout-'));
    const repository = join(parent, 'melete');
    try {
      await mkdir(join(repository, 'deploy'), { recursive: true });
      spawnSync('git', ['init', '-q'], { cwd: repository });
      expect(await checkoutProblems(repository)).toEqual([]);
      expect(await checkoutProblems(join(repository, 'deploy'))).toEqual([
        `${join(repository, 'deploy')} is deploy inside its git checkout. Give --repository the top of the installation's checkout.`,
      ]);
      expect((await checkoutProblems(parent))[0]).toContain(`${parent} is not a git checkout`);
      // On a filesystem that ignores case, the same directory spelt otherwise is the same top.
      const respelt = join(parent, 'MELETE');
      if (existsSync(respelt)) expect(await checkoutProblems(respelt)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 60_000);
});
