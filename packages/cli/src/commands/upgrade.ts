/**
 * `melete upgrade <version> [--dry-run] [--backup-dir <path>] [--wait-timeout <seconds>]`:
 * the upgrade for an installation that builds its images here. It takes the
 * target release's own deploy/scripts/upgrade.ts out of its tag into a
 * temporary directory and runs that copy, the procedure in docs/UPGRADING.md,
 * with every overlay file and profile deploy/melete.deploy.json names, under the
 * deployment lock, and records the run in deploy/.melete/history.jsonl. Its
 * backup goes in the contract's backup.dir, where `melete backup` puts this
 * installation's backups, unless `--backup-dir` names another folder. An
 * installation that runs published images updates with `melete deploy` instead.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseEnvFile } from '../../../../deploy/scripts/provider-settings.ts';
import type { Context } from '../context.ts';
import { DEPLOY_FILE, type DeployConfig } from '../deploy-config.ts';
import { appendHistory } from '../history.ts';
import { envImageTag, readInstallation } from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { EXIT, type ExitCode } from '../schema.ts';
import { expandHome } from './backup.ts';
import { journalCount } from './deploy.ts';

export const UPGRADE_USAGE =
  'Usage: bun run melete upgrade <version> [--dry-run] [--backup-dir /absolute/parent] [--wait-timeout seconds]';

/** Options the deploy contract decides; given by hand they could disagree with it. */
const FROM_CONTRACT = [
  '--repository',
  '--browser',
  '--tailscale',
  '--tailscale-kernel',
  '--external-db',
  '--blobs-s3',
  '--profile',
];

/**
 * The upgrade script's options for every overlay file and profile the
 * installation runs with, so each of its Compose commands reads the same files,
 * in the same order, as `melete deploy` (deploy-config.ts, composeCommand).
 */
export function upgradeOverlayArguments(config: DeployConfig): string[] {
  return [
    ...(config.overlays.includes('browser') ? ['--browser'] : []),
    ...(config.overlays.includes('tailscale') ? ['--tailscale'] : []),
    ...(config.overlays.includes('tailscale-kernel') ? ['--tailscale-kernel'] : []),
    ...(config.database.external ? ['--external-db'] : []),
    ...(config.blobs.store === 's3' ? ['--blobs-s3'] : []),
    ...config.profiles.flatMap((profile) => ['--profile', profile]),
  ];
}

