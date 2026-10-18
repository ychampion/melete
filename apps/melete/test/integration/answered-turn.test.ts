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
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
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
const LETTER = 'Dear Hiring Manager,\n\nHere is the letter.\n\nSincerely,\nRiya Sharma';
const FOLLOW_UP = 'The word count did not run, so I could not confirm the length.';

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
 */
type Shape = 'went_through' | 'failed' | 'lost';

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
    let stepId = '';
    const say = (bundle: AttemptBundle, sink: EventSink, text: string) =>
      sink.emit({
        type: 'text_delta',
        text,
        attempt_id: bundle.attempt.id,
        local_seq: 0,
        dedup_key: dedupKey(bundle.attempt.id, 0),
        at: new Date().toISOString(),
      } as never);
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
          // Told the letter reached the person, it adds only what changed.
          if (bundle.inputs.said_this_turn?.includes('Dear Hiring Manager')) {
            if (shape !== 'failed') return { kind: 'completed', summary: '', evidence: [] };
            await say(bundle, sink, FOLLOW_UP);
            return { kind: 'completed', summary: FOLLOW_UP, evidence: [] };
          }
          await say(bundle, sink, LETTER);
          return { kind: 'completed', summary: LETTER, evidence: [] };
        }
        await say(bundle, sink, LETTER);
        // The word count, sent and still out when the letter is written.
        stepId = newId('act');
        const sessionId = `session_${stepId}`;
        await handle.db.insert(action).values({
          id: stepId,
          jobId: bundle.attempt.job_id,
          attemptId: bundle.attempt.id,
          connectionId,
          kind: 'test.exec',
          effectClass: 'write_reversible',
          canonicalPayload: { command: 'python3 count.py' },
          payloadHash: 'a'.repeat(64),
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
            now() + interval '10 minutes')`;
        await handle.sql`insert into sandbox_command (action_id, session_id, marker)
          values (${stepId}, ${sessionId}, ${stepId})`;
        if (shape === 'lost')
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
    if (shape !== 'lost') worker.settleAbandoned = (attemptId) => broker.settleAbandoned(attemptId);
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
    if (shape !== 'lost') {
      // The word count reports back after the turn ended.
      await broker.recordResult(
        stepId,
        shape === 'went_through'
          ? {
              outcome: 'succeeded',
              receipt: {
                action_id: stepId,
                connection_id: connectionId,
                external_ref: null,
                detail: { stdout: '207' },
                received_at: new Date().toISOString(),
                late: false,
              },
            }
          : { outcome: 'failed', reason: 'python3: command not found', retryable: false },
      );
      await run(await jobs.get(chat.id));
    }

    const streamed = await handle.db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.jobId, chat.id), eq(event.type, 'text_delta')));
    const [turn] = await handle.db
      .select()
      .from(experienceTurn)
      .where(eq(experienceTurn.jobId, chat.id));
    const open = await handle.db
      .select({ text: question.text })
      .from(question)
      .where(and(eq(question.jobId, chat.id), eq(question.state, 'open')));
    return {
      bundles,
      letters: streamed.filter((row) =>
        String((row.payload as { text?: unknown }).text).includes('Dear Hiring Manager'),
      ).length,
      turn,
      open,
      state: (await jobs.get(chat.id)).state,
    };
  }

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
    const { bundles, letters, turn } = await converse('failed');
    expect(bundles).toHaveLength(2);
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
});
