import { afterAll, expect, test } from 'bun:test';
import { createPostgresFixture } from './postgres.ts';

const [first, second] = await Promise.all([createPostgresFixture(), createPostgresFixture()]);
const databaseTest = first && second ? test : test.skip;

afterAll(async () => {
  await first?.close();
  await second?.close();
});

databaseTest(
  'shared server retains isolated databases, durable pg-boss, and independent cleanup',
  async () => {
    if (!first || !second) throw new Error('Postgres fixture unavailable');
    expect(new URL(first.url).host).toBe(new URL(second.url).host);
    expect(new URL(first.url).pathname).not.toBe(new URL(second.url).pathname);
    const [queue] = await first.sql`select count(*)::int as jobs from pgboss.job`;
    expect(queue?.jobs).toBe(0);
    const [settings] = await first.sql`
      select current_setting('fsync') as fsync,
        current_setting('full_page_writes') as full_page_writes,
        current_setting('synchronous_commit') as synchronous_commit`;
    if (first.mode === 'embedded') {
      expect(settings).toEqual({ fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on' });
    }
    await first.sql`create table fixture_isolation_probe (value text not null)`;
    await first.sql`insert into fixture_isolation_probe values ('first fixture only')`;
    const [other] = await second.sql`select to_regclass('public.fixture_isolation_probe') as probe`;
    expect(other?.probe).toBeNull();
    const name = new URL(first.url).pathname.slice(1);
    await Promise.all([first.close(), first.close()]);
    const [remaining] = await second.sql`
      select count(*)::int as count from pg_database where datname = ${name}`;
    expect(remaining?.count).toBe(0);
    const [alive] = await second.sql`select 1 as alive`;
    expect(alive?.alive).toBe(1);
  },
  15_000,
);
