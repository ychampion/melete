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
 */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { noLinks, segmentsFor } from '../connectors/files.ts';
import type { SandboxHandle, SandboxProvider } from './types.ts';

const MiB = 1024 * 1024;

export const SYNC_LIMITS = {
  maxFiles: 2_000,
  maxTotalBytes: 64 * MiB,
  maxFileBytes: 8 * MiB,
} as const;

export const SANDBOX_WORKDIR = '/work';

export type SyncRefusalCode =
  | 'symlink'
  | 'path'
  | 'not_regular'
  | 'too_many_files'
  | 'too_large'
  | 'file_too_large'
  | 'duplicate'
  | 'changed';

export class SyncRefusal extends Error {
  override readonly name = 'SyncRefusal';
  constructor(
    readonly code: SyncRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export type SyncReport = { files: number; directories: number; bytes: number };

type WorkspaceLimits = { maxFiles: number; maxTotalBytes: number; maxFileBytes: number };

/** Only the two modes a synchronised file may have. */
export const syncMode = (mode: number): 0o644 | 0o755 => ((mode & 0o111) !== 0 ? 0o755 : 0o644);

function checkJob(jobId: string): void {
  if (!/^job_[A-Za-z0-9]+$/.test(jobId)) throw new Error('invalid trusted job scope');
}

function portable(relative: string): string[] {
  try {
    return segmentsFor(relative);
  } catch (error) {
    throw new SyncRefusal(
      'path',
      `a path outside the job workspace was refused: ${JSON.stringify(relative)} (${(error as Error).message})`,
    );
  }
}

/** The job's workspace directory, created if absent and never a link. */
async function jobBase(workRoot: string, jobId: string): Promise<string> {
  checkJob(jobId);
  const base = await realpath(workRoot);
  const target = path.join(base, jobId);
  try {
    await mkdir(target);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new SyncRefusal('symlink', 'the job workspace is not a plain directory');
  return base;
}

async function ensureDirectory(base: string, segments: string[]): Promise<void> {
  const target = await noLinks(base, segments, true);
  try {
    await mkdir(target);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new SyncRefusal('not_regular', `not a directory: ${segments.slice(1).join('/')}`);
}

/**
 * Write one file under `<workRoot>/<job_id>`, re-resolving every component
 * first. The final open does not follow a link, so a link swapped in after
 * the check is an error rather than a write somewhere else.
 */
export async function writeWorkspaceFile(
  workRoot: string,
  jobId: string,
  relative: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  const base = await jobBase(workRoot, jobId);
  const target = await noLinks(base, [jobId, ...portable(relative)], true);
  const file = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    syncMode(mode),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new SyncRefusal('not_regular', `not a regular file: ${relative}`);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  // The open mode is filtered by the umask; the synchronised mode is not.
  await chmod(target, syncMode(mode));
}

/** Read one file under `<workRoot>/<job_id>`, refusing links and anything above `maxBytes`. */
export async function readWorkspaceFile(
  workRoot: string,
  jobId: string,
  relative: string,
  maxBytes: number,
): Promise<Buffer> {
  checkJob(jobId);
  const base = await realpath(workRoot);
  const target = await noLinks(base, [jobId, ...portable(relative)], false);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new SyncRefusal('not_regular', `not a regular file: ${relative}`);
    if (stat.size > maxBytes) throw new SyncRefusal('file_too_large', `too large: ${relative}`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}

type LocalFile = { relative: string; absolute: string; size: number; mode: 0o644 | 0o755 };

async function walkLocal(root: string, limits: WorkspaceLimits): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  let total = 0;
  const visit = async (directory: string, prefix: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      portable(relative);
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        throw new SyncRefusal('symlink', `a symbolic link was refused: ${relative}`);
      if (stat.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!stat.isFile())
        throw new SyncRefusal('not_regular', `not a regular file or directory: ${relative}`);
      if (stat.size > limits.maxFileBytes)
        throw new SyncRefusal('file_too_large', `a file above the per-file cap: ${relative}`);
      total += stat.size;
      if (total > limits.maxTotalBytes)
        throw new SyncRefusal('too_large', 'the workspace is above the total size cap');
      files.push({ relative, absolute, size: stat.size, mode: syncMode(stat.mode) });
      if (files.length > limits.maxFiles)
        throw new SyncRefusal('too_many_files', 'the workspace has more files than the cap');
    }
  };
  await visit(root, '');
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
export async function syncIn(options: SyncOptions): Promise<SyncReport> {
  const limits = { ...SYNC_LIMITS, ...options.limits };
  const base = await jobBase(options.workRoot, options.jobId);
  const root = await noLinks(base, [options.jobId], false);
  const files = await walkLocal(root, limits);
  let bytes = 0;
  async function* read() {
    for (const file of files) {
      const target = await noLinks(base, [options.jobId, ...portable(file.relative)], false);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== file.size)
          throw new SyncRefusal(
            'changed',
            `a file changed while it was synchronised: ${file.relative}`,
          );
        const content = await handle.readFile();
        bytes += content.byteLength;
        yield { path: `${SANDBOX_WORKDIR}/${file.relative}`, bytes: content, mode: file.mode };
      } finally {
        await handle.close();
      }
    }
  }
  await options.provider.putFiles(options.handle, read(), options.signal);
  return { files: files.length, directories: 0, bytes };
}

/**
 * Copy the sandbox's `/work` into `<workRoot>/<job_id>`. Files deleted in the
 * sandbox are not deleted here: the workspace on this machine is the record.
 */
export async function syncOut(options: SyncOptions): Promise<SyncReport> {
  const limits = { ...SYNC_LIMITS, ...options.limits };
  checkJob(options.jobId);
  const listing = await options.provider.listFiles(options.handle, SANDBOX_WORKDIR, options.signal);
  const seen = new Set<string>();
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
  const base = await jobBase(options.workRoot, options.jobId);
  directories.sort((a, b) => a.length - b.length);
  for (const segments of directories) await ensureDirectory(base, [options.jobId, ...segments]);
  let bytes = 0;
  for (const file of fetched) {
    options.signal.throwIfAborted();
    await writeWorkspaceFile(options.workRoot, options.jobId, file.relative, file.bytes, file.mode);
    bytes += file.bytes.byteLength;
  }
  return { files: fetched.length, directories: directories.length, bytes };
}
