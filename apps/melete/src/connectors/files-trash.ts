/**
 * The trash a delete moves files into, so every delete can be undone.
 *
 * A delete never unlinks: each file is renamed into a trash folder on the
 * same filesystem, beside the tree it came from and outside everything that
 * tree is synced to or mounted in:
 *
 * - from a job's workspace: `<workRoot>/.trash/<job>/<trash id>/`
 * - from the person's Files, and a deleted skill: `<spacesRoot>/<space>/.trash/<job>/<trash id>/`
 *
 * Each trash folder holds the files as `items/<n>` and a `manifest.json` that
 * says where each came from and until when it is kept. The manifest is
 * written before the first file moves, naming every file the delete means to
 * take, and again once they have: a crash between leaves a trash that still
 * restores whatever reached it. Each job's trash holds at most
 * `MELETE_TRASH_MAX_MB`; a delete that would pass it first evicts the
 * oldest trash (expired first), and one larger than it alone is refused and
 * deletes nothing. A file is renamed
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
import { lstat, readdir, rename, rmdir } from 'node:fs/promises';
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
/** The most one job's trash holds, by default. */
export const DEFAULT_TRASH_MAX_BYTES = 1024 * 1024 * 1024;
const TRASH_ID = /^del_[0-9]{13}_[0-9a-f]{12}$/;
const MANIFEST = 'manifest.json';
const ITEMS = 'items';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Where an area's files are and where its trash is, as trusted roots and the names under them. */
export type TrashPlace = {
  area: 'work' | 'artifacts' | 'skills';
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
  area: 'work' | 'artifacts' | 'skills';
  created_at: string;
  expires_at: string;
  items: { path: string; item: string }[];
  /** Folders the delete removed, made again on restore. */
  folders: string[];
};

export type Trashed = {
  trash_id: string | null;
  /** Earlier deletes taken out of the trash to make room for this one. */
  evicted: string[];
  restorable_until: string;
  moved: string[];
  kept: { path: string; reason: string }[];
};

/** When a trash folder was made, from its id. */
const madeAt = (id: string) => Number(id.slice(4, 17));

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

/** What one job's trash holds now: each folder with its size and when it expires. */
async function trashUsage(place: TrashPlace) {
  const folders: { id: string; bytes: number; expires: number }[] = [];
  let held: HeldDirectory;
  try {
    held = await holdBeneath(place.base, place.trash);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return folders;
    throw error;
  }
  try {
    for (const id of await readdir(held.self)) {
      if (!TRASH_ID.test(id)) continue;
      const manifest = await readManifest(place, id).catch(() => null);
      let bytes = 0;
      const items = await holdBeneath(place.base, [...place.trash, id, ITEMS]).catch(() => null);
      if (items)
        try {
          for (const item of await readdir(items.self))
            bytes += (await lstat(items.at(item)).catch(() => null))?.size ?? 0;
        } finally {
          await items.close();
        }
      folders.push({
        id,
        bytes,
        expires: manifest ? Date.parse(manifest.expires_at) : madeAt(id),
      });
    }
  } finally {
    await held.close();
  }
  return folders;
}

