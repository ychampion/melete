/**
 * A reply streamed quickly is recorded a few events at a time, each batch in
 * one transaction. What lands must be exactly what recording the events one
 * at a time would have left. Real Postgres.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { dedupKey, type RuntimeEvent } from '@melete/contracts';
import { asc, eq } from 'drizzle-orm';
import { onEventOrderHeld } from '../../src/db/lock-guard.ts';
import { attempt, event, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;

withDb('runtime events recorded together', () => {
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  const runner = () =>
    new AttemptRunner(required(jobs), new StubRuntimeAdapter(), {
      key: 'batch-test-capability-key-at-least-32-bytes',
    });

  async function claimed(name: string) {
    const spaceId = newId('sp');
    await required(handle)
      .db.insert(space)
      .values({ id: spaceId, name, gitPath: `/spaces/${spaceId}` });
    const row = await required(jobs).create({
      space_id: spaceId,
      title: name,
      objective: 'Answer.',
    });
    const one = runner();
    const claim = await one.claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'created',
    });
    if (!claim) throw new Error('Expected an admitted attempt');
    return { runner: one, claims: claim.claims };
  }

  /** A reply with a step, a result, a skipped place and an outcome. */
  function reply(attemptId: string, places: number[]): RuntimeEvent[] {
    const at = '2026-10-01T09:00:00.000Z';
    const base = (localSeq: number) => ({
      attempt_id: attemptId as RuntimeEvent['attempt_id'],
      local_seq: localSeq,
      dedup_key: dedupKey(attemptId, localSeq),
      at,
    });
    return places.map((place, index): RuntimeEvent => {
      if (index === 2)
        return {
          ...base(place),
          type: 'tool_call_proposed',
          tool: 'web.search',
          call_id: 'c1',
          arguments: { q: 'hours' },
        };
      if (index === 3)
        return { ...base(place), type: 'tool_result', call_id: 'c1', ok: true, result: { n: 1 } };
      if (index === places.length - 1)
        return {
          ...base(place),
          type: 'attempt_outcome',
          outcome: { kind: 'completed', summary: 'Done.', evidence: [] },
        } as RuntimeEvent;
      return { ...base(place), type: 'text_delta', text: `piece ${place} ` };
    });
  }

  /** What the attempt's runtime events left, after what claiming it wrote. */
  async function saved(attemptId: string) {
    const db = required(handle).db;
    const rows = (
      await db.select().from(event).where(eq(event.attemptId, attemptId)).orderBy(asc(event.seq))
    ).filter((row) => !['job_state_changed', 'attempt_started'].includes(row.type));
    const [execution] = await db.select().from(attempt).where(eq(attempt.id, attemptId));
    return {
      // Without the ids that differ between attempts.
      events: rows.map((row) => {
        const {
          attempt_id: _attempt,
          dedup_key: _key,
          ...payload
        } = row.payload as Record<string, unknown>;
        return { type: row.type, payload, key: row.dedupKey.split(':').slice(1).join(':') };
      }),
      seqs: rows.map((row) => row.seq),
      cursor: execution?.runtimeCursor,
    };
  }

  test('a batch leaves exactly what one at a time would, gaps included', async () => {
    const places = [0, 1, 2, 3, 5, 6, 7, 10, 11];
    const alone = await claimed('Alone');
    for (const value of reply(alone.claims.attempt_id, places))
      await alone.runner.emit(alone.claims, value);
    const together = await claimed('Together');
    let turns = 0;
    const stop = onEventOrderHeld(() => turns++);
    const results = await together.runner.emitMany(
      together.claims,
      reply(together.claims.attempt_id, places),
    );
    stop();
    // One turn of the event order for the whole batch.
    expect(turns).toBe(1);
    expect(results.every((result) => result === null)).toBe(true);
    const a = await saved(alone.claims.attempt_id);
    const b = await saved(together.claims.attempt_id);
    expect(b.events).toEqual(a.events);
    expect(b.cursor).toBe(11);
    expect(a.cursor).toBe(11);
    // One batch commits as one run of the event order.
    expect((b.seqs.at(-1) ?? 0) - (b.seqs[0] ?? 0)).toBe(b.seqs.length - 1);
  });

  test('a batch sent again adds nothing, and one overlapping it adds only what is new', async () => {
    const { runner: one, claims } = await claimed('Again');
    const events = reply(claims.attempt_id, [0, 1, 2, 3, 4, 5]);
    await one.emitMany(claims, events.slice(0, 4));
    const first = await saved(claims.attempt_id);
    expect(await one.emitMany(claims, events.slice(0, 4))).toEqual([null, null, null, null]);
    expect((await saved(claims.attempt_id)).events).toEqual(first.events);
    await one.emitMany(claims, events.slice(2));
    const after = await saved(claims.attempt_id);
    expect(after.events.map((row) => row.key)).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(after.cursor).toBe(5);
  });

  test('a bad event in a batch fails alone and the rest are kept, in order', async () => {
    const { runner: one, claims } = await claimed('Bad');
    const events = reply(claims.attempt_id, [0, 1, 2, 3, 4, 5]);
    await one.emit(claims, required(events[2]));
    // Place 1 now arrives after place 2: out of order, as it would be alone.
    const results = await one.emitMany(claims, [
      required(events[1]),
      required(events[3]),
      required(events[4]),
    ]);
    expect(results[0]).not.toBeNull();
    expect(String((results[0] as { error: unknown }).error)).toMatch(/out of order/);
    expect(results.slice(1)).toEqual([null, null]);
    const after = await saved(claims.attempt_id);
    expect(after.events.map((row) => row.key)).toEqual(['gap:stream:0:2', '2', '3', '4']);
    expect(after.cursor).toBe(4);
  });

  test('an attempt that is no longer current refuses the batch as it refuses each event', async () => {
    const { runner: one, claims } = await claimed('Fenced');
    const events = reply(claims.attempt_id, [0, 1, 2]);
    const stale = { ...claims, epoch: claims.epoch + 1 };
    const results = await one.emitMany(stale, events);
    expect(results.every((result) => result !== null)).toBe(true);
    const alone = await one.emit(stale, required(events[0])).then(
      () => null,
      (error: unknown) => String(error),
    );
    expect(String((results[0] as { error: unknown }).error)).toBe(alone ?? '');
    expect((await saved(claims.attempt_id)).events).toEqual([]);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Postgres unavailable');
  return value;
}
