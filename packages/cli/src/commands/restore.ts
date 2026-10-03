/**
 * `melete restore <backup> [--plan]`: checks a backup made by `melete backup`
 * against its SHA256SUMS and prints the steps that restore it. It changes
 * nothing; the operator runs the steps.
 *
 * Only the database volume is replaced. On this machine the restriction
 * journal volume is kept as it is, because it is newer than any backup; on a
 * machine that has never run this installation, the newest journal archive
 * beside the backups is put back before the service starts. Either way the
 * service replays the journal at startup, so nothing forgotten comes back.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Context } from '../context.ts';
import { composeCommand } from '../deploy-config.ts';
import { readInstallation, shellOverrideMessage, shellOverrides } from '../installation.ts';
import { FINGERPRINT_FILE, MASTER_KEY, masterKeyFingerprint } from '../master-key.ts';
import { decryptCommand, encryptedSuffixOf, restoreSteps } from '../plan.ts';
import { EXIT, type ExitCode, type Result, renderReport, report } from '../schema.ts';
import { BACKUP_NAME, expandHome, writersOf } from './backup.ts';

export const RESTORE_USAGE = 'Usage: bun run melete restore <backup directory> [--plan]';

/**
 * Whether the operator has supplied the master key this backup was made with:
 * deploy/.env's, or MELETE_MASTER_KEY in this terminal, each judged by its
 * fingerprint. A set made before keys were kept apart carries no fingerprint
 * and no check applies.
 */
export function judgeMasterKey(
  backup: string,
  env: Record<string, string> | null,
  environment: Readonly<Record<string, string | undefined>>,
): { result: Result | null; setFromEnvironment: boolean } {
  const path = join(backup, FINGERPRINT_FILE);
  if (!existsSync(path)) return { result: null, setFromEnvironment: false };
  const recorded = readFileSync(path, 'utf8').trim();
  const here = env?.[MASTER_KEY]?.trim();
  if (here && masterKeyFingerprint(here) === recorded)
    return {
      result: {
        id: 'restore.master_key',
        level: 'ok',
        detail: 'deploy/.env holds the master key this backup was made with.',
      },
      setFromEnvironment: false,
    };
  const supplied = environment[MASTER_KEY]?.trim();
  if (supplied && masterKeyFingerprint(supplied) === recorded)
    return {
      result: {
        id: 'restore.master_key',
        level: 'ok',
        detail: 'MELETE_MASTER_KEY in this terminal is the key this backup was made with.',
      },
      setFromEnvironment: true,
    };
  return {
    result: {
      id: 'restore.master_key',
      level: 'fail',
      detail: supplied
        ? 'MELETE_MASTER_KEY in this terminal is not the key this backup was made with, so the credentials in its database could not be opened. Nothing was changed.'
        : 'This backup holds no master key, and neither deploy/.env nor this terminal has the one it was made with. Nothing was changed.',
      fix: 'Export the master key you kept apart from the backups (read -rs MELETE_MASTER_KEY && export MELETE_MASTER_KEY), then run this again.',
    },
    setFromEnvironment: false,
  };
}

/** How a backup set was encrypted, from its dump's name; null for a plain one. */
export function backupEncryption(backup: string): 'age' | 'gpg' | null {
  if (existsSync(join(backup, 'database.dump.age'))) return 'age';
  if (existsSync(join(backup, 'database.dump.gpg'))) return 'gpg';
  return null;
}

/** The newest restriction journal archive in this backup and the backups beside it. */
export function newestJournal(backup: string): string | null {
  const parent = dirname(backup);
  const sets = [
    backup,
    ...(existsSync(parent)
      ? readdirSync(parent)
          .filter((entry) => BACKUP_NAME.test(entry))
          .map((entry) => join(parent, entry))
      : []),
  ];
  const archives = [...new Set(sets)].flatMap((set) => {
    try {
      return readdirSync(set)
        .filter((file) => /^restrictions-\d{8}T\d{6}Z\.tar(\.age|\.gpg)?$/.test(file))
        .map((file) => join(set, file));
    } catch {
      return [];
    }
  });
  return archives.sort((a, b) => basename(a).localeCompare(basename(b))).at(-1) ?? null;
}

/**
 * What makes a backup unusable, one line each; empty when it is whole. Every file in
 * it, the dump above all, must be listed in SHA256SUMS and match.
 */
