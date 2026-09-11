import { afterAll, describe, expect, test } from 'bun:test';
import { PgBoss } from 'pg-boss';
import { type AttemptWake, QUEUES } from '../../src/jobs/queue.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;

afterAll(async () => {
  await fixture?.close();
});

describe('isolated Postgres and durable queue', () => {
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
