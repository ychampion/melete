/**
 * Where a paired computer's screenshots are kept: by the service, for the
 * service, and nowhere the agent can open them.
 *
 * A job's workspace (`<workRoot>/<job_id>`) is the agent's: its engine mounts
 * it, its sandbox gets a copy of it before every command, and its files tools
 * read it. A screenshot of the person's own screen does not belong there,
 * because a picture the person has not let cloud models see would then be
 * one `open()` away from becoming text the model reads. So each one is kept
 * in a directory beside the workspaces that only the service's own user can
 * enter, and leaves it in two ways only: to the person's own trail, and to the
 * model as a picture when that computer lets cloud models see its screen.
 */

import type { Dirent } from 'node:fs';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  holdBeneath,
  noLinks,
  openBeneath,
  openedAt,
  pathCheck,
  pinDirectory,
  READ_FLAGS,
} from '../connectors/files.ts';

/** Under the workspace root, beside the job directories; never mounted or synchronised. */
export const DEVICE_SCREENS_DIRECTORY = '.melete-device-screens';

import { LEGACY_SCREEN_PATH } from './screen-paths.ts';

export { LEGACY_SCREEN_PATH };

const JOB = /^job_[A-Za-z0-9]+$/;
const ACTION = /^act_[A-Za-z0-9]{1,64}$/;

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT';

function names(jobId: string, actionId: string): [string, string] {
  if (!JOB.test(jobId)) throw new Error('invalid trusted job scope');
  if (!ACTION.test(actionId)) throw new Error('invalid action id');
  return [jobId, `${actionId}.png`];
}

/** A directory only the service's user may enter, created when absent and never a link. */
async function privateDirectory(target: string): Promise<void> {
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('the screenshot store is not a plain directory');
  // The umask may have taken bits away; it never adds any, but an older
  // directory may carry more than this.
  await chmod(target, 0o700);
}

async function storeRoot(workRoot: string, create: boolean): Promise<string> {
  const base = await realpath(workRoot);
  const root = path.join(base, DEVICE_SCREENS_DIRECTORY);
  if (create) await privateDirectory(root);
  else if ((await lstat(root)).isSymbolicLink()) throw new Error('symbolic links are not allowed');
  return root;
}

/**
 * Keep one screenshot. The same action writing again replaces its own picture.
 * Written the way a confined workspace write is: in the directory that was
 * checked and held open, never through a link or a second name, and without
 * waiting on a pipe planted at the name.
 */
export async function saveDeviceScreen(
  workRoot: string,
  jobId: string,
  actionId: string,
  bytes: Uint8Array,
): Promise<void> {
  const [job, file] = names(jobId, actionId);
  const root = await storeRoot(workRoot, true);
  const folder = await noLinks(root, [job], false);
  await privateDirectory(folder);
  const target = await noLinks(root, [job, file], false);
  const directory = await pinDirectory(folder);
  try {
    const handle = await open(
      directory.at(file),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      await openedAt(handle, target);
      await handle.truncate(0);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  } finally {
    await directory.close();
  }
}

/** One kept screenshot, refusing links and anything above `maxBytes`. Throws when there is none. */
export async function readDeviceScreen(
  workRoot: string,
  jobId: string,
  actionId: string,
  maxBytes: number,
): Promise<Buffer> {
  const [job, file] = names(jobId, actionId);
  const root = await storeRoot(workRoot, false);
  await noLinks(root, [job, file], false);
  const handle = await openBeneath(root, [job, file], READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('not a kept screenshot');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The largest legacy file moved: a device's own cap is 8 MB. */
const MAX_LEGACY_BYTES = 16 * 1024 * 1024;

/**
 * Move the screenshots an earlier version kept in one job's workspace
 * (`<job>/device/screenshot-<action>.png`) into the store. Each is copied,
 * synced and then its name in the workspace removed, so a second name for the
 * same file, or a store on another filesystem, is handled the same way. Run
 * before every attempt of the job and, for every job, at start. Anything that
 * is not exactly such a file is left alone. Returns how many were moved.
 */
export async function moveJobScreens(workRoot: string, jobId: string): Promise<number> {
  if (!JOB.test(jobId)) throw new Error('invalid trusted job scope');
  let base: string;
  let folder: string;
  try {
    base = await realpath(workRoot);
    folder = path.join(base, jobId, 'device');
    const stat = await lstat(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 0;
    await pathCheck.noLinks(base, [jobId, 'device'], false);
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }
  // The folder is in the agent's workspace, which its commands can change at
  // any moment: it is walked and held, and each file read and removed in it.
  const held = await holdBeneath(base, [jobId, 'device']).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!held) return 0;
  let moved = 0;
  try {
    for (const name of await readdir(held.self)) {
      if (!LEGACY_SCREEN_PATH.test(`device/${name}`)) continue;
      const source = held.at(name);
      if (!(await lstat(source)).isFile()) continue;
      const handle = await open(source, READ_FLAGS);
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_LEGACY_BYTES) continue;
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      await saveDeviceScreen(
        workRoot,
        jobId,
        name.slice('screenshot-'.length, -'.png'.length),
        bytes,
      );
      await unlink(source);
      moved += 1;
    }
  } finally {
    await held.close();
  }
  // An emptied folder goes too, so the workspace looks as it would have.
  await rmdir(folder).catch(() => {});
  return moved;
}

/** `moveJobScreens` for every job under the workspace root. */
export async function moveWorkspaceScreens(workRoot: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(await realpath(workRoot), { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }
  let moved = 0;
  for (const entry of entries)
    if (entry.isDirectory() && JOB.test(entry.name))
      moved += await moveJobScreens(workRoot, entry.name);
  return moved;
}

/**
 * Keep moving them at start until every one is out, saying each time what
 * happened; a failure is tried again a minute later rather than left behind.
 */
export function moveWorkspaceScreensUntilDone(
  workRoot: string,
  report: (line: string) => void,
  retryMs = 60_000,
): Promise<void> {
  return new Promise((resolve) => {
    const attempt = () => {
      moveWorkspaceScreens(workRoot).then(
        (moved) => {
          if (moved) report(`moved ${moved} device screenshot(s) out of job workspaces`);
          resolve();
        },
        (error: unknown) => {
          report(
            `device screenshots were not moved out of job workspaces, trying again: ${error instanceof Error ? error.message : String(error)}`,
          );
          setTimeout(attempt, retryMs).unref?.();
        },
      );
    };
    attempt();
  });
}
