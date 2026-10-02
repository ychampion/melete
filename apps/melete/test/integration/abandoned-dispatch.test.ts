/**
 * A tool call whose waiter gives up before the broker answers. The runtime
 * stops waiting, reads an unknown result and finishes its answer; the action it
 * started is still dispatched. Before the attempt commits, that action must be
 * settled or waited for, and the turn must never be run again over it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AttemptBundle,
  type AttemptOutcome,
  type DispatchResult,
  dedupKey,
  type EventSink,
  type RuntimeAdapter,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { action, attempt, connection, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { verifyCapability } from '../../src/jobs/capability.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, STILL_RUNNING_NOTE } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'abandoned-dispatch-signing-key-32-bytes';
const runners: AttemptRunner[] = [];
const ANSWER = 'The build finished; here is what it printed.';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** A command that runs until released, as a long sandbox command does. */
function slowCommand() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runs: string[] = [];
  let started: () => void = () => {};
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const connector: Connector = {
    manifest: {
      name: 'slow',
      version: '0.1.0',
      provider: 'test',
      description: 'A command that takes longer than its caller waits.',
      credentials: [],
      health: true,
      tools: [
        {
          name: 'test.slow',
          description: 'Run a slow command.',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
          effect_class: 'write_reversible',
          required_scopes: ['test.slow'],
          verify: false,
          requires_approval: false,
          record_schema: null,
        },
      ],
    },
    dispatchBudgetMs: () => 60_000,
    async execute(proposed): Promise<DispatchResult> {
      runs.push(proposed.id);
      started();
      await released;
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: proposed.id,
          connection_id: proposed.connection_id,
          external_ref: proposed.id,
          late: false,
          received_at: new Date().toISOString(),
          detail: { exit_code: 0 },
        },
      };
    },
    async verify() {
      return { decision: 'unsupported', reason: 'fixture' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
  return { connector, runs, release, dispatched };
}

/**
 * A runtime whose one tool call stops waiting after `waitMs`, as the engine's
 * broker client did at its 30 second socket timeout, then answers.
 */
function impatientRuntime(propose: (bundle: AttemptBundle) => Promise<unknown>, waitMs = 50) {
  const starts: string[] = [];
  const runtime: RuntimeAdapter = {
    capabilities: async () => ({ streaming: true, tools: true, interrupt: false, version: 'test' }),
    async start(bundle: AttemptBundle, sink: EventSink): Promise<AttemptOutcome> {
      starts.push(bundle.attempt.id);
      let seq = 0;
      const send = (body: object) =>
        sink.emit({
          ...body,
          attempt_id: bundle.attempt.id,
          local_seq: seq,
          dedup_key: dedupKey(bundle.attempt.id, seq++),
          at: new Date().toISOString(),
        } as never);
      const call = propose(bundle).catch(() => null);
      await Promise.race([call, new Promise((resolve) => setTimeout(resolve, waitMs))]);
      await send({ type: 'text_delta', text: ANSWER });
      return { kind: 'completed', summary: ANSWER, evidence: [] };
    },
  };
  return { runtime, starts };
}

async function setup() {
  const { handle } = fixture();
  const spaceId = newId('sp');
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  const connectionId = newId('conn');
  await handle.db.insert(connection).values({
    id: connectionId,
    spaceId,
    provider: 'test',
    label: 'Sandbox',
    scopes: ['test.slow'],
  });
  const row = await fixture().jobs.create({
    space_id: spaceId,
    title: 'Build it',
    objective: 'Run the build and say how it went',
  });
  return { spaceId, connectionId, row };
}

function wake(row: JobRow) {
  return {
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'created' as const,
  };
}

function runner(runtime: RuntimeAdapter, dispatchWaitMs?: number) {
  const worker = new AttemptRunner(fixture().jobs, runtime, {
    key,
    scopes: ['test.slow'],
    ...(dispatchWaitMs === undefined ? {} : { dispatchWaitMs }),
  });
  runners.push(worker);
  return worker;
}

async function actions(jobId: string) {
  return fixture().handle.db.select().from(action).where(eq(action.jobId, jobId));
}

async function attempts(jobId: string) {
  return fixture().handle.db.select().from(attempt).where(eq(attempt.jobId, jobId));
}

withDb('an action its tool call stopped waiting for', () => {
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

  test('a command still running is waited for, and the turn completes once with one answer', async () => {
    const { handle, jobs } = fixture();
    const slow = slowCommand();
    const { connectionId, row } = await setup();
    const registry = new ConnectorRegistry().register(connectionId, slow.connector);
    const live = new BrokerService({ sql: handle.sql, connectors: registry });
    // The call gives up as soon as the command is running in the sandbox.
    const { runtime, starts } = impatientRuntime(async (bundle) => {
      void live
        .propose(verifyCapability(bundle.attempt.token, key), {
          connection_id: connectionId,
          kind: 'test.slow',
          payload: { command: 'make' },
        })
        .catch(() => {});
      await slow.dispatched;
    }, 10_000);
    const worker = runner(runtime);
    worker.settleAbandoned = (attemptId) => live.settleAbandoned(attemptId);
    // The command finishes a moment after the runtime has given up on it.
    setTimeout(() => slow.release(), 400);
    await worker.handleWake(wake(row));

    expect(starts).toHaveLength(1);
    expect(slow.runs).toHaveLength(1);
    const [ran] = await actions(row.id);
    expect(ran?.status).toBe('succeeded');
    const job = await jobs.get(row.id);
    expect(job.state).not.toBe('queued');
    expect(job.state).toBe('completed');
    const [only] = await attempts(row.id);
    expect(only?.outcome).toBe('completed');
    const deltas = await handle.sql`select payload->>'text' as text from event
      where job_id = ${row.id} and type = 'text_delta'`;
    expect(deltas.map((delta) => delta.text)).toEqual([ANSWER]);
  });

  test('a dispatch nobody is sending any more is settled as unknown, not run again', async () => {
    const { handle, jobs } = fixture();
    const { connectionId, row } = await setup();
    const registry = new ConnectorRegistry().register(connectionId, slowCommand().connector);
    const broker = new BrokerService({ sql: handle.sql, connectors: registry });
    // The action was claimed and its sender went away: dispatched, and no
    // process is waiting on it.
    const { runtime, starts } = impatientRuntime(async (bundle) => {
      await handle.db.insert(action).values({
        id: newId('act'),
        jobId: bundle.attempt.job_id,
        attemptId: bundle.attempt.id,
        connectionId,
        kind: 'test.slow',
        effectClass: 'write_reversible',
        canonicalPayload: { command: 'make' },
        payloadHash: 'a'.repeat(64),
        idempotencyKey: newId('act'),
        status: 'dispatched',
        dispatchedAt: new Date(),
      });
    }, 1_000);
    const worker = runner(runtime);
    worker.settleAbandoned = (attemptId) => broker.settleAbandoned(attemptId);
    await worker.handleWake(wake(row));

    expect(starts).toHaveLength(1);
    const [left] = await actions(row.id);
    expect(left?.status).toBe('unknown');
    const job = await jobs.get(row.id);
    expect(job.state).toBe('needs_reconciliation');
    expect(await attempts(row.id)).toHaveLength(1);
  });

  test('past the wait, an action still out rests the turn on its answer instead of re-running it', async () => {
    const { handle, jobs } = fixture();
    const { connectionId, row } = await setup();
    const { runtime, starts } = impatientRuntime(async (bundle) => {
      await handle.db.insert(action).values({
        id: newId('act'),
        jobId: bundle.attempt.job_id,
        attemptId: bundle.attempt.id,
        connectionId,
        kind: 'test.slow',
        effectClass: 'write_reversible',
        canonicalPayload: { command: 'make' },
        payloadHash: 'b'.repeat(64),
        idempotencyKey: newId('act'),
        status: 'dispatched',
        dispatchedAt: new Date(),
      });
    }, 1_000);
    // No broker in this process to settle it, and a short wait.
    const worker = runner(runtime, 300);
    await worker.handleWake(wake(row));

    expect(starts).toHaveLength(1);
    const job = await jobs.get(row.id);
    expect(job.state).toBe('waiting_for_input');
    expect(job.wait).toMatchObject({ kind: 'user_input', question: STILL_RUNNING_NOTE });
    const [only] = await attempts(row.id);
    expect(only?.outcome).toBe('waiting_for_input');
    expect(await attempts(row.id)).toHaveLength(1);
  });
});
