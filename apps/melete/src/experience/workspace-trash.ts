/**
 * What happens to a deleted conversation's workspace.
 *
 * A chat's workspace (`<work root>/<job>`) is the agent's own: what it wrote,
 * downloaded and ran while working. When the chat is deleted the workspace
 * goes with it, into the chat's trash beside the other files it deleted
 * (`<work root>/.trash/<job>/<trash id>/`), where it can still be restored for
 * `MELETE_TRASH_DAYS`. The trash sweep takes it after that, as it takes any
 * delete. Files the chat saved to the person's own Files stay theirs.
 *
 * The pages the browser captured while working in a chat (each page's text
 * and its picture, under the space's `artifacts/browser/`) are the chat's
 * too: they are deleted with it, for good, since they show what was on the
 * screen, an inbox or a bank page, and mean nothing without the chat.
 *
 * Chats deleted with an earlier version left their workspaces and captured
 * pages behind, with nothing that could reach them. At start, each workspace
 * whose job is gone goes to the trash the same way, each captured page whose
 * chat is gone is deleted, and a recorded file that pointed into a removed
 * workspace stops being listed.
 */
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { moveToTrash } from '../connectors/files-trash.ts';
import { segmentsFor } from '../paths.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';

/**
 * Where job workspaces are, and how long a deleted one is kept restorable.
 * With the spaces' folder, a deleted chat's captured pages are deleted too.
 */
export type WorkspaceTrash = { workRoot: string; days: number; spacesRoot?: string };

/** The path the browser gives a captured page, relative to the space's `artifacts/`. */
export const CAPTURED_PAGE = '^browser/art_[A-Za-z0-9_-]+[.](txt|png)$';
const capturedPage = new RegExp(CAPTURED_PAGE);
const SPACE = /^sp_[A-Za-z0-9_-]+$/;

const JOB = /^job_[A-Za-z0-9]+$/;
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

/** A name that can stand alone as a path in the workspace. */
function portableName(name: string): boolean {
  try {
    return segmentsFor(name).length === 1;
  } catch {
    return false;
  }
}

/**
 * Move a deleted job's whole workspace into its trash, restorable for the
 * trash period. Anything that cannot be moved (a name no path may carry, a
 * file still held open) is removed for good, so nothing of the chat is left
 * where no one can reach it. Answers the trash id, or null when there was
 * nothing to keep.
 */
