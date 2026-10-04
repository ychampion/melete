/**
 * Every place the service touches a job's workspace, `<MELETE_WORK_DIR>/<job_id>`.
 *
 * Cells mount a job's workspace at /work, and the service reads and writes the
 * same tree: the files connector, artifacts, stored command output, device
 * screenshots and sandbox synchronisation. Nothing outside this module joins
 * the workspace root with a job id, so a host that keeps workspaces somewhere
 * the service cannot see has one interface to implement.
 *
 * `LocalWorkspaceFs` is the workspace volume this service shares with its cells.
 */
import { randomBytes } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prefixedId } from '@melete/contracts';
import {
  type HeldDirectory,
  heldDirectories,
  holdBeneath,
  openBeneath,
  openedAt,
  openIn,
  pathCheck,
} from '../connectors/files.ts';
import type { TrashPlace } from '../connectors/files-trash.ts';
import { noLinks, removeConfined, segmentsFor } from '../paths.ts';

export interface WorkspaceFs {
  /**
   * The job's workspace directory on this host, as written under the root
   * (no link resolved), or null when this host does not hold it. `resolve`
   * is the one that checks every component.
   */
  root(job: string): string | null;
  /**
   * A path under the job's workspace on this host, every component checked and
   * no link followed; with `create`, missing parent directories are made.
   * Only for a host whose `root` is not null.
   */
  resolve(job: string, relative: string | string[], create: boolean): Promise<string>;
  /** One regular file, refusing links and anything above `maxBytes`. */
  read(job: string, relative: string, maxBytes: number): Promise<Buffer>;
  /** One regular file, written with mode 0o644 or 0o755 and never through a link. */
  write(job: string, relative: string, bytes: Uint8Array, mode: number): Promise<void>;
  /**
   * Removes the job's workspace and everything in it. Throws `PathHeld` when it
   * is still held open after the retries, running `beforeRetry` before each.
   */
  remove(job: string, beforeRetry?: () => Promise<void>): Promise<void>;
  /** Where the job's workspace still is, for a report, or null when it is gone. */
  remaining(job: string): Promise<string | null>;
  /** Brings the workspace up to date from the cell, for a host that does not share it. */
  syncFromCell?(job: string, signal: AbortSignal): Promise<void>;
}

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

/** Only the two modes a synchronised file may have. */
export const syncMode = (mode: number): 0o644 | 0o755 => ((mode & 0o111) !== 0 ? 0o755 : 0o644);

/** A relative path as segments, refused as a `SyncRefusal` when it could leave the workspace. */
export function portable(relative: string): string[] {
  try {
    return segmentsFor(relative);
  } catch (error) {
    throw new SyncRefusal(
      'path',
      `a path outside the job workspace was refused: ${JSON.stringify(relative)} (${(error as Error).message})`,
    );
  }
}

function checkJob(jobId: string): void {
  if (!/^job_[A-Za-z0-9]+$/.test(jobId)) throw new Error('invalid trusted job scope');
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Where deletes keep what they took, beside the job workspaces (connectors/files-trash.ts). */
export const TRASH_DIRECTORY = '.trash';

/** A spare's own workspace directory, until an attempt's job takes it over. */
export const SPARE_DIRECTORY = '.spare-';
/** Where a job's workspace is set aside while a spare's directory becomes it. */
export const ADOPTING = '.adopt-';

/** Whether the leftovers of the instance that labelled them (none: from before labels) may go. */
export type Removable = (owner: string | undefined) => Promise<boolean>;

/** Validate a service-owned job directory before handing any path to a runtime. */
export async function jobWorkspace(root: string, jobId: string): Promise<string> {
  prefixedId('job').parse(jobId);
  await mkdir(root, { recursive: true });
  const base = await realpath(root);
  const path = join(base, jobId);
  let created = false;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('A job workspace cannot be a link');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await mkdir(path, { mode: 0o770 });
    created = true;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error('The job workspace must be an ordinary directory under MELETE_WORK_DIR.');
  }
  // mkdir applies the service's umask. The runtime has a different UID and
  // needs the shared group's write bit on this newly created directory.
  if (created) await chmod(path, 0o770);
  return path;
}

