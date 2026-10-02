/**
 * `melete backup [--estimate] [--with-volumes] [--dir <path>] [--to ssh://host:/path]`
 *
 * By default the backup is online and small: the database as a custom-format
 * dump, checked with `pg_restore --list` while it is written, the restriction
 * journal on its own under a timestamped name, deploy/.env, deploy/config/ and
 * deploy/melete.deploy.json, and a SHA256SUMS list of all of them. Each backup
 * is a new directory, melete-<time>, private to its owner (0700, files 0600).
 *
 * `--with-volumes` also archives /data and /work, with the writers stopped so
 * the database and the files agree, and starts them again afterwards.
 * `--to ssh://host:/path` streams every part to another machine over SSH and
 * keeps nothing on this disk, for a host short on space. `--estimate` measures
 * and compares with the free space at the destination, and changes nothing.
 *
 * The restriction journal is kept per backup, so a restore never pairs an old
 * journal with a newer database: restore keeps the newest journal there is.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context, Endpoint, Source } from '../context.ts';
import { composeCommand, DEPLOY_FILE, type DeployConfig } from '../deploy-config.ts';
import { readInstallation } from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { EXIT, type ExitCode, type Result, renderReport, report } from '../schema.ts';

const MB = 1024 ** 2;

export const BACKUP_USAGE =
  'Usage: bun run melete backup [--estimate] [--with-volumes] [--dir <path>] [--to ssh://host:/path]';

export class BackupRefusal extends Error {}

export type SshTarget = { host: string; path: string };
export type Destination = { kind: 'dir'; dir: string } | { kind: 'ssh'; target: SshTarget };

export type BackupOptions = {
  estimate: boolean;
  withVolumes: boolean;
  destination: Destination | null;
};

/**
 * `ssh://host:/path` or `ssh://user@host:~/path`. Both halves are limited to
 * characters that need no quoting, because the path is used in a remote shell.
 */
export function parseSshTarget(value: string): SshTarget {
  const match = /^ssh:\/\/([A-Za-z0-9_][A-Za-z0-9._@-]*):((?:~|\/)[A-Za-z0-9._/~-]*)$/.exec(value);
  if (!match?.[1] || !match[2] || match[2].includes('..'))
    throw new BackupRefusal(
      `${value} is not a backup destination this command takes: use ssh://host:/absolute/path or ssh://host:~/path, with letters, digits, . _ - / in the path.`,
    );
  return { host: match[1], path: match[2].replace(/\/+$/, '') || '/' };
}

export function backupOptions(args: readonly string[]): BackupOptions {
  const options: BackupOptions = { estimate: false, withVolumes: false, destination: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('-'))
        throw new BackupRefusal(`${arg} needs a value. ${BACKUP_USAGE}`);
      index += 1;
      return next;
    };
    if (arg === '--estimate') options.estimate = true;
    else if (arg === '--with-volumes') options.withVolumes = true;
    else if (arg === '--dir') options.destination = { kind: 'dir', dir: value() };
    else if (arg === '--to') options.destination = { kind: 'ssh', target: parseSshTarget(value()) };
    else throw new BackupRefusal(`${arg} is not a backup option. ${BACKUP_USAGE}`);
  }
  return options;
}

export const expandHome = (path: string, home = homedir()) =>
  path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;

/** `2026-10-02T07:11:05.123Z` as `20261002T071105Z`, for names that sort by time. */
export const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');

export const BACKUP_NAME = /^melete-\d{8}T\d{6}Z$/;

const sshCommand = (target: SshTarget, script: string) => [
  'ssh',
  '-o',
  'BatchMode=yes',
  target.host,
  script,
];

const psql = (sql: string) => [
  'exec',
  '-T',
  'postgres',
  'sh',
  '-c',
  `exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "${sql}"`,
];

/** The services that write to the database or the volumes. */
export const writersOf = (config: DeployConfig) => [
  'melete',
  'runtime',
  'web',
  ...(config.overlays.includes('browser') ? ['browser'] : []),
  ...(config.overlays.includes('tailscale') ? ['tailscale'] : []),
];

