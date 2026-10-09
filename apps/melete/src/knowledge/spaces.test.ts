import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, initSpace, isGitRepo } from '@melete/knowledge';
import { testDatabase } from '../../test/helpers/database.ts';
import { space } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { databaseSpaces, filesystemSpaces, hasSymlink, spaceIdFor } from './spaces.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
let root = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'melete-catalog-spaces-'));
  if (handle) await handle.sql`truncate space cascade`;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(async () => handle?.close());

withDb('catalog knowledge spaces', () => {
  const catalog = () => {
    if (!handle) throw new Error('Postgres is unavailable');
    return databaseSpaces(handle.db, join(root, 'spaces'));
  };
  const insert = async (values: Partial<typeof space.$inferInsert> = {}) => {
    if (!handle) throw new Error('Postgres is unavailable');
    const id = newId('sp');
    const row = { id, name: 'Personal', gitPath: join(root, 'spaces', id), ...values };
    await handle.db.insert(space).values(row);
    return row;
  };

  test('initializes the catalog ID once and preserves it across resolver restarts', async () => {
    const row = await insert();
    const spaces = catalog();
    const refs = await Promise.all(Array.from({ length: 8 }, () => spaces.byId(row.id)));
    const ref = refs[0];
    if (!ref) throw new Error('The catalog space was not initialized');
    expect(ref?.id).toBe(row.id);
    expect(ref?.id).not.toBe(spaceIdFor(row.id));
    expect(ref?.name).toBe(row.id);
    expect(ref?.paths.root).toBe(row.gitPath);
    expect(isGitRepo(row.gitPath)).toBe(true);
    expect((await git(row.gitPath, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
    expect(await catalog().byId(row.id)).toEqual(ref);
    expect(await spaces.byName(row.id)).toEqual(ref);
    expect((await git(row.gitPath, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
  });

  test('never discovers an unlisted directory or accepts a display name as a path', async () => {
    const paths = await initSpace(join(root, 'spaces'), 'unlisted');
    const row = await insert();
    expect(await catalog().byId(spaceIdFor('unlisted'))).toBeNull();
    expect(await catalog().byName('Personal')).toBeNull();
    expect((await catalog().list()).map((ref) => ref.id)).toEqual([row.id]);
    expect((await filesystemSpaces(join(root, 'spaces')).byName('unlisted'))?.paths).toEqual(paths);
  });

  test('refuses corrupt catalog paths and spaces outside the owner audience', async () => {
    const outside = await insert({ gitPath: join(root, 'outside') });
    const traversal = await insert({ gitPath: join(root, 'spaces', '..', 'elsewhere') });
    const sibling = await insert({ gitPath: join(root, 'spaces', outside.id) });
    const otherAudience = await insert({ audience: 'unknown' });
    for (const row of [outside, traversal, sibling, otherAudience]) {
      expect(await catalog().byId(row.id)).toBeNull();
    }
    expect(await catalog().byId('../escape')).toBeNull();
    expect(existsSync(join(root, 'outside'))).toBe(false);
    expect(existsSync(join(root, 'elsewhere'))).toBe(false);
  });

  test('refuses live and dangling repository symlinks before initializing anything', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    mkdirSync(join(root, 'spaces'));
    const live = await insert();
    const dangling = await insert();
    symlinkSync(outside, live.gitPath);
    symlinkSync(join(root, 'missing'), dangling.gitPath);
    expect(await catalog().byId(live.id)).toBeNull();
    expect(await catalog().byId(dangling.id)).toBeNull();
    expect(isGitRepo(outside)).toBe(false);
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });

  test('refuses symlinked knowledge, index storage, and Git directory redirects', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    for (const path of ['knowledge', '.index', '.git']) {
      const row = await insert();
      mkdirSync(row.gitPath, { recursive: true });
      symlinkSync(outside, join(row.gitPath, path));
      expect(await catalog().byId(row.id)).toBeNull();
    }
    const gitFile = await insert();
    mkdirSync(gitFile.gitPath);
    writeFileSync(join(gitFile.gitPath, '.git'), `gitdir: ${outside}\n`);
    expect(await catalog().byId(gitFile.id)).toBeNull();
    expect(isGitRepo(outside)).toBe(false);
  });
});

// Permission bits keep the service out only on a POSIX filesystem, and never root.
const unreadable = process.platform !== 'win32' && process.getuid?.() !== 0;
describe('looking for links under a space', () => {
  const space = () => {
    const directory = join(root, 'space');
    mkdirSync(directory, { recursive: true });
    return directory;
  };
  const restore = (...paths: string[]) => {
    for (const path of paths) if (existsSync(path)) chmodSync(path, 0o700);
  };

  (unreadable ? test : test.skip)(
    "the worker's directory is passed over when it can be neither listed nor passed through",
    () => {
      const directory = space();
      const browser = join(directory, 'browser');
      mkdirSync(browser);
      symlinkSync(tmpdir(), join(browser, 'out'));
      chmodSync(browser, 0o000);
      try {
        expect(hasSymlink(directory)).toBe(false);
      } finally {
        restore(browser);
      }
    },
  );

  (unreadable ? test : test.skip)(
    'a directory that can be passed through but not listed hides nothing',
    () => {
      for (const name of ['browser', 'notes']) {
        const directory = space();
        const hidden = join(directory, name);
        mkdirSync(hidden);
        symlinkSync(tmpdir(), join(hidden, 'out'));
        chmodSync(hidden, 0o100);
        try {
          expect(hasSymlink(directory), name).toBe(true);
        } finally {
          restore(hidden);
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  );

  (unreadable ? test : test.skip)(
    'any other directory the service cannot read stops the check, and so does the space itself',
    () => {
      const directory = space();
      const other = join(directory, 'notes');
      const nested = join(directory, 'docs', 'browser');
      mkdirSync(other);
      mkdirSync(nested, { recursive: true });
      chmodSync(other, 0o000);
      try {
        expect(() => hasSymlink(directory)).toThrow();
        chmodSync(other, 0o700);
        // Only the space's own browser directory is the worker's.
        chmodSync(nested, 0o000);
        expect(() => hasSymlink(directory)).toThrow();
        chmodSync(nested, 0o700);
        chmodSync(directory, 0o000);
        expect(() => hasSymlink(directory)).toThrow();
      } finally {
        restore(directory, other, nested);
      }
    },
  );

  test('a link anywhere readable counts', () => {
    const directory = space();
    mkdirSync(join(directory, 'notes'));
    expect(hasSymlink(directory)).toBe(false);
    symlinkSync(tmpdir(), join(directory, 'notes', 'out'), 'junction');
    expect(hasSymlink(directory)).toBe(true);
  });
});
