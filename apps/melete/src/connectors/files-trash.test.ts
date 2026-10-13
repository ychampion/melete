/**
 * A delete takes only the file it was decided on, and a delete is put back
 * once, however many ask at the same moment.
 */
import { afterAll, expect, spyOn, test } from 'bun:test';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as filesModule from './files.ts';
import { filesTrash, hasTrash, moveToTrash, restoreFromTrash } from './files-trash.ts';

const root = await realpath(await mkdtemp(join(tmpdir(), 'melete-files-trash-')));
const spaceId = 'sp_trashtest';
const files = join(root, spaceId, 'artifacts');
await mkdir(files, { recursive: true });
afterAll(() => rm(root, { recursive: true, force: true }));

const identity = async (path: string) => {
  const found = await stat(path);
  return { dev: found.dev, ino: found.ino };
};

test('a file swapped for a folder after the delete was decided stays, folder and all', async () => {
  const place = filesTrash(root, spaceId, 'job_swappedfolder');
  await writeFile(join(files, 'notes.txt'), 'notes\n');
  const decided = await identity(join(files, 'notes.txt'));
  // Between the check and the move, something puts a folder at that name.
  await rm(join(files, 'notes.txt'));
  await mkdir(join(files, 'notes.txt'));
  await writeFile(join(files, 'notes.txt', 'inside.md'), 'inside\n');
  const trashed = await moveToTrash(place, [{ path: 'notes.txt', hash: null, file: decided }], {
    days: 7,
  });
  expect(trashed.moved).toEqual([]);
  expect(trashed.trash_id).toBeNull();
  expect(trashed.kept[0]?.reason).toContain('changed after the delete was decided');
  expect((await stat(join(files, 'notes.txt'))).isDirectory()).toBe(true);
  expect(await readFile(join(files, 'notes.txt', 'inside.md'), 'utf8')).toBe('inside\n');
});

test('a file replaced by another file after the delete was decided stays', async () => {
  const place = filesTrash(root, spaceId, 'job_swappedfile');
  await writeFile(join(files, 'budget.csv'), 'old\n');
  const decided = await identity(join(files, 'budget.csv'));
  await writeFile(join(files, 'budget.csv.next'), 'new\n');
  await rename(join(files, 'budget.csv.next'), join(files, 'budget.csv'));
  const trashed = await moveToTrash(place, [{ path: 'budget.csv', hash: null, file: decided }], {
    days: 7,
  });
  expect(trashed.moved).toEqual([]);
  expect(await readFile(join(files, 'budget.csv'), 'utf8')).toBe('new\n');
});

test('the file the delete was decided on goes, and comes back', async () => {
  const place = filesTrash(root, spaceId, 'job_unchanged');
  await writeFile(join(files, 'letter.md'), 'letter\n');
  const decided = await identity(join(files, 'letter.md'));
  const trashed = await moveToTrash(place, [{ path: 'letter.md', hash: null, file: decided }], {
    days: 7,
  });
  expect(trashed.moved).toEqual(['letter.md']);
  expect(trashed.trash_id).not.toBeNull();
  await restoreFromTrash(place, trashed.trash_id as string);
  expect(await readFile(join(files, 'letter.md'), 'utf8')).toBe('letter\n');
});

test('three restores of one delete at once put it back once; the others find nothing', async () => {
  const place = filesTrash(root, spaceId, 'job_together');
  await mkdir(join(files, 'together'), { recursive: true });
  for (const name of ['a.md', 'b.md', 'c.md'])
    await writeFile(join(files, 'together', name), `${name}\n`);
  const trashed = await moveToTrash(
    place,
    ['a.md', 'b.md', 'c.md'].map((name) => ({ path: `together/${name}`, hash: null })),
    { days: 7 },
  );
  const id = trashed.trash_id as string;
  const outcomes = await Promise.allSettled([
    restoreFromTrash(place, id),
    restoreFromTrash(place, id),
    restoreFromTrash(place, id),
  ]);
  const done = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  expect(done.length).toBe(1);
  expect(done[0]?.status === 'fulfilled' && done[0].value.restored.length).toBe(3);
  expect(done[0]?.status === 'fulfilled' && done[0].value.kept).toEqual([]);
  for (const outcome of outcomes)
    if (outcome.status === 'rejected')
      expect(String(outcome.reason)).toContain('there is nothing in the trash');
  for (const name of ['a.md', 'b.md', 'c.md'])
    expect(await readFile(join(files, 'together', name), 'utf8')).toBe(`${name}\n`);
  expect(await readdir(join(root, spaceId, '.trash', 'job_together')).catch(() => [])).toEqual([]);
});

