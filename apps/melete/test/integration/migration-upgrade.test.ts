/**
 * An upgrade between releases is the boot-time migration and nothing else: the
 * service takes the advisory lock, applies whatever the journal has that the
 * database does not, and is a no-op on every later boot. These tests start from
 * a database migrated with exactly the journal the v0.1.0 tag shipped.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { openDatabase } from '../../src/db/client.ts';
import { migrateDatabase } from '../../src/db/migrate.ts';
import { acquireTestServer } from '../helpers/database.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

type Released = {
  release: string;
  version: string;
  dialect: string;
  entries: { idx: number; when: number; tag: string; sha256: string }[];
};

const current = fileURLToPath(new URL('../../drizzle', import.meta.url));
const released = JSON.parse(
  await readFile(new URL('../fixtures/journal-v0.1.0.json', import.meta.url), 'utf8'),
) as Released;
const server = await acquireTestServer();
const databaseTest = server ? test : test.skip;
const folders: string[] = [];

afterAll(async () => {
  await server?.release();
  for (const folder of folders)
    if (resolve(folder).startsWith(resolve(tmpdir())))
      await rm(folder, { recursive: true, force: true });
});

/** A migrations folder holding the released journal, plus any later entries given. */
async function releasedFolder(later: { tag: string; when: number; sql: string }[] = []) {
  const folder = await mkdtemp(join(tmpdir(), 'melete-released-journal-'));
  folders.push(folder);
  await mkdir(join(folder, 'meta'));
  for (const entry of released.entries)
    await copyFile(join(current, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  for (const entry of later) await writeFile(join(folder, `${entry.tag}.sql`), entry.sql);
  const entries = [
    ...released.entries.map(({ idx, when, tag }) => ({ idx, when, tag })),
    ...later.map(({ tag, when }, index) => ({ idx: released.entries.length + index, when, tag })),
  ].map((entry) => ({ ...entry, version: released.version, breakpoints: true }));
  await writeFile(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: released.version, dialect: released.dialect, entries }),
  );
  return folder;
}

const recorded = (sql: ReturnType<typeof openDatabase>['sql']) =>
  sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`;

test('no migration released in v0.1.0 has been edited or reordered since', async () => {
  const journal = JSON.parse(await readFile(join(current, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  // The released entries are a prefix of the current journal: later releases append.
  expect(
    journal.entries.slice(0, released.entries.length).map(({ idx, when, tag }) => ({
      idx,
      when,
      tag,
    })),
  ).toEqual(released.entries.map(({ idx, when, tag }) => ({ idx, when, tag })));
  for (const entry of released.entries) {
    const bytes = await readFile(join(current, `${entry.tag}.sql`));
    // A database that already recorded this migration never runs an edited copy.
    expect(`${entry.tag} ${createHash('sha256').update(bytes).digest('hex')}`).toBe(
      `${entry.tag} ${entry.sha256}`,
    );
  }
});

databaseTest(
  'a database at the v0.1.0 journal upgrades to the current journal, and a second boot changes nothing',
  async () => {
    const fixture = await createPostgresFixture({ migrationsFolder: await releasedFolder() });
    if (!fixture) throw new Error('Postgres fixture unavailable');
    try {
      expect(await recorded(fixture.sql)).toHaveLength(released.entries.length);
      // A row written by the old release has to be there after the upgrade.
      await fixture.sql`insert into space (id, name, git_path)
        values ('spc_upgrade_probe', 'Kept across the upgrade', 'spaces/upgrade-probe')`;

      const expected = readMigrationFiles({ migrationsFolder: current });
      await migrateDatabase(fixture);
      const first = await recorded(fixture.sql);
      expect(first.map((row) => row.hash)).toEqual(expected.map((migration) => migration.hash));
      expect(first.map((row) => Number(row.created_at))).toEqual(
        expected.map((migration) => migration.folderMillis),
      );

      await migrateDatabase(fixture);
      expect(await recorded(fixture.sql)).toEqual(first);
      const kept = await fixture.sql`select name from space where id = 'spc_upgrade_probe'`;
      expect(kept.map((row) => row.name)).toEqual(['Kept across the upgrade']);
      // The lock is session-level; a boot that kept it would block the next one.
      const [lock] = await fixture.sql`select count(*)::int as held from pg_locks
        where locktype = 'advisory' and objid = 31003102`;
      expect(lock?.held).toBe(0);
    } finally {
      await fixture.close();
    }
  },
  120_000,
);

databaseTest(
  'two services booting at once apply a newer journal exactly once',
  async () => {
    const newer = await releasedFolder([
      {
        tag: '9000_upgrade_probe',
        when: Math.max(...released.entries.map((entry) => entry.when)) + 1,
        // Not idempotent on purpose, and slow enough that the second boot arrives
        // while the first is still inside it: without the lock that boot reads
        // the old journal state and fails on the second CREATE.
        sql: 'create table upgrade_probe (id integer primary key);\n--> statement-breakpoint\nselect pg_sleep(1);\n--> statement-breakpoint\ninsert into upgrade_probe values (1);',
      },
    ]);
    const fixture = await createPostgresFixture({ migrationsFolder: await releasedFolder() });
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const second = openDatabase(fixture.url, 2);
    try {
      await Promise.all([migrateDatabase(fixture, newer), migrateDatabase(second, newer)]);
      expect(await recorded(fixture.sql)).toHaveLength(released.entries.length + 1);
      expect((await fixture.sql`select id from upgrade_probe`).map((row) => row.id)).toEqual([1]);
      // A third boot, and a fourth, are no-ops.
      const before = await recorded(fixture.sql);
      await migrateDatabase(fixture, newer);
      await migrateDatabase(second, newer);
      expect(await recorded(fixture.sql)).toEqual(before);
    } finally {
      await second.close();
      await fixture.close();
    }
  },
  120_000,
);
