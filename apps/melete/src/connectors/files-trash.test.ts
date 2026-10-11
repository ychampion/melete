/**
 * A delete takes only the file it was decided on, and a delete is put back
 * once, however many ask at the same moment.
 */
import { afterAll, expect, test } from 'bun:test';
import {
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