test('a delete that takes nothing takes no earlier delete out of a full trash', async () => {
  const place = filesTrash(root, spaceId, 'job_fulltrash');
  await writeFile(join(files, 'first.bin'), 'a'.repeat(600));
  const first = await moveToTrash(place, [{ path: 'first.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
    now: new Date(Date.now() - 60_000),
  });
  expect(first.trash_id).not.toBeNull();
  await writeFile(join(files, 'second.bin'), 'b'.repeat(600));
  const decided = await identity(join(files, 'second.bin'));
  // Rewritten after the delete was decided: this delete takes nothing.
  await writeFile(join(files, 'second.bin.next'), 'c'.repeat(600));
  await rename(join(files, 'second.bin.next'), join(files, 'second.bin'));
  const trashed = await moveToTrash(place, [{ path: 'second.bin', hash: null, file: decided }], {
    days: 7,
    maxBytes: 1000,
  });
  expect(trashed).toMatchObject({ trash_id: null, moved: [], evicted: [] });
  expect(await hasTrash(place, first.trash_id as string)).toBe(true);
  // A delete that does go makes the room it needs, and says what it took.
  await writeFile(join(files, 'third.bin'), 'd'.repeat(600));
  const third = await moveToTrash(place, [{ path: 'third.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
  });
  expect(third.moved).toEqual(['third.bin']);
  expect(third.evicted).toEqual([first.trash_id as string]);
  expect(await hasTrash(place, first.trash_id as string)).toBe(false);
  expect(await hasTrash(place, third.trash_id as string)).toBe(true);
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

test('a trash that cannot take its oldest delete out takes the next oldest instead', async () => {
  const place = filesTrash(root, spaceId, 'job_stucktrash');
  const made: string[] = [];
  for (const [index, name] of ['stuck.bin', 'older.bin', 'newer.bin'].entries()) {
    await writeFile(join(files, name), 'a'.repeat(300));
    const trashed = await moveToTrash(place, [{ path: name, hash: null }], {
      days: 7,
      maxBytes: 1000,
      now: minutesAgo(3 - index),
    });
    made.push(trashed.trash_id as string);
  }
  const [stuck, older, newer] = made as [string, string, string];
  const removeIn = filesModule.removeIn;
  const spy = spyOn(filesModule, 'removeIn').mockImplementation(async (directory, name) => {
    if (name === stuck)
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return removeIn(directory, name);
  });
  try {
    await writeFile(join(files, 'latest.bin'), 'b'.repeat(300));
    const latest = await moveToTrash(place, [{ path: 'latest.bin', hash: null }], {
      days: 7,
      maxBytes: 1000,
    });
    expect(latest.moved).toEqual(['latest.bin']);
    expect(latest.evicted).toEqual([older]);
  } finally {
    spy.mockRestore();
  }
  expect(await hasTrash(place, stuck)).toBe(true);
  expect(await hasTrash(place, older)).toBe(false);
  expect(await hasTrash(place, newer)).toBe(true);
});

test('a delete that went stays done when the trash cannot be trimmed after it', async () => {
  const place = filesTrash(root, spaceId, 'job_untrimmable');
  await writeFile(join(files, 'early.bin'), 'a'.repeat(600));
  const early = await moveToTrash(place, [{ path: 'early.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
    now: minutesAgo(1),
  });
  const holdBeneath = filesModule.holdBeneath;
  const spy = spyOn(filesModule, 'holdBeneath').mockImplementation(async (base, names, create) => {
    // The chat's trash itself can no longer be read.
    if (names.join('/') === place.trash.join('/'))
      throw Object.assign(new Error('input/output error'), { code: 'EIO' });
    return holdBeneath(base, names, create);
  });
  let late: Awaited<ReturnType<typeof moveToTrash>>;
  try {
    await writeFile(join(files, 'late.bin'), 'b'.repeat(600));
    late = await moveToTrash(place, [{ path: 'late.bin', hash: null }], {
      days: 7,
      maxBytes: 1000,
    });
  } finally {
    spy.mockRestore();
  }
  expect(late.moved).toEqual(['late.bin']);
  expect(late.evicted).toEqual([]);
  // Over its size until the earlier delete expires: both still restore.
  expect(await hasTrash(place, early.trash_id as string)).toBe(true);
  expect(await hasTrash(place, late.trash_id as string)).toBe(true);
});

test('a file that grew after the delete sized it is never taken out by its own delete', async () => {
  const place = filesTrash(root, spaceId, 'job_grew');
  await writeFile(join(files, 'before.bin'), 'a'.repeat(300));
  const before = await moveToTrash(place, [{ path: 'before.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
    now: minutesAgo(1),
  });
  await writeFile(join(files, 'growing.log'), 'b'.repeat(100));
  const holdBeneath = filesModule.holdBeneath;
  let grown = false;
  const spy = spyOn(filesModule, 'holdBeneath').mockImplementation(async (base, names, create) => {
    // Sized already: the file is written on past what the trash holds.
    if (create && !grown) {
      grown = true;
      await appendFile(join(files, 'growing.log'), 'c'.repeat(5000));
    }
    return holdBeneath(base, names, create);
  });
  let grew: Awaited<ReturnType<typeof moveToTrash>>;
  try {
    grew = await moveToTrash(place, [{ path: 'growing.log', hash: null }], {
      days: 7,
      maxBytes: 1000,
    });
  } finally {
    spy.mockRestore();
  }
  expect(grown).toBe(true);
  expect(grew.moved).toEqual(['growing.log']);
  expect(grew.evicted).toEqual([before.trash_id as string]);
  expect(await hasTrash(place, grew.trash_id as string)).toBe(true);
});

test('a full trash lets expired deletes go before older ones still kept', async () => {
  const place = filesTrash(root, spaceId, 'job_expiredfirst');
  await writeFile(join(files, 'kept.bin'), 'a'.repeat(400));
  const kept = await moveToTrash(place, [{ path: 'kept.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
    now: minutesAgo(3 * 24 * 60),
  });
  await writeFile(join(files, 'expired.bin'), 'b'.repeat(400));
  const expired = await moveToTrash(place, [{ path: 'expired.bin', hash: null }], {
    days: 1,
    maxBytes: 1000,
    now: minutesAgo(2 * 24 * 60),
  });
  await writeFile(join(files, 'now.bin'), 'c'.repeat(400));
  const latest = await moveToTrash(place, [{ path: 'now.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
  });
  expect(latest.evicted).toEqual([expired.trash_id as string]);
  expect(await hasTrash(place, kept.trash_id as string)).toBe(true);
});
