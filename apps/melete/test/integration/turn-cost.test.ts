/**
 * A long chat's turns cost the service about what a short chat's do.
 *
 * Each claim builds the attempt's bundle while it holds the event order lock,
 * which every event writer waits on. It used to read the whole history to do
 * it, every tool result's output included, so each turn of a long chat held
 * the lock longer than the one before. It now reads only the outputs an
 * attempt can see, and must hand the attempt exactly what the whole read did.
 *
 * And a turn whose bundle cannot be built ends, once, with a sentence the
 * person can read, instead of waiting queued while every wake fails again.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { dedupKey, jobBudget } from '@melete/contracts';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { onEventOrderHeld } from '../../src/db/lock-guard.ts';
import { attempt, connection, event, experienceTurn, job, space } from '../../src/db/schema.ts';
import { appendEvent } from '../../src/events/store.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { ExperienceService } from '../../src/experience/service.ts';
import { newId } from '../../src/ids.ts';
import { assembleHistory, transcriptLimits, usableHistory } from '../../src/jobs/bundle.ts';
import { attemptContextBudget } from '../../src/jobs/context-budget.ts';
import { readGenerations } from '../../src/jobs/generations.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import {
  AttemptRunner,
  BUNDLE_FAILED_CODE,
  BUNDLE_FAILED_NOTE,
  type ClaimedAttempt,
} from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'turn-cost-signing-key-32-bytes-long!';
/** Enough finished turns that the transcript's bound leaves the oldest out. */
const TURNS = 50;
/** The oldest turns, whose outputs are made large once the chat is long. */
const OLD_TURNS = 10;

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** A chat in a space of its own, with a computer connection its steps run on. */
async function newChat() {
  const { handle, jobs } = fixture();
  const spaceId = newId('sp');
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  const connectionId = newId('conn');
  await handle.db
    .insert(connection)
    .values({ id: connectionId, spaceId, provider: 'computer', label: 'Computer' });
  const submissions = new SubmissionService(jobs);
  const experience = new ExperienceService(handle.db, jobs, submissions);
  const melete = await experience.defaultAgent(spaceId);
  const chat = await jobs.transaction((tx) =>
    jobs.createInTransaction(
      tx,
      { space_id: spaceId, title: 'Checks', objective: 'Talk' },
      { kind: 'chat' },
    ),
  );
  await handle.db.update(job).set({ agentId: melete.id }).where(eq(job.id, chat.id));
  return { chatId: chat.id, spaceId, connectionId, submissions };
}

type Chat = Awaited<ReturnType<typeof newChat>>;

async function send(chat: Chat, n: number): Promise<JobRow> {
  const sent = await chat.submissions.input(chat.chatId, {
    text: `Step ${n}: run the check and tell me what changed.`,
  });
  if (!sent.job) throw new Error(`message refused: ${JSON.stringify(sent.error)}`);
  return sent.job;
}

const wake = (row: JobRow) => ({
  job_id: row.id,
  expected_epoch: row.leaseEpoch,
  expected_version: row.stateVersion,
  reason: 'input' as const,
});

/** The claim, and how long it held the event order lock. */
async function claim(runner: AttemptRunner, row: JobRow) {
  const holds: number[] = [];
  const stop = onEventOrderHeld((ms) => holds.push(ms));
  try {
    const claimed = await runner.claim(wake(row));
    return { claimed, held: holds.reduce((sum, ms) => sum + ms, 0) };
  } finally {
    stop();
  }
}

/** One step on the computer, the reply's words, and the commit. */
async function answer(runner: AttemptRunner, claimed: ClaimedAttempt, n: number) {
  const { claims } = claimed;
  let local = 0;
  const emit = (body: Record<string, unknown>) =>
    runner.emit(claims, {
      ...body,
      attempt_id: claims.attempt_id,
      local_seq: ++local,
      dedup_key: dedupKey(claims.attempt_id, local),
      at: new Date().toISOString(),
    } as Parameters<AttemptRunner['emit']>[1]);
  const callId = `call_${n}_${newId('act').slice(-8)}`;
  await emit({
    type: 'tool_call_proposed',
    tool: 'terminal.run',
    call_id: callId,
    arguments: { command: `check --turn ${n}` },
  });
  await emit({ type: 'tool_result', call_id: callId, ok: true, result: { output: `ok ${n}` } });
  await emit({ type: 'text_delta', text: `Turn ${n}: the check passed.` });
  await runner.commitOutcome(claims, {
    kind: 'completed',
    summary: `Turn ${n}: the check passed.`,
    evidence: [],
  });
}

