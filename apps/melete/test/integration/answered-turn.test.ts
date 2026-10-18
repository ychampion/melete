/**
 * A conversation turn whose answer reached the person while a step it started
 * (a word count on the agent's computer) was still out. A later attempt of
 * the same turn must not send that answer again:
 *
 * - the step went through after the answer: nothing runs again, the step
 *   shows on the turn's record, and the question about it is withdrawn;
 * - the step failed after the answer: a follow-up runs, shown what was
 *   already said, and adds only what changed;
 * - the engine failed after the answer and the turn runs again: the retry is
 *   shown what was already said and carries on from it.
 *
 * The scripted engine answers the person's request whenever nothing tells it
 * the turn was answered, as a model reading the request alone does. Before,
 * every one of these sent the letter twice.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AttemptBundle,
  type AttemptOutcome,
  dedupKey,
  type EventSink,
  type RuntimeAdapter,
} from '@melete/contracts';
import { ANSWERED_QUESTION, renderInput, SAID_THEN_WROTE } from '@melete/runtime-hermes';
import { and, eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import {
  action,
  connection,
  event,
  experienceTurn,
  job,
  question,
  space,
} from '../../src/db/schema.ts';
import { ExperienceService } from '../../src/experience/service.ts';
import { newId } from '../../src/ids.ts';
import { QuestionService, withdrawSettledQuestion } from '../../src/jobs/questions.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { RUNAWAY_NOTE } from '../../src/jobs/runaway.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'answered-turn-signing-key-32-bytes-long';
const runners: AttemptRunner[] = [];
const LETTER =
  'Dear Hiring Manager,\n\nHere is the letter. I admire [something about the company].\n\nSincerely,\nRiya Sharma';
/** The letter with its marked gap filled in, which the person's answer allowed. */
const FILLED =
  'Dear Hiring Manager,\n\nHere is the letter. I admire your fresh food.\n\nSincerely,\nRiya Sharma';
/** Told what the person already has, the agent says first what changed. */
const UPDATE = `Here is the letter with the gap filled in.\n\n${FILLED}`;
const ANSWER = "Go ahead with your best judgement. I can't help further right now.";
const FOLLOW_UP = 'The word count did not run, so I could not confirm the length.';
const STEER = 'Also, can you make it a little warmer?';
const STEER_REPLY =
  'Here is a warmer closing line: I would love to bring this energy to your team.';
/** One paragraph of a reply gone round in a loop, long enough to count as one. */
const LOOPED =
  'This paragraph is written the same way every time, word for word, because the reply has fallen into a loop and keeps going on and on. '.repeat(
    5,
  );

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** The agent's own computer, with network access, so an unsure step is asked about. */
const computer: Connector = {
  manifest: {
    name: 'computer',
    version: '0.1.0',
    provider: 'test',
    description: "The agent's computer.",
    credentials: [],
    health: true,
    tools: [
      {
        name: 'test.exec',
        description: 'Run a command.',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        effect_class: 'write_reversible',
        required_scopes: ['test.exec'],
        verify: false,
        requires_approval: false,
        record_schema: null,
      },
      {
        name: 'test.count',
        description: 'Count the words in a file.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        effect_class: 'read',
        required_scopes: ['test.exec'],
        verify: false,
        requires_approval: false,
        record_schema: null,
      },
    ],
  },
  ownComputer: true,
  dispatchBudgetMs: () => 60_000,
  async execute() {
    throw new Error('not run here');
  },
  async verify() {
    return { decision: 'unsupported', reason: 'fixture' };
  },
  async health() {
    return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
  },
};

