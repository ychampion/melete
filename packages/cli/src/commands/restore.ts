/**
 * `melete restore <backup> [--plan | --verify | --yes] [--keep-database [--replace-files]]`
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
 * kept as it is, because it is newer than any backup; where it is missing or
 * holds no entry (a machine that has never run this installation, or a restore
 * that stopped before it put the journal back), the newest journal archive
 * beside the backups is put back before the service starts. Either way the
 * service replays the journal at startup, so nothing forgotten comes back. A
 * journal kept here that lacks removals the backup's journal records (a machine
 * started and used before the restore) is named, with each removal it lacks.
 *
 * `--keep-database` leaves the database alone, for an external database that
 * already holds the data, as on a replaced VM. When the file volumes here
 * already hold files, which may be newer than the backup's, it is refused
 * unless `--replace-files` says to put the backup's in their place.
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
import { psqlLine, rolesElsewhere, TABLE_COUNT_SQL } from '../database.ts';
import { composeCommand, type DeployConfig } from '../deploy-config.ts';
import {
  CELLS_SERVICE,
  CONTENTS_FILE,
  type Contents,
  composeVolume,
  computerExists,
  FILE_PARTS,
  type FilePart,
  fileSettings,
  helperImage,
  JOURNAL_MEMBER,
  journalInVolume,
  journalOnEngine,
  journalRemovals,
  legacyMembers,
  ownComputer,
  parseContents,
  volumeOnEngine,
  volumePresence,
  volumesHoldingFiles,
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
  'Usage: bun run melete restore <backup directory> [--plan | --verify | --yes] [--keep-database [--replace-files]]';

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
 * The journal a journal archive holds, as text: empty when it holds none (a
 * backup of a machine whose journal was not written yet). An encrypted archive
 * is decrypted into a private folder that is removed afterwards.
 */