/**
 * What the claim hands the attempt when it reads every event whole: the
 * history as it was read before the reads were narrowed.
 */
async function wholeHistory(row: JobRow) {
  const { jobs } = fixture();
  return jobs.transaction(async (tx) => {
    const generations = await readGenerations(tx, row.spaceId);
    const events = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.jobId, row.id),
          inArray(event.type, ['notice', 'tool_result', 'approval_decided', 'steer_delivered']),
        ),
      )
      .orderBy(asc(event.seq));
    const all = await tx.select().from(attempt).where(eq(attempt.jobId, row.id));
    const matches = (entry: (typeof all)[number]) =>
      entry.policyGeneration === generations.policy_generation &&
      Object.entries(entry.connectionGenerations).every(
        ([id, generation]) => generations.connection_generations[id] === generation,
      );
    const settledAttempts = new Set(
      all
        .filter((entry) => entry.turnId !== null && entry.turnId !== row.currentTurnId)
        .map((entry) => entry.id),
    );
    const [previous] = await tx
      .select({ cursor: attempt.inputCursor })
      .from(attempt)
      .where(eq(attempt.jobId, row.id))
      .orderBy(asc(attempt.epoch))
      .then((rows) => rows.slice(-1));
    const ended = all
      .filter((entry) => entry.endedAt !== null && matches(entry))
      .sort((left, right) => right.epoch - left.epoch);
    const history = assembleHistory(
      usableHistory(events, generations, new Set(all.filter(matches).map((entry) => entry.id))),
      ended,
      previous?.cursor ?? 0,
      {
        fileTexts: new Map(),
        settledAttempts,
        limits: transcriptLimits(attemptContextBudget('script', jobBudget.parse(row.budget))),
      },
    );
    return {
      transcript: history.transcript,
      earlier: history.earlier,
      new_user_messages: history.inputs.new_user_messages,
    };
  });
}