/**
 * - `went_through` / `failed`: the step's sender let go of it, so it is unsure
 *   when the turn ends, and its result lands later;
 * - `lost`: the engine failed after the answer, with the step still out, and
 *   the turn is retried.
 * - `steered`: the step went through, and the person wrote again while the
 *   step was still out, words the answer never read;
 * - `refenced`: the step failed, and the follow-up's engine went away part way
 *   through its first words, so the follow-up is run once more;
 * - `looping`: `lost`, and the retry falls into repeating one paragraph;
 * - `two_through` / `two_one_failed`: two steps out, both going through, or
 *   the second failing after the first went through.
 * - `answered`: the step never reports back, and the person types an answer to
 *   the question the turn rests on, which opens a new turn.
 * - `answered_lost`: `answered`, and the new turn's first attempt is lost
 *   before it says a word, so a retry that has read the message runs it.
 * - `read_only` / `read_and_effect`: the step left out is a read-only check,
 *   alone or beside a step with effects.
 */
type Shape =
  | 'went_through'
  | 'failed'
  | 'lost'
  | 'steered'
  | 'refenced'
  | 'looping'
  | 'two_through'
  | 'two_one_failed'
  | 'answered'
  | 'answered_lost'
  | 'spoofed'
  | 'read_only'
  | 'read_and_effect';
const FAILS = new Set<Shape>(['failed', 'refenced', 'two_one_failed']);
const RETRIED = new Set<Shape>(['lost', 'looping']);
/** A read-only check left out when the turn ended, alone or beside a step with effects. */
const READS = new Set<Shape>(['read_only', 'read_and_effect']);