/** One number from a command, or null. */
const number = (output: { code: number; stdout: string }) => {
  const text = output.stdout.trim();
  return output.code === 0 && /^\d+$/.test(text) ? Number(text) : null;
};

/** `du -sk` lines summed, in bytes; null when the command failed. */
const duBytes = (output: { code: number; stdout: string }) =>
  output.code === 0
    ? output.stdout
        .split('\n')
        .reduce((total, line) => total + (Number(line.trim().split(/\s+/)[0]) || 0) * 1024, 0)
    : null;

export type Estimate = {
  databaseBytes: number | null;
  journalBytes: number | null;
  volumeBytes: number | null;
};

export function measureBackup(
  context: Context,
  compose: readonly string[],
  withVolumes: boolean,
): Estimate {
  const run = context.run;
  return {
    databaseBytes: number(
      run([...compose, ...psql('select pg_database_size(current_database())')]),
    ),
    journalBytes: duBytes(
      run([...compose, 'exec', '-T', 'melete', 'du', '-sk', '/data/restrictions']),
    ),
    volumeBytes: withVolumes
      ? duBytes(run([...compose, 'exec', '-T', 'melete', 'du', '-sk', '/data', '/work']))
      : null,
  };
}

/** Free bytes at the destination, measured there. */
export function destinationFree(context: Context, destination: Destination): number | null {
  if (destination.kind === 'dir') return context.freeAt(destination.dir);
  const output = context.run(
    sshCommand(
      destination.target,
      `p=${destination.target.path}; while [ ! -e "$p" ]; do p=$(dirname "$p"); done; df -Pk "$p"`,
    ),
  );
  const line = output.stdout.trim().split('\n')[1];
  const available = Number(line?.trim().split(/\s+/)[3]);
  return output.code === 0 && Number.isFinite(available) ? available * 1024 : null;
}

export const describeDestination = (destination: Destination) =>
  destination.kind === 'dir'
    ? destination.dir
    : `ssh://${destination.target.host}:${destination.target.path}`;

export type BackupRun = { ok: boolean; location: string; results: Result[] };

/**
 * Takes one backup into a new directory at the destination. A part that fails
 * stops the run and removes the partial directory, so a backup that exists is
 * whole.
 */