/** Job workspaces in a directory on this host, shared with the cells that mount them. */
export class LocalWorkspaceFs implements WorkspaceFs {
  constructor(readonly workRoot: string) {}

  root(job: string): string {
    checkJob(job);
    return join(this.workRoot, job);
  }

  async resolve(job: string, relative: string | string[], create: boolean): Promise<string> {
    const base = await realpath(this.workRoot);
    checkJob(job);
    const segments = typeof relative === 'string' ? segmentsFor(relative) : relative;
    return noLinks(base, [job, ...segments], create);
  }

  /** The job's workspace directory, created if absent and never a link; returns the real root. */
  private async jobBase(jobId: string): Promise<string> {
    checkJob(jobId);
    const base = await realpath(this.workRoot);
    const target = join(base, jobId);
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

  /** The job's workspace directory, created if absent and never a link. */
  async prepare(jobId: string): Promise<string> {
    const base = await this.jobBase(jobId);
    return noLinks(base, [jobId], false);
  }

  /** A directory inside the job's workspace, created if absent and never a link. */
  async directory(jobId: string, segments: string[]): Promise<void> {
    const base = await this.jobBase(jobId);
    const target = await noLinks(base, [jobId, ...segments], true);
    try {
      await mkdir(target);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new SyncRefusal('not_regular', `not a directory: ${segments.join('/')}`);
  }

  /**
   * The job's own workspace directory on this host, as a base to walk from:
   * the real workspace root joined with the job id, made first when `create`
   * is set and never a link. Every open beneath it walks the names itself
   * (`holdBeneath`, `openBeneath`), so nothing done after this changes where
   * an open lands.
   */
  async jobDirectory(job: string, create = false): Promise<string> {
    checkJob(job);
    if (create) return join(await this.jobBase(job), job);
    return join(await realpath(this.workRoot), job);
  }

  /** Where a file of the job is: its workspace directory and the names under it. */
  async location(
    job: string,
    relative: string | string[],
    create = false,
  ): Promise<{ base: string; segments: string[] }> {
    const segments = typeof relative === 'string' ? portable(relative) : relative;
    return { base: await this.jobDirectory(job, create), segments };
  }

  /** Where a delete from the job's workspace keeps what it took, restorable. */
  async trash(job: string): Promise<TrashPlace> {
    checkJob(job);
    return {
      area: 'work',
      base: await realpath(this.workRoot),
      origin: [job],
      trash: [TRASH_DIRECTORY, job],
    };
  }

  /** The job's folders, each held while files in it are opened (`heldDirectories`). */
  async folders(job: string, create = false) {
    return heldDirectories(await this.jobDirectory(job, create), create);
  }

  /**
   * Write one file under `<workRoot>/<job_id>`. Its folder is walked and held,
   * so the file is created in it and nowhere else, never through a link, and
   * only into the one ordinary file at that name.
   */
  async write(jobId: string, relative: string, bytes: Uint8Array, mode: number): Promise<void> {
    await this.writeConfined(jobId, relative, bytes, syncMode(mode));
  }

  /** Like `write`, for a file the service keeps for itself: owner-only access. */
  async writePrivate(jobId: string, relative: string, bytes: Uint8Array): Promise<void> {
    await this.writeConfined(jobId, relative, bytes, 0o600);
  }

  private async writeConfined(
    jobId: string,
    relative: string,
    bytes: Uint8Array,
    mode: number,
  ): Promise<void> {
    const { base, segments } = await this.location(jobId, relative, true);
    const target = await pathCheck.noLinks(base, segments, false);
    const directory = await holdBeneath(base, segments.slice(0, -1), true);
    try {
      await writeIn(directory, segments.at(-1) as string, target, relative, bytes, mode);
    } finally {
      await directory.close();
    }
  }

  /** Read one file under `<workRoot>/<job_id>`, refusing links and anything above `maxBytes`. */
  async read(jobId: string, relative: string, maxBytes: number): Promise<Buffer> {
    const { base, segments } = await this.location(jobId, relative);
    await pathCheck.noLinks(base, segments, false);
    const file = await openBeneath(base, segments, constants.O_RDONLY);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new SyncRefusal('not_regular', `not a regular file: ${relative}`);
      if (stat.size > maxBytes) throw new SyncRefusal('file_too_large', `too large: ${relative}`);
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async remove(job: string, beforeRetry?: () => Promise<void>): Promise<void> {
    await removeConfined(this.workRoot, job, beforeRetry);
    // What the job deleted goes with it: its trash is beside the workspace.
    // `removeConfined` checks the name, as it does for the workspace itself.
    await removeConfined(join(this.workRoot, TRASH_DIRECTORY), job, beforeRetry);
  }

  async remaining(job: string): Promise<string | null> {
    const path = join(this.workRoot, job);
    try {
      await access(path, constants.F_OK);
      return path;
    } catch {
      return null;
    }
  }

  /**
   * Every path a held job workspace can be reported under: below the root as
   * written and below its real path.
   */
  workspacePaths(jobs: readonly string[]): Set<string> {
    const roots = new Set([resolve(this.workRoot)]);
    try {
      roots.add(realpathSync(this.workRoot));
    } catch {
      // A work root that does not exist holds no workspace; the written form is enough.
    }
    return new Set(jobs.flatMap((id) => [...roots].map((root) => join(root, id))));
  }

  // The directories engine containers mount: a job's own, a spare's, and a
  // job's set aside while a spare's directory becomes it.

  /** The workspace root, which must be a real directory. */
  private async cellRoot(): Promise<string> {
    const root = resolve(this.workRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (await realpath(root)) !== root)
      throw new Error('The workspace root must be a real directory');
    return root;
  }

  /** A directory directly under the workspace root, created for the runtime's group. */
  async cellDirectory(name: string): Promise<string> {
    const path = join(await this.cellRoot(), name);
    await mkdir(path, { mode: 0o2770 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error('Refusing a symlink or non-directory job workspace');
    await chmod(path, 0o2770);
    return path;
  }

  /** The job's workspace, as a directory an engine container can mount. */
  async cellWorkspace(jobId: string): Promise<void> {
    await this.cellDirectory(prefixedId('job').parse(jobId));
  }

  /**
   * Makes the spare's directory, which its container has mounted at /work, the
   * job's workspace, with what the job already had in it. Each step is a rename
   * on the one volume; a stop between them leaves the set-aside directory
   * `aside`, which the next start puts back (`reconcileCellDirectories`).
   */
  async adopt(directory: string, jobId: string, aside: string): Promise<void> {
    const root = await this.cellRoot();
    const spare = join(root, directory);
    const job = join(root, prefixedId('job').parse(jobId));
    const spareStat = await lstat(spare);
    if (!spareStat.isDirectory() || spareStat.isSymbolicLink())
      throw new Error("Refusing a spare workspace that is not the spare's own directory");
    const existing = await lstat(job).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!existing) {
      await rename(spare, job);
      return;
    }
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error('Refusing a symlink or non-directory job workspace');
    const asidePath = join(root, aside);
    await rename(job, asidePath);
    try {
      await rename(spare, job);
    } finally {
      // Whichever directory is the job's now, it ends with everything it had.
      await this.restoreSetAside(asidePath, job);
    }
  }

  /** Moves a set-aside workspace's entries back into the job's; the job's own win. */
  private async restoreSetAside(aside: string, job: string) {
    const exists = await lstat(job).catch(() => undefined);
    if (!exists) {
      await rename(aside, job);
      return;
    }
    if (!exists.isDirectory() || exists.isSymbolicLink())
      throw new Error('Refusing a symlink or non-directory job workspace');
    for (const entry of await readdir(aside)) {
      // Anything the spare wrote under the same name while it loaded gives way.
      await rm(join(job, entry), { recursive: true, force: true });
      await rename(join(aside, entry), join(job, entry));
    }
    await rmdir(aside);
  }

  /**
   * A job workspace set aside while a spare's directory became it is put back,
   * and a spare directory no attempt took is removed, when `removable` allows
   * the instance that left it. `claimant` names this instance in a claim.
   */
  async reconcileCellDirectories(removable: Removable, claimant: string): Promise<void> {
    // No workspace root yet means no attempt has ever left anything in it.
    if (!(await lstat(resolve(this.workRoot)).catch(() => undefined))) return;
    const root = await this.cellRoot();
    // `<prefix><instance>.<name>`, or `<prefix><name>` from before instances were
    // named; `<instance>~<claim>` is a set-aside that instance claimed to restore.
    const owner = (rest: string) => {
      const dot = rest.indexOf('.');
      return dot < 0
        ? { name: rest }
        : { instance: rest.slice(0, dot).split('~')[0], name: rest.slice(dot + 1) };
    };
    for (const entry of await readdir(root)) {
      if (entry.startsWith(ADOPTING)) {
        const found = owner(entry.slice(ADOPTING.length));
        if (!(await removable(found.instance))) continue;
        const jobId = prefixedId('job').parse(found.name);
        // Claimed by one atomic rename first: of two runners restoring the same
        // set-aside, the one that loses the rename (ENOENT on Linux, where the
        // service runs) leaves it to the other.
        const claimed = join(
          root,
          `${ADOPTING}${claimant}~${randomBytes(6).toString('hex')}.${jobId}`,
        );
        try {
          await rename(join(root, entry), claimed);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        await this.restoreSetAside(claimed, join(root, jobId));
      } else if (entry.startsWith(SPARE_DIRECTORY)) {
        if (!(await removable(owner(entry.slice(SPARE_DIRECTORY.length)).instance))) continue;
        const path = join(root, entry);
        const found = await lstat(path).catch((error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (found?.isDirectory()) await rm(path, { recursive: true, force: true });
      }
    }
  }

  /** A spare's own directory, unless it has already become a job's workspace. */
  async removeCellDirectory(directory: string): Promise<void> {
    const path = join(await this.cellRoot(), directory);
    const stat = await lstat(path).catch(() => undefined);
    if (stat?.isDirectory() && !stat.isSymbolicLink())
      await rm(path, { recursive: true, force: true });
  }
}

/**
 * Write `bytes` into the file `name` in a held directory: created there if
 * missing, never through a link, and only into the one ordinary file at that
 * name, checked on the opened file before a byte of it changes.
 */
export async function writeIn(
  directory: HeldDirectory,
  name: string,
  target: string,
  relative: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  // Non-blocking, so a pipe planted at the name fails the open instead of hanging it.
  const file = await openIn(directory, name, constants.O_WRONLY | constants.O_CREAT, mode);
  try {
    await checkWritable(file, directory, target).catch((error: unknown) => {
      throw new SyncRefusal('not_regular', `${(error as Error).message}: ${relative}`);
    });
    await file.truncate(0);
    await file.writeFile(bytes);
    await file.sync();
    // The open mode is filtered by the umask; set it on the open file, never by
    // path, which would follow a link swapped in after the write.
    await file.chmod(mode);
  } finally {
    await file.close();
  }
}

/**
 * The opened file is one ordinary file with one name. In a directory held by
 * descriptor that is all there is to check: the open could land nowhere else.
 * Named by path, the path is checked again (`openedAt`).
 */
async function checkWritable(
  file: FileHandle,
  directory: HeldDirectory,
  target: string,
): Promise<void> {
  if (!directory.pinned) return openedAt(file, target);
  const opened = await file.stat();
  if (!opened.isFile()) throw new Error('write target is not a regular file');
  if (opened.nlink !== 1) throw new Error('write target has more than one name');
}
