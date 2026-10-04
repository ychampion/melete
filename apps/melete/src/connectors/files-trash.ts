/**
 * The trash a delete moves files into, so every delete can be undone.
 *
 * A delete never unlinks: each file is renamed into a trash folder on the
 * same filesystem, beside the tree it came from and outside everything that
 * tree is synced to or mounted in:
 *
 * - from a job's workspace: `<workRoot>/.trash/<job>/<trash id>/`
 * - from the person's Files: `<spacesRoot>/<space>/.trash/<job>/<trash id>/`
 *
 * Each trash folder holds the files as `items/<n>` and a `manifest.json` that
 * says where each came from and until when it is kept. A file is renamed
 * first and checked after, in the trash, so nothing can change it between
 * the check and the delete; one that is not what was expected goes back to
 * its name. Restoring moves every file back to its own name, never over a
 * file that has taken that name since. The trash is swept after
 * `MELETE_TRASH_DAYS` (7 by default).
 *
 * Every open, rename and removal goes through held directories, as every
 * other file operation here does, so no name in a manifest or a path can
 * reach outside the roots.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { readdir, rename, rmdir } from 'node:fs/promises';
import { segmentsFor } from '../paths.ts';
import { TRASH_DIRECTORY } from '../runtime/workspace-fs.ts';
import {
  type HeldDirectory,
  heldDirectories,
  holdBeneath,
  holdWithin,
  moveWithoutReplacing,
  openBeneath,
  openIn,
  READ_FLAGS,
  removeIn,
} from './files.ts';

export { TRASH_DIRECTORY };
export const DEFAULT_TRASH_DAYS = 7;
const TRASH_ID = /^del_[0-9]{13}_[0-9a-f]{12}$/;
const MANIFEST = 'manifest.json';
const ITEMS = 'items';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Where an area's files are and where its trash is, as trusted roots and the names under them. */
export type TrashPlace = {
  area: 'work' | 'artifacts';
  /** The trusted root both trees are under. */
  base: string;
  /** The names from `base` to the area's own top (the job's workspace, the space's Files). */
  origin: string[];
  /** The names from `base` to this job's trash (`.trash/<job>`). */
  trash: string[];
};

/** A job workspace's own trash is given by `LocalWorkspaceFs.trash`. */
export const filesTrash = (base: string, spaceId: string, jobId: string): TrashPlace => ({
  area: 'artifacts',
  base,
  origin: [spaceId, 'artifacts'],
  trash: [spaceId, TRASH_DIRECTORY, jobId],
});

/** One file a delete takes: its path under the area, and the content it must have (null: any). */
export type TrashEntry = { path: string; hash: string | null };

type Manifest = {
  version: 1;
  area: 'work' | 'artifacts';
  created_at: string;
  expires_at: string;
  items: { path: string; item: string }[];
  /** Folders the delete removed, made again on restore. */
  folders: string[];
};

export type Trashed = {
  trash_id: string | null;
  restorable_until: string;
  moved: string[];
  kept: { path: string; reason: string }[];
};

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

/** The content hash of an entry in a held directory, never following a link; null for anything but a file. */
async function hashIn(directory: HeldDirectory, name: string): Promise<string | null> {
  const file = await openIn(directory, name, READ_FLAGS);
  try {
    const stat = await file.stat();
    return stat.isFile() ? digest(await file.readFile()) : null;
  } finally {
    await file.close();
  }
}

async function writeManifest(directory: HeldDirectory, manifest: Manifest) {
  const temporary = `${MANIFEST}.${randomBytes(4).toString('hex')}`;
  const file = await openIn(
    directory,
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(manifest));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(directory.at(temporary), directory.at(MANIFEST));
}

/**
 * Move `entries` into a new trash folder. Each is renamed first, then checked
 * there against the hash it must have; one that differs goes back to its
 * name and is kept, with the reason. `folders` are removed afterwards, deepest
 * first, only where empty: a folder that gained a file since is left, with
 * that file in it, and said so.
 */
