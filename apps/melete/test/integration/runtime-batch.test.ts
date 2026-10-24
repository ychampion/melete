/**
 * A reply streamed quickly is recorded a few events at a time, each batch in
 * one transaction. What lands must be exactly what recording the events one
 * at a time would have left. Real Postgres.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { dedupKey, type ExperienceEvent, type RuntimeEvent } from '@melete/contracts';
import { asc, eq } from 'drizzle-orm';
import { guardPoolWait, holdingEventOrder, onEventOrderHeld } from '../../src/db/lock-guard.ts';
import { attempt, event, experienceTurn, principal, space } from '../../src/db/schema.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { ExperienceService } from '../../src/experience/service.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { principalContext, requestPrincipal } from '../../src/principals/authority.ts';
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

  async function claimed(name: string, one = runner(), principalId?: string) {
    const spaceId = newId('sp');
    if (principalId)
      await required(handle)
        .db.insert(principal)
        .values({ id: principalId, email: `${principalId}@example.test` });
    await required(handle)
      .db.insert(space)
      .values({ id: spaceId, name, gitPath: `/spaces/${spaceId}`, ownerPrincipalId: principalId });
    const create = async () => {
      const row = await required(jobs).create({
        space_id: spaceId,
        title: name,
        objective: 'Answer.',
      });
      const claim = await one.claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'created',
      });
      if (!claim) throw new Error('Expected an admitted attempt');
      return { runner: one, claims: claim.claims };
    };
    return principalId ? principalContext.run(principalId, create) : create();
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

  test('two attempts share one event-order acquisition and retain independent durable cursors', async () => {
    const one = runner();
    const first = await claimed('First concurrent attempt', one);
    const second = await claimed('Second concurrent attempt', one);
    let turns = 0;
    const stop = onEventOrderHeld(() => turns++);
    try {
      await Promise.all([
        one.emit(first.claims, required(reply(first.claims.attempt_id, [0, 1])[0])),
        one.emit(second.claims, required(reply(second.claims.attempt_id, [0, 1])[0])),
      ]);
    } finally {
      stop();
    }
    expect(turns).toBe(1);
    const a = await saved(first.claims.attempt_id);
    const b = await saved(second.claims.attempt_id);
    expect(a.cursor).toBe(0);
    expect(b.cursor).toBe(0);
    expect(a.events.map((row) => row.key)).toEqual(['0']);
    expect(b.events).toEqual(a.events);
    // Both acknowledged writes are already committed, in the order submitted.
    expect(required(b.seqs[0])).toBe(required(a.seqs[0]) + 1);
    await Promise.all([
      one.emit(first.claims, required(reply(first.claims.attempt_id, [1, 2])[0])),
      one.emit(second.claims, required(reply(second.claims.attempt_id, [1, 2])[0])),
    ]);
    expect((await saved(first.claims.attempt_id)).cursor).toBe(1);
    expect((await saved(second.claims.attempt_id)).cursor).toBe(1);
  });

  test('one fenced caller cannot discard another attempt or poison later writes', async () => {
    const one = runner();
    const healthy = await claimed('Healthy concurrent attempt', one);
    const fenced = await claimed('Fenced concurrent attempt', one);
    const results = await Promise.allSettled([
      one.emit(healthy.claims, required(reply(healthy.claims.attempt_id, [0, 1])[0])),
      one.emit(
        { ...fenced.claims, epoch: fenced.claims.epoch + 1 },
        required(reply(fenced.claims.attempt_id, [0, 1])[0]),
      ),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason.code).toBe('stale_epoch');
    const a = await saved(healthy.claims.attempt_id);
    const b = await saved(fenced.claims.attempt_id);
    expect(a.events.map((row) => row.key)).toEqual(['0']);
    expect(a.cursor).toBe(0);
    expect(b.events).toEqual([]);
    expect(b.cursor).toBe(-1);
    await Promise.all([
      one.emit(healthy.claims, required(reply(healthy.claims.attempt_id, [1, 2])[0])),
      one.emit(fenced.claims, required(reply(fenced.claims.attempt_id, [0, 1])[0])),
    ]);
    expect((await saved(healthy.claims.attempt_id)).events.map((row) => row.key)).toEqual([
      '0',
      '1',
    ]);
    expect((await saved(fenced.claims.attempt_id)).events.map((row) => row.key)).toEqual(['0']);
  });

  test('a shared rollback retries the first answer join without keeping or repeating old text', async () => {
    const db = required(handle).db;
    const service = required(jobs);
    const one = runner();
    const spaceId = newId('sp');
    await db.insert(space).values({
      id: spaceId,
      name: 'Retried conversation',
      gitPath: `/spaces/${spaceId}`,
    });
    const conversations = new ExperienceService(db, service, new SubmissionService(service), one);
    const created = await conversations.createConversation(spaceId, {
      title: 'Retried answer',
    });
    if (!('conversation' in created)) throw new Error('Expected an available conversation');
    const { conversation } = created;
    const accepted = await conversations.message(spaceId, conversation.id, {
      text: 'Answer again.',
    });
    if (!('turn_id' in accepted)) throw new Error('Expected an accepted turn');
    const claim = async () => {
      const row = await service.get(conversation.id);
      return required(
        await one.claim({
          job_id: row.id,
          expected_epoch: row.leaseEpoch,
          expected_version: row.stateVersion,
          reason: 'input',
        }),
      );
    };
    const text = (
      attemptId: RuntimeEvent['attempt_id'],
      localSeq: number,
      value: string,
    ): RuntimeEvent => ({
      type: 'text_delta',
      attempt_id: attemptId,
      local_seq: localSeq,
      dedup_key: dedupKey(attemptId, localSeq),
      at: new Date().toISOString(),
      text: value,
    });
    const answer = async () => {
      const [turn] = await db
        .select()
        .from(experienceTurn)
        .where(eq(experienceTurn.id, accepted.turn_id));
      return required(turn).answer;
    };
    const shown = (events: ExperienceEvent[], initial = '') =>
      events.reduce(
        (value, { item }) =>
          item.type === 'text_delta' ? (item.restart ? '' : value) + item.text : value,
        initial,
      );
    const projection = new ExperienceEvents(db);
    const first = await claim();
    await one.emit(first.claims, text(first.claims.attempt_id, 0, 'Earlier partial. '));
    expect(await answer()).toBe('Earlier partial. ');
    expect(shown((await projection.page(spaceId, 0, conversation.id)).events)).toBe(
      'Earlier partial. ',
    );
    expect(await one.loseAttempt(first.claims.attempt_id, 'runtime_crashed')).toBe(true);
    const current = await claim();
    const [previous] = await db
      .select()
      .from(attempt)
      .where(eq(attempt.id, first.claims.attempt_id));
    const [execution] = await db
      .select()
      .from(attempt)
      .where(eq(attempt.id, current.claims.attempt_id));
    expect(required(previous).outcome).toBe('fenced');
    expect(required(execution).turnId).toBe(accepted.turn_id);
    const companion = await claimed('Fenced answer companion', one);
    let holds = 0;
    const stop = onEventOrderHeld(() => holds++);
    let results: PromiseSettledResult<void>[];
    try {
      results = await Promise.allSettled([
        // This sets the answer-join cache before the next caller rolls the
        // transaction back. Its individual retry must still replace old text.
        one.emit(current.claims, text(current.claims.attempt_id, 0, 'Fresh answer. ')),
        one.emit(
          { ...companion.claims, epoch: companion.claims.epoch + 1 },
          text(companion.claims.attempt_id, 0, 'Refused. '),
        ),
      ]);
    } finally {
      stop();
    }
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(holds).toBe(3); // The rolled-back batch, then each caller alone.
    expect(await answer()).toBe('Fresh answer. ');
    const page = await projection.page(spaceId, 0, conversation.id);
    expect(
      page.events.filter(({ item }) => item.type === 'text_delta' && item.restart),
    ).toHaveLength(1);
    expect(shown(page.events)).toBe('Fresh answer. ');
    await one.emit(current.claims, text(current.claims.attempt_id, 1, 'More detail. '));
    expect(await answer()).toBe('Fresh answer. More detail. ');
    const after = await projection.page(spaceId, page.next_cursor, conversation.id);
    expect(after.events.filter(({ item }) => item.type === 'text_delta' && item.restart)).toEqual(
      [],
    );
    expect(shown(after.events, shown(page.events))).toBe('Fresh answer. More detail. ');
    const runtime = await db
      .select()
      .from(event)
      .where(eq(event.attemptId, current.claims.attempt_id))
      .orderBy(asc(event.seq));
    expect(runtime.filter((row) => row.type === 'text_delta').map((row) => row.dedupKey)).toEqual([
      dedupKey(current.claims.attempt_id, 0),
      dedupKey(current.claims.attempt_id, 1),
    ]);
  });

  test('shared writes retain each caller principal and the transaction lock guard', async () => {
    const one = runner();
    const firstPerson = newId('own');
    const secondPerson = newId('own');
    const first = await claimed('First private attempt', one, firstPerson);
    const second = await claimed('Second private attempt', one, secondPerson);
    const internal = await claimed('Trusted internal attempt', one);
    const service = required(jobs);
    const lock = service.lockRuntime;
    const seen: { jobId: string; principalId: string | undefined }[] = [];
    const previous = process.env.MELETE_EVENT_LOCK_GUARD;
    process.env.MELETE_EVENT_LOCK_GUARD = 'throw';
    let turns = 0;
    const stop = onEventOrderHeld(() => turns++);
    service.lockRuntime = async function (tx, id, attemptId, dedupKeys) {
      seen.push({ jobId: id, principalId: requestPrincipal() });
      expect(holdingEventOrder()).toBe(true);
      expect(() => guardPoolWait()).toThrow(/event order lock/);
      return lock.call(this, tx, id, attemptId, dedupKeys);
    };
    try {
      await Promise.all([
        principalContext.run(firstPerson, () =>
          one.emit(first.claims, required(reply(first.claims.attempt_id, [0, 1])[0])),
        ),
        principalContext.run(secondPerson, () =>
          one.emit(second.claims, required(reply(second.claims.attempt_id, [0, 1])[0])),
        ),
        principalContext.exit(() =>
          one.emit(internal.claims, required(reply(internal.claims.attempt_id, [0, 1])[0])),
        ),
      ]);
    } finally {
      service.lockRuntime = lock;
      stop();
      if (previous === undefined) delete process.env.MELETE_EVENT_LOCK_GUARD;
      else process.env.MELETE_EVENT_LOCK_GUARD = previous;
    }
    expect(turns).toBe(1);
    expect(seen).toEqual([
      { jobId: first.claims.job_id, principalId: firstPerson },
      { jobId: second.claims.job_id, principalId: secondPerson },
      { jobId: internal.claims.job_id, principalId: undefined },
    ]);
    for (const { claims } of [first, second, internal])
      expect((await saved(claims.attempt_id)).cursor).toBe(0);
    // Batching changes no authority: the first person cannot write as the second.
    const refused = await principalContext
      .run(firstPerson, () =>
        one.emit(second.claims, required(reply(second.claims.attempt_id, [1, 2])[0])),
      )
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'scope_denied' });
    expect((await saved(second.claims.attempt_id)).cursor).toBe(0);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Postgres unavailable');
  return value;
}