withDb("a long chat's turns", () => {
  let chat: Chat;
  let runner: AttemptRunner;
  let n = 0;

  beforeAll(async () => {
    const { jobs } = fixture();
    runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    chat = await newChat();
    for (; n < TURNS; ) {
      n += 1;
      const { claimed } = await claim(runner, await send(chat, n));
      if (!claimed) throw new Error('nothing claimed');
      await answer(runner, claimed, n);
    }
  }, 120_000);

  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('hand the attempt what reading every event would, without reading old outputs', async () => {
    const { handle } = fixture();
    n += 1;
    const row = await send(chat, n);
    const whole = await wholeHistory(row);
    // An output no attempt can see any more is broken in the record; the
    // whole read refuses it, and the claim never reads it.
    const [oldest] = await handle.db
      .select({ seq: event.seq })
      .from(event)
      .where(and(eq(event.jobId, chat.chatId), eq(event.type, 'tool_result')))
      .orderBy(asc(event.seq))
      .limit(1);
    if (!oldest) throw new Error('no tool result');
    await handle.db
      .update(event)
      .set({ payload: { not: 'a tool result' } })
      .where(eq(event.seq, oldest.seq));
    // (`rejects` would format the whole validation error, which takes far longer.)
    const refused = await wholeHistory(row).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.name : 'error'),
    );
    expect(refused).toBe('ZodError');
    const { claimed } = await claim(runner, row);
    if (!claimed) throw new Error('nothing claimed');
    expect(claimed.bundle.earlier?.left_out ?? 0).toBeGreaterThan(0);
    expect({
      transcript: claimed.bundle.transcript,
      earlier: claimed.bundle.earlier,
      new_user_messages: claimed.bundle.inputs.new_user_messages,
    }).toEqual(whole);
    await answer(runner, claimed, n);
  }, 60_000);

  test('hold the event order lock no longer when old outputs are large', async () => {
    const { handle } = fixture();
    const held = async () => {
      n += 1;
      const { claimed, held } = await claim(runner, await send(chat, n));
      if (!claimed) throw new Error('nothing claimed');
      await answer(runner, claimed, n);
      return held;
    };
    const before = Math.min(await held(), await held());
    // The oldest turns' outputs become 4 MB each: what a long chat of real
    // work carries, and what every claim used to read.
    const old = await handle.db
      .select({ id: attempt.id })
      .from(attempt)
      .where(and(eq(attempt.jobId, chat.chatId), isNotNull(attempt.endedAt)))
      .orderBy(asc(attempt.epoch))
      .limit(OLD_TURNS);
    await handle.sql`update event
      set payload = jsonb_set(payload, '{result,output}', to_jsonb(repeat(md5(seq::text), 125000)))
      where job_id = ${chat.chatId} and type = 'tool_result'
        and attempt_id in ${handle.sql(old.map((entry) => entry.id))}`;
    const after = Math.min(await held(), await held());
    expect(after).toBeLessThan(before * 1.5 + 100);
  }, 120_000);

  test('a turn whose bundle cannot be built fails once, in words the person can read', async () => {
    const { handle, jobs } = fixture();
    const broken = await newChat();
    const row = await send(broken, 1);
    // A step of the turn under way whose result is not one: every build reads
    // it, and every build fails on it.
    await jobs.transaction((tx) =>
      appendEvent(tx, {
        jobId: row.id,
        type: 'tool_result',
        payload: { not: 'a tool result' },
        dedupKey: `${row.id}:broken-result`,
      }),
    );
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await claim(runner, row)).claimed).toBeNull();
      expect(logged.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining(`${BUNDLE_FAILED_CODE}:ZodError`),
      );
    } finally {
      logged.mockRestore();
    }
    const after = await jobs.get(row.id);
    expect(after.state).toBe('failed');
    expect(after.nextWakeAt).toBeNull();
    const [turn] = await handle.db
      .select({ status: experienceTurn.status, answer: experienceTurn.answer })
      .from(experienceTurn)
      .where(eq(experienceTurn.jobId, row.id));
    expect(turn).toEqual({ status: 'failed', answer: BUNDLE_FAILED_NOTE });
    const attempts = await handle.db
      .select({ outcome: attempt.outcome, detail: attempt.outcomeDetail })
      .from(attempt)
      .where(eq(attempt.jobId, row.id));
    expect(attempts).toEqual([
      {
        outcome: 'failed',
        detail: { kind: 'failed', reason: BUNDLE_FAILED_CODE, retryable: false },
      },
    ]);
    // Nothing wakes it again: the old wake is stale, and no new one was set.
    expect((await claim(runner, row)).claimed).toBeNull();
    expect(
      await handle.db.select({ id: attempt.id }).from(attempt).where(eq(attempt.jobId, row.id)),
    ).toHaveLength(1);
    // A page following the turn live reads the sentence its saved copy ends on.
    const page = await new ExperienceEvents(handle.db).page(broken.spaceId, 0, row.id);
    expect(
      page.events.filter((entry) => entry.item.type === 'note').map((entry) => entry.item),
    ).toContainEqual(expect.objectContaining({ text: BUNDLE_FAILED_NOTE }));
    // What the person sent is still theirs to read, and to send again: once
    // what broke the build is gone, the next message starts a turn that reads it.
    const [first] = await handle.db
      .select({ text: experienceTurn.text })
      .from(experienceTurn)
      .where(eq(experienceTurn.jobId, row.id));
    expect(first?.text).toBe('Step 1: run the check and tell me what changed.');
    await handle.db
      .delete(event)
      .where(and(eq(event.jobId, row.id), eq(event.dedupKey, `${row.id}:broken-result`)));
    const again = await send(broken, 2);
    const { claimed } = await claim(runner, again);
    if (!claimed) throw new Error('the message sent again was not claimed');
    const read = [...claimed.bundle.transcript, ...claimed.bundle.inputs.new_user_messages].map(
      (message) => message.content,
    );
    expect(read).toContain('Step 1: run the check and tell me what changed.');
    expect(read).toContain('Step 2: run the check and tell me what changed.');
    await answer(runner, claimed, 2);
  }, 60_000);
});
