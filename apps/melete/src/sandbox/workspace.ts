/**
 * Moving a job's workspace between this machine and a remote sandbox.
 *
 * Nothing a sandbox returns is trusted to be a path on this machine. A listing
 * is checked in full before a byte is written: every entry must be a portable
 * relative path, no entry may be a symbolic link, and the counts and sizes must
 * fit the caps. Then each file is fetched, and each target is re-resolved under
 * `<workRoot>/<job_id>` component by component immediately before it is opened,
 * so a link planted on this side between the check and the write is refused too.
 * A refusal refuses the whole synchronisation; a partial copy of a workspace is
 * a wrong answer that looks like a right one.
 *
 * Files arrive with mode 0o644 or 0o755 and nothing else: an executable bit is
 * kept, and set-id, sticky, group- and world-writable bits never cross.
 *
 * A file the sandbox no longer has is moved to the job's trash here only when
 * this same command's sync-in sent it, the caller says it is Melete's own
 * (`SyncOutOptions.deletions`), and, checked in the trash, it is still what
 * was sent. Any other is kept, goes back on the next sync-in, and the report
 * says which and why, so a command is never told it deleted something that
 * then comes back. What went to the trash can be restored (files-trash.ts).
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { recordId } from '../broker/records.ts';
import { type HeldDirectory, holdBeneath, holdWithin, openIn } from '../connectors/files.ts';
import { DEFAULT_TRASH_DAYS, moveToTrash } from '../connectors/files-trash.ts';
import { LEGACY_SCREEN_PATH } from '../devices/screen-paths.ts';
import {
  LocalWorkspaceFs,
  portable,
  SyncRefusal,
  syncMode,
  writeIn,
} from '../runtime/workspace-fs.ts';
import type { SandboxHandle, SandboxProvider } from './types.ts';

const MiB = 1024 * 1024;

export const SYNC_LIMITS = {
  maxFiles: 2_000,
  maxTotalBytes: 64 * MiB,
  maxFileBytes: 8 * MiB,
} as const;

export const SANDBOX_WORKDIR = '/work';

export { SyncRefusal, type SyncRefusalCode, syncMode } from '../runtime/workspace-fs.ts';

export type SyncReport = { files: number; directories: number; bytes: number };

/** A file one sync-in sent: its size and content hash. */
export type SentFile = { size: number; hash: string };
export type SyncInReport = SyncReport & {
  /** Every file sent, by its path under the workspace. */
  sent: Map<string, SentFile>;
};
export type SyncOutReport = SyncReport & {
  /** Every file read back, by its path under the workspace, with its content hash. */
  hashes: Map<string, string>;
  /** Files the command deleted that went to the trash here too. */
  deleted: string[];
  /** Files the command deleted that are kept here, and go back on the next sync-in. */
  kept: { path: string; reason: string }[];
  /** The trash they went to, restorable until `restorable_until`; null when none went. */
  trash_id: string | null;
  /** Earlier deletes taken out of the trash to make room. */
  evicted?: string[];
  restorable_until: string | null;
};

type WorkspaceLimits = { maxFiles: number; maxTotalBytes: number; maxFileBytes: number };

/** A folder on the way that is a file says so as a refusal of the synchronisation. */
const notDirectory = (relative: string) => (error: unknown) => {
  if ((error as Error).message === 'not a directory')
    throw new SyncRefusal('not_regular', `not a directory: ${relative}`);
  throw error;
};

/** Write one file under `<workRoot>/<job_id>` (see `LocalWorkspaceFs.write`). */
export function writeWorkspaceFile(
  workRoot: string,
  jobId: string,
  relative: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  return new LocalWorkspaceFs(workRoot).write(jobId, relative, bytes, mode);
}

/** Like `writeWorkspaceFile`, for a file the service keeps for itself: owner-only access. */
export function writePrivateWorkspaceFile(
  workRoot: string,
  jobId: string,
  relative: string,
  bytes: Uint8Array,
): Promise<void> {
  return new LocalWorkspaceFs(workRoot).writePrivate(jobId, relative, bytes);
}

