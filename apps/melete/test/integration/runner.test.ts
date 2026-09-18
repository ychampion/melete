import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AttemptBundle,
  type AttemptOutcome,
  attemptBundle,
  type CreateJobRequest,
  dedupKey,
  type RuntimeEvent,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { ServiceError } from '../../src/api/errors.ts';
import { action, artifact, attempt, connection, event, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { bootstrap } from '../../src/index.ts';
import { verifyCapability } from '../../src/jobs/capability.ts';
import { recordReceipt, requireCurrentAttempt, withCapability } from '../../src/jobs/fence.ts';
import { type AttemptWake, QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, type ClaimedAttempt, type RunnerOptions } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter, type StubStep } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'runner-integration-signing-key-32-bytes';
const runners: AttemptRunner[] = [];
let spaceId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

function runner(runtime = new StubRuntimeAdapter(), options: Partial<RunnerOptions> = {}) {
  const result = new AttemptRunner(fixture().jobs, runtime, { key, ...options });
  runners.push(result);
  return result;
}

function create(steps: StubStep[] = [], options: Partial<CreateJobRequest> = {}) {
  return fixture().jobs.create({
    space_id: spaceId,
    title: 'Runner integration',
    objective: 'Complete one durable responsibility',
    ...options,
    constraints: { ...options.constraints, notes: JSON.stringify({ script: steps }) },
  });
}

function wake(row: JobRow): AttemptWake {
  return {
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'created',
  };
}

async function claim(worker: AttemptRunner, row: JobRow): Promise<ClaimedAttempt> {
  const claimed = await worker.claim(wake(row));
  if (!claimed) throw new Error('Expected an admitted attempt');
  return claimed;
}

async function rejects(operation: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).code).toBe(code);
}