export async function moveToTrash(
  place: TrashPlace,
  entries: readonly TrashEntry[],
  options: { days: number; folders?: readonly string[]; now?: Date },
): Promise<Trashed> {
  const now = options.now ?? new Date();
  const expires = new Date(now.getTime() + options.days * DAY_MS).toISOString();
  const id = `del_${String(now.getTime()).padStart(13, '0')}_${randomBytes(6).toString('hex')}`;
  const moved: { path: string; item: string }[] = [];
  const kept: { path: string; reason: string }[] = [];
  const trash = await holdBeneath(place.base, [...place.trash, id, ITEMS], true);
  const origin = heldDirectories(place.base);
  try {
    for (const [index, entry] of entries.entries()) {
      const segments = segmentsFor(entry.path);
      const name = segments.at(-1);
      if (!name) continue;
      const item = String(index);
      let from: HeldDirectory;
      try {
        from = await origin.at([...place.origin, ...segments.slice(0, -1)]);
        await rename(from.at(name), trash.at(item));
      } catch (error) {
        // Gone already: nothing to delete and nothing to put back.
        if (codeOf(error) === 'ENOENT') continue;
        kept.push({
          path: entry.path,
          reason: `it could not be moved (${(error as Error).message})`,
        });
        continue;
      }
      // Checked in the trash, where nothing else names it: what was approved,
      // or what the command's sync-in sent, is what goes.
      const there =
        entry.hash === null ? null : await hashIn(trash, item).catch(() => 'unreadable');
      if (entry.hash !== null && there !== entry.hash) {
        try {
          await moveWithoutReplacing(trash.at(item), from.at(name));
          kept.push({ path: entry.path, reason: 'it changed after the delete was decided' });
        } catch {
          moved.push({ path: entry.path, item });
          kept.push({
            path: entry.path,
            reason:
              'it changed after the delete was decided, and another file took its name; it is in the trash',
          });
        }
        continue;
      }
      moved.push({ path: entry.path, item });
    }
    const folders = [...(options.folders ?? [])].sort(
      (a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1),
    );
    const removed: string[] = [];
    for (const folder of folders) {
      const segments = segmentsFor(folder);
      try {
        const parent = await origin.at([...place.origin, ...segments.slice(0, -1)]);
        await rmdir(parent.at(segments.at(-1) as string));
        removed.push(folder);
      } catch (error) {
        if (codeOf(error) === 'ENOTEMPTY' || codeOf(error) === 'EEXIST')
          kept.push({
            path: folder,
            reason: 'something was added to it after the delete was decided',
          });
      }
    }
    await origin.close();
    const directory = await holdBeneath(place.base, [...place.trash, id]);
    try {
      if (!moved.length && !removed.length) {
        await removeIn(directory, ITEMS);
        await directory.close();
        const job = await holdBeneath(place.base, place.trash);
        try {
          await removeIn(job, id);
        } finally {
          await job.close();
        }
        return { trash_id: null, restorable_until: expires, moved: [], kept };
      }
      await writeManifest(directory, {
        version: 1,
        area: place.area,
        created_at: now.toISOString(),
        expires_at: expires,
        items: moved,
        folders: removed,
      });
    } finally {
      await directory.close();
    }
    return { trash_id: id, restorable_until: expires, moved: moved.map((m) => m.path), kept };
  } finally {
    await origin.close();
    await trash.close();
  }
}

async function readManifest(place: TrashPlace, id: string): Promise<Manifest | null> {
  if (!TRASH_ID.test(id)) return null;
  let file: Awaited<ReturnType<typeof openBeneath>>;
  try {
    file = await openBeneath(place.base, [...place.trash, id, MANIFEST], READ_FLAGS);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse((await file.readFile()).toString('utf8')) as Manifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
    return parsed;
  } finally {
    await file.close();
  }
}

/** Whether this job's trash in this place holds `id`. */
export async function hasTrash(place: TrashPlace, id: string): Promise<boolean> {
  return (await readManifest(place, id).catch(() => null)) !== null;
}

export type Restored = {
  restored: string[];
  kept: { path: string; reason: string }[];
};

/**
 * Put back everything a delete moved into the trash. A file goes back to its
 * own name only while that name is unused; one whose name was taken since
 * stays in the trash, with the reason, and can be restored again later.
 */
