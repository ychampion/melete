/**
 * A reminder arrives as a new message, at the time it fires, and the attempt
 * that gives it knows the person's date, time and likely city.
 *
 * Before, the timer's wake reused the turn that set it up: the reminder
 * replaced "I'll nudge you" in the same bubble, stamped with the time that
 * reply was sent, and the weather came for the city a stale profile zone was
 * named for.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  type CapabilityClaims,
  conversationResponse,
  dedupKey,
  type RuntimeEvent,
} from '@melete/contracts';
import { renderInput } from '@melete/runtime-hermes';
import { and, asc, eq, sql } from 'drizzle-orm';
import { requestRuntimeWait } from '../../src/broker/runtime-wait.ts';
import { session } from '../../src/db/auth-schema.ts';
import { experienceProfile, experienceTurn, job, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { openWakeTurn } from '../../src/jobs/wake-turn.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'reminder-turns-signing-key-32-bytes!!',
      scopes: ['job.wait'],
    })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const withDb = handle ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('fixture unavailable');
  return value;
}

const ownerId = newId('own');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'reminders@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
}

/** The owner signed in to a space of its own; a profile when `zone` is given. */
async function person(zone?: { timeZone: string; confirmed: boolean }) {
  const db = required(handle).db;
  const spaceId = newId('sp');
  const token = randomBytes(32).toString('base64url');
  await db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  await db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
  if (zone)
    await db.insert(experienceProfile).values({
      spaceId,
      timeZone: zone.timeZone,
      ...(zone.confirmed ? { timeZoneConfirmedAt: new Date() } : {}),
    });
  const request = (path: string, method = 'GET', body?: unknown) =>
    required(app).request(path, {
      method,
      headers: {
        Cookie: `melete_session=${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { spaceId, request };
}

async function claimNow(row: JobRow, reason: 'input' | 'timer' = 'input') {
  return required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason,
    }),
  );
}

function say(claims: CapabilityClaims, text: string) {
  return required(runner).emit(claims, {
    type: 'text_delta',
    text,
    attempt_id: claims.attempt_id,
    local_seq: 0,
    dedup_key: dedupKey(claims.attempt_id, 0),
    at: new Date().toISOString(),
  } as RuntimeEvent);
}

async function turnsOf(chatId: string) {
  return required(handle)
    .db.select()
    .from(experienceTurn)
    .where(eq(experienceTurn.jobId, chatId))
    .orderBy(asc(experienceTurn.createdAt), asc(experienceTurn.id));
}

/** A chat whose first turn set a reminder and rests on its timer. */
async function reminderSet(who: Awaited<ReturnType<typeof person>>, timeZone?: string) {
  const persona = agentResponse.parse(
    await (await who.request('/agents', 'POST', freshAgent())).json(),
  ).agent;
  const chat = conversationResponse.parse(
    await (
      await who.request('/conversations', 'POST', { title: 'Stretch', agent_id: persona.id })
    ).json(),
  ).conversation;
  const sent = await who.request(`/conversations/${chat.id}/messages`, 'POST', {
    text: 'Remind me in 5 minutes to stretch, and tell me the weather then.',
    ...(timeZone ? { time_zone: timeZone } : {}),
  });
  expect(sent.status).toBe(200);
  const first = await claimNow(await required(jobs).get(chat.id));
  await say(first.claims, "Set. I'll nudge you in 5 minutes.");
  const wait = { kind: 'timer' as const, wake_at: new Date(Date.now() + 300_000).toISOString() };
  await requestRuntimeWait(required(handle).sql, first.claims, wait);
  await required(runner).commitOutcome(first.claims, { kind: 'waiting_for_event_or_time', wait });
  return { chat, first, wait };
}

async function fire(chatId: string) {
  await required(handle)
    .db.update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, chatId));
  return claimNow(await required(jobs).get(chatId), 'timer');
}

withDb('a reminder the agent set', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('fires as a new message, and the setup reply stays as it was', async () => {
    const who = await person();
    const { chat } = await reminderSet(who);
    const [setup] = await turnsOf(chat.id);
    expect(required(setup).answer).toBe("Set. I'll nudge you in 5 minutes.");

    const fired = await fire(chat.id);
    const turns = await turnsOf(chat.id);
    expect(turns).toHaveLength(2);
    const [kept, reminder] = turns;
    // The wake answers in a turn of its own, with no words from the person.
    expect(required(reminder).text).toBe('');
    expect(required(reminder).createdAt.getTime()).toBeGreaterThan(
      required(kept).createdAt.getTime(),
    );
    expect((await required(jobs).get(chat.id)).currentTurnId).toBe(required(reminder).id);
    const [attemptRow] = await required(handle)
      .sql`select turn_id from attempt where id = ${fired.claims.attempt_id}`;
    expect(attemptRow?.turn_id).toBe(required(reminder).id);

    await say(fired.claims, 'Time to stretch. It is 18°C and clear.');
    await required(runner).commitOutcome(fired.claims, {
      kind: 'completed',
      summary: 'Time to stretch. It is 18°C and clear.',
      evidence: [],
    });
    const after = await turnsOf(chat.id);
    expect(after.map((turn) => turn.answer)).toEqual([
      "Set. I'll nudge you in 5 minutes.",
      'Time to stretch. It is 18°C and clear.',
    ]);
    expect(after.map((turn) => turn.status)).toEqual(['needs_you', 'done']);
  });

  test('while it waits, the chat says until when, not that it needs the person', async () => {
    const who = await person();
    const { chat, wait } = await reminderSet(who);
    const shown = conversationResponse.parse(
      await (await who.request(`/conversations/${chat.id}`)).json(),
    ).conversation;
    expect(shown.status).toBe('needs_you');
    expect(Date.parse(shown.waiting_until ?? '')).toBe(Date.parse(wait.wake_at));
    await fire(chat.id);
    const woken = conversationResponse.parse(
      await (await who.request(`/conversations/${chat.id}`)).json(),
    ).conversation;
    expect(woken.waiting_until).toBeUndefined();
  });

  test('a message while it waits is answered, and the reminder still comes at its time', async () => {
    const who = await person();
    const { chat, wait } = await reminderSet(who);
    const sent = await who.request(`/conversations/${chat.id}/messages`, 'POST', {
      text: 'Thanks! What should I stretch first?',
    });
    expect(sent.status).toBe(200);
    const reply = await claimNow(await required(jobs).get(chat.id));
    // The reply is told the reminder is set aside for it, not that it is gone.
    expect(reply.bundle.inputs.cancelled_wait).toEqual(wait);
    expect(renderInput(reply.bundle)).toContain('Thanks! What should I stretch first?');
    await say(reply.claims, 'Start with your neck and shoulders.');
    await required(runner).commitOutcome(reply.claims, {
      kind: 'completed',
      summary: 'Start with your neck and shoulders.',
      evidence: [],
    });
    const resting = await required(jobs).get(chat.id);
    expect(resting.state).toBe('waiting_for_event_or_time');
    expect(resting.wait).toEqual(wait);
    expect(resting.nextWakeAt?.getTime()).toBe(Date.parse(wait.wake_at));
    const shown = conversationResponse.parse(
      await (await who.request(`/conversations/${chat.id}`)).json(),
    ).conversation;
    expect(Date.parse(shown.waiting_until ?? '')).toBe(Date.parse(wait.wake_at));

    const fired = await fire(chat.id);
    await say(fired.claims, 'Time to stretch.');
    await required(runner).commitOutcome(fired.claims, {
      kind: 'completed',
      summary: 'Time to stretch.',
      evidence: [],
    });
    const turns = await turnsOf(chat.id);
    expect(turns.map((turn) => turn.answer)).toEqual([
      "Set. I'll nudge you in 5 minutes.",
      'Start with your neck and shoulders.',
      'Time to stretch.',
    ]);
    expect(required(turns[2]).text).toBe('');
    expect((await required(jobs).get(chat.id)).state).toBe('waiting_for_input');
  });

  test('a reminder that comes due while its reply is being written still comes', async () => {
    const who = await person();
    const { chat, wait } = await reminderSet(who);
    expect(
      (await who.request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Ok.' })).status,
    ).toBe(200);
    const reply = await claimNow(await required(jobs).get(chat.id));
    expect(reply.bundle.inputs.cancelled_wait).toEqual(wait);
    // The time passes before the reply finishes.
    const lapsed = { kind: 'timer' as const, wake_at: new Date(Date.now() - 1000).toISOString() };
    await required(handle).db.update(job).set({ wait: lapsed }).where(eq(job.id, chat.id));
    await required(handle)
      .sql`update event set payload = jsonb_set(payload, '{wait}', ${JSON.stringify(lapsed)}::jsonb)
      where dedup_key = ${`${reply.claims.attempt_id}:wait-cancelled`}`;
    await required(runner).commitOutcome(reply.claims, {
      kind: 'completed',
      summary: 'Sure.',
      evidence: [],
    });
    const resting = await required(jobs).get(chat.id);
    expect(resting.state).toBe('waiting_for_event_or_time');
    expect(resting.nextWakeAt?.getTime()).toBeLessThanOrEqual(Date.now());
    await claimNow(resting, 'timer');
    expect(await turnsOf(chat.id)).toHaveLength(3);
  });

  test('one wake opens one turn, however often it is delivered', async () => {
    const who = await person();
    const { chat } = await reminderSet(who);
    await fire(chat.id);
    const [, opened] = await turnsOf(chat.id);
    const row = await required(jobs).get(chat.id);
    const again = await required(jobs).transaction((tx) => openWakeTurn(tx, row, 'timer:replayed'));
    const replayed = await required(jobs).transaction((tx) =>
      openWakeTurn(tx, row, 'timer:replayed'),
    );
    expect(replayed.currentTurnId).toBe(again.currentTurnId);
    expect(again.currentTurnId).not.toBe(required(opened).id);
    expect(await turnsOf(chat.id)).toHaveLength(3);
  });

  test('knows the date, time, weekday and likely city, in the device zone until the profile is confirmed', async () => {
    const who = await person({ timeZone: 'Asia/Kolkata', confirmed: false });
    const { chat, first } = await reminderSet(who, 'America/Los_Angeles');
    const now = required(first.bundle.local_now);
    expect(now.time_zone).toBe('America/Los_Angeles');
    expect(now.city).toBe('Los Angeles');
    expect(first.bundle.time_zone).toBe('America/Los_Angeles');
    // The difference is told once.
    expect(now.zone_mismatch).toEqual({
      profile: 'Asia/Kolkata',
      device: 'America/Los_Angeles',
      used: 'device',
    });
    const input = renderInput(first.bundle);
    expect(input).toContain('## Now');
    expect(input).toMatch(/It is (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /);
    expect(input).toContain('(America/Los_Angeles)');
    expect(input).toContain('probably in or near Los Angeles');
    expect(input).toContain('Mention the difference once');
    // Before the new message, after the conversation: the volatile part.
    expect(input.indexOf('## Now')).toBeLessThan(input.indexOf('## From the person'));

    const fired = await fire(chat.id);
    expect(required(fired.bundle.local_now).time_zone).toBe('America/Los_Angeles');
    expect(required(fired.bundle.local_now).zone_mismatch).toBeNull();
    expect(renderInput(fired.bundle)).not.toContain('Mention the difference once');
    const flagged = await required(handle).db.execute(
      sql`select count(*)::int as n from event
        where payload->>'kind' = 'time_zone_mismatch' and job_id = ${chat.id}`,
    );
    expect((flagged as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
  });

  test('a confirmed profile zone wins over the device, and the difference is still told', async () => {
    const who = await person({ timeZone: 'America/Los_Angeles', confirmed: true });
    const { first } = await reminderSet(who, 'Asia/Kolkata');
    expect(required(first.bundle.local_now)).toMatchObject({
      time_zone: 'America/Los_Angeles',
      city: 'Los Angeles',
      zone_mismatch: { profile: 'America/Los_Angeles', device: 'Asia/Kolkata', used: 'profile' },
    });
  });

  test('a device that says nothing leaves the profile zone, with no difference to tell', async () => {
    const who = await person({ timeZone: 'Europe/London', confirmed: false });
    const { first } = await reminderSet(who);
    expect(required(first.bundle.local_now)).toMatchObject({
      time_zone: 'Europe/London',
      city: 'London',
      zone_mismatch: null,
    });
    const rows = await required(handle)
      .db.select({ payload: sql`payload` })
      .from(sql`event`)
      .where(and(sql`payload->>'kind' = 'user_message'`, sql`job_id = ${first.claims.job_id}`));
    expect(JSON.stringify(rows)).not.toContain('client_time_zone');
  });
});
