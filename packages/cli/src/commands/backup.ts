/**
 * `melete backup [--estimate] [--with-volumes] [--dir <path>] [--to ssh://host:/path]
 *                [--encrypt | --encrypt-to <age recipient>]`
 *
 * By default the backup is online and small: the database as a custom-format
 * dump, checked with `pg_restore --list` while it is written, the restriction
 * journal on its own under a timestamped name, deploy/.env, deploy/config/ and
 * deploy/melete.deploy.json, and a SHA256SUMS list of all of them. Each backup
 * is a new directory, melete-<time>, readable only by the account that made it
 * (0700, files 0600).
 *
 * `--with-volumes` also archives /data and /work, with the writers stopped so
 * the database and the files agree, and starts them again afterwards.
 * `--to ssh://host:/path` streams every part to another machine over SSH and
 * keeps nothing on this disk, for a host short on space. `--estimate` measures
 * and compares with the free space at the destination, and changes nothing.
 *
 * The restriction journal is kept per backup, so a restore never pairs an old
 * journal with a newer database: restore keeps the newest journal there is.
 *
 * deploy/.env is stored without MELETE_MASTER_KEY, which seals every credential
 * the database holds: a set carries only the key's fingerprint
 * (master-key.fingerprint), and a restore asks for the key, which the operator
 * keeps apart from the backups. The rest of deploy/.env still holds service
 * keys; unencrypted, a set is protected by its file modes alone, and the
 * command says so each time. `--encrypt-to <age
 * recipient>` encrypts every part with age to that public key; `--encrypt`
 * encrypts every part with gpg (AES-256) under the passphrase in
 * MELETE_BACKUP_PASSPHRASE. Each part is encrypted before it is written, and
 * SHA256SUMS lists the encrypted files, so a backup is checked without opening it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context, Endpoint, Source } from '../context.ts';
import { clientCommand, databaseShell, psqlLine } from '../database.ts';
import { composeCommand, DEPLOY_FILE, type DeployConfig } from '../deploy-config.ts';
import { lastSwitched, readHistory } from '../history.ts';
import { readInstallation, shellOverrideMessage, shellOverrides } from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { FINGERPRINT_FILE, masterKeyFingerprint, withoutMasterKey } from '../master-key.ts';
import { installationSecrets, redact } from '../redact.ts';
import { EXIT, type ExitCode, type Result, renderReport, report } from '../schema.ts';

const MB = 1024 ** 2;

export const BACKUP_USAGE =
  'Usage: bun run melete backup [--estimate] [--with-volumes] [--dir <path>] [--to ssh://host:/path] [--encrypt | --encrypt-to <age recipient>]';

export class BackupRefusal extends Error {}

export type SshTarget = { host: string; path: string };
export type Destination = { kind: 'dir'; dir: string } | { kind: 'ssh'; target: SshTarget };

export type BackupOptions = {
  estimate: boolean;
  withVolumes: boolean;
  destination: Destination | null;
  /** `passphrase` for --encrypt, a recipient for --encrypt-to; null for none. */
  encrypt: 'passphrase' | { recipient: string } | null;
};

/** How each part is encrypted: age to a recipient, or gpg under a passphrase file. */
export type Encryption =
  | { kind: 'age'; recipient: string }
  | { kind: 'gpg'; passphraseFile: string };

/** The file name ending each encrypted part carries. */
export const encryptedSuffix = (encryption: Encryption | null) =>
  encryption === null ? '' : encryption.kind === 'age' ? '.age' : '.gpg';

/** An age public key, or an SSH public key age accepts. */
const AGE_RECIPIENT = /^(age1[0-9a-z]{20,}|ssh-(ed25519|rsa) [A-Za-z0-9+/]+=*)$/;

/** The encrypting command, reading the plaintext on stdin; `$1` is the recipient or the passphrase file. */
const encryptor = (encryption: Encryption) =>
  encryption.kind === 'age'
    ? 'age -r "$1"'
    : 'gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$1" --symmetric --cipher-algo AES256';

/**
 * A sink that encrypts before the destination: into a new private file
 * (noclobber, umask 077), or into the command that writes it elsewhere.
 */
