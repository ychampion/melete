/**
 * Intents: what the person says they want, kept past the chat it was said in,
 * with every detail marked as theirs or Melete's guess, followed through on a
 * deadline clock, and stopped when they cancel it.
 *
 * The capture goes the way the engine sends it: the broker route, then the
 * intent service, which reads the person's words from their own message. The
 * clock runs on a time the test moves.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { type IntentView, intentCancelResponse, intentList } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { signCapability } from '../../src/broker/capability.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { session } from '../../src/db/auth-schema.ts';
import { connection, experienceProfile, job, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { intent } from '../../src/intents/schema.ts';
import { IntentService, type ReversalStep } from '../../src/intents/service.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { createMemoryTrustResolver } from '../../src/memory/broker-trust.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { SituationService } from '../../src/situations/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'intents-fixture-signing-key-32-bytes!';
const runner = jobs ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: KEY }) : null;
const runs = jobs ? new RunService(jobs) : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
if (runner && runs) attachRuns(runner, runs);
if (runs && triggers) runs.triggers = triggers;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock = Date.now();
const situations =
  jobs && triggers ? new SituationService({ jobs, triggers, now: () => clock }) : null;
const intents =
  jobs && runs && situations
    ? new IntentService({ jobs, runs, situations, now: () => clock })
    : null;
if (situations && intents) situations.deps.sweeps = [() => intents.sweep()];
const app =
  handle && jobs && triggers && situations && intents
    ? createApp({
        db: handle.db,
        env: loadEnv({ NODE_ENV: 'test' }),
        jobs,
        triggers,
        runner: runner ?? undefined,
        runs: runs ?? undefined,
        situations,
        intents,
        sql: handle.sql,
        checkDatabase: async () => 'ok',
      })
    : null;
const broker =
  handle && runs && intents
    ? new BrokerService({
        sql: handle.sql,
        connectors: new ConnectorRegistry(),
        runs,
        intents,
      })
    : null;
const brokerApp = broker
  ? createBrokerApp({
      broker,
      capabilityKey: KEY,
      approvalKey: 'intents-fixture-approval-key-32-bytes!!',
    })
  : null;

const spaceId = newId('sp');
const ownerId = newId('own');
const mailId = newId('conn');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'intents@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
  await handle.db
    .insert(connection)
    .values({ id: mailId, spaceId, provider: 'test', label: 'Work mail' });
  await handle.db.insert(experienceProfile).values({ spaceId, timeZone: 'UTC' });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}
const withDb = app ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
async function request(path: string, method = 'GET', body?: unknown) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const listed = async (): Promise<IntentView[]> => {
  const response = await request('/intents');
  expect(response.status).toBe(200);
  return intentList.parse(await response.json()).intents;
};

/** Claims the job's next turn; the bundle is what the engine would be given. */
async function claim(id: string) {
  await required(handle)
    .db.update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, id));
  const current = await required(jobs).get(id);
  return required(
    await required(runner).claim({
      job_id: id,
      expected_epoch: current.leaseEpoch,
      expected_version: current.stateVersion,
      reason: 'timer',
    }),
  );
}

/** A day some days ahead, as the person would say it and as a date. */
function dayAhead(days: number) {
  const at = new Date(clock + days * DAY);
  const iso = at.toISOString().slice(0, 10);
  const spoken = `${at.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${at.getUTCDate()}`;
  return { iso, spoken, due: Date.parse(`${iso}T17:00:00.000Z`) };
}

/** The person says something in a new chat, and the chat's turn keeps it as an intent. */
async function capture(words: string, args: Record<string, unknown>) {
  const chat = await required(jobs).transaction((tx) =>
    required(jobs).createInTransaction(
      tx,
      { space_id: spaceId, title: 'A request', objective: 'A request' },
      { kind: 'chat' },
    ),
  );
  await required(jobs).input(chat.id, words);
  const turn = await claim(chat.id);
  expect(turn.claims.scopes).toContain('intent.capture');
  const response = await required(brokerApp).request('/tools/call', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${signCapability(turn.claims, KEY)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'intent.capture', arguments: args }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    intent_id: string;
    read_back: string;
    guesses: string[];
  };
  await required(runner).commitOutcome(turn.claims, {
    kind: 'completed',
    summary: '',
    evidence: [],
  });
  const [row] = await required(handle)
    .db.select()
    .from(intent)
    .where(eq(intent.id, result.intent_id));
  return { chat, result, row: required(row) };
}

const clockOf = async (subject: string) => {
  const [row] = await required(handle).sql`select * from clock where subject_key = ${subject}
    order by created_at desc limit 1`;
  return row;
};
const situationsOn = (subject: string) =>
  required(handle).sql`select * from situation where subject_key = ${subject} order by created_at`;