export async function verifyBackup(context: Context, backup: string): Promise<string[]> {
  if (!existsSync(backup) || !statSync(backup).isDirectory()) return ['it is not there'];
  const sumsPath = join(backup, 'SHA256SUMS');
  if (!existsSync(sumsPath)) return ['it has no SHA256SUMS'];
  const problems: string[] = [];
  const listed = new Map<string, string>();
  for (const line of readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean)) {
    const [sum, file] = line.split(/\s+/, 2);
    if (!sum || !file || file.includes('/') || file.includes('\\'))
      problems.push(`SHA256SUMS has a line it cannot read`);
    else listed.set(file, sum);
  }
  const dump = `database.dump${encryptedSuffixOf(backupEncryption(backup))}`;
  if (!listed.has(dump)) problems.push(`SHA256SUMS does not list ${dump}`);
  for (const file of readdirSync(backup))
    if (file !== 'SHA256SUMS' && !listed.has(file))
      problems.push(`SHA256SUMS does not list ${file}`);
  for (const [file, sum] of listed) {
    const path = join(backup, file);
    const hashed = existsSync(path) ? await context.stream({ file: path }, []) : null;
    if (!hashed?.ok || hashed.sha256 !== sum) problems.push(`${file} does not match SHA256SUMS`);
  }
  return problems;
}

export async function runRestore(
  context: Context,
  args: readonly string[],
  json: boolean,
): Promise<ExitCode> {
  const paths = args.filter((arg) => arg !== '--plan');
  const unknown = paths.filter((arg) => arg.startsWith('-'));
  if (paths.length !== 1 || unknown.length > 0) {
    context.err(`${RESTORE_USAGE}\n`);
    return EXIT.refused;
  }
  const backup = resolve(expandHome(paths[0] ?? ''));
  const encryption = backupEncryption(backup);
  if (
    !existsSync(join(backup, `database.dump${encryptedSuffixOf(encryption)}`)) ||
    !statSync(backup).isDirectory()
  ) {
    context.err(
      `${backup} is not a backup made by bun run melete backup: it has no database.dump.\n`,
    );
    return EXIT.refused;
  }
  const results: Result[] = [];
  const problems = await verifyBackup(context, backup);
  results.push(
    problems.length === 0
      ? {
          id: 'restore.checksums',
          level: 'ok',
          detail: `${readdirSync(backup).length - 1} file(s) match SHA256SUMS.`,
        }
      : {
          id: 'restore.checksums',
          level: 'fail',
          detail: problems.join('; '),
          fix: 'Use another backup; a damaged one cannot be restored safely.',
        },
  );

  const installation = readInstallation(context.deployDir, context.machine.platform);
  const overridden = shellOverrides(context.environment, installation.env ?? {});
  if (overridden.length > 0) {
    context.err(`${shellOverrideMessage(overridden)}\n`);
    return EXIT.refused;
  }
  const { config } = installation;
  const compose = composeCommand(context.deployDir, config);
  const freshHost =
    context.run(['docker', 'volume', 'inspect', `${config.project}_restrictions`]).code !== 0;
  const journal = freshHost ? newestJournal(backup) : null;
  results.push(
    freshHost
      ? journal
        ? {
            id: 'restore.journal',
            level: 'ok',
            detail: `This machine has no journal yet; the newest archive is ${journal}.`,
          }
        : {
            id: 'restore.journal',
            level: 'fail',
            detail: 'This machine has no restriction journal and the backup holds none.',
            fix: 'Restore from a backup made by bun run melete backup, which keeps the journal.',
          }
      : {
          id: 'restore.journal',
          level: 'ok',
          detail: `${config.project}_restrictions stays as it is: it is newer than the backup.`,
        },
  );
  // The master key is supplied apart from the set; it must be the one the database was sealed with.
  const keyCheck = judgeMasterKey(backup, installation.env, context.environment);
  if (keyCheck.result) results.push(keyCheck.result);
  if (keyCheck.result?.level === 'fail') {
    const refused = report('restore', results);
    context.out(json ? `${JSON.stringify(refused, null, 2)}\n` : renderReport(refused));
    return EXIT.refused;
  }
  const steps = restoreSteps({
    root: context.root,
    project: config.project,
    compose,
    writers: writersOf(config),
    backupDir: backup,
    previous: null,
    freshHost,
    journalArchive: journal,
    externalDatabase: config.database.external,
    encryption,
  });
  if (keyCheck.setFromEnvironment)
    steps.unshift(
      '# The master key is kept apart from backups: with MELETE_MASTER_KEY still exported in this terminal,',
      `bun run melete set --from-env ${MASTER_KEY}`,
    );
  if (!installation.env)
    steps.unshift(
      encryption === null
        ? `cp -p ${join(backup, 'deploy.env')} deploy/.env  # its keys open the sealed credentials in the database`
        : `(umask 077 && ${decryptCommand(encryption, join(backup, `deploy.env${encryptedSuffixOf(encryption)}`))} > deploy/.env)  # its keys open the sealed credentials in the database`,
    );
  const value = report('restore', results);
  if (json) context.out(`${JSON.stringify({ ...value, steps }, null, 2)}\n`);
  else
    context.out(
      `${renderReport(value)}${value.ok ? "To restore, from the installation's checkout:\n" : 'The steps, for when a sound backup is chosen:\n'}${steps.map((line) => `    ${line}`).join('\n')}\n`,
    );
  return value.ok ? EXIT.ok : EXIT.failed;
}
