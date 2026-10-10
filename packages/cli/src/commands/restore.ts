/**
 * `melete restore <backup> [--plan | --verify | --yes] [--keep-database]`
 *
 * Checks a backup made by `melete backup` against its SHA256SUMS and its list
 * of parts (contents.json), then:
 * - with no flag, or `--plan`: prints the steps that restore it, and changes nothing;
 * - `--verify` (or `--dry-run`): reads every archive through as well, decrypting
 *   an encrypted one, and changes nothing;
 * - `--yes`: checks every archive the same way first, then runs the steps:
 *   it stops the stack, puts back the database, the people's files and the
 *   agents' computers, and starts the stack only once every part is back. A
 *   step that fails stops the restore there, with the stack left stopped.
 *
 * The restriction journal is never rolled back. On this machine its volume is
 * kept as it is, because it is newer than any backup; on a machine that has
 * never run this installation, the newest journal archive beside the backups
 * is put back before the service starts. Either way the service replays the
 * journal at startup, so nothing forgotten comes back.
 *
 * `--keep-database` leaves the database alone, for an external database that
 * already holds the data, as on a replaced VM.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Context, Source } from '../context.ts';
import { psqlLine } from '../database.ts';
import { composeCommand, type DeployConfig } from '../deploy-config.ts';
import {
  CELLS_SERVICE,
  CONTENTS_FILE,
  type Contents,
  computerExists,
  fileSettings,
  helperImage,
  legacyMembers,
  ownComputer,
  parseContents,
  volumeOnEngine,
} from '../files.ts';
import {
  type Installation,
  longRunningServices,
  readInstallation,
  shellOverrideMessage,
  shellOverrides,
} from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { FINGERPRINT_FILE, MASTER_KEY, masterKeyFingerprint } from '../master-key.ts';
import {
  actionLine,
  decryptCommand,
  encryptedSuffixOf,
  type FileRestore,
  type RestoreAction,
  restoreActions,
  shellLine,
} from '../plan.ts';
import { installationSecrets, redact } from '../redact.ts';
import { EXIT, type ExitCode, type Result, renderReport, report } from '../schema.ts';
import { BACKUP_NAME, expandHome, writersOf } from './backup.ts';

export const RESTORE_USAGE =
  'Usage: bun run melete restore <backup directory> [--plan | --verify | --yes] [--keep-database]';

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
 * it, the dump above all, must be listed in SHA256SUMS and match, and every part
 * contents.json names must be there.
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
  const suffix = encryptedSuffixOf(backupEncryption(backup));
  const dump = `database.dump${suffix}`;
  if (!listed.has(dump)) problems.push(`SHA256SUMS does not list ${dump}`);
  for (const file of readdirSync(backup))
    if (file !== 'SHA256SUMS' && !listed.has(file))
      problems.push(`SHA256SUMS does not list ${file}`);
  for (const [file, sum] of listed) {
    const path = join(backup, file);
    const hashed = existsSync(path) ? await context.stream({ file: path }, []) : null;
    if (!hashed?.ok || hashed.sha256 !== sum) problems.push(`${file} does not match SHA256SUMS`);
  }
  const contents = readContents(backup);
  if (typeof contents === 'string') problems.push(contents);
  else if (contents !== null)
    for (const file of partsOf(contents)) {
      const stored = `${file}${suffix}`;
      if (!existsSync(join(backup, stored)))
        problems.push(`${stored} is missing: ${CONTENTS_FILE} says the backup holds it`);
      else if (!listed.has(stored)) problems.push(`SHA256SUMS does not list ${stored}`);
    }
  return problems;
}

/** contents.json, or null for a backup made before backups held files; a string says what is wrong with it. */
export function readContents(backup: string): Contents | null | string {
  const path = join(backup, CONTENTS_FILE);
  if (!existsSync(path)) return null;
  return parseContents(readFileSync(path, 'utf8'));
}

const partsOf = (contents: Contents) => [
  ...contents.parts.map((part) => part.file),
  ...contents.computers.map((computer) => computer.file),
];