export async function takeBackup(
  context: Context,
  config: DeployConfig,
  destination: Destination,
  withVolumes: boolean,
): Promise<BackupRun> {
  const compose = composeCommand(context.deployDir, config);
  const name = `melete-${stamp(context.now())}`;
  const results: Result[] = [];
  const sums: string[] = [];
  let location: string;
  let sink: (file: string) => Endpoint;
  let remove: () => void;

  if (destination.kind === 'dir') {
    const base = destination.dir;
    mkdirSync(base, { recursive: true, mode: 0o700 });
    location = join(base, name);
    mkdirSync(location, { mode: 0o700 });
    const created = location;
    sink = (file) => ({ file: join(created, file) });
    remove = () => rmSync(created, { recursive: true, force: true });
  } else {
    const { target } = destination;
    location = `ssh://${target.host}:${target.path}/${name}`;
    const made = context.run(
      sshCommand(
        target,
        `umask 077 && mkdir -p ${target.path} && mkdir -m 700 ${target.path}/${name}`,
      ),
    );
    if (made.code !== 0)
      return {
        ok: false,
        location,
        results: [
          {
            id: 'backup.destination',
            level: 'fail',
            detail: `Could not create ${location}: ${made.stderr.trim().split('\n').at(-1) ?? `exit ${made.code}`}`,
          },
        ],
      };
    sink = (file) => ({
      command: sshCommand(target, `umask 077 && cat > ${target.path}/${name}/${file}`),
    });
    remove = () => {
      context.run(sshCommand(target, `rm -rf ${target.path}/${name}`));
    };
  }

  const part = async (id: string, file: string, source: Source, extra: Endpoint[] = []) => {
    const outcome = await context.stream(source, [sink(file), ...extra]);
    if (!outcome.ok) {
      results.push({ id, level: 'fail', detail: `${file}: ${outcome.detail}` });
      return false;
    }
    sums.push(`${outcome.sha256}  ${file}`);
    results.push({
      id,
      level: 'ok',
      detail: `${file}, ${Math.max(1, Math.ceil(outcome.bytes / 1024))} KB`,
    });
    return true;
  };

  let ok =
    (await part(
      'backup.database',
      'database.dump',
      {
        command: [
          ...compose,
          'exec',
          '-T',
          'postgres',
          'sh',
          '-c',
          'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom',
        ],
      },
      // Read back as it is written: a dump pg_restore cannot list is no backup.
      [{ command: [...compose, 'exec', '-T', 'postgres', 'pg_restore', '--list'] }],
    )) &&
    (await part('backup.journal', `restrictions-${name.slice('melete-'.length)}.tar`, {
      command: [...compose, 'cp', 'melete:/data/restrictions', '-'],
    })) &&
    (await part('backup.env', 'deploy.env', { file: join(context.deployDir, '.env') }));
  if (ok && existsSync(join(context.deployDir, 'config')))
    ok = await part('backup.config', 'config.tar', {
      command: ['tar', '-C', context.deployDir, '-cf', '-', 'config'],
    });
  if (ok && existsSync(join(context.deployDir, DEPLOY_FILE)))
    ok = await part('backup.contract', DEPLOY_FILE, { file: join(context.deployDir, DEPLOY_FILE) });

  if (ok && withVolumes) {
    const writers = writersOf(config);
    const stopped = context.run([...compose, 'stop', ...writers], 300_000);
    if (stopped.code !== 0) {
      results.push({
        id: 'backup.stop_writers',
        level: 'fail',
        detail: `Could not stop ${writers.join(', ')}: ${stopped.stderr.trim().split('\n').at(-1) ?? ''}`,
      });
      ok = false;
    } else {
      ok =
        (await part('backup.data', 'data.tar', {
          command: [...compose, 'cp', '-a', 'melete:/data', '-'],
        })) &&
        (await part('backup.work', 'work.tar', {
          command: [...compose, 'cp', '-a', 'melete:/work', '-'],
        }));
    }
    const started = context.run(
      [...compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '300'],
      420_000,
    );
    results.push(
      started.code === 0
        ? {
            id: 'backup.start_writers',
            level: 'ok',
            detail: `${writers.join(', ')} started again.`,
          }
        : {
            id: 'backup.start_writers',
            level: 'fail',
            detail: `The stack did not come back after the volume archive: ${started.stderr.trim().split('\n').at(-1) ?? ''}`,
            fix: `Run ${compose.join(' ')} up -d --no-build --wait, then bun run melete status.`,
          },
    );
    if (started.code !== 0) ok = false;
  }

  if (ok)
    ok = await part('backup.checksums', 'SHA256SUMS', {
      bytes: new TextEncoder().encode(`${sums.join('\n')}\n`),
    });
  if (!ok) {
    remove();
    return { ok: false, location, results };
  }

  if (destination.kind === 'dir') {
    const kept = readdirSync(destination.dir)
      .filter((entry) => BACKUP_NAME.test(entry))
      .filter((entry) => statSync(join(destination.dir, entry)).isDirectory())
      .sort();
    const removed = kept.slice(0, Math.max(0, kept.length - config.backup.keep));
    for (const entry of removed)
      rmSync(join(destination.dir, entry), { recursive: true, force: true });
    if (removed.length > 0)
      results.push({
        id: 'backup.keep',
        level: 'ok',
        detail: `Kept the newest ${config.backup.keep}; removed ${removed.join(', ')}.`,
      });
  }
  return { ok: true, location, results };
}

