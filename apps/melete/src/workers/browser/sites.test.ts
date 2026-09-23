import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { BrowserWorkers } from './routes.ts';
import { BrowserSiteService, confinedSpaceProfile } from './sites.ts';

const scratch = await mkdtemp(join(tmpdir(), 'melete-browser-sites-'));
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A directory the removal must never reach, holding a file that must survive. */
async function elsewhere(name: string) {
  const directory = join(scratch, name);
  await mkdir(join(directory, 'browser'), { recursive: true });
  await writeFile(join(directory, 'browser', 'keep.txt'), 'keep', 'utf8');
  return directory;
}

/** A directory link; a junction on Windows, which Node also reports as a link. */
const link = (target: string, path: string) =>
  symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => 'accepted',
    (error: Error) => error.message,
  );

function service(spacesRoot: string) {
  const released: string[] = [];
  // Only the delete of the space's rows reaches the database here.
  const sql = (async () => Object.assign([], { count: 0 })) as unknown as Sql;
  const workers = {
    get: async () => {
      throw new Error('no worker is started here');
    },
    release: async (spaceId: string) => {
      released.push(spaceId);
    },
    spacesRoot,
  } as unknown as BrowserWorkers;
  return { sites: new BrowserSiteService(sql, workers), released };
}

test("a space's browser profile is found where it sits, and nothing is created for it", async () => {
  const spaces = join(scratch, 'plain', 'spaces');
  await mkdir(join(spaces, 'sp_real', 'browser'), { recursive: true });
  expect(await confinedSpaceProfile(spaces, 'sp_real')).toBe(join(spaces, 'sp_real', 'browser'));
  expect(await confinedSpaceProfile(spaces, 'sp_absent')).toBe(
    join(spaces, 'sp_absent', 'browser'),
  );
  expect(await confinedSpaceProfile(join(scratch, 'no-root-yet'), 'sp_any')).toBe(
    join(scratch, 'no-root-yet', 'sp_any', 'browser'),
  );
});

test('a space directory or its browser directory planted as a link is refused', async () => {
  const spaces = join(scratch, 'linked', 'spaces');
  await mkdir(spaces, { recursive: true });
  const victim = await elsewhere('victim-space');
  await link(victim, join(spaces, 'sp_linked'));
  expect(await reason(confinedSpaceProfile(spaces, 'sp_linked'))).toBe('profile_symlink');

  const inner = await elsewhere('victim-profile');
  await mkdir(join(spaces, 'sp_inner'), { recursive: true });
  await link(join(inner, 'browser'), join(spaces, 'sp_inner', 'browser'));
  expect(await reason(confinedSpaceProfile(spaces, 'sp_inner'))).toBe('profile_symlink');

  // The spaces root itself behind a link is refused the same way.
  const realRoot = join(scratch, 'real-root');
  await mkdir(join(realRoot, 'sp_behind', 'browser'), { recursive: true });
  await link(realRoot, join(scratch, 'linked-root'));
  expect(await reason(confinedSpaceProfile(join(scratch, 'linked-root'), 'sp_behind'))).toBe(
    'profile_symlink',
  );

  // So is a link further up, above the spaces root, which a check of the root alone would miss.
  const realParent = join(scratch, 'real-parent');
  await mkdir(join(realParent, 'spaces', 'sp_under', 'browser'), { recursive: true });
  await link(realParent, join(scratch, 'linked-parent'));
  expect(
    await reason(confinedSpaceProfile(join(scratch, 'linked-parent', 'spaces'), 'sp_under')),
  ).toBe('profile_symlink');
});

test('forgetting a space whose directory is a link removes nothing behind the link', async () => {
  const spaces = join(scratch, 'forget', 'spaces');
  await mkdir(spaces, { recursive: true });
  const victim = await elsewhere('forget-victim');
  await link(victim, join(spaces, 'sp_link'));
  const { sites, released } = service(spaces);
  expect(await reason(sites.forgetSpace('sp_link'))).toBe('profile_symlink');
  expect(await Bun.file(join(victim, 'browser', 'keep.txt')).text()).toBe('keep');
  // Refused before the worker is stopped, as a malformed id already is.
  expect(released).toEqual([]);

  // An ordinary space is still forgotten: its worker stopped, its profile gone.
  await mkdir(join(spaces, 'sp_ordinary', 'browser'), { recursive: true });
  await writeFile(join(spaces, 'sp_ordinary', 'browser', 'Cookies'), 'c', 'utf8');
  expect(await sites.forgetSpace('sp_ordinary')).toEqual({
    space_id: 'sp_ordinary',
    profile: join(spaces, 'sp_ordinary', 'browser'),
    rows: 0,
  });
  expect(await Bun.file(join(spaces, 'sp_ordinary', 'browser', 'Cookies')).exists()).toBe(false);
  expect(released).toEqual(['sp_ordinary']);
});
