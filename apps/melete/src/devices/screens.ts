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
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { noLinks, openedAt, pinDirectory, READ_FLAGS } from '../connectors/files.ts';

/** Under the workspace root, beside the job directories; never mounted or synchronised. */
export const DEVICE_SCREENS_DIRECTORY = '.melete-device-screens';

/** Where a workspace used to hold one, relative to the job's directory. */
export const LEGACY_SCREEN_PATH = /^device\/screenshot-act_[A-Za-z0-9]{1,64}\.png$/;

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
  const target = await noLinks(await storeRoot(workRoot, false), [job, file], false);
  const handle = await open(target, READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('not a kept screenshot');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Move the screenshots an earlier version kept in job workspaces
 * (`<job>/device/screenshot-<action>.png`) into the store. Run once at start,
 * before any attempt; anything that is not exactly such a file is left alone.
 * Returns how many were moved.
 */
export async function moveWorkspaceScreens(workRoot: string): Promise<number> {
  let base: string;
  try {
    base = await realpath(workRoot);
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }
  let moved = 0;
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB.test(entry.name)) continue;
    const folder = path.join(base, entry.name, 'device');
    let found: string[];
    try {
      const stat = await lstat(folder);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      found = await readdir(folder);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    for (const name of found) {
      const relative = `device/${name}`;
      if (!LEGACY_SCREEN_PATH.test(relative)) continue;
      const source = path.join(folder, name);
      const held = await lstat(source);
      if (!held.isFile() || held.nlink !== 1) continue;
      const actionId = name.slice('screenshot-'.length, -'.png'.length);
      const [job, file] = names(entry.name, actionId);
      const root = await storeRoot(workRoot, true);
      await privateDirectory(await noLinks(root, [job], false));
      // Same filesystem: the store is beside the workspaces it is moved from.
      const target = await noLinks(root, [job, file], false);
      await rename(source, target);
      await chmod(target, 0o600);
      moved += 1;
    }
    // An emptied folder goes too, so the workspace looks as it would have.
    await rmdir(folder).catch(() => {});
  }
  return moved;
}
