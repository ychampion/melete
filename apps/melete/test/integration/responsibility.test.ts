import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  type ContextInvalidated,
  type OperationRegistration,
  type RuntimeAdapter,
  responsibilityAttemptBundle,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { ServiceError } from '../../src/api/errors.ts';
import { mountEvents } from '../../src/api/events.ts';
import {
  action,
  attempt,
  backgroundOperation,
  connection,
  event,
  secret,
  space,
} from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { appendEvent } from '../../src/events/store.ts';
import { EventStream } from '../../src/events/stream.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { buildBundle } from '../../src/jobs/bundle.ts';
import {
  requireConnectionGeneration,
  withCapability,
  withConnectionCapability,
} from '../../src/jobs/fence.ts';
import { OperationService } from '../../src/jobs/operations.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';
import { processFault } from '../helpers/process-fault.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
let spaceId = '';
function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}
async function createJob() {
  return fixture().jobs.create({
    space_id: spaceId,
    title: 'Responsibility',
    objective: 'Durable progress',
  });
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
withDb('responsibility protocol', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await handle.sql`truncate "space", event_retention cascade`;
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  });
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  for (const kind of ['timer', 'remote_task', 'local_process'] as const) {
    test(`${kind}: deaths at registration, claim, rearm and settlement preserve recovery truth`, async () => {
      const { handle, queue, jobs } = fixture();
      const job = await createJob();
      const inspected: string[] = [];
      const service = new OperationService(jobs, undefined, async (ref) => {
        inspected.push(ref);
        return { finished: true };
      });
      for (const phase of ['registration', 'claim', 'rearm', 'settlement']) {
        const registration: OperationRegistration = {
          operation_key: `${kind}-${phase}`,
          kind,
          ...(kind === 'remote_task' ? { remote_ref: `accepted:${phase}` } : {}),
        };
        const marker = await processFault(
          fileURLToPath(new URL('../helpers/operation-child.ts', import.meta.url)),
          { url: handle.url, jobId: job.id, registration, phase },
          90,
        );
        const id = marker.replace('OPERATION:', '');
        await handle.db
          .update(backgroundOperation)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(backgroundOperation.id, id));
        await queue.boss.deleteAllJobs(QUEUES.operation);
        await service.recover();
        const recovered = await service.get(id);
        if (phase === 'settlement') expect(recovered.state).toBe('settled');
        else if (kind === 'local_process') {
          expect(recovered.state).toBe('interrupted');
          expect(recovered.substrateDisposition).toBe('local_process_interrupted');
          expect(await service.claim(id, recovered.version)).toBeNull();
          await expect(service.rearm(id, recovered.version, new Date())).rejects.toMatchObject({
            code: 'stale_operation',
          });
        } else {
          const wakes =
            await handle.sql`select * from pgboss.job where name = ${QUEUES.operation} and data->>'id' = ${id}`;
          expect(wakes).toHaveLength(1);
          await service.handleWake({ id, version: recovered.version });
          expect((await service.get(id)).state).toBe('settled');
          await service.handleWake({ id, version: recovered.version });
        }
      }
      expect(inspected).toHaveLength(kind === 'remote_task' ? 3 : 0);
    }, 30_000);
  }

  test('uncertain external work is visible and never automatically dispatched', async () => {
    const { jobs } = fixture();
    const row = await createJob();
    const service = new OperationService(jobs, undefined, async () => {
      throw new Error('Must not dispatch');
    });
    const op = await service.register(row.id, { operation_key: 'uncertain', kind: 'remote_task' });
    await service.recover();
    expect((await service.get(op.id)).substrateDisposition).toBe('external_uncertain');
    expect((await service.get(op.id)).state).toBe('unknown');
    expect(await service.claim(op.id, op.version)).toBeNull();
    expect(
      (await service.register(row.id, { operation_key: 'uncertain', kind: 'remote_task' })).id,
    ).toBe(op.id);
    await expect(
      service.register(row.id, { operation_key: 'uncertain', kind: 'timer' }),
    ).rejects.toMatchObject({ code: 'operation_conflict' });
  });

  test('operation settlement before wait registration wakes once from the persisted event', async () => {
    const { jobs } = fixture();
    const row = await createJob();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'operation-test-capability-key-32bytes',
    });
    const triggers = new TriggerService(jobs, runner);
    const service = new OperationService(jobs, runner);
    const trigger = await triggers.create(row.id, {
      kind: 'schedule',
      cron: '* * * * *',
      timezone: 'UTC',
    });
    const op = await service.register(row.id, {
      operation_key: 'early-timer',
      kind: 'timer',
      trigger_id: trigger.id,
    });
    await service.handleWake({ id: op.id, version: op.version });
    const claimed = await runner.claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'created',
    });
    if (!claimed) throw new Error('Attempt not claimed');
    const updated = await runner.commitOutcome(claimed.claims, {
      kind: 'waiting_for_event_or_time',
      wait: { kind: 'event', trigger_id: trigger.id, deadline_at: null },
    });
    expect(updated.state).toBe('queued');
    expect(updated.substrateDisposition).toBe('timer_or_event');
    const after = await service.get(op.id);
    await service.settle(op.id, after.version - 1, { fired_at: op.dueAt.toISOString() });
    expect((await jobs.get(row.id)).stateVersion).toBe(updated.stateVersion);
  });

  test('retention reconnect emits a gap and reset snapshot without replaying unavailable history', async () => {
    const { handle, jobs } = fixture();
    const submissions = new SubmissionService(jobs);
    const accepted = await submissions.create(
      { space_id: spaceId, title: 'Retained request', objective: 'Retain acceptance' },
      'retention-submission',
    );
    if (!accepted.job) throw new Error('Submission missing');
    const row = accepted.job;
    const old = await jobs.transaction((tx) =>
      appendEvent(tx, {
        jobId: row.id,
        type: 'text_delta',
        payload: { text: 'Past stream retention' },
        dedupKey: 'retention:old',
      }),
    );
    if (!old) throw new Error('Old event missing');
    const events = new EventStream(handle, { pollIntervalMs: 10 });
    const app = new Hono();
    mountEvents(app, events, jobs);
    await events.protocol.retainAfter(old.seq);
    const response = await app.request(
      `/jobs/${row.id}/events?after=${accepted.receipt.event_cursor}`,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Stream missing');
    try {
      const gap = new TextDecoder().decode((await reader.read()).value);
      expect(gap).toContain('event: gap\n');
      expect(gap).not.toContain('id:');
      const reset = new TextDecoder().decode((await reader.read()).value);
      expect(reset).toContain('event: reset\n');
      const data = JSON.parse(reset.split('data: ')[1] ?? '{}');
      expect(data.reason).toBe('retention');
      expect(data.snapshot.jobs[0].id).toBe(row.id);
      expect(data.snapshot.cursor).toBe(old.seq);
      expect(reset).not.toContain('Past stream retention');
      const next = await jobs.transaction((tx) =>
        appendEvent(tx, {
          jobId: row.id,
          type: 'notice',
          payload: { text: 'New durable data' },
          dedupKey: 'retention:new',
        }),
      );
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toContain(`id: ${next?.seq}\n`);
      expect(JSON.parse(frame.split('data: ')[1] ?? '{}')).toMatchObject({
        cursor: next?.seq,
        epoch: 0,
      });
      expect(await submissions.get('retention-submission')).toEqual(accepted.receipt);
      expect(await handle.db.select().from(event).where(eq(event.seq, old.seq))).toHaveLength(1);
    } finally {
      await reader.cancel();
      await events.close();
    }
  });

  test('epoch changes and explicit resync return current snapshots; old unknown epochs are not invented', async () => {
    const { handle, jobs } = fixture();
    const row = await createJob();
    const [created] = await handle.db.select().from(event).where(eq(event.jobId, row.id));
    if (!created) throw new Error('Created event missing');
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'event-protocol-test-key-32bytes-long',
    });
    const claim = await runner.claim({
      job_id: row.id,
      expected_epoch: 0,
      expected_version: 0,
      reason: 'created',
    });
    if (!claim) throw new Error('Attempt not claimed');
    const events = new EventStream(handle, { pollIntervalMs: 10 });
    const app = new Hono();
    mountEvents(app, events, jobs);
    try {
      for (const [query, reason] of [
        [`after=${created.seq}`, 'epoch_changed'],
        ['resync=true', 'resync'],
        ['after=999999', 'cursor_ahead'],
      ] as const) {
        const response = await app.request(`/jobs/${row.id}/events?${query}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Stream missing');
        const frame = new TextDecoder().decode((await reader.read()).value);
        await reader.cancel();
        expect(frame).toContain('event: reset\n');
        const data = JSON.parse(frame.split('data: ')[1] ?? '{}');
        expect(data.reason).toBe(reason);
        expect(data.epoch).toBe(1);
        expect(data.snapshot.jobs[0].state).toBe('running');
      }
      await handle.db.update(event).set({ epoch: null }).where(eq(event.seq, created.seq));
      const handshake = await events.protocol.handshake(created.seq, row.id);
      expect(handshake.frames[0]).toContain('unknown_epoch');
      expect(await (await app.request(`/jobs/${row.id}/snapshot`)).json()).toMatchObject({
        epoch: 1,
      });
    } finally {
      await events.close();
    }
  });

  test('revocation during inference fences admission and restarts without revoked context', async () => {
    const { handle, jobs } = fixture();
    const key = 'policy-test-signing-key-32bytes-long';
    const connectionId = newId('conn');
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Account' });
    const row = await jobs.create({
      space_id: spaceId,
      title: 'Account context',
      objective: 'Use the current account',
      constraints: {
        notes: JSON.stringify({
          script: [
            {
              type: 'tool',
              tool: 'test.read',
              call_id: 'account-read',
              epoch: 1,
            },
            { type: 'stall', key: 'inference', epoch: 1 },
          ],
        }),
      },
    });
    let ready = () => {};
    const stalled = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let oldToken = '';
    let oldAttemptId = '';
    const controls: ContextInvalidated[] = [];
    const runtime = new StubRuntimeAdapter({
      onTool: async () => ({ private_material: 'REVOKED_ACCOUNT_BYTES' }),
      onStall: async (_key, bundle) => {
        const parsed = responsibilityAttemptBundle.parse(bundle);
        expect(parsed.connection_generations[connectionId]).toBe(0);
        oldToken = bundle.attempt.token;
        oldAttemptId = bundle.attempt.id;
        ready();
        await new Promise<void>(() => {});
      },
      onContextInvalidated: (control) => {
        controls.push(control);
      },
    });
    const runner = new AttemptRunner(jobs, runtime, { key });
    const running = runner.handleWake({
      job_id: row.id,
      expected_epoch: 0,
      expected_version: 0,
      reason: 'created',
    });
    await stalled;
    await handle.db
      .update(attempt)
      .set({ contextSnapshotRef: 'cached-private-context' })
      .where(eq(attempt.id, oldAttemptId));
    const actionIds = [newId('act'), newId('act')];
    for (const [index, id] of actionIds.entries())
      await handle.db.insert(action).values({
        id,
        jobId: row.id,
        attemptId: oldAttemptId,
        connectionId,
        kind: 'test.send',
        effectClass: 'write_external',
        canonicalPayload: {},
        payloadHash: 'a'.repeat(64),
        idempotencyKey: id,
        status: index === 0 ? 'admitted' : 'dispatched',
        dispatchedAt: index === 0 ? null : new Date(),
      });
    let admitted = 0;
    expect(
      await withConnectionCapability(jobs, oldToken, key, connectionId, async () => ++admitted),
    ).toBe(1);
    const policy = new PolicyService(jobs, runner);
    expect(
      await policy.changeConnection(connectionId, { kind: 'revoke', expected_generation: 0 }),
    ).toMatchObject({ generation: 1, policy_generation: 1, status: 'revoked' });
    await running;
    await expect(withCapability(jobs, oldToken, key, async () => ++admitted)).rejects.toMatchObject(
      { code: 'stale_epoch' },
    );
    expect(admitted).toBe(1);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({
      type: 'context_invalidated',
      attempt_id: oldAttemptId,
      reason: 'connection_revoked',
    });
    const [ended] = await handle.db.select().from(attempt).where(eq(attempt.id, oldAttemptId));
    expect(ended?.contextSnapshotRef).toBeNull();
    expect(ended?.leaseStatus).toBe('context_invalidated');
    const effects = await handle.db.select().from(action).where(eq(action.jobId, row.id));
    expect(effects.find((effect) => effect.id === actionIds[0])?.status).toBe('failed');
    expect(effects.find((effect) => effect.id === actionIds[1])?.status).toBe('unknown');
    const nextJob = await jobs.get(row.id);
    const next = await runner.claim({
      job_id: row.id,
      expected_epoch: nextJob.leaseEpoch,
      expected_version: nextJob.stateVersion,
      reason: 'recovery',
    });
    if (!next) throw new Error('Fresh context attempt missing');
    expect(next.bundle.policy_generation).toBe(1);
    expect(next.bundle.connection_generations[connectionId]).toBeUndefined();
    expect(JSON.stringify(next.bundle)).not.toContain('REVOKED_ACCOUNT_BYTES');
    expect(next.bundle.transcript.some((message) => message.tool_call_id === 'account-read')).toBe(
      true,
    );
    await expect(
      jobs.transaction((tx) => requireConnectionGeneration(tx, next.claims, connectionId)),
    ).rejects.toMatchObject({ code: 'context_invalidated' });
    const invalidations = await handle.db
      .select()
      .from(event)
      .where(eq(event.type, 'context_invalidated'));
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.attemptId).toBe(oldAttemptId);
    await runner.stop();
  });

  test('credential switches compare generations at both context assembly and connector admission', async () => {
    const { handle, jobs } = fixture();
    const key = 'generation-test-signing-key-32bytes';
    const connectionId = newId('conn');
    const credentialId = newId('sec');
    await handle.db
      .insert(secret)
      .values({ id: credentialId, spaceId, ciphertext: 'sealed-fixture' });
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Switchable' });
    const row = await createJob();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const first = await runner.claim({
      job_id: row.id,
      expected_epoch: 0,
      expected_version: 0,
      reason: 'created',
    });
    if (!first) throw new Error('First attempt missing');
    await handle.db
      .update(connection)
      .set({ generation: 1 })
      .where(eq(connection.id, connectionId));
    await rejects(
      () => withCapability(jobs, first.bundle.attempt.token, key, async () => 'admitted'),
      'context_invalidated',
    );
    await rejects(
      () =>
        jobs.transaction((tx) =>
          buildBundle(
            tx,
            row,
            {
              id: first.claims.attempt_id,
              epoch: first.claims.epoch,
              revision: first.claims.revision,
              token: first.bundle.attempt.token,
            },
            first.bundle.model,
            0,
            first.bundle,
          ),
        ),
      'context_invalidated',
    );
    const policy = new PolicyService(jobs, runner);
    await expect(
      policy.changeConnection(connectionId, {
        kind: 'switch',
        expected_generation: 0,
        secret_ref: credentialId,
      }),
    ).rejects.toMatchObject({ code: 'generation_conflict' });
    expect(
      await policy.changeConnection(connectionId, {
        kind: 'switch',
        expected_generation: 1,
        secret_ref: credentialId,
      }),
    ).toMatchObject({ generation: 2, policy_generation: 1, status: 'active' });
    const freshJob = await jobs.get(row.id);
    const fresh = await runner.claim({
      job_id: row.id,
      expected_epoch: freshJob.leaseEpoch,
      expected_version: freshJob.stateVersion,
      reason: 'recovery',
    });
    if (!fresh) throw new Error('Fresh attempt missing');
    expect(fresh.bundle.connection_generations[connectionId]).toBe(2);
    expect(JSON.stringify(fresh.bundle)).not.toContain('sealed-fixture');
    expect(
      await withConnectionCapability(
        jobs,
        fresh.bundle.attempt.token,
        key,
        connectionId,
        async () => 'admitted',
      ),
    ).toBe('admitted');
    expect(await policy.changePolicy(spaceId, 1)).toMatchObject({ policy_generation: 2 });
    await expect(
      withCapability(jobs, fresh.bundle.attempt.token, key, async () => 'admitted'),
    ).rejects.toMatchObject({ code: 'stale_epoch' });
    const app = createApp({
      env: loadEnv({}),
      db: handle.db,
      jobs,
      policy,
      checkDatabase: async () => 'ok',
    });
    expect(
      (
        await app.request(`/connections/${connectionId}/lifecycle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'revoke', expected_generation: 2 }),
        })
      ).status,
    ).toBe(401);
  });

  test('a delayed invalidation signal stops the old inference without aborting its replacement', async () => {
    const { jobs } = fixture();
    const row = await jobs.create({
      space_id: spaceId,
      title: 'Overlapping generations',
      objective: 'Replace stale inference',
      constraints: { notes: JSON.stringify({ script: [{ type: 'stall', key: 'inference' }] }) },
    });
    const signals = new Map<string, AbortSignal>();
    const ready: Array<() => void> = [];
    const oldReady = new Promise<void>((resolve) => ready.push(resolve));
    const newReady = new Promise<void>((resolve) => ready.push(resolve));
    const stub = new StubRuntimeAdapter({
      onStall: async () => {
        ready.shift()?.();
        await new Promise<void>(() => {});
      },
    });
    const runtime: RuntimeAdapter = {
      capabilities: () => stub.capabilities(),
      start: (bundle, sink, signal) => {
        signals.set(bundle.attempt.id, signal);
        return stub.start(bundle, sink, signal);
      },
    };
    const runner = new AttemptRunner(jobs, runtime, {
      key: 'overlapping-generation-test-key-32bytes',
    });
    const first = runner.handleWake({
      job_id: row.id,
      expected_epoch: 0,
      expected_version: 0,
      reason: 'created',
    });
    await oldReady;
    const oldAttemptId = [...signals.keys()][0];
    if (!oldAttemptId) throw new Error('Old inference missing');
    // A second service can deliver the durable replacement wake before the old adapter gets its control.
    await new PolicyService(jobs).changePolicy(spaceId, 0);
    const updated = await jobs.get(row.id);
    const second = runner.handleWake({
      job_id: row.id,
      expected_epoch: updated.leaseEpoch,
      expected_version: updated.stateVersion,
      reason: 'recovery',
    });
    await newReady;
    await runner.invalidateContext({
      type: 'context_invalidated',
      job_id: row.id,
      attempt_id: oldAttemptId,
      connection_id: null,
      policy_generation: 1,
      reason: 'policy_changed',
    });
    await first;
    expect(signals.get(oldAttemptId)?.aborted).toBe(true);
    expect([...signals.entries()].filter(([id]) => id !== oldAttemptId)[0]?.[1].aborted).toBe(
      false,
    );
    expect((await jobs.get(row.id)).state).toBe('running');
    await runner.stop();
    await second;
  });
});