export async function trashWorkspace(trash: WorkspaceTrash, jobId: string): Promise<string | null> {
  if (!JOB.test(jobId)) throw new Error('not a job workspace');
  const workspaces = new LocalWorkspaceFs(trash.workRoot);
  // No work folder on this host: no job has a workspace here to keep.
  const directory = await workspaces.jobDirectory(jobId).catch((error: unknown) => {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  });
  if (!directory) return null;
  const stat = await lstat(directory).catch((error: unknown) => {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  // A link or a file where a workspace belongs is never followed; it is only removed.
  let id: string | null = null;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const names = (await readdir(directory)).filter(portableName);
    if (names.length) {
      const moved = await moveToTrash(
        await workspaces.trash(jobId),
        names.map((path) => ({ path, hash: null })),
        // A deleted chat's files always go: no size limit holds the deletion up.
        { days: trash.days, maxBytes: Number.POSITIVE_INFINITY },
      );
      id = moved.trash_id;
    }
  }
  await workspaces.removeWorkspace(jobId);
  return id;
}

/**
 * Delete the files of captured pages whose records are gone. Only a file
 * under the space's own `artifacts/browser/` is touched, never through a
 * link; one that is already gone is fine. Answers how many files went.
 */
export async function removeCapturedPages(
  spacesRoot: string,
  pages: readonly { space_id: unknown; path: unknown }[],
): Promise<number> {
  let removed = 0;
  let root: string;
  try {
    root = await realpath(spacesRoot);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return 0;
    throw error;
  }
  for (const page of pages) {
    const spaceId = String(page.space_id);
    const path = String(page.path);
    if (!SPACE.test(spaceId) || !capturedPage.test(path)) continue;
    const folder = join(root, spaceId, 'artifacts', 'browser');
    const real = await realpath(folder).catch(() => null);
    if (real !== folder) continue;
    const file = join(folder, path.slice('browser/'.length));
    const stat = await lstat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    await rm(file, { force: true });
    removed += 1;
  }
  return removed;
}

/** A capture file younger than this may still be waiting for its record. */
const CAPTURE_SETTLE_MS = 60 * 60 * 1000;

/**
 * Captured pages of chats that are gone: their records, which then name no
 * chat, and their files; then any capture file that no record names, once
 * it is an hour old, such as one a deletion could not remove at the time.
 * Answers how many pages went.
 */
export async function removeOrphanedCaptures(
  sql: Sql,
  spacesRoot: string,
  now = Date.now(),
): Promise<number> {
  const pages = await sql<
    { id: string; space_id: string; path: string }[]
  >`select id, space_id, path from artifact
    where job_id is null and source_job_id is null and area = 'work' and path ~ ${CAPTURED_PAGE}`;
  let removed = 0;
  if (pages.length) {
    await removeCapturedPages(spacesRoot, pages);
    const gone = await sql`delete from artifact
      where id = any(${pages.map((page) => String(page.id))}) and job_id is null`;
    removed += gone.count;
  }
  const spaces = await readdir(spacesRoot).catch(() => [] as string[]);
  for (const spaceId of spaces.filter((name) => SPACE.test(name))) {
    const names = await readdir(join(spacesRoot, spaceId, 'artifacts', 'browser')).catch(
      () => [] as string[],
    );
    const paths = names.map((name) => `browser/${name}`).filter((path) => capturedPage.test(path));
    if (!paths.length) continue;
    const named = new Set(
      (
        await sql`select path from artifact where space_id = ${spaceId} and path = any(${paths})`
      ).map((row) => String(row.path)),
    );
    const stray: { space_id: string; path: string }[] = [];
    for (const path of paths) {
      if (named.has(path)) continue;
      const stat = await lstat(join(spacesRoot, spaceId, 'artifacts', path)).catch(() => null);
      if (stat && now - stat.mtimeMs > CAPTURE_SETTLE_MS) stray.push({ space_id: spaceId, path });
    }
    removed += await removeCapturedPages(spacesRoot, stray);
  }
  return removed;
}

/**
 * Workspaces of jobs that no longer exist, moved to the trash, and recorded
 * files that pointed into them no longer listed. Run once at start; a
 * workspace that cannot go yet is tried again at the next. Answers how many
 * workspaces went.
 */
export async function trashOrphanedWorkspaces(
  sql: Sql,
  roots: WorkspaceTrash & { spacesRoot: string },
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(roots.workRoot)).filter((name) => JOB.test(name));
  } catch (error) {
    if (codeOf(error) === 'ENOENT') names = [];
    else throw error;
  }
  let moved = 0;
  if (names.length) {
    const live = new Set(
      (await sql`select id from job where id = any(${names})`).map((row) => String(row.id)),
    );
    for (const name of names) {
      if (live.has(name)) continue;
      try {
        await trashWorkspace(roots, name);
        moved += 1;
      } catch (error) {
        log(
          `the workspace of the deleted chat ${name} could not be moved to the trash yet: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    if (moved)
      log(`moved ${moved} workspace${moved === 1 ? '' : 's'} of deleted chats to the trash`);
  }
  const captures = await removeOrphanedCaptures(sql, roots.spacesRoot);
  if (captures)
    log(`deleted ${captures} page capture${captures === 1 ? '' : 's'} of deleted chats`);
  const unlisted = await forgetMissingSpaceFiles(sql, roots.spacesRoot);
  if (unlisted)
    log(`stopped listing ${unlisted} saved file${unlisted === 1 ? '' : 's'} of deleted chats`);
  return moved;
}

/**
 * Records of files a deleted chat made in its own workspace. Before deleting
 * a chat took them with it, such a record was kept with no job, which reads as
 * a file in the space's folder; where that folder has no such file, the record
 * names nothing and is taken out. A space whose folder is not there at all is
 * left alone, so a volume that is not mounted never empties the list.
 */
async function forgetMissingSpaceFiles(sql: Sql, spacesRoot: string): Promise<number> {
  const rows = await sql`select id, space_id, path from artifact
    where job_id is null and source_job_id is null and area = 'work'`;
  let removed = 0;
  for (const row of rows) {
    const spaceId = String(row.space_id);
    if (!/^sp_[A-Za-z0-9]+$/.test(spaceId)) continue;
    let segments: string[];
    try {
      segments = segmentsFor(String(row.path).replace(/^artifacts\//, ''));
    } catch {
      continue;
    }
    if (!segments.length) continue;
    const folder = join(spacesRoot, spaceId, 'artifacts');
    if (!(await lstat(folder).catch(() => null))?.isDirectory()) continue;
    const there = await lstat(join(folder, ...segments)).then(
      () => true,
      (error: unknown) => codeOf(error) !== 'ENOENT',
    );
    if (there) continue;
    await sql`delete from artifact where id = ${row.id} and job_id is null`;
    removed += 1;
  }
  return removed;
}