withDb('intents', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('an intent survives its chat', async () => {
    const day = dayAhead(9);
    const words = `Family birthday, book a suitable Haidilao on ${day.spoken} for 6 of us`;
    const { chat, row } = await capture(words, {
      title: 'Book a table for the family birthday',
      kind: 'booking',
      constraints: { place: { name: 'Haidilao' }, party: { size: 6 } },
      deadline_at: day.iso,
    });
    expect(row.words).toBe(words);
    expect(row.conversationId).toBe(chat.id);
    const run = required(row.runId);

    const deleted = await request(`/conversations/${chat.id}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(await required(handle).db.select().from(job).where(eq(job.id, chat.id))).toHaveLength(0);

    const shown = (await listed()).find((entry) => entry.id === row.id);
    expect(shown).toMatchObject({
      words,
      title: 'Book a table for the family birthday',
      state: 'active',
      conversation_id: null,
      run_id: run,
      deadline_at: new Date(day.due).toISOString(),
      deadline_origin: 'person',
    });
    // Its work goes on without the chat.
    const [work] = await required(handle).db.select().from(job).where(eq(job.id, run));
    expect(work?.kind).toBe('run');
    expect(['completed', 'failed', 'cancelled']).not.toContain(work?.state);
  }, 60_000);

  test('a value the person never said shows as inferred', async () => {
    const day = dayAhead(9);
    const { result, row } = await capture(`Dinner at Haidilao for six on ${day.spoken}`, {
      title: 'Dinner at Haidilao',
      kind: 'booking',
      constraints: {
        place: { name: 'Haidilao' },
        party: { size: 6 },
        window: { from: `${day.iso}T19:00:00Z` },
        budget: { max: 300, currency: 'USD' },
      },
      deadline_at: day.iso,
    });
    // The model's own guesses, as it is told to read them back.
    expect(result.read_back).toContain('7:00 PM (my guess)');
    expect(result.read_back).toContain('up to $300 (my guess)');
    expect(result.read_back).not.toContain('Haidilao (my guess)');
    expect(result.guesses).toEqual([expect.stringContaining('7:00 PM'), 'up to $300']);
    // And on Home.
    const shown = required((await listed()).find((entry) => entry.id === row.id));
    expect(shown.origins).toEqual({
      'place.name': 'person',
      'party.size': 'person',
      'window.from': 'inferred',
      deadline_at: 'person',
      'budget.max': 'inferred',
      'budget.currency': 'inferred',
    });
    expect(shown.read_back.parts.map((part) => [part.path, part.origin])).toEqual([
      ['place.name', 'person'],
      ['party.size', 'person'],
      ['window.from', 'inferred'],
      ['deadline_at', 'person'],
      ['budget.max', 'inferred'],
    ]);

    // The person corrects the time: it is theirs now; the budget stays a guess.
    const corrected = await request(`/intents/${row.id}`, 'PATCH', {
      version: shown.version,
      values: { 'window.from': `${day.iso}T19:30:00Z` },
    });
    expect(corrected.status).toBe(200);
    const after = required((await listed()).find((entry) => entry.id === row.id));
    expect(after.version).toBe(shown.version + 1);
    expect(after.origins['window.from']).toBe('person');
    expect(after.origins['budget.max']).toBe('inferred');
    expect(after.read_back.line).toContain('up to $300 (my guess)');
    expect(after.read_back.line).not.toContain('7:30 PM (my guess)');
    // An edit against an older version is refused.
    expect(
      (
        await request(`/intents/${row.id}`, 'PATCH', {
          version: shown.version,
          values: { 'budget.max': 250 },
        })
      ).status,
    ).toBe(409);
  }, 60_000);

  test('an inferred value never raises broker trust', async () => {
    const day = dayAhead(9);
    const guessed = await capture(`Book Haidilao on ${day.spoken}`, {
      title: 'Book Haidilao',
      kind: 'booking',
      constraints: {
        place: { name: 'Haidilao' },
        budget: { max: 300, currency: 'USD' },
        counterparties: ['bookings@haidilao.example'],
      },
    });
    const said = await capture(
      `Book Haidilao on ${day.spoken}, keep it under $250, and email bookings@haidilao.example`,
      {
        title: 'Book Haidilao',
        kind: 'booking',
        constraints: {
          place: { name: 'Haidilao' },
          budget: { max: 250, currency: 'USD' },
          counterparties: ['bookings@haidilao.example'],
        },
      },
    );
    const resolver = createMemoryTrustResolver();
    const ask = (jobId: string) =>
      required(handle).sql.begin((tx) =>
        resolver.resolve(tx, {
          space_id: spaceId,
          job_id: jobId,
          connection_id: mailId,
          kind: 'test.send',
          effect_class: 'spend',
          canonical_payload: {
            to: 'bookings@haidilao.example',
            amount: jobId === guessed.row.runId ? 300 : 250,
          },
          fields: [
            { path: 'to', category: 'recipient', value: 'bookings@haidilao.example' },
            {
              path: 'amount',
              category: 'amount',
              value: jobId === guessed.row.runId ? '300' : '250',
            },
          ],
        }),
      );
    // What Melete guessed answers nothing: the broker treats it as unknown.
    expect(await ask(required(guessed.row.runId))).toEqual([]);
    // What the person said is theirs, for that work.
    expect(
      (await ask(required(said.row.runId))).map((entry) => [entry.path, entry.origin_trust]),
    ).toEqual([
      ['to', 'owner'],
      ['amount', 'owner'],
    ]);
  }, 60_000);

  test('an unfinished intent raises one at-risk situation at T − lead', async () => {
    const day = dayAhead(5);
    const { row } = await capture(`Book a table at Haidilao for the 4 of us on ${day.spoken}`, {
      title: 'Book a table at Haidilao',
      kind: 'booking',
      constraints: { place: { name: 'Haidilao' }, party: { size: 4 } },
      deadline_at: day.iso,
    });
    const kept = required(await clockOf(row.subjectKey));
    // A booking is looked at a day before it is due; the person said the day.
    expect(kept.state).toBe('armed');
    expect(kept.lead_s).toBe(24 * 3600);
    expect(new Date(kept.due_at).getTime()).toBe(day.due);
    expect(new Date(kept.fire_at).getTime()).toBe(day.due - DAY);
    expect(kept.person_set).toBe(true);

    clock = day.due - DAY - 60_000;
    await required(situations).sweep();
    expect(await situationsOn(row.subjectKey)).toHaveLength(0);

    clock = day.due - DAY + 1000;
    await required(situations).sweep();
    clock += 2 * 60_000;
    await required(situations).sweep();
    const raised = await situationsOn(row.subjectKey);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'deadline.at_risk', person_set: true });
    expect((await clockOf(row.subjectKey))?.state).toBe('fired');
    const shown = required((await listed()).find((entry) => entry.id === row.id));
    expect(shown.state).toBe('at_risk');
    expect(shown.next_step).toBe('Running out of time');

    // At the deadline, still not done: it expires, its work stops, and the person is told.
    clock = day.due + 1000;
    await required(situations).sweep();
    const ended = required((await listed()).find((entry) => entry.id === row.id));
    expect(ended).toMatchObject({ state: 'expired' });
    expect((await required(jobs).get(required(row.runId))).state).toBe('cancelled');
    expect((await situationsOn(row.subjectKey)).map((entry) => entry.kind)).toEqual([
      'deadline.at_risk',
      'intent.expired',
    ]);
    clock = Date.now();
  }, 60_000);

  test('a deadline the person never said is kept, but never as theirs', async () => {
    const day = dayAhead(5);
    const { row } = await capture('Find me a good plumber', {
      title: 'Find a plumber',
      kind: 'other',
      deadline_at: `${day.iso}T12:00:00Z`,
    });
    expect(row.deadlineOrigin).toBe('inferred');
    const kept = required(await clockOf(row.subjectKey));
    expect(kept.person_set).toBe(false);
    expect(kept.lead_s).toBe(2 * 3600);
  }, 60_000);

  test('an intent that is done before its deadline raises nothing', async () => {
    const day = dayAhead(5);
    const { row } = await capture(`Send the deck to Dana by ${day.spoken}`, {
      title: 'Send the deck to Dana',
      kind: 'deliver',
      deadline_at: day.iso,
    });
    await required(handle)
      .db.update(job)
      .set({ state: 'completed' })
      .where(eq(job.id, required(row.runId)));
    clock = day.due - 2 * HOUR + 1000;
    await required(situations).sweep();
    expect(await situationsOn(row.subjectKey)).toHaveLength(0);
    expect((await clockOf(row.subjectKey))?.state).toBe('met');
    expect(required((await listed()).find((entry) => entry.id === row.id)).state).toBe('done');
    clock = Date.now();
  }, 60_000);

  test('a cancelled intent stops its run', async () => {
    const day = dayAhead(9);
    const { row } = await capture(`Book Haidilao for 6 on ${day.spoken}`, {
      title: 'Book Haidilao',
      kind: 'booking',
      constraints: { place: { name: 'Haidilao' }, party: { size: 6 } },
      deadline_at: day.iso,
    });
    const run = required(row.runId);
    const cancelled = await request(`/intents/${row.id}/cancel`, 'POST');
    expect(cancelled.status).toBe(200);
    const body = intentCancelResponse.parse(await cancelled.json());
    expect(body.intent).toMatchObject({ state: 'cancelled', closed_reason: 'You cancelled it.' });
    expect((await required(jobs).get(run)).state).toBe('cancelled');
    expect((await clockOf(row.subjectKey))?.state).toBe('cleared');
    // Nothing wakes it again: its deadline passes quietly.
    clock = Date.parse(`${day.iso}T17:00:00.000Z`) - DAY + 1000;
    await required(situations).sweep();
    expect(await situationsOn(row.subjectKey)).toHaveLength(0);
    clock = Date.now();
    // Cancelling again answers with how it ended.
    expect((await request(`/intents/${row.id}/cancel`, 'POST')).status).toBe(200);
  }, 60_000);

  test('cancelling takes back what the work changed, newest first, and lists what it kept', async () => {
    const day = dayAhead(9);
    const { row } = await capture(`Book Haidilao for 6 on ${day.spoken}`, {
      title: 'Book Haidilao for the team',
      kind: 'booking',
      constraints: { place: { name: 'Haidilao' } },
    });
    const run = required(row.runId);
    const shift = await claim(run);
    const made: string[] = [];
    for (const kind of ['calendar.create', 'email.send']) {
      const id = newId('act');
      made.push(id);
      await required(handle).sql`insert into action (id, job_id, attempt_id, connection_id, kind,
          effect_class, canonical_payload, payload_hash, idempotency_key, status, resolved_at)
        values (${id}, ${run}, ${shift.claims.attempt_id}, ${mailId}, ${kind},
          'write_external', '{}'::jsonb, ${'e'.repeat(64)}, ${id}, 'succeeded',
          ${new Date(Date.now() + made.length * 1000).toISOString()}::timestamptz)`;
    }
    await required(runner).commitOutcome(shift.claims, {
      kind: 'completed',
      summary: '',
      evidence: [],
    });
    // Reopened for the test: the work is still going when the person cancels.
    await required(handle).db.update(job).set({ state: 'queued' }).where(eq(job.id, run));

    const order: string[] = [];
    const undoing = new IntentService({
      jobs: required(jobs),
      runs: required(runs),
      situations: required(situations),
      now: () => clock,
      reverse: async (effects) => {
        const steps: ReversalStep[] = [];
        for (const effect of [...effects].reverse()) {
          order.push(effect.actionId);
          steps.push({
            effect,
            ok: effect.actionId === made[0],
            reason: 'A message once sent stays sent.',
          });
        }
        return steps;
      },
    });
    const result = await undoing.cancel(ownerId, row.id);
    expect(order).toEqual([required(made[1]), required(made[0])]);
    expect(result.effects).toEqual([
      {
        action_id: required(made[1]),
        title: 'Email send',
        outcome: 'failed',
        reason: 'A message once sent stays sent.',
      },
      { action_id: required(made[0]), title: 'Calendar create', outcome: 'reversed', reason: null },
    ]);

    // Without a way to take things back wired, they are listed as kept.
    const other = await capture(`Book Haidilao for 2 on ${day.spoken}`, {
      title: 'Book Haidilao for two',
      kind: 'booking',
    });
    const second = await claim(required(other.row.runId));
    const id = newId('act');
    await required(handle).sql`insert into action (id, job_id, attempt_id, connection_id, kind,
        effect_class, canonical_payload, payload_hash, idempotency_key, status)
      values (${id}, ${required(other.row.runId)}, ${second.claims.attempt_id}, ${mailId},
        'email.send', 'write_external', '{}'::jsonb, ${'f'.repeat(64)}, ${id}, 'succeeded')`;
    await required(runner).commitOutcome(second.claims, {
      kind: 'completed',
      summary: '',
      evidence: [],
    });
    await required(handle)
      .db.update(job)
      .set({ state: 'queued' })
      .where(eq(job.id, required(other.row.runId)));
    const kept = intentCancelResponse.parse(
      await (await request(`/intents/${other.row.id}/cancel`, 'POST')).json(),
    );
    expect(kept.effects).toEqual([
      { action_id: id, title: 'Email send', outcome: 'kept', reason: null },
    ]);
  }, 60_000);

  test('the same request kept twice is one intent', async () => {
    const day = dayAhead(9);
    const chat = await required(jobs).transaction((tx) =>
      required(jobs).createInTransaction(
        tx,
        { space_id: spaceId, title: 'Twice', objective: 'Twice' },
        { kind: 'chat' },
      ),
    );
    await required(jobs).input(chat.id, `Book Haidilao on ${day.spoken}`);
    const turn = await claim(chat.id);
    const args = { title: 'Book Haidilao', kind: 'booking' };
    const first = (await required(intents).capture(turn.claims, args)) as { intent_id: string };
    const again = (await required(intents).capture(turn.claims, args)) as {
      intent_id: string;
      status: string;
    };
    expect(again).toMatchObject({ intent_id: first.intent_id, status: 'already_kept' });
    const kept = await required(handle).sql`select count(*)::int as n from intent
      where conversation_id = ${chat.id}`;
    expect(kept[0]?.n).toBe(1);
  }, 60_000);
});
