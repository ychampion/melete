/**
 * A reminder the agent set is one the person can take back: the conversation
 * finds it with run.list and cancels it with run.stop, and then it neither
 * comes back after the reply nor fires.
 *
 * One in another conversation is held rather than removed, said in both
 * conversations, and run.resume turns it back on at the time it was due.
 *
 * Before, a conversation's own reminder was set aside while it answered
 * "cancel that reminder", listed nowhere, and put back by itself when the
 * reply ended, so it fired anyway.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  type CapabilityClaims,
  conversationResponse,
  type ExperienceEvent,
} from '@melete/contracts';
import { renderInput } from '@melete/runtime-hermes';
import { eq } from 'drizzle-orm';
import { requestRuntimeWait } from '../../src/broker/runtime-wait.ts';
import { session } from '../../src/db/auth-schema.ts';
import { job, owner, space, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'reminder-cancel-signing-key-32-bytes!',
      scopes: ['job.wait'],
    })
  : null;
const runs = jobs ? new RunService(jobs) : null;
if (runner && runs) attachRuns(runner, runs);
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      runs: runs ?? undefined,
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
  await handle.db.insert(owner).values({ id: ownerId, email: 'reminder-cancel@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
}

/** The person signed in to a space of their own. */
async function person() {
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
  const request = (path: string, method = 'GET', body?: unknown) =>
    required(app).request(path, {
      method,
      headers: {
        Cookie: `melete_session=${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const persona = agentResponse.parse(
    await (await request('/agents', 'POST', freshAgent())).json(),
  ).agent;
  return { spaceId, request, agentId: persona.id };
}
type Person = Awaited<ReturnType<typeof person>>;

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

async function conversation(who: Person, title: string) {
  return conversationResponse.parse(
    await (await who.request('/conversations', 'POST', { title, agent_id: who.agentId })).json(),
  ).conversation;
}

async function send(who: Person, chatId: string, text: string) {
  const sent = await who.request(`/conversations/${chatId}/messages`, 'POST', { text });
  expect(sent.status).toBe(200);
  return claimNow(await required(jobs).get(chatId));
}

/** The turn that sets the reminder, ending to rest on its timer. */
async function setReminder(chatId: string, claims: CapabilityClaims, minutes: number) {
  const wait = {
    kind: 'timer' as const,
    wake_at: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
  await requestRuntimeWait(required(handle).sql, claims, wait);
  await required(runner).commitOutcome(claims, { kind: 'waiting_for_event_or_time', wait });
  expect((await required(jobs).get(chatId)).state).toBe('waiting_for_event_or_time');
  return wait;
}

async function reminderIn(who: Person, title: string, minutes = 3) {
  const chat = await conversation(who, title);
  const first = await send(who, chat.id, `Remind me in ${minutes} minutes to ${title}.`);
  const wait = await setReminder(chat.id, first.claims, minutes);
  return { chat, wait };
}

const tool = (claims: CapabilityClaims, name: string, input: unknown) =>
  required(runs).call(claims, name, input) as Promise<Record<string, unknown>>;

type Listed = {
  id: string;
  this_conversation: boolean;
  wakes_at: string;
  conversation: string;
  status: string;
};
const remindersOf = async (claims: CapabilityClaims) =>
  ((await tool(claims, 'run.list', {})).reminders ?? []) as Listed[];

const waitingUntil = async (who: Person, chatId: string) =>
  conversationResponse.parse(await (await who.request(`/conversations/${chatId}`)).json())
    .conversation.waiting_until;

async function notesOf(who: Person, chatId: string) {
  const page = await new ExperienceEvents(required(handle).db).page(who.spaceId, 0, chatId, 500);
  return (page as { events: ExperienceEvent[] }).events.flatMap((entry) =>
    entry.item.type === 'note' ? [entry.item.text] : [],
  );
}

const done = (summary: string) => ({ kind: 'completed' as const, summary, evidence: [] });

withDb('cancelling a reminder the agent set', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('in its own conversation: listed, cancelled, not put back, and it never fires', async () => {
    const who = await person();
    const { chat, wait } = await reminderIn(who, 'drink water');
    expect(Date.parse((await waitingUntil(who, chat.id)) ?? '')).toBe(Date.parse(wait.wake_at));

    const reply = await send(who, chat.id, 'Actually, cancel that reminder.');
    expect(reply.bundle.inputs.cancelled_wait).toEqual(wait);
    // The turn is told how to take it back, not only that it comes back.
    expect(renderInput(reply.bundle)).toContain('run.stop');

    const listed = await remindersOf(reply.claims);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: chat.id, this_conversation: true });
    expect(Date.parse(required(listed[0]).wakes_at)).toBe(Date.parse(wait.wake_at));

    const cancelled = await tool(reply.claims, 'run.stop', { run: chat.id });
    expect(cancelled).toMatchObject({ status: 'cancelled', reminder: chat.id });
    // Asked again, it is already gone, and nothing is listed.
    expect((await tool(reply.claims, 'run.stop', { run: chat.id })).status).toBe('not_scheduled');
    expect(await remindersOf(reply.claims)).toHaveLength(0);

    await required(runner).commitOutcome(reply.claims, done('Cancelled.'));
    const after = await required(jobs).get(chat.id);
    expect(after.state).not.toBe('waiting_for_event_or_time');
    expect((after.wait as { kind?: string }).kind).not.toBe('timer');
    expect(after.nextWakeAt).toBeNull();
    expect(await waitingUntil(who, chat.id)).toBeUndefined();

    // The next turn has nothing set aside and nothing to list.
    const later = await send(who, chat.id, 'Thanks.');
    expect(later.bundle.inputs.cancelled_wait).toBeUndefined();
    expect(await remindersOf(later.claims)).toHaveLength(0);
    await required(runner).commitOutcome(later.claims, done('You are welcome.'));
    expect((await required(jobs).get(chat.id)).nextWakeAt).toBeNull();
  });

  test('from another conversation: held, said in both places, undone by resume, and nothing else touched', async () => {
    const who = await person();
    const water = await reminderIn(who, 'drink water');
    const stretch = await reminderIn(who, 'stretch', 10);
    const elsewhere = await conversation(who, 'Errands');
    const turn = await send(who, elsewhere.id, 'Set a weekly check-in, and show my reminders.');
    const routine = await tool(turn.claims, 'run.start', {
      goal: 'Check in with the person every Monday at 9:00',
      title: 'weekly-check-in',
      repeat: { cron: '0 9 * * 1' },
    });
    const routineId = String(routine.run_id);

    const listed = await remindersOf(turn.claims);
    expect(listed.map((entry) => entry.id).sort()).toEqual([water.chat.id, stretch.chat.id].sort());
    expect(listed.every((entry) => entry.this_conversation === false)).toBe(true);
    expect(listed.find((entry) => entry.id === water.chat.id)?.conversation).toBe('drink water');

    const before = await required(jobs).get(water.chat.id);
    expect(await tool(turn.claims, 'run.stop', { run: water.chat.id })).toMatchObject({
      status: 'cancelled',
      reminder: water.chat.id,
      undo: expect.stringContaining('run.resume'),
    });
    // Held, not removed: it rests on the same timer with no wake.
    const held = await required(jobs).get(water.chat.id);
    expect(held.state).toBe('waiting_for_event_or_time');
    expect(held.wait).toEqual(water.wait);
    expect(held.nextWakeAt).toBeNull();
    expect(await waitingUntil(who, water.chat.id)).toBeUndefined();
    // The wake queued for its time, and any later one, finds nothing to start.
    for (const version of [before.stateVersion, held.stateVersion])
      expect(
        await required(runner).claim({
          job_id: water.chat.id,
          expected_epoch: held.leaseEpoch,
          expected_version: version,
          reason: 'timer',
        }),
      ).toBeNull();
    // Said where it was done, and in the conversation it belongs to.
    expect((await notesOf(who, elsewhere.id)).join('\n')).toContain(
      'Cancelled the reminder in "drink water"',
    );
    expect((await notesOf(who, water.chat.id)).join('\n')).toContain(
      'was cancelled from another conversation',
    );
    expect(
      (await remindersOf(turn.claims)).find((entry) => entry.id === water.chat.id)?.status,
    ).toBe('cancelled');

    const kept = await required(jobs).get(stretch.chat.id);
    expect(kept.state).toBe('waiting_for_event_or_time');
    expect(kept.wait).toEqual(stretch.wait);
    expect(Date.parse((await waitingUntil(who, stretch.chat.id)) ?? '')).toBe(
      Date.parse(stretch.wait.wake_at),
    );
    const [standing] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.jobId, routineId));
    expect(required(standing).enabled).toBe(true);
    expect((await required(jobs).get(routineId)).paused).toBe(false);

    // A message in that conversation is answered, and the reminder stays held.
    const next = await send(who, water.chat.id, 'Hello again.');
    await required(runner).commitOutcome(next.claims, done('Hello.'));
    const still = await required(jobs).get(water.chat.id);
    expect(still.state).toBe('waiting_for_event_or_time');
    expect(still.nextWakeAt).toBeNull();

    // Turned back on from here: the same due time, its wake queued for it.
    expect(await tool(turn.claims, 'run.resume', { run: water.chat.id })).toMatchObject({
      status: 'resumed',
      due_at: water.wait.wake_at,
    });
    const back = await required(jobs).get(water.chat.id);
    expect(back.nextWakeAt?.getTime()).toBe(Date.parse(water.wait.wake_at));
    expect(Date.parse((await waitingUntil(who, water.chat.id)) ?? '')).toBe(
      Date.parse(water.wait.wake_at),
    );
    const [queued] = await required(handle)
      .sql`select start_after from pgboss.job where data->>'job_id' = ${water.chat.id}
        and (data->>'expected_version')::int = ${back.stateVersion}`;
    expect(new Date(String(required(queued).start_after)).getTime()).toBe(
      Date.parse(water.wait.wake_at),
    );
    expect((await notesOf(who, elsewhere.id)).join('\n')).toContain(
      'Turned the reminder in "drink water" back on',
    );
    expect((await notesOf(who, water.chat.id)).join('\n')).toContain('This reminder is back on');
    // At its time it fires as a new message.
    await required(handle)
      .db.update(job)
      .set({ nextWakeAt: new Date(Date.now() - 1000) })
      .where(eq(job.id, water.chat.id));
    const fired = await claimNow(await required(jobs).get(water.chat.id), 'timer');
    expect(fired.bundle.inputs.trigger_events).toContainEqual(
      expect.objectContaining({ kind: 'timer_fired' }),
    );
  });

  test('another person’s reminder is not listed and cannot be cancelled', async () => {
    const who = await person();
    const otherId = newId('own');
    await required(handle)
      .sql`insert into principal (id, email) values (${otherId}, 'other-reminder@example.test')`;
    // A conversation of someone else's, resting on a reminder, beside the person's own.
    const theirs = await required(jobs).transaction((tx) =>
      required(jobs).createInTransaction(
        tx,
        { space_id: who.spaceId, title: 'Their reminder', objective: 'Their reminder' },
        { kind: 'chat' },
      ),
    );
    const wait = {
      kind: 'timer' as const,
      wake_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    await required(handle)
      .db.update(job)
      .set({
        principalId: otherId,
        state: 'waiting_for_event_or_time',
        wait,
        nextWakeAt: new Date(wait.wake_at),
      })
      .where(eq(job.id, theirs.id));

    const mine = await conversation(who, 'Mine');
    const turn = await send(who, mine.id, 'Cancel every reminder.');
    expect((await remindersOf(turn.claims)).map((entry) => entry.id)).not.toContain(theirs.id);
    const refused = await tool(turn.claims, 'run.stop', { run: theirs.id }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ status: 404 });
    const resumed = await tool(turn.claims, 'run.resume', { run: theirs.id }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(resumed).toMatchObject({ status: 404 });
    const untouched = await required(handle).db.select().from(job).where(eq(job.id, theirs.id));
    expect(required(untouched[0]).state).toBe('waiting_for_event_or_time');
    expect(required(untouched[0]).wait).toEqual(wait);
  });
});