export async function runBackup(
  context: Context,
  args: readonly string[],
  json: boolean,
): Promise<ExitCode> {
  let options: BackupOptions;
  try {
    options = backupOptions(args);
  } catch (error) {
    if (!(error instanceof BackupRefusal)) throw error;
    context.err(`${error.message}\n`);
    return EXIT.refused;
  }
  const installation = readInstallation(context.deployDir, context.machine.platform);
  if (installation.env === null) {
    context.err('There is no deploy/.env, so there is no installation here to back up.\n');
    return EXIT.refused;
  }
  const { config } = installation;
  const destination: Destination = options.destination
    ? options.destination.kind === 'dir'
      ? { kind: 'dir', dir: expandHome(options.destination.dir) }
      : options.destination
    : { kind: 'dir', dir: expandHome(config.backup.dir) };
  const compose = composeCommand(context.deployDir, config);
  const print = (results: Result[]) => {
    const value = report('backup', results);
    context.out(json ? `${JSON.stringify(value, null, 2)}\n` : renderReport(value));
    return value;
  };

  if (options.estimate) {
    const estimate = measureBackup(context, compose, options.withVolumes);
    const free = destinationFree(context, destination);
    const results: Result[] = [];
    const size = (bytes: number) => `${Math.ceil(bytes / MB)} MB`;
    results.push(
      estimate.databaseBytes === null
        ? {
            id: 'backup.database_mb',
            level: 'fail',
            detail: 'The database did not answer; is postgres running?',
          }
        : {
            id: 'backup.database_mb',
            level: 'ok',
            detail: `The database is ${size(estimate.databaseBytes)}; its dump is smaller.`,
          },
      estimate.journalBytes === null
        ? {
            id: 'backup.journal_mb',
            level: 'warn',
            detail: 'The restriction journal could not be measured; is the melete service running?',
          }
        : {
            id: 'backup.journal_mb',
            level: 'ok',
            detail: `The restriction journal is ${size(estimate.journalBytes)}.`,
          },
    );
    if (options.withVolumes)
      results.push(
        estimate.volumeBytes === null
          ? {
              id: 'backup.volumes_mb',
              level: 'fail',
              detail: '/data and /work could not be measured.',
            }
          : {
              id: 'backup.volumes_mb',
              level: 'ok',
              detail: `/data and /work hold ${size(estimate.volumeBytes)}.`,
            },
      );
    const total =
      (estimate.databaseBytes ?? 0) +
      (estimate.journalBytes ?? 0) +
      (estimate.volumeBytes ?? 0) +
      64 * MB;
    const where = describeDestination(destination);
    results.push(
      free === null
        ? {
            id: 'backup.target_free_mb',
            level: 'fail',
            detail: `The free space at ${where} could not be measured.`,
          }
        : free >= total
          ? {
              id: 'backup.target_free_mb',
              level: 'ok',
              detail: `${size(free)} free at ${where}; the backup needs about ${size(total)}.`,
            }
          : {
              id: 'backup.target_free_mb',
              level: 'fail',
              detail: `${size(free)} free at ${where}; the backup needs about ${size(total)}.`,
              fix: 'Choose another --dir, or stream it to another machine with --to ssh://host:/path.',
            },
    );
    return print(results).ok ? EXIT.ok : EXIT.failed;
  }

  try {
    return await withLock(context.deployDir, 'backup', async () => {
      const outcome = await takeBackup(context, config, destination, options.withVolumes);
      const results: Result[] = [
        ...outcome.results,
        outcome.ok
          ? { id: 'backup.location', level: 'ok', detail: outcome.location }
          : {
              id: 'backup.location',
              level: 'fail',
              detail: `No backup was kept at ${outcome.location}; the partial one was removed.`,
            },
      ];
      print(results);
      if (outcome.ok) return EXIT.ok;
      // The writers were stopped and did not come back: the stack changed.
      return results.some(
        (result) => result.id === 'backup.start_writers' && result.level === 'fail',
      )
        ? EXIT.partial
        : EXIT.failed;
    });
  } catch (error) {
    if (error instanceof LockRefusal || error instanceof BackupRefusal) {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}