/** Read one file under `<workRoot>/<job_id>`, refusing links and anything above `maxBytes`. */
export function readWorkspaceFile(
  workRoot: string,
  jobId: string,
  relative: string,
  maxBytes: number,
): Promise<Buffer> {
  return new LocalWorkspaceFs(workRoot).read(jobId, relative, maxBytes);
}

type LocalFile = { relative: string; segments: string[]; size: number; mode: 0o644 | 0o755 };

/**
 * List the job's workspace through folders held open as they are walked, so a
 * folder swapped for a link meanwhile lists nothing outside the workspace.
 */
async function walkLocal(jobDirectory: string, limits: WorkspaceLimits): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  let total = 0;
  const visit = async (directory: HeldDirectory, prefix: string[]) => {
    const entries = await readdir(directory.self, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = [...prefix, entry.name].join('/');
      const segments = portable(relative);
      const stat = await lstat(directory.at(entry.name));
      if (stat.isSymbolicLink())
        throw new SyncRefusal('symlink', `a symbolic link was refused: ${relative}`);
      if (stat.isDirectory()) {
        const inner = await holdWithin(directory, entry.name).catch(() => {
          throw new SyncRefusal(
            'changed',
            `a folder changed while it was synchronised: ${relative}`,
          );
        });
        try {
          await visit(inner, segments);
        } finally {
          await inner.close();
        }
        continue;
      }
      if (!stat.isFile())
        throw new SyncRefusal('not_regular', `not a regular file or directory: ${relative}`);
      // A paired computer's screenshot an earlier version left in the workspace
      // never goes to a sandbox (devices/screens.ts).
      if (LEGACY_SCREEN_PATH.test(relative)) continue;
      if (stat.size > limits.maxFileBytes)
        throw new SyncRefusal('file_too_large', `a file above the per-file cap: ${relative}`);
      total += stat.size;
      if (total > limits.maxTotalBytes)
        throw new SyncRefusal('too_large', 'the workspace is above the total size cap');
      files.push({ relative, segments, size: stat.size, mode: syncMode(stat.mode) });
      if (files.length > limits.maxFiles)
        throw new SyncRefusal('too_many_files', 'the workspace has more files than the cap');
    }
  };
  const root = await holdBeneath(jobDirectory, []);
  try {
    await visit(root, []);
  } finally {
    await root.close();
  }
  return files;
}

export type SyncOptions = {
  provider: SandboxProvider;
  handle: SandboxHandle;
  workRoot: string;
  jobId: string;
  signal: AbortSignal;
  limits?: Partial<WorkspaceLimits>;
};

/** Copy `<workRoot>/<job_id>` into the sandbox's `/work`. */
export async function syncIn(options: SyncOptions): Promise<SyncInReport> {
  const limits = { ...SYNC_LIMITS, ...options.limits };
  const workspace = new LocalWorkspaceFs(options.workRoot);
  const files = await walkLocal(await workspace.jobDirectory(options.jobId, true), limits);
  const sent = new Map<string, SentFile>();
  let bytes = 0;
  async function* read() {
    // Each folder is walked again and held while its files are read, so a
    // folder swapped for a link since the listing sends nothing from outside.
    const folders = await workspace.folders(options.jobId);
    try {
      for (const file of files) {
        const changed = () => {
          throw new SyncRefusal(
            'changed',
            `a file changed while it was synchronised: ${file.relative}`,
          );
        };
        const folder = await folders.at(file.segments.slice(0, -1)).catch(changed);
        const name = file.segments.at(-1) as string;
        const handle = await openIn(folder, name, constants.O_RDONLY).catch(changed);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== file.size)
            throw new SyncRefusal(
              'changed',
              `a file changed while it was synchronised: ${file.relative}`,
            );
          const content = await handle.readFile();
          bytes += content.byteLength;
          sent.set(file.relative, { size: content.byteLength, hash: digest(content) });
          yield { path: `${SANDBOX_WORKDIR}/${file.relative}`, bytes: content, mode: file.mode };
        } finally {
          await handle.close();
        }
      }
    } finally {
      await folders.close();
    }
  }
  await options.provider.putFiles(options.handle, read(), options.signal);
  return { files: files.length, directories: 0, bytes, sent };
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Remove files from the sandbox's `/work`; each path is a checked portable one under it. */
async function removeFromSandbox(options: SyncOptions, paths: string[]): Promise<void> {
  const outcome = await options.provider.exec(
    options.handle,
    {
      marker: recordId('act'),
      argv: ['rm', '-f', '--', ...paths],
      cwd: SANDBOX_WORKDIR,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
    },
    options.signal,
  );
  if (outcome.exitCode !== 0)
    throw new SyncRefusal('changed', "a paired computer's old screenshot could not be removed");
}