async function archivedJournal(
  context: Context,
  archive: string,
): Promise<string | { unreadable: string }> {
  const encryption = archive.endsWith('.age') ? 'age' : archive.endsWith('.gpg') ? 'gpg' : null;
  const read = await withDecryption(context, encryption, async (decrypt) => {
    if (!decrypt) return context.run(['tar', '-xOf', archive, JOURNAL_MEMBER]);
    const dir = mkdtempSync(join(tmpdir(), 'melete-journal-'));
    try {
      const plain = join(dir, 'journal.tar');
      const copied = await context.stream({ command: decrypt(archive) }, [{ file: plain }]);
      if (!copied.ok) return { code: 1, stdout: '', stderr: copied.detail || 'it is damaged' };
      return context.run(['tar', '-xOf', plain, JOURNAL_MEMBER]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  if (typeof read === 'string') return { unreadable: read.replace(/ Nothing was changed\.$/, '') };
  if (read.code === 0) return read.stdout;
  if (/not found in archive/i.test(read.stderr)) return '';
  return { unreadable: read.stderr.trim().split('\n').at(-1) || `exit ${read.code}` };
}

/**
 * Whether the journal kept here holds every removal the backup's journal
 * records. A machine started and used before the restore has a journal of its
 * own, not the one the backup's goes on from: a removal it lacks is not put
 * back, and the service never replays it. Null when nothing is missing.
 */
async function journalAgainstArchive(
  context: Context,
  image: string,
  volume: string,
  archive: string,
): Promise<Result | null> {
  const here = journalInVolume(context, image, volume);
  const archived = await archivedJournal(context, archive);
  const kept = typeof here === 'string' ? journalRemovals(here) : null;
  const backedUp = typeof archived === 'string' ? journalRemovals(archived) : null;
  if (kept === null || backedUp === null)
    return {
      id: 'restore.journal_diverged',
      level: 'warn',
      detail: `Whether ${volume} holds every removal in the backup's journal could not be read (${
        typeof here === 'object'
          ? here.unreadable
          : kept === null
            ? `${volume} holds a line the service does not write`
            : typeof archived === 'object'
              ? archived.unreadable
              : `${basename(archive)} holds a line the service does not write`
      }), so a removal recorded only in the backup may not be put back.`,
    };
  const keptIds = new Set(kept.map((removal) => removal.id));
  const missing = backedUp.filter((removal) => !keptIds.has(removal.id));
  if (missing.length === 0) return null;
  const backedUpIds = new Set(backedUp.map((removal) => removal.id));
  const onlyHere = kept.filter((removal) => !backedUpIds.has(removal.id)).length;
  const shown = missing
    .slice(0, 10)
    .map((removal) => `${removal.id} (${removal.operation}, ${removal.recordedAt})`)
    .join(', ');
  return {
    id: 'restore.journal_diverged',
    level: 'warn',
    detail: `${volume} does not hold ${missing.length} removal(s) recorded in the backup's journal (${archive}), so they are not put back and the service does not replay them: ${shown}${missing.length > 10 ? `, and ${missing.length - 10} more` : ''}. The journal here is not the one the backup's goes on from, as on a machine started and used before the restore.`,
    fix: `Removing ${volume}, with the stack down, before the restore puts the backup's journal back in its place, and loses the ${onlyHere} removal(s) recorded only here. Do that only when those were made on data the restore replaces.`,
  };
}

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
  let rerun: string | null = null;
  // What a Ctrl-C says: where the restore stopped, and what to run next. While a step
  // that replaces something runs, it may have begun to, so the stack must not start.
  const hint = (running?: Extract<RestoreAction, { kind: 'run' }>) =>
    context.interruptHint?.(
      running?.phase === 'start'
        ? `Every part is back; the start was stopped. See bun run melete status, then start it with ${start}. The restore need not run again.`
        : rerun
          ? `Some parts are back and the stack is stopped. ${rerun}`
          : changed
            ? 'Some parts are back and the stack is stopped: run the same restore --yes again, which is safe, since it starts over from the backup.'
            : running && running.phase === undefined
              ? 'It stopped while it put a part back, and the stack is stopped: run the same restore --yes again, which is safe, since it starts over from the backup. Do not start the stack before it has run.'
              : `Nothing was replaced yet, but services may be stopped: run the same restore --yes again, which is safe, or start the stack as it was with ${start}.`,
    );
  hint();
  for (const action of actions) {
    if (action.kind !== 'run') continue;
    // A Ctrl-C that came during the step before is handled here, before this one starts.
    await new Promise((settle) => setImmediate(settle));
    hint(action);
    let detail: string | null = null;
    // A step that depends on whether a volume is here runs only on a clear answer.
    const asked = action.ifVolume ?? action.unlessVolume;
    const presence = asked ? volumePresence(context, asked) : null;
    if (presence !== null && typeof presence === 'object')
      detail = `could not ask the engine whether ${asked} is here: ${presence.unreadable}`;
    else if (action.ifVolume && presence === 'absent') continue;
    else if (action.unlessVolume && presence === 'present') continue;
    for (const volume of detail === null ? (action.unused ?? []) : []) {
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
      if (action.rerun) rerun = action.rerun;
      hint();
      continue;
    }
    const outcome: StepsOutcome =
      action.phase === 'start' ? 'not_started' : changed ? 'midway' : 'before_change';
    results.push({
      id: 'restore.step',
      level: 'fail',
      // The step's name: its shell line, printed with the plan, can run to many lines.
      detail: redact(`Step failed (${action.say.replace(/\.$/, '')}): ${detail}`, secrets),
      fix:
        action.failure ??
        (outcome === 'not_started'
          ? `Every part is back; only the start failed. See bun run melete status and bun run melete logs, fix the cause, then start it with ${start}. The restore need not run again.`
          : outcome === 'midway'
            ? `The restore stopped here, and the stack was not started on a half-restored installation. Fix the cause, then ${rerun ? `restore again. ${rerun}` : 'run the same restore --yes again: it starts over from the backup.'}`
            : `Nothing was replaced yet, but services may be stopped. Fix the cause and run the same restore --yes again, or start the stack as it was with ${start}.`),
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
  const output = context.run(psqlLine(compose, config, TABLE_COUNT_SQL));
  const text = output.stdout.trim();
  return output.code === 0 && /^\d+$/.test(text) ? Number(text) === 0 : null;
}

type Options = {
  path: string;
  mode: 'plan' | 'verify' | 'yes';
  keepDatabase: boolean;
  replaceFiles: boolean;
};

function restoreOptions(args: readonly string[]): Options | null {
  let mode: Options['mode'] | null = null;
  let keepDatabase = false;
  let replaceFiles = false;
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
    else if (arg === '--replace-files') replaceFiles = true;
    else if (arg.startsWith('-')) return null;
    else paths.push(arg);
  }
  // Only a kept database can be newer than the files; otherwise both come back together.
  if (paths.length !== 1 || (replaceFiles && !keepDatabase)) return null;
  return { path: paths[0] ?? '', mode: mode ?? 'plan', keepDatabase, replaceFiles };
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
  // Unknown is neither absent nor ours: a volume the engine could not describe might be
  // another installation's, so nothing is planned into it.
  const unknown = [...states].flatMap(([volume, state]) =>
    typeof state === 'object' ? [`${volume} (${state.unreadable})`] : [],
  );
  if (unknown.length > 0)
    return {
      files: null,
      results: [
        {
          id: 'restore.files',
          level: 'fail',
          detail: `Whether these agent computer volumes are on this machine, and whose they are, could not be read: ${unknown.join('; ')}. Nothing was changed.`,
          fix: 'Check that docker volume inspect answers for them, then run this again.',
        },
      ],
    };
  const leftOut = new Set(
    listed
      .filter((volume) => states.get(volume.volume) === 'foreign')
      .map((volume) => volume.computer),
  );
  const computers = listed.filter((volume) => !leftOut.has(volume.computer));
  const names = [...new Set(computers.map((computer) => computer.computer))];
  const containerStates = new Map(
    names.map((computer) => [computer, computerExists(context, computer)]),
  );
  const unreadable = [...containerStates].flatMap(([computer, state]) =>
    typeof state === 'object' ? [{ computer, why: state.unreadable }] : [],
  );
  const files: FileRestore = {
    image,
    parts: contents?.parts ?? [],
    computers,
    legacy: contents === null ? legacy : [],
    // Every one whose container is here, running, paused or stopped: one that starts
    // between this plan and the run is stopped all the same. One the engine could not
    // describe is stopped too: a container that is there never runs on its volumes as
    // they are put back, and stopping one that is not fails before anything is replaced.
    containers: names.filter((computer) => containerStates.get(computer) !== 'absent'),
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
  // What becomes of a computer whose container is gone is the service's to say:
  // one that makes the container again on kept volumes brings the computer back
  // whole; an earlier one gives the agent a new computer.
  if (unreadable.length > 0)
    results.push({
      id: 'restore.computers_unreadable',
      level: 'warn',
      detail: `Whether ${unreadable.map((each) => each.computer).join(', ')} ${unreadable.length === 1 ? 'has' : 'have'} a container on this machine could not be read (${[...new Set(unreadable.map((each) => each.why))].join('; ')}): the engine did not answer. ${unreadable.length === 1 ? 'It is' : 'They are'} stopped with the others before the volumes are put back; where there is no such container, that stop fails before anything is replaced.`,
      fix: 'Check that docker container inspect answers, then run this again.',
    });
  const absent = names.filter((computer) => !files.containers.includes(computer));
  if (absent.length > 0)
    results.push({
      id: 'restore.computers_without_container',
      level: 'warn',
      detail: `${absent.length} of the ${names.length} agent computer(s) have no container on this machine (a new machine, or one removed). Their volumes are put back, and the service makes each container again on them the next time the agent uses it, with its /work and home folder. An older service, from before computers came back this way, gives the agent a new computer instead, with each chat's files in /work back from the shared /work and an empty home folder (browser sign-ins and installed tools lost).`,
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
  // Kept, the files here may be newer than the backup's: putting the backup's in
  // their place deletes what was added since, while the database still names it.
  if (options.keepDatabase && config.database.external && files) {
    // Only the volumes this set replaces: an earlier --with-volumes set may hold some of them.
    const replaced: FilePart[] = [
      ...files.parts.map((part) => part.part),
      ...files.legacy.flatMap((file) =>
        file === 'data.tar' ? (['spaces', 'artifacts'] as const) : (['work'] as const),
      ),
    ];
    const volumes = FILE_PARTS.filter((part) => replaced.includes(part)).map((part) =>
      composeVolume(config.project, part),
    );
    const presence = volumes.map((volume) => ({ volume, state: volumePresence(context, volume) }));
    // The agents' computers' volumes the restore replaces are here and this installation's;
    // the ones it makes are not, and hold nothing to lose.
    const computers = files.computers
      .map((computer) => computer.volume)
      .filter((volume) => !files.missing.includes(volume));
    const present = [
      ...presence.filter((each) => each.state === 'present').map((each) => each.volume),
      ...computers,
    ];
    const unknown = presence.flatMap(({ volume, state }) =>
      typeof state === 'object' ? [`${volume} (${state.unreadable})`] : [],
    );
    const held = unknown.length > 0 ? null : volumesHoldingFiles(context, files.image, present);
    if (unknown.length > 0)
      results.push({
        id: 'restore.keep_database_files',
        level: 'fail',
        detail: `Whether ${unknown.join('; ')} ${unknown.length === 1 ? 'is' : 'are'} on this machine could not be read, and with --keep-database the backup's files would replace newer ones. Nothing was changed.`,
        fix: 'Check that docker volume inspect answers for them, then run this again.',
      });
    else if (held === null)
      results.push({
        id: 'restore.keep_database_files',
        level: 'fail',
        detail: `Whether ${present.join(', ')} already hold files could not be read, and with --keep-database the backup's files would replace newer ones. Nothing was changed.`,
        fix: "Check that docker run works with the service's image, then run this again.",
      });
    else if (held.length > 0)
      results.push(
        options.replaceFiles
          ? {
              id: 'restore.keep_database_files',
              level: 'warn',
              detail: `${held.join(', ')} already hold files; --replace-files puts the backup's in their place, and any file added since the backup is deleted.`,
            }
          : {
              id: 'restore.keep_database_files',
              level: 'fail',
              detail: `${held.join(', ')} already hold files. With --keep-database the database stays as it is, so putting the backup's files in their place would delete any file added since the backup while the database still names it.`,
              fix: "On a new machine whose stack started before the restore, the files there are only its own (an agent computer's too, if one was used there): add --replace-files. On the machine the backup came from, restore into a new, empty database instead of keeping this one.",
            },
      );
  }
  // The service runs where the administrator's role addresses point, not where DATABASE_URL does.
  const elsewhere =
    config.database.external && installation.env ? rolesElsewhere(installation.env) : [];
  if (elsewhere.length > 0)
    results.push({
      id: 'restore.database_roles',
      level: 'fail',
      detail: `${elsewhere.join(', ')} name${elsewhere.length === 1 ? 's' : ''} another server or database than DATABASE_URL, and the service runs on what ${elsewhere.length === 1 ? 'it names' : 'they name'}, not on the database this restore ${options.keepDatabase ? 'keeps' : 'loads'}. Nothing was changed.`,
      fix: 'Have the database\'s administrator grant those roles the database DATABASE_URL names (docs/DEPLOYMENT.md, "Roles an administrator creates"), point each at it with bun run melete set --from-env, then run this again.',
    });
  // Missing, or with no entry yet: a new machine, or a restore that stopped
  // after `compose create` made the volume and before the journal went back.
  const journalVolume = `${config.project}_restrictions`;
  const image = helperImage(installation);
  const journalState = journalOnEngine(context, image, journalVolume);
  const freshHost = journalState === 'absent' || journalState === 'empty';
  const journal = freshHost ? newestJournal(backup) : null;
  results.push(
    typeof journalState === 'object'
      ? {
          id: 'restore.journal',
          level: 'fail',
          detail: `${journalVolume} could not be read (${journalState.unreadable}), so whether it holds the journal is not known. Nothing was changed.`,
          fix: "Check that docker volume inspect answers for it and docker run works with the service's image, then run this again.",
        }
      : freshHost
        ? journal
          ? {
              id: 'restore.journal',
              level: 'ok',
              detail:
                journalState === 'absent'
                  ? `This machine has no journal yet; the newest archive is ${journal}.`
                  : `${journalVolume} holds no entry yet (a new machine, or a restore that stopped before the journal went back); the newest archive, ${journal}, is put back.`,
            }
          : journalState === 'empty'
            ? // A set made by hand may hold no journal; with no entry here either, none is lost.
              {
                id: 'restore.journal',
                level: 'ok',
                detail: `${journalVolume} holds no entry and the backup holds no journal: there is nothing to put back.`,
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
            detail: `${journalVolume} stays as it is: it is newer than the backup.`,
          },
  );
  // Kept, the journal here must hold the backup's removals too: it is replayed, the backup's is not.
  const archive = journalState === 'kept' && image ? newestJournal(backup) : null;
  const diverged =
    archive && image ? await journalAgainstArchive(context, image, journalVolume, archive) : null;
  if (diverged) results.push(diverged);
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
        if (done === 'done')
          context.interruptHint?.(
            'Every part was back and the stack started: see bun run melete status.',
          );
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