export async function runUpgrade(context: Context, args: readonly string[]): Promise<ExitCode> {
  const version = args.find((arg) => !arg.startsWith('-') && /^v\d+\.\d+\.\d+/.test(arg));
  if (!version || args.some((arg) => FROM_CONTRACT.includes(arg))) {
    context.err(
      `${UPGRADE_USAGE}\nThe overlay files, the profiles and the repository come from deploy/melete.deploy.json and --deploy-dir.\n`,
    );
    return EXIT.refused;
  }
  const installation = readInstallation(context.deployDir, context.machine.platform);
  // Without the file, the overlay files and profiles would be guessed from deploy/.env,
  // and an upgrade that leaves one out rebuilds the stack without it.
  if (installation.loaded.kind !== 'found') {
    context.err(
      installation.loaded.kind === 'invalid'
        ? `${DEPLOY_FILE} is not valid (${installation.loaded.issues.join('; ')}). The upgrade takes the overlay files and profiles from it; correct it, then run this again.\n`
        : `upgrade needs ${DEPLOY_FILE} for the overlay files and profiles the installation runs with. Run bun run melete init --adopt to write it from the running stack.\n`,
    );
    return EXIT.refused;
  }
  const { config } = installation;
  if (config.images.registry !== null) {
    context.err(
      'This installation runs published images; update it with bun run melete deploy --tag <tag>.\n',
    );
    return EXIT.refused;
  }
  const dryRun = args.includes('--dry-run');
  const release = takeRelease(context, version);
  if ('problem' in release) {
    context.err(`${release.problem}\n`);
    return EXIT.refused;
  }
  // The upgrade's backup goes where this installation's backups go.
  const backupDir = expandHome(config.backup.dir);
  const command = [
    process.execPath,
    join(release.directory, 'deploy', 'scripts', 'upgrade.ts'),
    ...args,
    '--repository',
    context.root,
    ...(args.includes('--backup-dir') || !isAbsolute(backupDir) ? [] : ['--backup-dir', backupDir]),
    ...upgradeOverlayArguments(config),
  ];
  // The installation's own backup folder is made the way melete backup makes it, so a
  // second installation that has not backed up yet can upgrade. A folder named with
  // --backup-dir must already exist: the release's script refuses one that does not.
  const ownFolder = !args.includes('--backup-dir') && isAbsolute(backupDir);
  if (ownFolder && !existsSync(backupDir)) {
    if (dryRun)
      context.out(
        `${backupDir} does not exist yet; a real upgrade creates it (mode 700) before the backup.
`,
      );
    else mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  }
  // The folder the script makes its upgrade-<version>-<time> backup in.
  const given = args.indexOf('--backup-dir');
  const backupParent = given >= 0 ? (args[given + 1] ?? null) : ownFolder ? backupDir : null;
  const run = async () => {
    const before = { tag: envImageTag(installation.env ?? {}), revision: head(context) };
    const migrations = journalCount(context, null);
    const earlier = upgradeBackups(backupParent, version);
    const code = await context.attach(command);
    if (code === 2)
      context.err(
        `${version}'s upgrade script refused these options. A release older than this melete command may not know every overlay or profile in deploy/melete.deploy.json; upgrade to a newer release.\n`,
      );
    if (!dryRun) {
      let tag = before.tag;
      try {
        tag = envImageTag(parseEnvFile(readFileSync(join(context.deployDir, '.env'), 'utf8')));
      } catch {}
      appendHistory(context.deployDir, {
        at: context.now().toISOString(),
        command: 'upgrade',
        from: before,
        to: { tag: tag === before.tag ? version : tag, revision: head(context) },
        checkout: null,
        migrations: { from: migrations, to: journalCount(context, null) },
        backup:
          upgradeBackups(backupParent, version)
            .filter((entry) => !earlier.includes(entry))
            .at(-1) ?? null,
        result: code === 0 ? 'deployed' : 'failed',
        detail: code === 0 ? `upgraded to ${version}` : `upgrade.ts exited ${code}`,
      });
    }
    // upgrade.ts says which step stopped it and prints the rollback; its exit 1 covers both.
    // It exits 3 when the repository it was given is not there, and says so itself.
    return code === 0 ? EXIT.ok : code === 2 || code === 3 ? EXIT.refused : EXIT.failed;
  };
  try {
    if (dryRun) return await run();
    return await withLock(context.deployDir, 'upgrade', run);
  } catch (error) {
    if (error instanceof LockRefusal) {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  } finally {
    rmSync(release.directory, { recursive: true, force: true });
  }
}

/**
 * The target release's tree, taken with `git archive` into a new temporary
 * directory, as docs/UPGRADING.md requires: the script that upgrades is the
 * release's own, and its stamp lets it check that it came from that tag. A tag
 * this clone does not have yet is fetched first.
 */
function takeRelease(
  context: Context,
  version: string,
): { directory: string } | { problem: string } {
  const git = (...rest: string[]) => context.run(['git', '-C', context.root, ...rest], 120_000);
  const tag = `refs/tags/${version}`;
  const known = () => git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`).code === 0;
  if (!known()) {
    git('fetch', '--tags', 'origin');
    if (!known())
      return {
        problem: `The tag ${version} is not in this checkout, and git fetch --tags origin did not bring it. Check the name with git tag --list 'v*'.`,
      };
  }
  const directory = mkdtempSync(join(tmpdir(), `melete-release-${version}-`));
  const archive = join(directory, 'release.tar');
  const archived = git('archive', '--format=tar', '-o', archive, tag);
  const unpacked =
    archived.code === 0
      ? context.run(['tar', '-x', '-f', archive, '-C', directory], 120_000)
      : null;
  rmSync(archive, { force: true });
  if (archived.code !== 0 || unpacked?.code !== 0) {
    rmSync(directory, { recursive: true, force: true });
    const failed = archived.code !== 0 ? archived : unpacked;
    return {
      problem: `${version}'s upgrade script could not be taken out of the tag: ${(failed?.stderr ?? '').trim().slice(-500)}`,
    };
  }
  return { directory };
}

/**
 * The backups an upgrade to `version` made in `parent`, oldest first, as paths.
 * The script names each upgrade-<version>-<time>; the one a run made is the one
 * that was not there before it.
 */
function upgradeBackups(parent: string | null, version: string): string[] {
  if (parent === null) return [];
  const prefix = `upgrade-${version}-`;
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith(prefix) &&
          /^\d{8}T\d{6}Z$/.test(entry.name.slice(prefix.length)),
      )
      .map((entry) => join(parent, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function head(context: Context): string | null {
  const output = context.run(['git', '-C', context.root, 'rev-parse', 'HEAD']);
  return output.code === 0 ? output.stdout.trim() : null;
}