export type SyncOutOptions = SyncOptions & {
  /**
   * What the command's sync-in sent, and why a file may not be deleted here
   * (null when it may). Without it, nothing is deleted here, as before this
   * existed, and nothing is reported.
   */
  deletions?: {
    sent: ReadonlyMap<string, SentFile>;
    keep: (relative: string) => string | null;
    /** How many days the trash keeps them (`MELETE_TRASH_DAYS`). */
    trashDays?: number;
    /** The most the job's trash holds, in bytes (`MELETE_TRASH_MAX_MB`). */
    trashMaxBytes?: number;
  };
};

/**
 * Copy the sandbox's `/work` into `<workRoot>/<job_id>`. The workspace on this
 * machine is the record: a file the sandbox lost is deleted here only under
 * the rules at the top of this file, and every other one is reported as kept.
 */
export async function syncOut(options: SyncOutOptions): Promise<SyncOutReport> {
  const limits = { ...SYNC_LIMITS, ...options.limits };
  // The job id is checked before anything is listed or fetched.
  new LocalWorkspaceFs(options.workRoot).root(options.jobId);
  const listing = await options.provider.listFiles(options.handle, SANDBOX_WORKDIR, options.signal);
  const seen = new Set<string>();
  const stale: string[] = [];
  const directories: string[][] = [];
  const files: { relative: string; segments: string[]; size: number; mode: number }[] = [];
  let declared = 0;
  for (const entry of listing) {
    if (entry.symlink)
      throw new SyncRefusal(
        'symlink',
        `a symbolic link was refused: ${JSON.stringify(entry.path)}`,
      );
    const segments = portable(entry.path);
    if (segments.length === 0) throw new SyncRefusal('path', 'the listing named its own root');
    // Two names a Linux sandbox keeps apart can be one file on this machine.
    const key = segments.join('/').toLowerCase();
    if (seen.has(key))
      throw new SyncRefusal('duplicate', `a path was listed twice: ${JSON.stringify(entry.path)}`);
    seen.add(key);
    // Nor does one a sandbox still holds come back into the workspace; it is
    // removed from the sandbox below.
    if (!entry.directory && LEGACY_SCREEN_PATH.test(segments.join('/'))) {
      stale.push(`${SANDBOX_WORKDIR}/${segments.join('/')}`);
      continue;
    }
    if (entry.directory) {
      directories.push(segments);
      if (directories.length > limits.maxFiles)
        throw new SyncRefusal('too_many_files', 'the sandbox workspace has too many directories');
      continue;
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new SyncRefusal('not_regular', `an entry has no usable size: ${entry.path}`);
    if (entry.size > limits.maxFileBytes)
      throw new SyncRefusal('file_too_large', `a file above the per-file cap: ${entry.path}`);
    declared += entry.size;
    if (declared > limits.maxTotalBytes)
      throw new SyncRefusal('too_large', 'the sandbox workspace is above the total size cap');
    files.push({ relative: segments.join('/'), segments, size: entry.size, mode: entry.mode });
    if (files.length > limits.maxFiles)
      throw new SyncRefusal('too_many_files', 'the sandbox workspace has more files than the cap');
  }
  // Fetch everything before writing anything, so a file that changed or grew
  // refuses the synchronisation instead of leaving half of it behind.
  const fetched: { relative: string; bytes: Uint8Array; mode: number }[] = [];
  for (const file of files) {
    const bytes = await options.provider.getFile(
      options.handle,
      `${SANDBOX_WORKDIR}/${file.relative}`,
      limits.maxFileBytes + 1,
      options.signal,
    );
    if (bytes.byteLength !== file.size)
      throw new SyncRefusal(
        'changed',
        `a file changed while it was synchronised: ${file.relative}`,
      );
    fetched.push({ relative: file.relative, bytes, mode: file.mode });
  }
  if (stale.length) await removeFromSandbox(options, stale);
  const workspace = new LocalWorkspaceFs(options.workRoot);
  const jobDirectory = await workspace.jobDirectory(options.jobId, true);
  // Folders are made and held one at a time, each inside the one before it,
  // and each file is written into its held folder: in path order, every
  // folder is walked once.
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  directories.sort((a, b) => byPath(a.join('/'), b.join('/')));
  fetched.sort((a, b) => byPath(a.relative, b.relative));
  const folders = await workspace.folders(options.jobId, true);
  let bytes = 0;
  try {
    for (const segments of directories)
      await folders.at(segments).catch(notDirectory(segments.join('/')));
    for (const file of fetched) {
      options.signal.throwIfAborted();
      const segments = portable(file.relative);
      const folder = await folders
        .at(segments.slice(0, -1))
        .catch(notDirectory(segments.slice(0, -1).join('/')));
      await writeIn(
        folder,
        segments.at(-1) as string,
        path.join(jobDirectory, ...segments),
        file.relative,
        file.bytes,
        syncMode(file.mode),
      );
      bytes += file.bytes.byteLength;
    }
  } finally {
    await folders.close();
  }
  const hashes = new Map(fetched.map((file) => [file.relative, digest(file.bytes)]));
  const listed = new Set(files.map((file) => file.relative));
  const lost = [...(options.deletions?.sent.keys() ?? [])]
    .filter((relative) => !listed.has(relative))
    .sort();
  const outcome = options.deletions
    ? await deleteLost(options, lost, new Set(directories.map((segments) => segments.join('/'))))
    : { deleted: [], kept: [], trash_id: null, restorable_until: null };
  return { files: fetched.length, directories: directories.length, bytes, hashes, ...outcome };
}

/**
 * Move to the job's trash the files the command deleted in the sandbox, where
 * the rules allow, and then each folder that held one, if the sandbox no
 * longer has it and nothing else is left in it.
 */
async function deleteLost(
  options: SyncOutOptions,
  lost: string[],
  sandboxFolders: Set<string>,
): Promise<Pick<SyncOutReport, 'deleted' | 'kept' | 'trash_id' | 'restorable_until' | 'evicted'>> {
  const deletions = options.deletions;
  const kept: { path: string; reason: string }[] = [];
  const none = { deleted: [], kept, trash_id: null, restorable_until: null };
  if (!deletions || !lost.length) return none;
  const entries: { path: string; hash: string }[] = [];
  for (const relative of lost) {
    const reason = deletions.keep(relative);
    const sent = deletions.sent.get(relative);
    if (reason || !sent) kept.push({ path: relative, reason: reason ?? 'it was not sent' });
    else entries.push({ path: portable(relative).join('/'), hash: sent.hash });
  }
  if (!entries.length) return none;
  const folders = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let depth = segments.length - 1; depth > 0; depth -= 1) {
      const folder = segments.slice(0, depth).join('/');
      if (!sandboxFolders.has(folder)) folders.add(folder);
    }
  }
  const trashed = await moveToTrash(
    await new LocalWorkspaceFs(options.workRoot).trash(options.jobId),
    entries,
    {
      days: deletions.trashDays ?? DEFAULT_TRASH_DAYS,
      folders: [...folders],
      ...(deletions.trashMaxBytes ? { maxBytes: deletions.trashMaxBytes } : {}),
    },
  );
  // A folder that still holds a kept file is not news; a file kept is.
  kept.push(...trashed.kept.filter((entry) => !folders.has(entry.path)));
  return {
    deleted: trashed.moved,
    kept,
    trash_id: trashed.trash_id,
    restorable_until: trashed.trash_id ? trashed.restorable_until : null,
    evicted: trashed.evicted,
  };
}
