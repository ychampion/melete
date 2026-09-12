import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PgBoss } from 'pg-boss';
import { type AttemptWake, QUEUES } from '../../src/jobs/queue.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;

afterAll(async () => {
  await fixture?.close();
});

describe('isolated Postgres and durable queue', () => {
  databaseTest(
    'journal_driven_loading: every production migration is applied and recorded',
    async () => {
      if (!fixture) throw new Error('Postgres fixture unavailable');
      const [present] =
        await fixture.sql`select to_regclass('drizzle.__drizzle_migrations') as journal`;
      expect(present?.journal).not.toBeNull();
      const journal = JSON.parse(
        await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
      );
      const applied =
        await fixture.sql`select created_at from drizzle.__drizzle_migrations order by created_at`;
      expect(applied.map((row) => Number(row.created_at))).toEqual(
        journal.entries.map((entry: { when: number }) => entry.when),
      );
    },
  );

  databaseTest(
    'journal_driven_loading: renamed files follow journal dependency order',
    async () => {
      if (!fixture) throw new Error('Postgres fixture unavailable');
      const directory = await mkdtemp(join(tmpdir(), 'melete-journal-'));
      let custom: Awaited<ReturnType<typeof createPostgresFixture>> = null;
      try {
        await mkdir(join(directory, 'meta'));
        await writeFile(
          join(directory, 'meta', '_journal.json'),
          JSON.stringify({
            version: '7',
            dialect: 'postgresql',
            entries: [
              { idx: 0, version: '7', when: 100, tag: '0100_parent', breakpoints: true },
              { idx: 1, version: '7', when: 200, tag: '0001_child', breakpoints: true },
            ],
          }),
        );
        await writeFile(
          join(directory, '0100_parent.sql'),
          'create table journal_parent (id integer primary key); insert into journal_parent values (1);',
        );
        await writeFile(
          join(directory, '0001_child.sql'),
          'create table journal_child (parent integer references journal_parent(id)); insert into journal_child values (1);',
        );
        await writeFile(
          join(directory, '9999_unlisted.sql'),
          'select nonexistent_unlisted_function();',
        );
        custom = await createPostgresFixture({ migrationsFolder: directory });
        if (!custom) throw new Error('Postgres fixture unavailable');
        expect(new URL(custom.url).port).toBe(new URL(fixture.url).port);
        expect(new URL(custom.url).pathname).not.toBe(new URL(fixture.url).pathname);
        const [present] = await custom.sql`select to_regclass('public.journal_child') as child`;
        expect(present?.child).not.toBeNull();
        expect(
          (await custom.sql`select parent from journal_child`).map((row) => row.parent),
        ).toEqual([1]);
      } finally {
        await custom?.close();
        if (
          resolve(directory).startsWith(
            `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}melete-journal-`,
          )
        )
          await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
  databaseTest('runs the frozen migration on Postgres 17', async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const [version] = await fixture.sql`SHOW server_version_num`;
    if (fixture.mode === 'embedded') {
      expect(Number(version?.server_version_num)).toBeGreaterThanOrEqual(170000);
      expect(Number(version?.server_version_num)).toBeLessThan(180000);
    }
    const tables = await fixture.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('job', 'action', 'approval', 'budget_ledger')
      ORDER BY table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      'action',
      'approval',
      'budget_ledger',
      'job',
    ]);
  });

  databaseTest('pg-boss enqueues, fetches and completes a real attempt wake', async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const boss = new PgBoss({ connectionString: fixture.url, schema: 'pgboss', max: 2 });
    const errors: unknown[] = [];
    boss.on('error', (error) => errors.push(error));
    try {
      await boss.start();
      await boss.createQueue(QUEUES.attempt);
      const payload: AttemptWake = {
        job_id: 'fixture-job',
        expected_epoch: 1,
        expected_version: 1,
        reason: 'created',
      };
      const id = await boss.send(QUEUES.attempt, payload);
      expect(id).toBeString();
      if (!id) throw new Error('pg-boss did not persist the wake');
      const [wake] = await boss.fetch<AttemptWake>(QUEUES.attempt);
      expect(wake?.id).toBe(id);
      expect(wake?.data).toEqual(payload);
      await boss.complete(QUEUES.attempt, id);
      const [stored] = await fixture.sql`SELECT state FROM pgboss.job WHERE id = ${id}`;
      expect(stored?.state).toBe('completed');
      expect(errors).toEqual([]);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