function completion(evidence: Extract<AttemptOutcome, { kind: 'completed' }>['evidence'] = []) {
  return { kind: 'completed' as const, summary: 'The requested result is ready.', evidence };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeEvent(claimed: ClaimedAttempt, seq: number, body: object): RuntimeEvent {
  return {
    ...body,
    attempt_id: claimed.claims.attempt_id,
    local_seq: seq,
    dedup_key: dedupKey(claimed.claims.attempt_id, seq),
    at: new Date().toISOString(),
  } as RuntimeEvent;
}

async function execution(id: string) {
  const [row] = await fixture().handle.db.select().from(attempt).where(eq(attempt.id, id));
  if (!row) throw new Error('Attempt not found');
  return row;
}

async function effect(claimed: ClaimedAttempt, status: string) {
  const { handle } = fixture();
  const connectionId = newId('conn');
  const id = newId('act');
  await handle.db.insert(connection).values({
    id: connectionId,
    spaceId,
    provider: 'test',
    label: 'Scripted effect',
  });
  await handle.db.insert(action).values({
    id,
    jobId: claimed.claims.job_id,
    attemptId: claimed.claims.attempt_id,
    connectionId,
    kind: 'test.effect',
    effectClass: 'write_external',
    canonicalPayload: {},
    payloadHash: 'a'.repeat(64),
    idempotencyKey: id,
    status,
    ...(status === 'succeeded'
      ? {
          receipt: {
            action_id: id,
            connection_id: connectionId,
            external_ref: 'test-effect',
            detail: {},
            received_at: new Date().toISOString(),
            late: false,
          },
        }
      : {}),
  });
  return id;
}

withDb('attempt runner against Postgres and pg-boss', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await queue.boss.deleteAllJobs(QUEUES.recoveryScan);
    await resetTestRows(handle.sql);
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  });

  afterEach(async () => {
    for (const worker of runners.splice(0)) await worker.stop();
  });

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  const outcomes: Array<{ outcome: AttemptOutcome; state: string }> = [
    { outcome: completion(), state: 'completed' },
    {
      outcome: {
        kind: 'unknown_check',
        check: 'parked_actions',
        reason: 'timed_out',
        message: 'The parked-action check timed out.',
      },
      state: 'waiting_for_input',
    },
    {
      outcome: { kind: 'waiting_for_input', question: 'Which date?', draft: 'Draft answer' },
      state: 'waiting_for_input',
    },
    {
      outcome: { kind: 'waiting_for_approval', action_ids: [newId('act')] },
      state: 'waiting_for_approval',
    },
    {
      outcome: {
        kind: 'waiting_for_event_or_time',
        wait: { kind: 'timer', wake_at: new Date(Date.now() + 60_000).toISOString() },
      },
      state: 'waiting_for_event_or_time',
    },
    { outcome: { kind: 'failed', reason: 'Scripted failure', retryable: false }, state: 'failed' },
    { outcome: { kind: 'budget_exhausted', summary: 'No budget left' }, state: 'failed' },
  ];

  test.each(outcomes)(
    'commits the stub outcome $outcome.kind as $state',
    async ({ outcome, state }) => {
      const { jobs, handle } = fixture();
      const row = await create([{ type: 'outcome', outcome }]);
      await runner().handleWake(wake(row));
      const updated = await jobs.get(row.id);
      expect(updated.state).toBe(state);
      expect(updated.leaseEpoch).toBe(1);
      expect(updated.stateVersion).toBe(2);
      const [saved] = await handle.db.select().from(attempt).where(eq(attempt.jobId, row.id));
      expect(saved?.outcome).toBe(outcome.kind);
      expect(saved?.outcomeDetail).toEqual(outcome);
      expect(saved?.leaseStatus).toBe('ended');
      expect(saved?.endedAt).toBeInstanceOf(Date);
      expect(saved?.leaseExpiresAt).toBeNull();
      if (outcome.kind === 'unknown_check') {
        expect(updated.wait).toEqual({ kind: 'user_input', question: outcome.message });
        expect(updated.nextWakeAt).toBeNull();
        const wakes =
          await handle.sql`select id from pgboss.job where data->>'job_id' = ${row.id} and (data->>'expected_version')::int = 2`;
        expect(wakes).toHaveLength(0);
      } else if (outcome.kind === 'waiting_for_input') {
        expect(updated.wait).toEqual({ kind: 'user_input', question: outcome.question });
      } else if (outcome.kind === 'waiting_for_approval') {
        expect(updated.wait).toEqual({ kind: 'approval', action_ids: outcome.action_ids });
      } else if (outcome.kind === 'waiting_for_event_or_time') {
        expect(updated.wait).toEqual(outcome.wait);
        if (outcome.wait.kind !== 'timer') throw new Error('Expected timer fixture');
        expect(updated.nextWakeAt?.toISOString()).toBe(outcome.wait.wake_at);
        const wakes =
          await handle.sql`select id from pgboss.job where data->>'job_id' = ${row.id} and (data->>'expected_version')::int = 2`;
        expect(wakes).toHaveLength(1);
      } else expect(updated.nextWakeAt).toBeNull();
    },
  );

  test('duplicate wakes admit one attempt with a signed bundle and increment the epoch once', async () => {
    const { jobs, handle } = fixture();
    const row = await create();
    const worker = runner(undefined, { scopes: ['test.read'] });
    const claims = await Promise.all([worker.claim(wake(row)), worker.claim(wake(row))]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const admitted = claims.find((value) => value !== null);
    if (!admitted) throw new Error('No attempt admitted');
    expect(attemptBundle.safeParse(admitted.bundle).success).toBe(true);
    expect(verifyCapability(admitted.bundle.attempt.token, key)).toEqual(admitted.claims);
    expect(admitted.claims).toMatchObject({
      job_id: row.id,
      epoch: 1,
      revision: 0,
      scopes: ['test.read'],
    });
    expect(admitted.claims.exp - Math.floor(Date.now() / 1000)).toBeWithin(1795, 1801);
    expect(admitted.bundle.workspace.mount).toBe('/work');
    expect(admitted.bundle.tools).toEqual([]);
    expect(admitted.bundle.skills).toEqual([]);
    expect(admitted.bundle.knowledge).toEqual([]);
    expect((await jobs.get(row.id)).leaseEpoch).toBe(1);
    expect(await handle.db.select().from(attempt).where(eq(attempt.jobId, row.id))).toHaveLength(1);
  });

  test('a separately locked job is skipped without holding the worker open', async () => {
    const { handle } = fixture();
    const row = await create();
    const locked = await handle.sql.reserve();
    try {
      await locked`begin`;
      // Deliberately take only the row lock, not the service event-order lock.
      await locked`select id from job where id = ${row.id} for update`;
      expect(await runner().claim(wake(row))).toBeNull();
    } finally {
      await locked`rollback`;
      locked.release();
    }
    expect((await claim(runner(), row)).claims.epoch).toBe(1);
  });

  test('a wake is judged by the database clock, not by a process clock up to 50 ms off', async () => {
    const { handle, jobs } = fixture();
    const realNow = Date.now;
    const shift = (ms: number) => {
      Date.now = () => realNow() + ms;
    };
    try {
      // Due by the database clock. A process clock 50 ms behind Postgres would
      // have called this wake early and dropped it until the recovery scan.
      const row = await create();
      await handle.sql`update job set next_wake_at = now() where id = ${row.id}`;
      shift(-50);
      expect((await claim(runner(), await jobs.get(row.id))).claims.epoch).toBe(1);
      // Not yet due by the database clock. A process clock 50 ms ahead would
      // have claimed it before its time.
      const next = await create();
      await handle.sql`update job set next_wake_at = now() + interval '30 milliseconds' where id = ${next.id}`;
      shift(50);
      expect(await runner().claim(wake(await jobs.get(next.id)))).toBeNull();
      await Bun.sleep(60);
      expect((await claim(runner(), await jobs.get(next.id))).claims.epoch).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  test.each([-120_000, 120_000])(
    'claim leases use database time with process skew %i',
    async (skew) => {
      const { handle } = fixture();
      const row = await create();
      await handle.sql`update job set next_wake_at = now() where id = ${row.id}`;
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + skew;
        const admitted = await claim(runner(), row);
        const [lease] =
          await handle.sql`select extract(epoch from (lease_expires_at - now()))::float as remaining
        from attempt where id = ${admitted.claims.attempt_id}`;
        expect(lease?.remaining).toBeWithin(40, 46);
      } finally {
        Date.now = realNow;
      }
    },
  );

  test.each([-120_000, 120_000])(
    'heartbeat then recovery preserves live work with process skew %i',
    async (skew) => {
      const { handle, jobs } = fixture();
      const row = await create();
      await handle.sql`update job set next_wake_at = now() where id = ${row.id}`;
      const worker = runner();
      const admitted = await claim(worker, row);
      const id = admitted.claims.attempt_id;
      // Isolate renewal from creation: the starting lease is healthy by Postgres time.
      await handle.sql`update attempt set lease_expires_at = now() + interval '10 seconds' where id = ${id}`;
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + skew;
        expect(await worker.heartbeat(admitted.claims)).toBe(true);
        await worker.recover();
        expect((await jobs.get(row.id)).state).toBe('running');
        expect((await jobs.get(row.id)).leaseEpoch).toBe(1);
        expect(await execution(id)).toMatchObject({
          endedAt: null,
          outcome: null,
          leaseStatus: 'active',
        });
        await jobs.transaction((tx) => requireCurrentAttempt(tx, admitted.claims));
        const [lease] =
          await handle.sql`select extract(epoch from (lease_expires_at - now()))::float as remaining
        from attempt where id = ${id}`;
        expect(lease?.remaining).toBeWithin(40, 46);
        expect(
          await handle.sql`select seq from event where attempt_id = ${id} and type = 'attempt_ended'`,
        ).toHaveLength(0);

        // A slow process clock must not admit or revive work that Postgres has expired.
        await handle.sql`update attempt set lease_expires_at = now() - interval '1 second' where id = ${id}`;
        await rejects(
          () => jobs.transaction((tx) => requireCurrentAttempt(tx, admitted.claims)),
          'stale_epoch',
        );
        expect(await worker.heartbeat(admitted.claims)).toBe(false);
        await worker.recover();
        expect(await execution(id)).toMatchObject({
          leaseStatus: 'lost',
          outcomeDetail: { reason: 'lease_expired' },
        });
      } finally {
        Date.now = realNow;
      }
    },
  );

  test.each([-120_000, 120_000])(
    'receipt lateness uses database time with process skew %i',
    async (skew) => {
      const { handle, jobs } = fixture();
      const row = await create();
      await handle.sql`update job set next_wake_at = now() where id = ${row.id}`;
      const admitted = await claim(runner(), row);
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + skew;
        for (const late of [false, true]) {
          const id = await effect(admitted, 'dispatched');
          const [dispatched] = await handle.db
            .update(action)
            .set({ dispatchedAt: new Date() })
            .where(eq(action.id, id))
            .returning();
          if (!dispatched) throw new Error('Expected dispatched action');
          await handle.sql`update attempt set lease_expires_at = now() + ${late ? -1 : 45} * interval '1 second'
          where id = ${admitted.claims.attempt_id}`;
          const receipt = await recordReceipt(jobs, admitted.claims.attempt_id, {
            action_id: id,
            connection_id: dispatched.connectionId,
            external_ref: id,
            detail: {},
            received_at: new Date().toISOString(),
            late: false,
          });
          expect(receipt.late).toBe(late);
        }
      } finally {
        Date.now = realNow;
      }
    },
  );

  test.each(['create', 'resume'] as const)(
    'an immediate %s wake stays due with a process clock ahead of Postgres',
    async (operation) => {
      const { handle, jobs } = fixture();
      const worker = runner();
      let row: JobRow | undefined;
      if (operation === 'resume') {
        row = await create();
        await handle.sql`update job set next_wake_at = now() where id = ${row.id}`;
        const admitted = await claim(worker, row);
        await worker.commitOutcome(admitted.claims, {
          kind: 'waiting_for_input',
          question: 'Continue?',
        });
      }
      // Unlike replacing Date.now alone, this also skews the Date constructor used by wakes.
      setSystemTime(new Date(Date.now() + 120_000));
      try {
        const due = row ? await jobs.input(row.id, 'Continue.') : await create();
        const [saved] =
          await handle.sql`select next_wake_at <= now() as due from job where id = ${due.id}`;
        expect(saved?.due).toBe(true);
        expect((await claim(worker, due)).claims.epoch).toBe(operation === 'resume' ? 2 : 1);
      } finally {
        setSystemTime();
      }
    },
  );

  test('an attempt still open when a later epoch claims the job ends as superseded', async () => {
    const { handle, jobs } = fixture();
    const row = await create();
    const first = await claim(runner(), row);
    // The job is queued again past the open attempt without ending it, as a
    // crashed service or an out-of-band state repair can leave it.
    await handle.sql`update job set state = 'queued', lease_epoch = lease_epoch + 1,
      state_version = state_version + 1, next_wake_at = now() where id = ${row.id}`;
    const second = await claim(runner(), await jobs.get(row.id));
    expect(second.claims.attempt_id).not.toBe(first.claims.attempt_id);
    const stale = await execution(first.claims.attempt_id);
    expect(stale.endedAt).not.toBeNull();
    expect(stale.outcome).toBe('fenced');
    expect(stale.outcomeDetail).toEqual({ kind: 'superseded', by: second.claims.attempt_id });
    const [ended] = await handle.sql`select count(*)::int as n from event
      where attempt_id = ${first.claims.attempt_id} and type = 'attempt_ended'`;
    expect(ended?.n).toBe(1);
    expect(
      await handle.sql`select id from attempt where job_id = ${row.id} and ended_at is null`,
    ).toHaveLength(1);
  });

  test('the recovery scan closes an expired attempt a later epoch already fenced', async () => {
    const { handle, jobs } = fixture();
    const row = await create();
    const first = await claim(runner(), row);
    await handle.sql`update job set lease_epoch = lease_epoch + 1, state = 'waiting_for_input',
      next_wake_at = null where id = ${row.id}`;
    await handle.sql`update attempt set lease_expires_at = now() - interval '1 second'
      where id = ${first.claims.attempt_id}`;
    await runner().recover();
    const stale = await execution(first.claims.attempt_id);
    expect(stale.endedAt).not.toBeNull();
    expect(stale.outcomeDetail).toEqual({ kind: 'superseded' });
    expect((await jobs.get(row.id)).state).toBe('waiting_for_input');
  });

  test('durable input cursors deliver new messages once while retaining completed tools in the transcript', async () => {
    const { jobs } = fixture();
    const worker = runner();
    const row = await create();
    const first = await claim(worker, row);
    await worker.emit(
      first.claims,
      runtimeEvent(first, 0, {
        type: 'tool_call_proposed',
        call_id: 'read-1',
        tool: 'test.read',
        arguments: {},
      }),
    );
    await worker.emit(
      first.claims,
      runtimeEvent(first, 1, {
        type: 'tool_result',
        call_id: 'read-1',
        ok: true,
        result: { value: 'stored result' },
      }),
    );
    await worker.commitOutcome(first.claims, { kind: 'waiting_for_input', question: 'Continue?' });
    const resumed = await jobs.input(row.id, 'Continue with Tuesday.');
    const second = await claim(worker, resumed);
    expect(second.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      'Continue with Tuesday.',
    ]);
    expect(
      second.bundle.transcript.find((message) => message.tool_call_id === 'read-1')?.content,
    ).toContain('stored result');
    expect((await execution(second.claims.attempt_id)).inputCursor).toBeGreaterThan(
      (await execution(first.claims.attempt_id)).inputCursor,
    );
    await worker.commitOutcome(second.claims, {
      kind: 'failed',
      reason: 'Retry once',
      retryable: true,
    });
    const third = await claim(worker, await jobs.get(row.id));
    expect(third.bundle.inputs.new_user_messages).toEqual([]);
    expect(
      third.bundle.transcript.some((message) => message.content === 'Continue with Tuesday.'),
    ).toBe(true);
    expect(third.bundle.transcript.some((message) => message.tool_call_id === 'read-1')).toBe(true);
  });

  test('a real stub crash retains text and completed tools, marks a gap, and resumes without a repeated effect', async () => {
    const { jobs, handle } = fixture();
    let calls = 0;
    const worker = runner(new StubRuntimeAdapter({ onTool: () => ({ call: ++calls }) }));
    const row = await create([
      { type: 'text_delta', epoch: 1, text: 'Partial answer' },
      { type: 'tool', tool: 'test.effect', call_id: 'effect-1' },
      { type: 'crash', epoch: 1, message: 'stub died after effect' },
      { type: 'outcome', outcome: completion() },
    ]);
    await worker.handleWake(wake(row));
    const retry = await jobs.get(row.id);
    expect(retry.state).toBe('queued');
    const [lost] = await handle.db.select().from(attempt).where(eq(attempt.jobId, row.id));
    expect(lost?.leaseStatus).toBe('lost');
    expect(lost?.outcome).toBe('fenced');
    expect(lost?.outcomeDetail).toMatchObject({ kind: 'lost', reason: 'stub died after effect' });
    const stored = await handle.db.select().from(event).where(eq(event.jobId, row.id));
    expect(stored.filter((entry) => entry.type === 'text_delta')).toHaveLength(1);
    expect(stored.some((entry) => (entry.payload as { kind?: string }).kind === 'gap')).toBe(true);
    await worker.handleWake(wake(retry));
    expect((await jobs.get(row.id)).state).toBe('completed');
    expect((await jobs.get(row.id)).leaseEpoch).toBe(2);
    expect(calls).toBe(1);
    const results =
      await handle.sql`select seq from event where job_id = ${row.id} and type = 'tool_result'`;
    expect(results).toHaveLength(1);
  });

  test('the wall budget ends a slow stub attempt with budget_exhausted', async () => {
    const { jobs, handle } = fixture();
    const row = await create([{ type: 'sleep', ms: 10_000 }], { budget: { max_wall_ms: 100 } });
    await runner().handleWake(wake(row));
    expect((await jobs.get(row.id)).state).toBe('failed');
    const [saved] = await handle.db.select().from(attempt).where(eq(attempt.jobId, row.id));
    expect(saved?.outcome).toBe('budget_exhausted');
    expect(saved?.leaseStatus).toBe('ended');
  });

  test('the turn budget rejects an extra runtime turn before persisting it', async () => {
    const { jobs, handle } = fixture();
    const row = await create(
      [
        { type: 'turn_started', turn: 0 },
        { type: 'turn_started', turn: 1 },
      ],
      { budget: { max_turns: 1 } },
    );
    await runner().handleWake(wake(row));
    expect((await jobs.get(row.id)).state).toBe('failed');
    expect(
      await handle.sql`select seq from event where job_id = ${row.id} and type = 'turn_started'`,
    ).toHaveLength(1);
    const [saved] = await handle.db.select().from(attempt).where(eq(attempt.jobId, row.id));
    expect(saved?.outcome).toBe('budget_exhausted');
  });

  test('a heartbeat extends a live lease but cannot revive an expired lease', async () => {
    const { handle } = fixture();
    const worker = runner();
    const admitted = await claim(worker, await create());
    const nearExpiry = new Date(Date.now() + 1000);
    await handle.db
      .update(attempt)
      .set({ leaseExpiresAt: nearExpiry })
      .where(eq(attempt.id, admitted.claims.attempt_id));
    expect(await worker.heartbeat(admitted.claims)).toBe(true);
    expect((await execution(admitted.claims.attempt_id)).leaseExpiresAt?.getTime()).toBeGreaterThan(
      nearExpiry.getTime(),
    );
    const expired = new Date(Date.now() - 1000);
    await handle.db
      .update(attempt)
      .set({ leaseExpiresAt: expired })
      .where(eq(attempt.id, admitted.claims.attempt_id));
    expect(await worker.heartbeat(admitted.claims)).toBe(false);
    expect((await execution(admitted.claims.attempt_id)).leaseExpiresAt?.getTime()).toBe(
      expired.getTime(),
    );
  });

  test.each(['cancel', 'revision', 'expiry'] as const)(
    'capability admission rejects %s before invoking the operation',
    async (change) => {
      const { jobs, handle } = fixture();
      const worker = runner();
      const row = await create();
      const admitted = await claim(worker, row);
      expect(
        await withCapability(jobs, admitted.bundle.attempt.token, key, async () => 'admitted'),
      ).toBe('admitted');
      if (change === 'cancel') await jobs.cancel(row.id);
      else if (change === 'revision') await jobs.revise(row.id, { objective: 'Changed objective' });
      else
        await handle.db
          .update(attempt)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(attempt.id, admitted.claims.attempt_id));
      const code = change === 'revision' ? 'revision_mismatch' : 'stale_epoch';
      let invoked = false;
      await rejects(
        () =>
          withCapability(jobs, admitted.bundle.attempt.token, key, async () => {
            invoked = true;
          }),
        code,
      );
      await rejects(
        () => jobs.transaction((tx) => requireCurrentAttempt(tx, admitted.claims)),
        code,
      );
      await rejects(() => worker.commitOutcome(admitted.claims, completion()), code);
      expect(invoked).toBe(false);
      expect((await jobs.get(row.id)).state).toBe(change === 'cancel' ? 'cancelled' : 'running');
    },
  );

  test('recovery replaces expired leases and restores a due wake missing from pg-boss', async () => {
    const { jobs, handle, queue } = fixture();
    const worker = runner();
    const row = await create();
    const old = await claim(worker, row);
    await handle.db
      .update(attempt)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(attempt.id, old.claims.attempt_id));
    await worker.recover();
    const recovered = await jobs.get(row.id);
    expect(recovered.state).toBe('queued');
    expect((await execution(old.claims.attempt_id)).leaseStatus).toBe('lost');
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await worker.recover();
    await worker.recover();
    expect(
      await handle.sql`select id from pgboss.job where name = ${QUEUES.attempt} and data->>'job_id' = ${row.id}`,
    ).toHaveLength(1);
    expect((await claim(worker, recovered)).claims.epoch).toBe(2);
  });

  test('cancelling a live stub finalizes its attempt once before interruption', async () => {
    const { jobs, handle } = fixture();
    const started = deferred<AttemptBundle>();
    const release = deferred<void>();
    const worker = runner(
      new StubRuntimeAdapter({
        onStall: (_name, bundle) => {
          started.resolve(bundle);
          return release.promise;
        },
      }),
    );
    const row = await create([{ type: 'stall', key: 'cancel-me' }], {
      budget: { max_wall_ms: 2000 },
    });
    const running = worker.handleWake(wake(row));
    const bundle = await started.promise;
    try {
      const cancelled = await jobs.cancel(row.id, 'No longer needed');
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.leaseEpoch).toBe(2);
      // Cancellation must finalize durable state even if the runtime has not unwound yet.
      const saved = await execution(bundle.attempt.id);
      expect(saved.outcome).toBe('fenced');
      expect(saved.outcomeDetail).toEqual({ kind: 'cancelled', reason: 'No longer needed' });
      expect(saved.leaseStatus).toBe('ended');
      expect(saved.endedAt).toBeInstanceOf(Date);
      expect(saved.leaseExpiresAt).toBeNull();
      await running;
      await worker.recover();
      expect((await jobs.get(row.id)).stateVersion).toBe(2);
      expect(
        await handle.sql`select seq from event where attempt_id = ${bundle.attempt.id} and type = 'attempt_ended'`,
      ).toHaveLength(1);
      expect(
        await handle.sql`select seq from event where job_id = ${row.id} and type = 'job_state_changed'`,
      ).toHaveLength(2);
    } finally {
      release.resolve();
      await running;
    }
  });

  test('recovery skipping a locked job does not abort its still-running runtime', async () => {
    const { jobs, handle } = fixture();
    const started = deferred<AttemptBundle>();
    const release = deferred<void>();
    const worker = runner(
      new StubRuntimeAdapter({
        onStall: (_name, bundle) => {
          started.resolve(bundle);
          return release.promise;
        },
      }),
    );
    const row = await create([{ type: 'stall', key: 'hold-running' }], {
      budget: { max_wall_ms: 2000 },
    });
    const running = worker.handleWake(wake(row));
    const bundle = await started.promise;
    const locked = await handle.sql.reserve();
    try {
      await handle.db
        .update(attempt)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(attempt.id, bundle.attempt.id));
      await locked`begin`;
      await locked`select id from job where id = ${row.id} for update`;
      await worker.recover();
      // A concurrent renewal can make the original recovery snapshot obsolete.
      await locked`update attempt set lease_expires_at = ${new Date(Date.now() + 45_000).toISOString()} where id = ${bundle.attempt.id}`;
      await locked`commit`;
    } finally {
      await locked`rollback`;
      locked.release();
      release.resolve();
      await running;
    }
    expect((await jobs.get(row.id)).state).toBe('completed');
    expect((await jobs.get(row.id)).leaseEpoch).toBe(1);
    expect((await execution(bundle.attempt.id)).outcome).toBe('completed');
    expect(
      await handle.sql`select seq from event where attempt_id = ${bundle.attempt.id} and payload->>'kind' = 'gap'`,
    ).toHaveLength(0);
  });

  test('a persisted outcome is recovered once after the process stops before its transition', async () => {
    const { jobs, handle } = fixture();
    const worker = runner();
    const row = await create();
    const admitted = await claim(worker, row);
    await worker.emit(
      admitted.claims,
      runtimeEvent(admitted, 0, { type: 'attempt_outcome', outcome: completion() }),
    );
    expect((await jobs.get(row.id)).state).toBe('running');
    expect((await execution(admitted.claims.attempt_id)).outcome).toBeNull();
    await handle.db
      .update(attempt)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(attempt.id, admitted.claims.attempt_id));
    await worker.recover();
    const completed = await jobs.get(row.id);
    expect(completed.state).toBe('completed');
    expect(completed.stateVersion).toBe(2);
    expect(completed.leaseEpoch).toBe(1);
    expect((await execution(admitted.claims.attempt_id)).outcomeDetail).toEqual(completion());
    const before = await handle.db.select().from(event).where(eq(event.jobId, row.id));
    await worker.recover();
    await worker.handleWake(wake(row));
    await rejects(() => worker.commitOutcome(admitted.claims, completion()), 'stale_epoch');
    expect(await handle.db.select().from(event).where(eq(event.jobId, row.id))).toEqual(before);
    expect(await handle.db.select().from(attempt).where(eq(attempt.jobId, row.id))).toHaveLength(1);
  });

  test('repeating a successful outcome cannot add another transition or ended event', async () => {
    const { jobs, handle } = fixture();
    const worker = runner();
    const row = await create();
    const admitted = await claim(worker, row);
    const completed = await worker.commitOutcome(admitted.claims, completion());
    const before = await handle.db.select().from(event).where(eq(event.jobId, row.id));
    await rejects(() => worker.commitOutcome(admitted.claims, completion()), 'stale_epoch');
    expect(await jobs.get(row.id)).toEqual(completed);
    expect(await handle.db.select().from(event).where(eq(event.jobId, row.id))).toEqual(before);
    expect(before.filter((entry) => entry.type === 'job_state_changed')).toHaveLength(2);
    expect(before.filter((entry) => entry.type === 'attempt_ended')).toHaveLength(1);
  });

  test('a rejected persisted completion cannot starve another expired attempt during recovery', async () => {
    const { jobs, handle } = fixture();
    const worker = runner();
    const blocked = await claim(worker, await create());
    const dispatchedId = await effect(blocked, 'dispatched');
    await worker.emit(
      blocked.claims,
      runtimeEvent(blocked, 0, { type: 'attempt_outcome', outcome: completion() }),
    );
    const other = await claim(worker, await create());
    await handle.db.update(attempt).set({ leaseExpiresAt: new Date(0) });
    await worker.recover();
    const blockedAttempt = await execution(blocked.claims.attempt_id);
    expect(blockedAttempt.leaseStatus).toBe('lost');
    expect(blockedAttempt.outcomeDetail).toMatchObject({
      kind: 'lost',
      reason: 'actions_not_terminal',
    });
    expect((await execution(other.claims.attempt_id)).leaseStatus).toBe('lost');
    for (const admitted of [blocked, other]) {
      const resumed = await jobs.get(admitted.claims.job_id);
      expect(resumed.state).toBe('queued');
      expect(resumed.stateVersion).toBe(2);
      expect(
        await handle.sql`select seq from event where attempt_id = ${admitted.claims.attempt_id} and type = 'attempt_ended'`,
      ).toHaveLength(1);
      expect(
        await handle.sql`select id from pgboss.job where data->>'job_id' = ${admitted.claims.job_id} and (data->>'expected_version')::int = 2`,
      ).toHaveLength(1);
    }
    const [dispatched] = await handle.db.select().from(action).where(eq(action.id, dispatchedId));
    expect(dispatched?.status).toBe('dispatched');
  });

  test('an unsatisfied artifact or another job artifact cannot satisfy the declared deliverable', async () => {
    const { jobs, handle } = fixture();
    const worker = runner();
    const other = await create();
    const artifactId = newId('art');
    await handle.db.insert(artifact).values({
      id: artifactId,
      spaceId,
      jobId: other.id,
      path: 'answer.md',
      contentHash: 'verified-hash',
      mime: 'text/markdown',
      size: 10,
    });
    for (const evidence of [[], [{ kind: 'artifact' as const, artifact_id: artifactId }]]) {
      const row = await create([], {
        constraints: { deliverable: { kind: 'artifact', path_glob: '*.md' } },
      });
      const admitted = await claim(worker, row);
      const updated = await worker.commitOutcome(admitted.claims, completion(evidence));
      expect(updated.state).toBe('waiting_for_input');
      expect(updated.wait).toMatchObject({ kind: 'user_input' });
      expect((await execution(admitted.claims.attempt_id)).outcomeDetail).toEqual(
        completion(evidence),
      );
      expect((await jobs.get(row.id)).stateVersion).toBe(2);
    }
  });

  test('a persisted artifact for this job satisfies its matching deliverable', async () => {
    const { handle } = fixture();
    const worker = runner();
    const row = await create([], {
      constraints: { deliverable: { kind: 'artifact', path_glob: '*.md' } },
    });
    const admitted = await claim(worker, row);
    const id = newId('art');
    await handle.db.insert(artifact).values({
      id,
      spaceId,
      jobId: row.id,
      path: 'answer.md',
      contentHash: 'verified-hash',
      mime: 'text/markdown',
      size: 10,
    });
    expect(
      (
        await worker.commitOutcome(
          admitted.claims,
          completion([{ kind: 'artifact', artifact_id: id }]),
        )
      ).state,
    ).toBe('completed');
  });

  test('an unknown action overrides completion while an in-flight action refuses it atomically', async () => {
    const { jobs, handle } = fixture();
    const worker = runner();
    const unknown = await claim(worker, await create());
    await effect(unknown, 'unknown');
    expect((await worker.commitOutcome(unknown.claims, completion())).state).toBe(
      'needs_reconciliation',
    );
    const running = await claim(worker, await create());
    await effect(running, 'dispatched');
    await rejects(() => worker.commitOutcome(running.claims, completion()), 'actions_not_terminal');
    expect((await jobs.get(running.claims.job_id)).state).toBe('running');
    expect((await execution(running.claims.attempt_id)).endedAt).toBeNull();
    expect(
      await handle.sql`select seq from event where attempt_id = ${running.claims.attempt_id} and type = 'attempt_ended'`,
    ).toHaveLength(0);
  });

  test('the real pg-boss worker executes an enqueued job without direct handleWake calls', async () => {
    const { jobs, handle } = fixture();
    const worker = runner();
    const row = await create([{ type: 'outcome', outcome: completion() }]);
    await worker.start();
    const deadline = Date.now() + 3500;
    while ((await jobs.get(row.id)).state !== 'completed' && Date.now() < deadline)
      await Bun.sleep(25);
    expect((await jobs.get(row.id)).state).toBe('completed');
    expect(await handle.db.select().from(attempt).where(eq(attempt.jobId, row.id))).toHaveLength(1);
    const scheduled =
      await handle.sql`select name from pgboss.schedule where name = ${QUEUES.recoveryScan}`;
    expect(scheduled).toHaveLength(1);
  });

  test('bootstrap starts migrated durable dependencies and the configured stub worker', async () => {
    const { handle, jobs } = fixture();
    const memoryRoot = await mkdtemp(join(tmpdir(), 'melete-runner-bootstrap-'));
    const bootstrapOwner = newId('own');
    await handle.sql`insert into owner (id, email) values (${bootstrapOwner}, 'bootstrap@example.test') on conflict do nothing`;
    await handle.sql`insert into principal (id, email) values (${bootstrapOwner}, 'bootstrap@example.test') on conflict do nothing`;
    const service = await bootstrap({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: handle.url,
        MELETE_RUNTIME_ADAPTER: 'stub',
        MELETE_CAPABILITY_KEY: key,
        PORT: '3100',
        MELETE_SPACES_DIR: memoryRoot,
      }),
    });
    try {
      const health = await service.app.request('/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ database: 'ok', runtime_adapter: 'stub' });
      expect((await service.app.request('/jobs')).status).toBe(401);
      expect((await service.app.request('/events')).status).toBe(401);
      expect((await service.app.request(`/jobs/${newId('job')}/events`)).status).toBe(401);
      const row = await create([{ type: 'outcome', outcome: completion() }]);
      const deadline = Date.now() + 3500;
      while ((await jobs.get(row.id)).state !== 'completed' && Date.now() < deadline)
        await Bun.sleep(25);
      expect((await jobs.get(row.id)).state).toBe('completed');
      expect(await handle.db.select().from(attempt).where(eq(attempt.jobId, row.id))).toHaveLength(
        1,
      );
      const [context] =
        await handle.sql`select style_violations from memory_contexts where job_id = ${row.id}`;
      expect(context?.style_violations).toEqual([]);
    } finally {
      await service.close();
    }
  });
});