export function encryptingSink(encryption: Encryption, sink: Endpoint): Endpoint {
  const argument = encryption.kind === 'age' ? encryption.recipient : encryption.passphraseFile;
  if ('file' in sink)
    return {
      command: [
        'bash',
        '-c',
        `set -o pipefail -o noclobber; umask 077; ${encryptor(encryption)} > "$2"`,
        'bash',
        argument,
        sink.file,
      ],
    };
  return {
    command: [
      'bash',
      '-c',
      `set -o pipefail; ${encryptor(encryption)} | "$\{@:2}"`,
      'bash',
      argument,
      ...sink.command,
    ],
  };
}

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
  const options: BackupOptions = {
    estimate: false,
    withVolumes: false,
    destination: null,
    encrypt: null,
  };
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
    else if (arg === '--encrypt') options.encrypt = 'passphrase';
    else if (arg === '--encrypt-to') {
      const recipient = value();
      if (!AGE_RECIPIENT.test(recipient))
        throw new BackupRefusal(
          `${recipient.slice(0, 24)}... is not an age recipient: use an age1... public key, or an ssh-ed25519 or ssh-rsa public key.`,
        );
      options.encrypt = { recipient };
    } else throw new BackupRefusal(`${arg} is not a backup option. ${BACKUP_USAGE}`);
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
  config: DeployConfig,
  withVolumes: boolean,
): Estimate {
  const run = context.run;
  return {
    databaseBytes: number(
      run(psqlLine(compose, config, 'select pg_database_size(current_database())')),
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
  encryption: Encryption | null = null,
): Promise<BackupRun> {
  const compose = composeCommand(context.deployDir, config);
  const suffix = encryptedSuffix(encryption);
  const name = `melete-${stamp(context.now())}`;
  const results: Result[] = [];
  const sums: string[] = [];
  let location: string;
  let sink: (file: string) => Endpoint;
  let remove: () => void;
  /** The sha256 of a part as stored, read back where it was written. */
  let storedHash: (file: string) => Promise<string | null>;

  if (destination.kind === 'dir') {
    const base = destination.dir;
    mkdirSync(base, { recursive: true, mode: 0o700 });
    location = join(base, name);
    mkdirSync(location, { mode: 0o700 });
    const created = location;
    sink = (file) => ({ file: join(created, file) });
    remove = () => rmSync(created, { recursive: true, force: true });
    storedHash = async (file) => {
      const hashed = await context.stream({ file: join(created, file) }, []);
      return hashed.ok ? hashed.sha256 : null;
    };
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
    storedHash = async (file) => {
      const output = context.run(sshCommand(target, `sha256sum ${target.path}/${name}/${file}`));
      const hash = output.stdout.trim().split(/\s+/)[0] ?? '';
      return output.code === 0 && /^[a-f0-9]{64}$/.test(hash) ? hash : null;
    };
  }

  const secrets = installationSecrets(context.deployDir);
  // The master key never enters the set: deploy.env is stored without it.
  const stripped = withoutMasterKey(readFileSync(join(context.deployDir, '.env'), 'utf8'));
  const part = async (id: string, plainFile: string, source: Source, extra: Endpoint[] = []) => {
    // SHA256SUMS itself stays readable, so a backup is checked without its key.
    const encrypt =
      encryption !== null && plainFile !== 'SHA256SUMS' && plainFile !== FINGERPRINT_FILE;
    const file = encrypt ? `${plainFile}${suffix}` : plainFile;
    const destination = encrypt && encryption ? encryptingSink(encryption, sink(file)) : sink(file);
    const outcome = await context.stream(source, [destination, ...extra]);
    if (!outcome.ok) {
      // A database error can repeat the URL or part of it; it never reaches output.
      results.push({ id, level: 'fail', detail: redact(`${file}: ${outcome.detail}`, secrets) });
      return false;
    }
    // Encrypted, the stream saw the plaintext: the sum is of what was stored.
    const stored = encrypt ? await storedHash(file) : outcome.sha256;
    if (stored === null) {
      results.push({
        id,
        level: 'fail',
        detail: `${file} could not be read back after it was written.`,
      });
      return false;
    }
    sums.push(`${stored}  ${file}`);
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
      { command: databaseShell(compose, config, (db) => `exec pg_dump ${db} --format=custom`) },
      // Read back as it is written: a dump pg_restore cannot list is no backup.
      [{ command: [...compose, ...clientCommand(config), 'pg_restore', '--list'] }],
    )) &&
    (await part('backup.journal', `restrictions-${name.slice('melete-'.length)}.tar`, {
      command: [...compose, 'cp', 'melete:/data/restrictions', '-'],
    })) &&
    (await part('backup.env', 'deploy.env', { bytes: new TextEncoder().encode(stripped.text) })) &&
    (stripped.key === null ||
      (await part('backup.master_key', FINGERPRINT_FILE, {
        bytes: new TextEncoder().encode(`${masterKeyFingerprint(stripped.key)}\n`),
      })));
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
  results.push(
    stripped.key === null
      ? {
          id: 'backup.master_key',
          level: 'warn',
          detail:
            'deploy/.env sets no MELETE_MASTER_KEY, so the backup records no fingerprint to check a key against.',
        }
      : {
          id: 'backup.master_key_apart',
          level: 'warn',
          detail:
            'MELETE_MASTER_KEY is not in this backup; it holds only its fingerprint. Restoring needs the key itself, so keep a copy of it apart from the backups (a password manager, for example).',
        },
  );
  results.push(
    encryption === null
      ? {
          id: 'backup.plaintext',
          level: 'warn',
          detail:
            "This backup holds the database and deploy/.env's service keys unencrypted. Only its file modes (0700, 0600) protect it: anyone who can read it, or a copy of it, can read the conversations and memory in the database.",
          fix: 'Keep it on storage only you can read, or back up with --encrypt-to <age recipient> or --encrypt (with MELETE_BACKUP_PASSPHRASE set).',
        }
      : {
          id: 'backup.encrypted',
          level: 'ok',
          detail:
            encryption.kind === 'age'
              ? 'Every part is encrypted with age to the recipient given; the matching identity opens it.'
              : 'Every part is encrypted with gpg (AES-256) under the passphrase given.',
        },
  );

  if (destination.kind === 'dir') {
    // The backup the last deploy took is the one rollback restores from: it is never pruned.
    const named = lastSwitched(readHistory(context.deployDir))?.backup;
    const kept = readdirSync(destination.dir)
      .filter((entry) => BACKUP_NAME.test(entry))
      .filter((entry) => statSync(join(destination.dir, entry)).isDirectory())
      .sort();
    const removed = kept
      .slice(0, Math.max(0, kept.length - config.backup.keep))
      .filter((entry) => !named || resolve(join(destination.dir, entry)) !== resolve(named));
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

/**
 * Runs `take` with the encryption the options ask for, after checking its tool
 * is here. A passphrase goes into a private file only for the run, so it is
 * never on a command line, and the file is removed afterwards.
 */
export async function withEncryption<T>(
  context: Context,
  encrypt: BackupOptions['encrypt'],
  take: (encryption: Encryption | null) => Promise<T>,
): Promise<T> {
  if (encrypt === null) return await take(null);
  const tool = encrypt === 'passphrase' ? 'gpg' : 'age';
  if (context.run([tool, '--version']).code !== 0)
    throw new BackupRefusal(
      `${tool} is not installed here, so the backup cannot be encrypted with it. Install ${tool}${tool === 'age' ? ' (https://age-encryption.org)' : ''}, then run this again. Nothing was changed.`,
    );
  if (encrypt !== 'passphrase') return await take({ kind: 'age', recipient: encrypt.recipient });
  const passphrase = context.environment.MELETE_BACKUP_PASSPHRASE ?? '';
  if (passphrase.length < 12)
    throw new BackupRefusal(
      'MELETE_BACKUP_PASSPHRASE holds no passphrase of 12 characters or more. Set it with read -rs MELETE_BACKUP_PASSPHRASE && export MELETE_BACKUP_PASSPHRASE, then run this again. Nothing was changed.',
    );
  const dir = mkdtempSync(join(tmpdir(), 'melete-backup-'));
  try {
    const passphraseFile = join(dir, 'passphrase');
    writeFileSync(passphraseFile, passphrase, { mode: 0o600, flag: 'wx' });
    return await take({ kind: 'gpg', passphraseFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const overridden = shellOverrides(context.environment, installation.env);
  if (overridden.length > 0) {
    context.err(`${shellOverrideMessage(overridden)}\n`);
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
    const estimate = measureBackup(context, compose, config, options.withVolumes);
    const free = destinationFree(context, destination);
    const results: Result[] = [];
    const size = (bytes: number) => `${Math.ceil(bytes / MB)} MB`;
    results.push(
      estimate.databaseBytes === null
        ? {
            id: 'backup.database_mb',
            level: 'fail',
            detail: config.database.external
              ? 'The database did not answer; run bun run melete doctor to see why.'
              : 'The database did not answer; is postgres running?',
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
      const outcome = await withEncryption(context, options.encrypt, (encryption) =>
        takeBackup(context, config, destination, options.withVolumes, encryption),
      );
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
