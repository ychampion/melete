/**
 * A conversation whose first turn left a step on the agent's computer that
 * never reported back. The person answers each question the conversation asks
 * in their own words, as someone busy does ("go ahead"), and each answer is a
 * turn of its own. The conversation must come to rest once every question has
 * been asked once: a later turn that took no open step of its own finishes.
 *
 * Before, a step asked about under another attempt's question (one that had
 * waited behind a question already open, or one a retry of the step's turn
 * asked) held every later turn open. Each turn then asked again, and each
 * answer started the next turn, which wrote the whole reply again.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AttemptBundle,
  type AttemptOutcome,
  dedupKey,
  type EventSink,
  type RuntimeAdapter,
} from '@melete/contracts';
import { asc, eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { action, connection, experienceTurn, job, question, space } from '../../src/db/schema.ts';
import { ExperienceService } from '../../src/experience/service.ts';
import { newId } from '../../src/ids.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { QuestionService } from '../../src/jobs/questions.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, STILL_RUNNING_NOTE } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'repeat-turns-signing-key-32-bytes-long';
const runners: AttemptRunner[] = [];
const LETTER = 'Dear Hiring Manager,\n\nHere is the letter.\n\nSincerely,\nRiya Sharma';
const BUSY = "Go ahead with your best judgement. I can't help further right now.";
/** More answers than any of these conversations should ever ask for. */
const ROUNDS = 6;

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** The agent's own computer, whose commands may reach the network. */
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
 * How the first turn's word count went missing:
 * - `unknown`: its sender went away, and the broker calls it unknown;
 * - `dispatched`: it is still out when the turn ends;
 * - `deferred`: still out, with another question already open, so the
 *   question about it waits and a later turn asks it;
 * - `retried`: still out, and the engine running that turn was lost, so a
 *   retry of the same turn finishes it and asks.
 * - `invalidated`: still out when a policy change fenced the attempt, which
 *   calls the step unknown; a retry of the same turn finishes it and asks.
 */
type Shape = 'unknown' | 'dispatched' | 'deferred' | 'retried' | 'invalidated';

withDb('a conversation over a step that never reported back', () => {
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

  test.each([
    ['unknown', 2],
    ['dispatched', 2],
    ['deferred', 3],
    ['retried', 2],
    ['invalidated', 2],
  ] as const)(
    'answered in your own words, a lost step (%s) is asked about once and the conversation rests',
    async (shape: Shape, turnsExpected) => {
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
      const questions = new QuestionService(jobs, submissions);
      const broker = new BrokerService({
        sql: handle.sql,
        connectors: new ConnectorRegistry().register(connectionId, computer),
      });

      let calls = 0;
      const runtime: RuntimeAdapter = {
        capabilities: async () => ({
          streaming: true,
          tools: true,
          interrupt: false,
          version: 'test',
        }),
        async start(bundle: AttemptBundle, sink: EventSink): Promise<AttemptOutcome> {
          calls++;
          if (calls === 1) {
            // The word count ran on the computer and its result never came back.
            const actionId = newId('act');
            const sessionId = `session_${actionId}`;
            await handle.db.insert(action).values({
              id: actionId,
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
            values (${actionId}, ${sessionId}, ${actionId})`;
            if (shape === 'deferred')
              // Something else is already being asked when the turn ends.
              await handle.db.insert(question).values({
                id: newId('qst'),
                jobId: bundle.attempt.job_id,
                attemptId: bundle.attempt.id,
                text: 'Should I keep your name as Riya Sharma?',
                because: [`attempt:${bundle.attempt.id}`],
                ifIgnored: 'It waits.',
                blocksExternalEffect: false,
                options: [],
              });
            if (shape === 'retried')
              return { kind: 'failed', reason: 'The engine went away.', retryable: true };
            if (shape === 'invalidated') {
              // The attempt is fenced while the step is out, as a context
              // invalidation does; what this engine says after that is refused.
              await jobs.transaction((tx) =>
                new PolicyService(jobs).invalidateInTransaction(
                  tx,
                  spaceId,
                  1,
                  null,
                  'policy_changed',
                  [bundle.attempt.job_id],
                ),
              );
              return { kind: 'completed', summary: LETTER, evidence: [] };
            }
          }
          await sink.emit({
            type: 'text_delta',
            text: LETTER,
            attempt_id: bundle.attempt.id,
            local_seq: 0,
            dedup_key: dedupKey(bundle.attempt.id, 0),
            at: new Date().toISOString(),
          } as never);
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
      if (shape === 'unknown')
        worker.settleAbandoned = (attemptId) => broker.settleAbandoned(attemptId);
      // Runs the conversation until it waits on the person, retries included.
      const run = async (row: JobRow) => {
        let current = row;
        for (let tries = 0; tries < 3 && current.state === 'queued'; tries++) {
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
      const asked: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const open = (
          await handle.db.select().from(question).where(eq(question.jobId, chat.id))
        ).find((row) => row.state === 'open');
        if (!open) break;
        asked.push(open.text);
        const answered = await questions.answer(open.id, { text: BUSY });
        if (answered.job?.state !== 'queued') throw new Error('the answer started no turn');
        await run(answered.job);
      }

      // Each question once, then nothing more to answer.
      expect(asked.length).toBeLessThan(ROUNDS);
      expect(asked.filter((text) => text.includes(STILL_RUNNING_NOTE)).length).toBeLessThanOrEqual(
        1,
      );
      const turns = await handle.db
        .select({ status: experienceTurn.status })
        .from(experienceTurn)
        .where(eq(experienceTurn.jobId, chat.id))
        .orderBy(asc(experienceTurn.createdAt), asc(experienceTurn.id));
      expect(turns).toHaveLength(turnsExpected);
      expect(turns.at(-1)?.status).toBe('done');
      expect((await jobs.get(chat.id)).state).toBe('waiting_for_input');
    },
  );
});
