import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ItemFailures } from '../ops/item-failures.ts';
import { sweepTrash } from './files-trash.ts';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A trash folder from long ago, with no receipt: its id alone says when it was made. */
const OLD = 'del_1000000000000_0123456789ab';

async function roots() {
  const root = await mkdtemp(path.join(tmpdir(), 'melete-trash-sweep-'));
  made.push(root);
  const workRoot = path.join(root, 'work');
  const spacesRoot = path.join(root, 'spaces');
  await mkdir(workRoot, { recursive: true });
  await mkdir(spacesRoot, { recursive: true });
  return { root, workRoot, spacesRoot };
}

async function oldTrash(spacesRoot: string, space: string, job = 'job_01') {
  const folder = path.join(spacesRoot, space, '.trash', job, OLD);
  await mkdir(folder, { recursive: true });
  return folder;
}

test('a space whose trash cannot be swept never stops the sweep of the other spaces', async () => {
  const { root, workRoot, spacesRoot } = await roots();
  // A trash that is a link, and a job folder that is one: neither is opened.
  const elsewhere = path.join(root, 'elsewhere');
  await mkdir(elsewhere);
  await mkdir(path.join(spacesRoot, 'sp_linked'), { recursive: true });
  await symlink(elsewhere, path.join(spacesRoot, 'sp_linked', '.trash'));
  const beside = await oldTrash(spacesRoot, 'sp_mixed', 'job_02');
  await symlink(elsewhere, path.join(spacesRoot, 'sp_mixed', '.trash', 'job_01'));
  const others = await Promise.all(
    ['sp_a', 'sp_b', 'sp_y', 'sp_z'].map((space) => oldTrash(spacesRoot, space)),
  );
  const said: string[] = [];
  const failures = new ItemFailures('trash sweep', {
    firstMs: 3_600_000,
    maxMs: 3_600_000,
    say: (line) => said.push(line),
  });

  expect(await sweepTrash({ workRoot, spacesRoot }, 7, Date.now(), failures)).toBe(5);
  for (const folder of [beside, ...others]) expect(existsSync(folder)).toBe(false);
  expect(said.filter((line) => line.includes('sp_linked'))).toHaveLength(1);
  expect(said.filter((line) => line.includes('sp_mixed'))).toHaveLength(1);
  expect(existsSync(elsewhere)).toBe(true);

  // The next sweeps try them again, since what they hold was promised to go,
  // but the log hears of them only at the 2nd, 4th, 8th... failure.
  for (let pass = 2; pass <= 5; pass++)
    await sweepTrash({ workRoot, spacesRoot }, 7, Date.now(), failures);
  expect(said.filter((line) => line.includes('sp_linked'))).toHaveLength(3);
  expect(
    failures
      .stuck()
      .map((item) => item.id)
      .sort(),
  ).toEqual(['sp_linked', 'sp_mixed']);
});