const megabytes = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MB`;

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
  options: { days: number; folders?: readonly string[]; now?: Date; maxBytes?: number },
): Promise<Trashed> {
  const now = options.now ?? new Date();
  const expires = new Date(now.getTime() + options.days * DAY_MS).toISOString();
  const id = `del_${String(now.getTime()).padStart(13, '0')}_${randomBytes(6).toString('hex')}`;
  const moved: { path: string; item: string }[] = [];
  const kept: { path: string; reason: string }[] = [];
  const evicted: string[] = [];
  // Room first: what this delete would add, against what the trash may hold.
  const maxBytes = options.maxBytes ?? DEFAULT_TRASH_MAX_BYTES;
  let incoming = 0;
  const sizing = heldDirectories(place.base);
  try {
    for (const entry of entries) {
      const segments = segmentsFor(entry.path);
      const name = segments.at(-1);
      if (!name) continue;
      const folder = await sizing.at([...place.origin, ...segments.slice(0, -1)]).catch(() => null);
      incoming += folder ? ((await lstat(folder.at(name)).catch(() => null))?.size ?? 0) : 0;
    }
  } finally {
    await sizing.close();
  }
  if (incoming > maxBytes) {
    const reason = `the trash holds at most ${megabytes(maxBytes)} and this delete is ${megabytes(incoming)}, so nothing was deleted; delete it in smaller parts`;
    return {
      trash_id: null,
      evicted,
      restorable_until: expires,
      moved: [],
      kept: entries.map((entry) => ({ path: entry.path, reason })),
    };
  }
  const held = await trashUsage(place);
  let used = held.reduce((sum, folder) => sum + folder.bytes, 0);
  if (used + incoming > maxBytes) {
    const oldest = [...held].sort((a, b) => {
      const expiredA = a.expires <= now.getTime() ? 0 : 1;
      const expiredB = b.expires <= now.getTime() ? 0 : 1;
      return expiredA - expiredB || madeAt(a.id) - madeAt(b.id);
    });
    const job = await holdBeneath(place.base, place.trash);
    try {
      for (const folder of oldest) {
        if (used + incoming <= maxBytes) break;
        await removeIn(job, folder.id);
        used -= folder.bytes;
        evicted.push(folder.id);
      }
    } finally {
      await job.close();
    }
  }
  const trash = await holdBeneath(place.base, [...place.trash, id, ITEMS], true);
  const origin = heldDirectories(place.base);
  // Written before anything moves: a crash part way leaves a trash that
  // restores whatever reached it, rather than files no manifest names.
  const intent = await holdBeneath(place.base, [...place.trash, id]);
  try {
    await writeManifest(intent, {
      version: 1,
      area: place.area,
      created_at: now.toISOString(),
      expires_at: expires,
      items: entries.map((entry, index) => ({ path: entry.path, item: String(index) })),
      folders: [],
    });
  } finally {
    await intent.close();
  }
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
        return { trash_id: null, evicted, restorable_until: expires, moved: [], kept };
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
    return {
      trash_id: id,
      evicted,
      restorable_until: expires,
      moved: moved.map((m) => m.path),
      kept,
    };
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

/**
 * A trash folder's manifest when it was made by a delete from this place's
 * area. Files and skills share a space's trash, and neither restores the other's.
 */
async function manifestHere(place: TrashPlace, id: string): Promise<Manifest | null> {
  const manifest = await readManifest(place, id);
  return manifest && manifest.area === place.area ? manifest : null;
}

/** Whether this job's trash in this place holds `id`. */
export async function hasTrash(place: TrashPlace, id: string): Promise<boolean> {
  return (await manifestHere(place, id).catch(() => null)) !== null;
}

/**
 * The latest delete in this job's trash here, or the latest that took `path`
 * (or something beneath it), with when it was made; null when there is none.
 */
export async function latestTrash(
  place: TrashPlace,
  path?: string,
): Promise<{ id: string; made: number } | null> {
  let held: HeldDirectory;
  try {
    held = await holdBeneath(place.base, place.trash);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
  let ids: string[];
  try {
    ids = (await readdir(held.self)).filter((id) => TRASH_ID.test(id));
  } finally {
    await held.close();
  }
  const wanted = path === undefined ? null : segmentsFor(path).join('/');
  for (const id of ids.sort((a, b) => madeAt(b) - madeAt(a))) {
    const manifest = await manifestHere(place, id).catch(() => null);
    if (!manifest || Date.parse(manifest.expires_at) <= Date.now()) continue;
    if (
      wanted === null ||
      manifest.items.some((item) => item.path === wanted || item.path.startsWith(`${wanted}/`)) ||
      (manifest.folders ?? []).includes(wanted)
    )
      return { id, made: madeAt(id) };
  }
  return null;
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
  const manifest = await manifestHere(place, id);
  if (!manifest) throw new Error(`there is nothing in the trash under ${JSON.stringify(id)}`);
  if (Date.parse(manifest.expires_at) <= Date.now())
    throw new Error('the time to restore this has passed');
  const restored: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  const left: Manifest['items'] = [];
  const trash = await holdBeneath(place.base, [...place.trash, id, ITEMS]);
  try {
    for (const folder of manifest.folders ?? []) {
      // One folder that cannot be made again holds up no other file.
      try {
        const held = await holdBeneath(place.base, [...place.origin, ...segmentsFor(folder)], true);
        await held.close();
      } catch (error) {
        kept.push({
          path: folder,
          reason: `it could not be made again (${(error as Error).message})`,
        });
      }
    }
    for (const entry of manifest.items) {
      const segments = segmentsFor(entry.path);
      const name = segments.at(-1);
      if (!name || !/^[0-9]+$/.test(entry.item)) continue;
      // Named before it moved, and never reached the trash (a crash part way,
      // or put back because it changed): nothing to restore.
      if (!(await lstat(trash.at(entry.item)).catch(() => null))) continue;
      let parent: HeldDirectory;
      try {
        parent = await holdBeneath(place.base, [...place.origin, ...segments.slice(0, -1)], true);
      } catch (error) {
        left.push(entry);
        kept.push({
          path: entry.path,
          reason: `it could not be put back (${(error as Error).message})`,
        });
        continue;
      }
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
            if (!TRASH_ID.test(id)) continue;
            // Kept until the time its receipt promised, whatever the setting is now.
            const manifest = await readManifest(
              { area: 'work', base, origin: [], trash: [...trash, job] },
              id,
            ).catch(() => null);
            const until = manifest ? Date.parse(manifest.expires_at) : madeAt(id) + days * DAY_MS;
            if (now < until) continue;
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