withDb('a turn answered while a step it started was still out', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await resetTestRows(handle.sql);
  });

  afterEach(async () => {
    for (const worker of runners.splice(0)) await worker.stop();
  });

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  async function converse(shape: Shape) {
    const { handle, jobs } = fixture();
    const spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    const connectionId = newId('conn');
    await handle.db.insert(connection).values({
      id: connectionId,
      spaceId,
      provider: 'test',
      label: 'Computer',
      scopes: ['test.exec'],
    });
    const submissions = new SubmissionService(jobs);
    const experience = new ExperienceService(handle.db, jobs, submissions);
    const melete = await experience.defaultAgent(spaceId);
    const chat = await jobs.transaction((tx) =>
      jobs.createInTransaction(
        tx,
        { space_id: spaceId, title: 'Cover letter', objective: 'Talk' },
        { kind: 'chat' },
      ),
    );
    await handle.db.update(job).set({ agentId: melete.id }).where(eq(job.id, chat.id));
    const broker = new BrokerService({
      sql: handle.sql,
      connectors: new ConnectorRegistry().register(connectionId, computer),
    });

    const bundles: AttemptBundle[] = [];
    const steps: string[] = [];
    const pieces = new Map<string, number>();
    const say = (bundle: AttemptBundle, sink: EventSink, text: string) => {
      const at = pieces.get(bundle.attempt.id) ?? 0;
      pieces.set(bundle.attempt.id, at + 1);
      return sink.emit({
        type: 'text_delta',
        text,
        attempt_id: bundle.attempt.id,
        local_seq: at,
        dedup_key: dedupKey(bundle.attempt.id, at),
        at: new Date().toISOString(),
      } as never);
    };
    const runtime: RuntimeAdapter = {
      capabilities: async () => ({
        streaming: true,
        tools: true,
        interrupt: false,
        version: 'test',
      }),
      async start(bundle: AttemptBundle, sink: EventSink): Promise<AttemptOutcome> {
        bundles.push(bundle);
        if (bundles.length > 1) {
          // The person answered the question the letter's turn rested on: told
          // they have the letter, the agent says first what it changed; not
          // told, it reads the answer as a go-ahead and sends the letter again.
          // The answer's first attempt is lost before it says a word, and the
          // turn runs again with the message already read.
          if (shape === 'answered_lost' && bundles.length === 2)
            throw new Error('The engine went away.');
          if (shape === 'answered' || shape === 'answered_lost' || shape === 'spoofed') {
            const reply = bundle.inputs.answered_question?.said.includes('Dear Hiring Manager')
              ? UPDATE
              : FILLED;
            await say(bundle, sink, reply);
            return { kind: 'completed', summary: reply, evidence: [] };
          }
          // A message the person sent since is answered whatever else was said.
          if (bundle.inputs.new_user_messages.some((message) => message.content.includes(STEER))) {
            await say(bundle, sink, STEER_REPLY);
            return { kind: 'completed', summary: STEER_REPLY, evidence: [] };
          }
          // Told the letter reached the person, it adds only what changed.
          if (bundle.inputs.said_this_turn?.includes('Dear Hiring Manager')) {
            if (shape === 'refenced' && bundles.length === 2) {
              await say(bundle, sink, 'The word count');
              throw new Error('The engine went away.');
            }
            if (shape === 'looping') {
              for (let copy = 0; copy < 6; copy++) await say(bundle, sink, `${LOOPED}\n\n`);
              return { kind: 'completed', summary: LOOPED.repeat(6), evidence: [] };
            }
            if (!FAILS.has(shape)) return { kind: 'completed', summary: '', evidence: [] };
            await say(bundle, sink, FOLLOW_UP);
            return { kind: 'completed', summary: FOLLOW_UP, evidence: [] };
          }
          await say(bundle, sink, LETTER);
          return { kind: 'completed', summary: LETTER, evidence: [] };
        }
        await say(bundle, sink, LETTER);
        // The word count, sent and still out when the letter is written.
        const sessionId = `session_${bundle.attempt.id}`;
        for (
          let count = shape.startsWith('two_') || shape === 'read_and_effect' ? 2 : 1;
          count > 0;
          count--
        ) {
          const stepId = newId('act');
          steps.push(stepId);
          const read = shape === 'read_only' || (shape === 'read_and_effect' && count === 2);
          await handle.db.insert(action).values({
            id: stepId,
            jobId: bundle.attempt.job_id,
            attemptId: bundle.attempt.id,
            connectionId,
            kind: read ? 'test.count' : 'test.exec',
            effectClass: read ? 'read' : 'write_reversible',
            canonicalPayload: { command: `python3 count.py ${count}` },
            payloadHash: String(count).repeat(64),
            idempotencyKey: newId('act'),
            status: 'dispatched',
            dispatchedAt: new Date(),
          });
          await handle.sql`insert into sandbox_session (id, connection_id, space_id, job_id,
              attempt_id, adapter, provider_sandbox_id, image_ref, egress_policy, persistence,
              status, lease_expires_at)
            values (${sessionId}, ${connectionId}, ${spaceId}, ${bundle.attempt.job_id},
              ${bundle.attempt.id}, 'fake', ${sessionId}, 'image',
              ${JSON.stringify({ kind: 'open' })}::jsonb, 'ephemeral', 'ready',
              now() + interval '10 minutes')
            on conflict do nothing`;
          await handle.sql`insert into sandbox_command (action_id, session_id, marker)
            values (${stepId}, ${sessionId}, ${stepId})`;
        }
        // Words the person sends while the turn is still running, after its answer.
        if (shape === 'steered') await jobs.steer(chat.id, { id: 'steer-warmer', text: STEER });
        if (RETRIED.has(shape))
          return { kind: 'failed', reason: 'The engine went away.', retryable: true };
        return { kind: 'completed', summary: LETTER, evidence: [] };
      },
    };
    const worker = new AttemptRunner(jobs, runtime, {
      key,
      scopes: ['test.exec'],
      dispatchWaitMs: 200,
      retryBackoffMs: 1,
    });
    runners.push(worker);
    // The step's sender has let go of it, as a tool call that ended does.
    if (!RETRIED.has(shape))
      worker.settleAbandoned = (attemptId) => broker.settleAbandoned(attemptId);
    // Runs the conversation until it waits on the person, retries included.
    const run = async (row: JobRow) => {
      let current = row;
      for (let tries = 0; tries < 4 && current.state === 'queued'; tries++) {
        if (current.nextWakeAt)
          await Bun.sleep(Math.max(0, current.nextWakeAt.getTime() - Date.now()) + 20);
        await worker.handleWake({
          job_id: current.id,
          expected_epoch: current.leaseEpoch,
          expected_version: current.stateVersion,
          reason: 'created',
        });
        current = await jobs.get(current.id);
      }
      return current;
    };

    const sent = await submissions.input(chat.id, {
      text: 'Write a 200-word cover letter. Sign it Riya Sharma.',
    });
    if (!sent.job) throw new Error(`message refused: ${JSON.stringify(sent.error)}`);
    await run(sent.job);
    if (shape === 'answered' || shape === 'answered_lost') {
      // The step never reports back; the person types an answer to the
      // question the turn rests on, as a reply box under it lets them.
      const [asked] = await handle.db
        .select({ id: question.id })
        .from(question)
        .where(and(eq(question.jobId, chat.id), eq(question.state, 'open')));
      if (!asked) throw new Error('the turn did not rest on a question');
      const answered = await new QuestionService(jobs, submissions).answer(asked.id, {
        text: ANSWER,
      });
      if (!answered.job) throw new Error(`answer refused: ${JSON.stringify(answered.error)}`);
      await run(answered.job);
    } else if (shape === 'spoofed') {
      // The person writes something else, which withdraws the question; then a
      // message arrives under the key an answer to it would have carried.
      const [asked] = await handle.db
        .select({ id: question.id })
        .from(question)
        .where(and(eq(question.jobId, chat.id), eq(question.state, 'open')));
      if (!asked) throw new Error('the turn did not rest on a question');
      const other = await submissions.input(chat.id, { text: 'Thanks, that is all for now.' });
      if (!other.job) throw new Error(`message refused: ${JSON.stringify(other.error)}`);
      await run(other.job);
      const crafted = await submissions.input(chat.id, { text: ANSWER }, `q:${asked.id}`);
      if (!crafted.job) throw new Error(`message refused: ${JSON.stringify(crafted.error)}`);
      await run(crafted.job);
    } else if (!RETRIED.has(shape) && !READS.has(shape)) {
      // The word count reports back after the turn ended; of two, the last one fails.
      for (const [index, stepId] of steps.entries()) {
        const fails = FAILS.has(shape) && index === steps.length - 1;
        await broker.recordResult(
          stepId,
          fails
            ? { outcome: 'failed', reason: 'python3: command not found', retryable: false }
            : {
                outcome: 'succeeded',
                receipt: {
                  action_id: stepId,
                  connection_id: connectionId,
                  external_ref: null,
                  detail: { stdout: '207' },
                  received_at: new Date().toISOString(),
                  late: false,
                },
              },
        );
        if (index < steps.length - 1) {
          // Nothing wakes the turn while another step is still out, and its
          // question stays: answering it is what settles that step.
          expect((await jobs.get(chat.id)).state).not.toBe('queued');
          await jobs.transaction((tx) => withdrawSettledQuestion(tx, chat.id));
          const asked = await handle.db
            .select({ id: question.id })
            .from(question)
            .where(and(eq(question.jobId, chat.id), eq(question.state, 'open')));
          expect(asked).toHaveLength(1);
        }
      }
      await run(await jobs.get(chat.id));
    }

    const streamed = await handle.db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.jobId, chat.id), eq(event.type, 'text_delta')));
    const turns = await handle.db
      .select()
      .from(experienceTurn)
      .where(eq(experienceTurn.jobId, chat.id))
      .orderBy(experienceTurn.createdAt);
    const [turn] = turns;
    const open = await handle.db
      .select({ text: question.text })
      .from(question)
      .where(and(eq(question.jobId, chat.id), eq(question.state, 'open')));
    const stepRows = await handle.db
      .select({ id: action.id, kind: action.kind, status: action.status })
      .from(action)
      .where(eq(action.jobId, chat.id));
    return {
      steps: stepRows,
      bundles,
      letters: streamed.filter((row) =>
        String((row.payload as { text?: unknown }).text).includes('Dear Hiring Manager'),
      ).length,
      turn,
      turns,
      open,
      state: (await jobs.get(chat.id)).state,
    };
  }

  test('an answer to the question a letter rested on gets an update, not the letter again', async () => {
    const { bundles, turns } = await converse('answered');
    expect(bundles).toHaveLength(2);
    // The answer opened a turn of its own, with the person's words in it.
    expect(turns).toHaveLength(2);
    const [message] = bundles[1]?.inputs.new_user_messages ?? [];
    expect(message?.content).toContain(ANSWER);
    // That turn's attempt is told the question the answer is to, and the
    // letter the person already has.
    const answered = bundles[1]?.inputs.answered_question;
    expect(answered?.question).toContain('could not confirm');
    expect(answered?.said).toContain('Dear Hiring Manager');
    expect(answered?.said).toContain('[something about the company]');
    expect(renderInput(bundles[1] as AttemptBundle)).toContain(ANSWERED_QUESTION);
    // The letter's turn keeps the letter; the next one says first what changed.
    expect(turns[0]?.answer.split('Dear Hiring Manager')).toHaveLength(2);
    expect(turns[1]?.answer.startsWith('Here is the letter with the gap filled in.')).toBe(true);
    expect(turns[1]?.answer.split('Dear Hiring Manager')).toHaveLength(2);
  });

  test('an answer whose first attempt was lost is still told what the person has', async () => {
    const { bundles, turns } = await converse('answered_lost');
    expect(bundles).toHaveLength(3);
    // The retry has read the message already; it is still the turn that answers.
    expect(bundles[2]?.inputs.new_user_messages).toEqual([]);
    expect(bundles[2]?.inputs.answered_question?.said).toContain('Dear Hiring Manager');
    expect(turns).toHaveLength(2);
    expect(turns[1]?.answer.startsWith('Here is the letter with the gap filled in.')).toBe(true);
  });

  test('a message carrying an answer key is not taken for the answer it was not', async () => {
    const { bundles } = await converse('spoofed');
    expect(bundles).toHaveLength(3);
    const [message] = bundles[2]?.inputs.new_user_messages ?? [];
    expect(message?.content).toContain(ANSWER);
    // The question was withdrawn by the message before; it answered nothing.
    expect(bundles[1]?.inputs.answered_question).toBeUndefined();
    expect(bundles[2]?.inputs.answered_question).toBeUndefined();
  });

  test('a read-only check that never reported back is not asked about', async () => {
    const { bundles, letters, turn, open, state, steps } = await converse('read_only');
    expect(bundles).toHaveLength(1);
    expect(letters).toBe(1);
    expect(open).toEqual([]);
    expect(turn?.status).toBe('done');
    expect(state).toBe('waiting_for_input');
    expect(steps.map((step) => step.status)).toEqual(['failed']);
  });

  test('beside a step with effects, the question names only that step', async () => {
    const { open, steps } = await converse('read_and_effect');
    expect(open).toHaveLength(1);
    expect(steps.find((step) => step.kind === 'test.count')?.status).toBe('failed');
    expect(steps.find((step) => step.kind === 'test.exec')?.status).toBe('unknown');
    // One step named, the one that may have changed something.
    expect(open[0]?.text.startsWith('Step: ')).toBe(true);
  });

  test('a step that went through after the answer runs nothing again', async () => {
    const { bundles, letters, turn, open, state } = await converse('went_through');
    // One engine run: the step's result is on the record, and the answer stands.
    expect(bundles).toHaveLength(1);
    expect(letters).toBe(1);
    expect(turn?.status).toBe('done');
    expect(turn?.answer.split('Dear Hiring Manager')).toHaveLength(2);
    // Nothing is left to ask about a step that went through.
    expect(open).toEqual([]);
    expect(state).toBe('waiting_for_input');
  });

  test('a step that failed after the answer gets a follow-up that knows the answer', async () => {
    const { bundles, letters, turn, open } = await converse('failed');
    expect(bundles).toHaveLength(2);
    // The step settled, so its question is gone even though a follow-up ran.
    expect(open).toEqual([]);
    expect(bundles[1]?.inputs.said_this_turn).toContain('Dear Hiring Manager');
    expect(bundles[1]?.inputs.new_user_messages).toEqual([]);
    expect(letters).toBe(1);
    expect(turn?.answer).toContain('Dear Hiring Manager');
    expect(turn?.answer).toContain(FOLLOW_UP);
  });

  test('a turn retried after its answer runs again from what it said', async () => {
    const { bundles, letters, turn } = await converse('lost');
    expect(bundles).toHaveLength(2);
    expect(bundles[1]?.inputs.said_this_turn).toBe(LETTER);
    expect(letters).toBe(1);
    // The letter the person was shown stays the turn's answer.
    expect(turn?.answer.split('Dear Hiring Manager')).toHaveLength(2);
  });

  test('words the person sent while the step was out are answered, not settled away', async () => {
    const { bundles, letters, turn, open } = await converse('steered');
    // The step went through, but the wake carries the person's words: an engine runs.
    expect(bundles).toHaveLength(2);
    const [message] = bundles[1]?.inputs.new_user_messages ?? [];
    expect(message?.content).toContain(STEER);
    expect(bundles[1]?.inputs.said_this_turn).toContain('Dear Hiring Manager');
    // It is told the letter does not answer them.
    expect(renderInput(bundles[1] as AttemptBundle)).toContain(SAID_THEN_WROTE);
    expect(letters).toBe(1);
    expect(turn?.answer.split('Dear Hiring Manager')).toHaveLength(2);
    expect(turn?.answer).toContain(STEER_REPLY);
    expect(open).toEqual([]);
  });

  test('a follow-up lost part way keeps the answer it followed', async () => {
    const { bundles, letters, turn } = await converse('refenced');
    expect(bundles).toHaveLength(3);
    // The retry is told everything the person has, the lost attempt's words included.
    expect(bundles[2]?.inputs.said_this_turn).toContain('Dear Hiring Manager');
    expect(bundles[2]?.inputs.said_this_turn).toContain('The word count');
    expect(letters).toBe(1);
    // Only a lost attempt's own words are ever taken back, never the answer before it.
    expect(turn?.answer.split('Dear Hiring Manager')).toHaveLength(2);
    expect(turn?.answer).toContain(FOLLOW_UP);
  });

  test('a retry that loops is cut back after the answer it carried on from', async () => {
    const { bundles, turn } = await converse('looping');
    expect(bundles).toHaveLength(2);
    expect(turn?.answer.split('Dear Hiring Manager')).toHaveLength(2);
    // The saved turn keeps the first copy and the line that says why it stopped.
    expect(turn?.answer.split(LOOPED.trim())).toHaveLength(2);
    expect(turn?.answer).toContain(RUNAWAY_NOTE);
  });

  test('two steps that went through after the answer run nothing again', async () => {
    const { bundles, letters, open, state } = await converse('two_through');
    expect(bundles).toHaveLength(1);
    expect(letters).toBe(1);
    expect(open).toEqual([]);
    expect(state).toBe('waiting_for_input');
  });

  test('of two steps, the one that failed last gets the follow-up', async () => {
    const { bundles, letters, turn } = await converse('two_one_failed');
    expect(bundles).toHaveLength(2);
    expect(letters).toBe(1);
    expect(turn?.answer.split('Dear Hiring Manager')).toHaveLength(2);
    expect(turn?.answer).toContain(FOLLOW_UP);
  });
});