export async function restoreFromTrash(place: TrashPlace, id: string): Promise<Restored> {
  const manifest = await readManifest(place, id);
  if (!manifest) throw new Error(`there is nothing in the trash under ${JSON.stringify(id)}`);
  if (Date.parse(manifest.expires_at) <= Date.now())
    throw new Error('the time to restore this has passed');
  const restored: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  const left: Manifest['items'] = [];
  const trash = await holdBeneath(place.base, [...place.trash, id, ITEMS]);
  try {
    for (const folder of manifest.folders ?? []) {
      const held = await holdBeneath(place.base, [...place.origin, ...segmentsFor(folder)], true);
      await held.close();
    }
    for (const entry of manifest.items) {
      const segments = segmentsFor(entry.path);
      const name = segments.at(-1);
      if (!name || !/^[0-9]+$/.test(entry.item)) continue;
      const parent = await holdBeneath(
        place.base,
        [...place.origin, ...segments.slice(0, -1)],
        true,
      );
      try {
        await moveWithoutReplacing(trash.at(entry.item), parent.at(name));
        restored.push(entry.path);
      } catch (error) {
        left.push(entry);
        kept.push({
          path: entry.path,
          reason:
            (error as Error).message === 'move destination already exists'
              ? 'a file is at that path now; it stays in the trash'
              : `it could not be put back (${(error as Error).message})`,
        });
      } finally {
        await parent.close();
      }
    }
  } finally {
    await trash.close();
  }
  const directory = await holdBeneath(place.base, [...place.trash, id]);
  try {
    if (left.length) await writeManifest(directory, { ...manifest, items: left, folders: [] });
  } finally {
    await directory.close();
  }
  if (!left.length) {
    const job = await holdBeneath(place.base, place.trash);
    try {
      await removeIn(job, id);
    } finally {
      await job.close();
    }
  }
  return { restored, kept };
}

/** When a trash folder was made, from its id. */
const madeAt = (id: string) => Number(id.slice(4, 17));

/**
 * Remove every trash folder kept longer than `days`, in the work root and in
 * every space. Returns how many went. Anything that is not a trash folder is
 * left alone.
 */
export async function sweepTrash(
  roots: { workRoot: string; spacesRoot: string },
  days: number,
  now = Date.now(),
): Promise<number> {
  let swept = 0;
  const sweepJobs = async (base: string, trash: string[]) => {
    let held: HeldDirectory;
    try {
      held = await holdBeneath(base, trash);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return;
      throw error;
    }
    try {
      for (const job of await readdir(held.self)) {
        if (!/^job_[A-Za-z0-9]+$/.test(job)) continue;
        const folder = await holdWithin(held, job);
        try {
          for (const id of await readdir(folder.self)) {
            if (!TRASH_ID.test(id) || now - madeAt(id) < days * DAY_MS) continue;
            await removeIn(folder, id);
            swept += 1;
          }
          if (!(await readdir(folder.self)).length) await rmdir(held.at(job)).catch(() => {});
        } finally {
          await folder.close();
        }
      }
    } finally {
      await held.close();
    }
  };
  await sweepJobs(roots.workRoot, [TRASH_DIRECTORY]);
  let spaces: string[] = [];
  try {
    spaces = await readdir(roots.spacesRoot);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
  for (const space of spaces)
    if (/^sp_[A-Za-z0-9]+$/.test(space))
      await sweepJobs(roots.spacesRoot, [space, TRASH_DIRECTORY]);
  return swept;
}

/** Sweep the trash now and every hour; the returned function stops it. */
export function startTrashSweep(
  roots: { workRoot: string; spacesRoot: string },
  days: number,
  leads: () => boolean | Promise<boolean> = () => true,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  const sweep = () =>
    void Promise.resolve(leads())
      .then((leading) => (leading ? sweepTrash(roots, days) : undefined))
      .catch((error: unknown) =>
        say(`trash sweep failed: ${String((error as Error)?.message ?? error)}`),
      );
  sweep();
  const timer = setInterval(sweep, 60 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