/** Archives an earlier `backup --with-volumes` made, which restore also puts back. */
const LEGACY = ['data.tar', 'work.tar'] as const;

/** Decrypts a part to stdout as an argument list; null for a plain set. */
type Decrypt = ((file: string) => string[]) | null;

/**
 * Runs `use` with the way to decrypt this set's parts: age with the identity
 * file MELETE_BACKUP_IDENTITY names, or gpg with MELETE_BACKUP_PASSPHRASE in a
 * private file that is removed afterwards. A string says what is missing.
 */
async function withDecryption<T>(
  context: Context,
  encryption: 'age' | 'gpg' | null,
  use: (decrypt: Decrypt) => Promise<T>,
): Promise<T | string> {
  if (encryption === null) return await use(null);
  if (context.run([encryption, '--version']).code !== 0)
    return `${encryption} is not installed here, so this encrypted backup cannot be opened. Nothing was changed.`;
  if (encryption === 'age') {
    const identity = context.environment.MELETE_BACKUP_IDENTITY?.trim() ?? '';
    if (!identity || !existsSync(identity))
      return 'This backup is encrypted with age: export MELETE_BACKUP_IDENTITY as the path of the identity file that opens it, then run this again. Nothing was changed.';
    return await use((file) => ['age', '-d', '-i', identity, file]);
  }
  const passphrase = context.environment.MELETE_BACKUP_PASSPHRASE ?? '';
  if (!passphrase)
    return 'This backup is encrypted with gpg: export its passphrase as MELETE_BACKUP_PASSPHRASE (read -rs MELETE_BACKUP_PASSPHRASE && export MELETE_BACKUP_PASSPHRASE), then run this again. Nothing was changed.';
  const dir = mkdtempSync(join(tmpdir(), 'melete-restore-'));
  try {
    const passphraseFile = join(dir, 'passphrase');
    writeFileSync(passphraseFile, passphrase, { mode: 0o600, flag: 'wx' });
    return await use((file) => [
      'gpg',
      '--batch',
      '--quiet',
      '--pinentry-mode',
      'loopback',
      '--passphrase-file',
      passphraseFile,
      '--decrypt',
      file,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sourceOf = (file: string, decrypt: Decrypt): Source =>
  decrypt ? { command: decrypt(file) } : { file };

/**
 * Reads every part of the set through: each archive is listed by tar from
 * start to end, and each encrypted part is decrypted, which also proves the
 * key opens it. An archive an earlier `--with-volumes` made (`legacy`) must
 * also hold what is unpacked from it, since putting it back empties those
 * volumes first. Returns a line per problem; empty when every part reads.
 */
export async function readThrough(
  context: Context,
  backup: string,
  decrypt: Decrypt,
  legacy = false,
): Promise<{ problems: string[]; archives: number }> {
  const problems: string[] = [];
  let archives = 0;
  for (const file of readdirSync(backup).sort()) {
    if (file === 'SHA256SUMS' || file === CONTENTS_FILE || file === FINGERPRINT_FILE) continue;
    const plain = decrypt ? file.replace(/\.(age|gpg)$/, '') : file;
    const isArchive = plain.endsWith('.tar');
    if (!isArchive && !decrypt) continue;
    const members =
      legacy && (plain === 'data.tar' || plain === 'work.tar') ? legacyMembers(plain) : [];
    const outcome = await context.stream(
      sourceOf(join(backup, file), decrypt),
      isArchive ? [{ command: ['tar', '-tf', '-', ...members] }] : [],
    );
    if (isArchive) archives += 1;
    if (!outcome.ok)
      problems.push(`${file} could not be read through: ${outcome.detail || 'it is damaged'}`);
  }
  return { problems, archives };
}

/** Whether a Docker volume is on this engine. */
const volumeExists = (context: Context, volume: string) =>
  context.run(['docker', 'volume', 'inspect', '--format', '{{.Name}}', volume]).code === 0;

/** The running containers that use a volume; null when the engine did not answer. */
function usersOf(context: Context, volume: string): string[] | null {
  const listed = context.run([
    'docker',
    'ps',
    '--filter',
    `volume=${volume}`,
    '--format',
    '{{.Names}}',
  ]);
  if (listed.code !== 0) return null;
  return listed.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * How a run of the steps ended: every step done; stopped at a step that only
 * stops things, before anything was replaced; stopped at a step that replaces
 * something; or every part back but the final start failed.
 */
type StepsOutcome = 'done' | 'before_change' | 'midway' | 'not_started';

/**
 * Runs the restore's steps in order. The first step that fails stops it: the
 * steps after it, the start among them, are not run.
 */
async function runSteps(
  context: Context,
  actions: readonly RestoreAction[],
  decrypt: Decrypt,
  results: Result[],
  start: string,
): Promise<StepsOutcome> {
  const secrets = installationSecrets(context.deployDir);
  let changed = false;
  for (const action of actions) {
    if (action.kind !== 'run') continue;
    if (action.ifVolume && !volumeExists(context, action.ifVolume)) continue;
    if (action.unlessVolume && volumeExists(context, action.unlessVolume)) continue;
    let detail: string | null = null;
    for (const volume of action.unused ?? []) {
      const users = usersOf(context, volume);
      if (users === null) detail = `could not ask the engine what uses ${volume}`;
      else if (users.length > 0)
        detail = `${volume} is still in use by ${users.join(', ')}; stop ${users.length === 1 ? 'it' : 'them'} first`;
      if (detail !== null) break;
    }
    if (detail !== null) {
      // Nothing of this step ran: the volume was not emptied.
    } else if (action.input) {
      const outcome = await context.stream(sourceOf(action.input, decrypt), [
        { command: action.command },
      ]);
      if (!outcome.ok) detail = outcome.detail || 'it failed';
    } else {
      const output = context.run(action.command, action.timeoutMs ?? 120_000);
      if (output.code !== 0)
        detail = output.stderr.trim().split('\n').at(-1) || `exit ${output.code}`;
    }
    if (detail === null) {
      results.push({ id: 'restore.step', level: 'ok', detail: action.say });
      if (action.phase === undefined) changed = true;
      continue;
    }
    const outcome: StepsOutcome =
      action.phase === 'start' ? 'not_started' : changed ? 'midway' : 'before_change';
    results.push({
      id: 'restore.step',
      level: 'fail',
      detail: redact(`${actionLine(action, null)}: ${detail}`, secrets),
      fix:
        outcome === 'not_started'
          ? `Every part is back; only the start failed. See bun run melete status and bun run melete logs, fix the cause, then start it with ${start}. The restore need not run again.`
          : outcome === 'midway'
            ? 'The restore stopped here, and the stack was not started on a half-restored installation. Fix the cause, then run the same restore --yes again: it starts over from the backup.'
            : `Nothing was replaced yet, but services may be stopped. Fix the cause and run the same restore --yes again, or start the stack as it was with ${start}.`,
    });
    return outcome;
  }
  return 'done';
}

/** Whether the database DATABASE_URL names holds no tables yet; null when it did not answer. */
function externalDatabaseEmpty(
  context: Context,
  compose: readonly string[],
  config: DeployConfig,
): boolean | null {
  const output = context.run(
    psqlLine(
      compose,
      config,
      "select count(*) from pg_catalog.pg_tables where schemaname not in ('pg_catalog', 'information_schema')",
    ),
  );
  const text = output.stdout.trim();
  return output.code === 0 && /^\d+$/.test(text) ? Number(text) === 0 : null;
}

type Options = { path: string; mode: 'plan' | 'verify' | 'yes'; keepDatabase: boolean };

function restoreOptions(args: readonly string[]): Options | null {
  let mode: Options['mode'] | null = null;
  let keepDatabase = false;
  const paths: string[] = [];
  for (const arg of args) {
    const wanted =
      arg === '--plan'
        ? 'plan'
        : arg === '--verify' || arg === '--dry-run'
          ? 'verify'
          : arg === '--yes'
            ? 'yes'
            : null;
    if (wanted) {
      if (mode !== null && mode !== wanted) return null;
      mode = wanted;
    } else if (arg === '--keep-database') keepDatabase = true;
    else if (arg.startsWith('-')) return null;
    else paths.push(arg);
  }
  if (paths.length !== 1) return null;
  return { path: paths[0] ?? '', mode: mode ?? 'plan', keepDatabase };
}

/** What the backup holds besides the database, as the steps need it. */
function filesToRestore(
  context: Context,
  installation: Installation,
  backup: string,
  contents: Contents | null,
  suffix: string,
): { files: FileRestore | null; results: Result[] } {
  const legacy = LEGACY.filter((file) => existsSync(join(backup, `${file}${suffix}`)));
  if (contents === null && legacy.length === 0)
    return {
      files: null,
      results: [
        {
          id: 'restore.files',
          level: 'warn',
          detail:
            'This backup holds no files: it was made with --database-only, or before backups held them. The database comes back; the files on this machine are left as they are.',
        },
      ],
    };
  const image = helperImage(installation);
  if (!image)
    return {
      files: null,
      results: [
        {
          id: 'restore.files',
          level: 'fail',
          detail:
            'The Compose files name no image for the melete service, so the files cannot be put back.',
        },
      ],
    };
  // Only this installation's computers, and only into volumes that are theirs or absent:
  // a backup of another installation, or a list edited by hand, never reaches another's.
  const { sandboxProject } = fileSettings(installation);
  const listed = contents?.computers ?? [];
  const states = new Map(
    listed.map((volume) => [
      volume.volume,
      ownComputer(volume, sandboxProject) && sandboxProject
        ? volumeOnEngine(context, volume, sandboxProject)
        : 'foreign',
    ]),
  );
  const leftOut = new Set(
    listed
      .filter((volume) => states.get(volume.volume) === 'foreign')
      .map((volume) => volume.computer),
  );
  const computers = listed.filter((volume) => !leftOut.has(volume.computer));
  const names = [...new Set(computers.map((computer) => computer.computer))];
  const files: FileRestore = {
    image,
    parts: contents?.parts ?? [],
    computers,
    legacy: contents === null ? legacy : [],
    // Every one whose container is here, running, paused or stopped: one that starts
    // between this plan and the run is stopped all the same.
    containers: names.filter((computer) => computerExists(context, computer)),
    missing: computers
      .map((computer) => computer.volume)
      .filter((volume) => states.get(volume) === 'absent'),
  };
  const results: Result[] = [
    {
      id: 'restore.files',
      level: 'ok',
      detail:
        contents === null
          ? `Holds ${legacy.join(' and ')} from an earlier --with-volumes backup: the spaces, the files kept by their content and /work come back from ${legacy.length === 1 ? 'it' : 'them'}.`
          : `Holds the spaces' files, the files kept by their content, the agents' shared /work and ${names.length} agent computer(s); each volume is emptied and put back from its archive.${contents.blobs === 's3' ? ' Files kept in the S3 bucket are not in it: the bucket keeps its own.' : ''}`,
    },
  ];
  if (leftOut.size > 0)
    results.push({
      id: 'restore.computers_left_out',
      level: 'warn',
      detail: `${leftOut.size} agent computer(s) in this backup are not this installation's${sandboxProject ? ` (MELETE_SANDBOX_PROJECT=${sandboxProject})` : ', which has no MELETE_SANDBOX_PROJECT'}, or a volume of the same name on this engine belongs to something else: they are left out, and nothing of theirs here is touched.`,
    });
  // The service starts a computer again on its volumes only while its container
  // is still here; one whose container is gone, it counts as gone.
  const absent = names.filter((computer) => !files.containers.includes(computer));
  if (absent.length > 0)
    results.push({
      id: 'restore.computers_without_container',
      level: 'warn',
      detail: `${absent.length} of the ${names.length} agent computer(s) have no container on this machine (a new machine, or one removed). Their volumes are put back, but the service treats a computer without its container as gone: those agents get a new computer, with each chat's files in /work back from the shared /work and an empty home folder (browser sign-ins and installed tools are lost).`,
    });
  return { files, results };
}

export async function runRestore(
  context: Context,
  args: readonly string[],
  json: boolean,
): Promise<ExitCode> {
  const options = restoreOptions(args);
  if (options === null) {
    context.err(`${RESTORE_USAGE}\n`);
    return EXIT.refused;
  }
  const backup = resolve(expandHome(options.path));
  const encryption = backupEncryption(backup);
  const suffix = encryptedSuffixOf(encryption);
  if (!existsSync(join(backup, `database.dump${suffix}`)) || !statSync(backup).isDirectory()) {
    context.err(
      `${backup} is not a backup made by bun run melete backup: it has no database.dump.\n`,
    );
    return EXIT.refused;
  }
  const results: Result[] = [];
  const print = () => {
    const value = report('restore', results);
    context.out(json ? `${JSON.stringify(value, null, 2)}\n` : renderReport(value));
    return value;
  };
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
  const contents = readContents(backup);
  const { files, results: filesResults } = filesToRestore(
    context,
    installation,
    backup,
    typeof contents === 'string' ? null : contents,
    suffix,
  );
  results.push(...filesResults);
  const legacyArchives = (files?.legacy.length ?? 0) > 0;
  // Kept, the database is newer than the files: putting back the files would delete
  // every upload made since, while the database still names it.
  if (options.keepDatabase && !config.database.external)
    results.push({
      id: 'restore.keep_database',
      level: 'fail',
      detail:
        "--keep-database is for an external database that already holds the data. This installation's database is the bundled one, which the restore replaces with the backup's, so the database and the files agree.",
      fix: 'Run the restore without --keep-database.',
    });
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
  if (options.mode === 'verify') {
    // Checking a set needs no key; restoring it does, so the check only says so.
    if (keyCheck.result)
      results.push(
        keyCheck.result.level === 'fail'
          ? {
              ...keyCheck.result,
              level: 'warn',
              detail: `${keyCheck.result.detail.replace(/ Nothing was changed\.$/, '')} A restore needs it.`,
            }
          : keyCheck.result,
      );
    const read = await withDecryption(context, encryption, (decrypt) =>
      readThrough(context, backup, decrypt, legacyArchives),
    );
    if (typeof read === 'string')
      results.push({ id: 'restore.archives', level: 'fail', detail: read });
    else
      results.push(
        read.problems.length === 0
          ? {
              id: 'restore.archives',
              level: 'ok',
              detail: `Every part reads through${read.archives > 0 ? `: ${read.archives} archive(s) unpack from start to end` : ''}. Nothing was changed.`,
            }
          : {
              id: 'restore.archives',
              level: 'fail',
              detail: read.problems.join('; '),
              fix: 'Use another backup; a damaged one cannot be restored safely.',
            },
      );
    return print().ok ? EXIT.ok : EXIT.failed;
  }
  if (keyCheck.result) results.push(keyCheck.result);
  if (keyCheck.result?.level === 'fail') {
    print();
    return EXIT.refused;
  }
  const services = longRunningServices(installation);
  const settings = fileSettings(installation);
  const actions = restoreActions({
    root: context.root,
    project: config.project,
    compose,
    // melete-cells too: it starts attempt containers that write into the shared /work.
    writers: [...writersOf(config), ...(settings.cells ? [CELLS_SERVICE] : [])],
    services,
    cells: settings.cells,
    backupDir: backup,
    previous: null,
    freshHost,
    journalArchive: journal,
    externalDatabase: config.database.external,
    encryption,
    files,
    keepDatabase: options.keepDatabase,
  });
  const steps = actions.map((action) => actionLine(action, encryption));
  if (keyCheck.setFromEnvironment)
    steps.unshift(
      '# The master key is kept apart from backups: with MELETE_MASTER_KEY still exported in this terminal,',
      `bun run melete set --from-env ${MASTER_KEY}`,
    );
  if (!installation.env)
    steps.unshift(
      encryption === null
        ? `cp -p ${join(backup, 'deploy.env')} deploy/.env  # its keys open the sealed credentials in the database`
        : `(umask 077 && ${decryptCommand(encryption, join(backup, `deploy.env${suffix}`))} > deploy/.env)  # its keys open the sealed credentials in the database`,
    );

  if (options.mode === 'plan') {
    const value = report('restore', results);
    if (json) context.out(`${JSON.stringify({ ...value, steps }, null, 2)}\n`);
    else
      context.out(
        `${renderReport(value)}${value.ok ? "To restore, from the installation's checkout:\n" : 'The steps, for when a sound backup is chosen:\n'}${steps.map((line) => `    ${line}`).join('\n')}\n${value.ok ? `Nothing was changed. ${shellLine(['bun', 'run', 'melete', 'restore', options.path, '--yes'])} runs these steps.\n` : ''}`,
      );
    return value.ok ? EXIT.ok : EXIT.failed;
  }

  // --yes: everything that would stop the restore halfway is judged before anything changes.
  const refuse = (id: string, detail: string, fix?: string) => {
    results.push({ id, level: 'fail', detail, ...(fix ? { fix } : {}) });
    print();
    return EXIT.refused;
  };
  if (results.some((result) => result.level === 'fail')) {
    print();
    return EXIT.refused;
  }
  if (!installation.env)
    return refuse(
      'restore.env',
      'There is no deploy/.env here, so the stack cannot be run. Nothing was changed.',
      `Put the backup's deploy.env in place first: ${steps[0] ?? ''}`,
    );
  if (keyCheck.setFromEnvironment)
    return refuse(
      'restore.master_key',
      'deploy/.env holds another master key than the one this backup was made with. Nothing was changed.',
      `With MELETE_MASTER_KEY still exported, run bun run melete set --from-env ${MASTER_KEY}, then run this again.`,
    );
  if (config.database.external && !options.keepDatabase) {
    const empty = externalDatabaseEmpty(context, compose, config);
    if (empty !== true)
      return refuse(
        'restore.database',
        empty === null
          ? 'The database DATABASE_URL names did not answer. Nothing was changed.'
          : 'The database DATABASE_URL names already holds tables, and a restore loads into an empty one. Nothing was changed.',
        'Create a new, empty database at the provider and point DATABASE_URL at it (bun run melete set --from-env DATABASE_URL), or pass --keep-database when it already holds the data.',
      );
  }
  try {
    return await withLock(context.deployDir, 'restore', async () => {
      const outcome = await withDecryption(context, encryption, async (decrypt) => {
        const read = await readThrough(context, backup, decrypt, legacyArchives);
        if (read.problems.length > 0) {
          results.push({
            id: 'restore.archives',
            level: 'fail',
            detail: `${read.problems.join('; ')}. Nothing was changed.`,
            fix: 'Use another backup; a damaged one cannot be restored safely.',
          });
          return EXIT.refused;
        }
        results.push({
          id: 'restore.archives',
          level: 'ok',
          detail: `Every part reads through${read.archives > 0 ? `: ${read.archives} archive(s) unpack from start to end` : ''}.`,
        });
        const start = shellLine([...compose, 'up', '-d', '--no-build', '--wait', ...services]);
        const done = await runSteps(context, actions, decrypt, results, start);
        results.push(
          done === 'done'
            ? {
                id: 'restore.done',
                level: 'ok',
                detail: `Restored from ${backup}. Run bun run melete status to see the stack.`,
              }
            : {
                id: 'restore.done',
                level: 'fail',
                detail:
                  done === 'not_started'
                    ? 'Every part is back, but the stack did not start healthy.'
                    : done === 'midway'
                      ? 'The restore did not finish; the stack is stopped.'
                      : 'The restore stopped before it replaced anything; some services may be stopped.',
              },
        );
        return done === 'done' ? EXIT.ok : EXIT.partial;
      });
      if (typeof outcome === 'string') {
        results.push({ id: 'restore.archives', level: 'fail', detail: outcome });
        print();
        return EXIT.refused;
      }
      print();
      return outcome;
    });
  } catch (error) {
    if (error instanceof LockRefusal) {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}
