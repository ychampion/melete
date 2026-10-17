/**
 * MELETE_RETENTION_DAYS: model calls older than the setting go once their
 * days are rolled up, so per-day figures keep their history; connector events
 * no job owns go unless something holds them; a job's own events stay.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { usageSeries, utcDay } from '../../src/gateway/usage-day.ts';
import {
  applyRetention,
  pruneConnectorEvents,
  pruneModelUsage,
  RETENTION_MIN_DAYS,
  retentionCutoff,
} from '../../src/ops/retention.ts';
import { seedJob } from '../helpers/broker.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const DAY = 86_400_000;
const now = new Date('2026-10-17T15:00:00.000Z');
const daysAgo = (days: number, hour = 12) =>
  new Date(
    Date.parse(`${utcDay(new Date(now.getTime() - days * DAY))}T00:00:00.000Z`) + hour * 3_600_000,
  );

function db() {
  if (!handle) throw new Error('Postgres unavailable');
  return handle;
}

async function call(at: Date, personId: string, usd: number) {
  await db().sql`insert into model_usage (id, created_at, principal_id, space_id, purpose, provider,
      model, status, cost_usd, input_tokens, output_tokens)
    values (${randomUUID()}, ${at.toISOString()}::timestamptz, ${personId}, 'sp_fixture', 'agent',
      'fireworks', 'm', 'succeeded', ${usd}, 100, 10)`;
}

async function connectorEvent(
  at: Date,
  connectionId: string,
  name: string,
  jobId: string | null = null,
) {
  const [row] = await db().sql`insert into event (job_id, type, payload, dedup_key, created_at)
    values (${jobId}, 'notice', ${JSON.stringify({
      kind: 'connector_event',
      connection_id: connectionId,
      event_name: name,
    })}::text::jsonb, ${`connector:${connectionId}:${randomUUID()}`}, ${at.toISOString()}::timestamptz)
    returning seq, dedup_key`;
  return { seq: Number(row?.seq), dedupKey: String(row?.dedup_key) };
}

afterAll(async () => {
  await handle?.close();
});

describe('the retention setting', () => {
  test('cuts at the start of a UTC day and refuses fewer than 35 days', () => {
    expect(retentionCutoff(90, now).toISOString()).toBe('2026-07-19T00:00:00.000Z');
    expect(() => retentionCutoff(RETENTION_MIN_DAYS - 1, now)).toThrow();
    expect(() => retentionCutoff(40.5, now)).toThrow();
  });
});

withDb('retention of model calls and connector events', () => {
  beforeEach(async () => {
    await resetTestRows(db().sql);
    await db().sql`delete from model_usage`;
    await db().sql`delete from usage_day`;
    await db().sql`delete from observation_tombstone`;
  });

  test('old model calls go after their day is rolled up, and the per-day history stays', async () => {
    const person = 'own_retention';
    // Two calls 50 days back that were never rolled up, one 45 days back that
    // was, and two recent ones.
    await call(daysAgo(50, 3), person, 0.25);
    await call(daysAgo(50, 20), person, 0.5);
    await call(daysAgo(45), person, 1);
    await db().sql`insert into usage_day (day, principal_id, space_id, class, tier, purpose, calls,
        input_tokens, cached_input_tokens, cache_write_tokens, charged_input_tokens, output_tokens, cost_usd)
      values (${utcDay(daysAgo(45))}, ${person}, 'sp_fixture', 'interactive', 'interactive', 'agent',
        1, 100, 0, 0, 0, 10, 1)`;
    await call(daysAgo(39, 23), person, 2);
    await call(daysAgo(1), person, 3);

    const result = await applyRetention(db().sql, 40, now);
    expect(result.modelUsage).toBe(3);
    expect(result.rolledUp).toContain(utcDay(daysAgo(50)));
    // A day already rolled up is not written again from what is left of it.
    expect(result.rolledUp).not.toContain(utcDay(daysAgo(45)));

    const left = await db().sql`select cost_usd from model_usage order by created_at`;
    expect(left.map((row) => Number(row.cost_usd))).toEqual([2, 3]);
    const days = await db().sql`select day, calls, cost_usd from usage_day
      where day <= ${utcDay(daysAgo(45))} order by day`;
    expect(days.map((row) => [row.day, row.calls, Number(row.cost_usd)])).toEqual([
      [utcDay(daysAgo(50)), 2, 0.75],
      [utcDay(daysAgo(45)), 1, 1],
    ]);

    // The usage chart reads removed days from the roll-up.
    const series = await usageSeries(db().sql, person, now, 60);
    expect(series.find((point) => point.day === utcDay(daysAgo(50)))?.usd).toBe(0.75);
    expect(series.find((point) => point.day === utcDay(daysAgo(1)))?.usd).toBe(3);

    // A later pass finds nothing to do and leaves the roll-up as it is.
    const again = await applyRetention(db().sql, 40, now);
    expect(again.modelUsage).toBe(0);
    const [kept] = await db().sql`select calls from usage_day where day = ${utcDay(daysAgo(50))}`;
    expect(kept?.calls).toBe(2);
  });

  test('every day is rolled up before its calls go, whatever time zone the database keeps', async () => {
    const person = 'own_zoned';
    // A day before New York's clocks went forward, and two after it.
    await call(new Date('2026-03-01T12:00:00.000Z'), person, 1);
    await call(new Date('2026-03-10T12:00:00.000Z'), person, 2);
    await call(new Date('2026-03-12T00:30:00.000Z'), person, 4);
    const zoned = postgres(db().url, { max: 1, connection: { TimeZone: 'America/New_York' } });
    try {
      const result = await applyRetention(zoned, 40, now);
      expect(result.modelUsage).toBe(3);
    } finally {
      await zoned.end();
    }
    const days = await db().sql`select day, sum(calls)::int as calls,
        sum(cost_usd)::float8 as usd from usage_day where principal_id = ${person}
      group by day order by day`;
    expect(days.map((row) => [row.day, row.calls, Number(row.usd)])).toEqual([
      ['2026-03-01', 1, 1],
      ['2026-03-10', 1, 2],
      ['2026-03-12', 1, 4],
    ]);
  });

  test('a call another transaction holds is passed over, not waited for', async () => {
    for (let index = 0; index < 3; index++) await call(daysAgo(60, index), 'own_held', 0.1);
    const holder = await db().sql.reserve();
    try {
      await holder`begin`;
      await holder`select id from model_usage order by created_at limit 1 for update`;
      const started = Date.now();
      const pass = await pruneModelUsage(db().sql, retentionCutoff(40, now), now);
      expect(pass.removed).toBe(2);
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      await holder`rollback`;
      holder.release();
    }
    const next = await pruneModelUsage(db().sql, retentionCutoff(40, now), now);
    expect(next.removed).toBe(1);
  });

  test('a backlog goes a batch at a time, and a pass stops after its batches', async () => {
    for (let index = 0; index < 7; index++) await call(daysAgo(60, index), 'own_batch', 0.1);
    const cutoff = retentionCutoff(40, now);
    const first = await pruneModelUsage(db().sql, cutoff, now, { batch: 2, maxBatches: 2 });
    expect(first.removed).toBe(4);
    const second = await pruneModelUsage(db().sql, cutoff, now, { batch: 2, maxBatches: 10 });
    expect(second.removed).toBe(3);
    const [day] = await db().sql`select calls from usage_day where day = ${utcDay(daysAgo(60))}`;
    expect(day?.calls).toBe(7);
  });

  test('connector events no job owns go unless held; a job keeps its own', async () => {
    const { claims, connectionId } = await seedJob(db().sql);
    const old = daysAgo(50);
    const loose = await connectorEvent(old, connectionId, 'process.exited');
    const recent = await connectorEvent(daysAgo(10), connectionId, 'process.exited');
    const owned = await connectorEvent(old, connectionId, 'process.exited', claims.job_id);
    const listened = await connectorEvent(old, connectionId, 'webhook.received');
    // A trigger still listening for this name has not read past it yet.
    await db().sql`insert into trigger (id, job_id, kind, spec, cursor)
      values (${`trg_${randomUUID()}`}, ${claims.job_id}, 'event',
        ${JSON.stringify({ connection_id: connectionId, event_name: 'webhook.received' })}::text::jsonb,
        ${String(listened.seq - 1)})`;
    const cited = await connectorEvent(old, connectionId, 'process.exited');
    await db().sql`insert into event (job_id, type, payload, dedup_key, created_at)
      values (${claims.job_id}, 'notice', ${JSON.stringify({
        kind: 'trigger_event',
        // An empty citation beside a real one holds nothing else.
        because: [null, `event:${cited.seq}`],
      })}::text::jsonb, ${randomUUID()}, ${old.toISOString()}::timestamptz)`;

    const removed = await pruneConnectorEvents(db().sql, retentionCutoff(40, now));
    expect(removed).toBe(1);
    const left = await db().sql`select seq from event where seq = any(${[
      loose.seq,
      recent.seq,
      owned.seq,
      listened.seq,
      cited.seq,
    ]})`;
    expect(left.map((row) => Number(row.seq)).sort((a, b) => a - b)).toEqual(
      [recent.seq, owned.seq, listened.seq, cited.seq].sort((a, b) => a - b),
    );
    // The removed event's delivery key is kept, so it is not delivered twice.
    const [tombstone] = await db().sql`select 1 as found from observation_tombstone
      where dedup_key = ${loose.dedupKey}`;
    expect(tombstone?.found).toBe(1);
  });
});
