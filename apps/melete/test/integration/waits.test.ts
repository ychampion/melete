import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalizePayload, type WaitSpec } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { ServiceError } from '../../src/api/errors.ts';
import { session } from '../../src/db/auth-schema.ts';
import { action, approval, connection, event, owner, space, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { ApprovalService } from '../../src/jobs/approvals.ts';
import { type AttemptWake, QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, type ClaimedAttempt } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'waits-integration-signing-key-32-bytes';
let runner: AttemptRunner;
let triggers: TriggerService;
let approvals: ApprovalService;
let spaceId = '';
let ownerId = '';
let connectionId = '';
const token = 'w'.repeat(43);

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

function wake(row: JobRow): AttemptWake {
  return {
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'event',
  };
}

async function create() {
  return fixture().jobs.create({
    space_id: spaceId,
    title: 'Durable wait',
    objective: 'Wait for a useful input',
  });
}

async function claim(row: JobRow) {
  const result = await runner.claim(wake(row));
  if (!result) throw new Error('Expected an admitted attempt');
  return result;
}

async function waitFor(claimed: ClaimedAttempt, wait: WaitSpec) {
  return runner.commitOutcome(claimed.claims, { kind: 'waiting_for_event_or_time', wait });
}

function deliver(id = 'one', name = 'mail.new') {
  return triggers.deliver({
    connection_id: connectionId,
    event_name: name,
    cursor: `opaque-${id}`,
    dedup_key: id,
    payload: { message: id },
  });
}

async function eventTrigger(row: JobRow) {
  return triggers.create(row.id, {
    kind: 'event',
    connection_id: connectionId,
    event_name: 'mail.new',
    poll_seconds: 300,
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

async function proposed(claimed: ClaimedAttempt, expiresAt: Date | null = null) {
  const { handle } = fixture();
  const actionId = newId('act');
  const approvalId = newId('apr');
  const payload = { to: 'reader@example.test', subject: 'Result', body: actionId };
  const hash = canonicalizePayload(payload).hash;
  await handle.db.insert(action).values({
    id: actionId,
    jobId: claimed.claims.job_id,
    attemptId: claimed.claims.attempt_id,
    connectionId,
    kind: 'test.send',
    effectClass: 'write_external',
    canonicalPayload: payload,
    payloadHash: hash,
    status: 'needs_approval',
    idempotencyKey: actionId,
  });
  await handle.db.insert(approval).values({
    id: approvalId,
    actionId,
    jobRevision: claimed.claims.revision,
    payloadHash: hash,
    expiresAt,
  });
  return { actionId, approvalId, hash };
}

withDb('durable waits, triggers and approval inputs', () => {
  beforeEach(async () => {
    const { handle, queue, jobs } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await queue.boss.deleteAllJobs(QUEUES.triggerSchedule);
    await resetTestRows(handle.sql);
    spaceId = newId('sp');
    ownerId = newId('own');
    connectionId = newId('conn');
    await handle.db
      .insert(owner)
      .values({ id: ownerId, email: 'owner@example.test', passwordHash: 'fixture' });
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Scripted inbox' });
    runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    triggers = new TriggerService(jobs, runner);
    approvals = new ApprovalService(jobs, runner);
  });

  afterEach(async () => {
    await triggers.stop();
    await runner.stop();
  });
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('a timer persists its wait and queue due time without keeping an attempt alive', async () => {
    const { handle, jobs } = fixture();
    const admitted = await claim(await create());
    const at = new Date(Date.now() + 60_000).toISOString();
    const waiting = await waitFor(admitted, { kind: 'timer', wake_at: at });
    expect(waiting.wait).toEqual({ kind: 'timer', wake_at: at });
    expect(waiting.nextWakeAt?.toISOString()).toBe(at);
    expect(await runner.claim(wake(waiting))).toBeNull();
    expect(
      await handle.sql`select id from attempt where job_id = ${waiting.id} and ended_at is null`,
    ).toHaveLength(0);
    const wakes =
      await handle.sql`select start_after from pgboss.job where name = ${QUEUES.attempt} and data->>'job_id' = ${waiting.id} and (data->>'expected_version')::int = ${waiting.stateVersion}`;
    expect(new Date(wakes[0]?.start_after).toISOString()).toBe(at);
    const replacement = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    await replacement.recover();
    expect((await jobs.get(waiting.id)).wait).toEqual(waiting.wait);
  });

  test('an event received before wait registration is consumed once and retains its opaque cursor', async () => {
    const { jobs, handle } = fixture();
    const row = await create();
    const registration = await eventTrigger(row);
    const admitted = await claim(row);
    const received = await deliver();
    const wait = { kind: 'event' as const, trigger_id: registration.id, deadline_at: null };
    const queued = await waitFor(admitted, wait);
    expect(queued.state).toBe('queued');
    expect(queued.stateVersion).toBe(3);
    expect(await deliver()).toEqual({ ...received, duplicate: true });
    expect((await jobs.get(row.id)).stateVersion).toBe(3);
    const next = await claim(queued);
    expect(next.bundle.inputs.trigger_events).toHaveLength(1);
    expect(next.bundle.inputs.trigger_events[0]).toMatchObject({
      cursor: 'opaque-one',
      payload: { message: 'one' },
    });
    expect((await waitFor(next, wait)).state).toBe('waiting_for_event_or_time');
    await deliver('two');
    expect((await jobs.get(row.id)).state).toBe('queued');
    const [saved] = await handle.db.select().from(trigger).where(eq(trigger.id, registration.id));
    expect(Number(saved?.cursor)).toBeGreaterThan(received.seq);
    expect(
      await handle.sql`select seq from event where payload->>'kind' = 'trigger_event'`,
    ).toHaveLength(2);
  });

  test('delivery racing registration cannot strand the job or admit two attempts', async () => {
    const { jobs, handle } = fixture();
    const row = await create();
    const registration = await eventTrigger(row);
    const admitted = await claim(row);
    await Promise.all([
      waitFor(admitted, { kind: 'event', trigger_id: registration.id, deadline_at: null }),
      deliver(),
    ]);
    const ready = await jobs.get(row.id);
    expect(ready.state).toBe('queued');
    const admittedAgain = await Promise.all([runner.claim(wake(ready)), runner.claim(wake(ready))]);
    expect(admittedAgain.filter(Boolean)).toHaveLength(1);
    expect(
      await handle.sql`select seq from event where job_id = ${row.id} and payload->>'input' = 'event_fired'`,
    ).toHaveLength(1);
  });

  test('unrelated events stay buffered without waking a different predicate', async () => {
    const { jobs } = fixture();
    const row = await create();
    const registration = await eventTrigger(row);
    await waitFor(await claim(row), {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: null,
    });
    await deliver('wrong', 'mail.deleted');
    expect((await jobs.get(row.id)).state).toBe('waiting_for_event_or_time');
    await deliver('right');
    expect((await jobs.get(row.id)).state).toBe('queued');
  });

  test('a delivered event invalidates its deadline wake and a due deadline survives duplicate timers', async () => {
    const { jobs } = fixture();
    const row = await create();
    const registration = await eventTrigger(row);
    const waiting = await waitFor(await claim(row), {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: new Date(Date.now() - 100).toISOString(),
    });
    const timer = wake(waiting);
    await deliver();
    expect(await runner.claim(timer)).toBeNull();
    const admitted = await claim(await jobs.get(row.id));
    const due = await waitFor(admitted, {
      kind: 'timer',
      wake_at: new Date(Date.now() - 100).toISOString(),
    });
    const results = await Promise.all([runner.claim(wake(due)), runner.claim(wake(due))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await jobs.get(row.id)).leaseEpoch).toBe(3);
  });

  test('missing, foreign and disabled wait triggers fail atomically', async () => {
    const { jobs, handle } = fixture();
    const foreign = await eventTrigger(await create());
    const row = await create();
    const local = await eventTrigger(row);
    await handle.db.update(trigger).set({ enabled: false }).where(eq(trigger.id, local.id));
    const admitted = await claim(row);
    for (const id of [newId('trg'), foreign.id, local.id])
      await rejects(
        () => waitFor(admitted, { kind: 'event', trigger_id: id, deadline_at: null }),
        'invalid_wait',
      );
    expect((await jobs.get(row.id)).state).toBe('running');
    expect(
      await handle.sql`select id from attempt where id = ${admitted.claims.attempt_id} and ended_at is null`,
    ).toHaveLength(1);
  });

  test('cron registrations are restored from durable trigger rows and disabled schedules disappear', async () => {
    const { queue, handle } = fixture();
    const row = await create();
    const spec = { kind: 'schedule' as const, cron: '*/5 * * * *', timezone: 'Asia/Kolkata' };
    const registration = await triggers.create(row.id, spec);
    expect(
      (await queue.boss.getSchedules(QUEUES.triggerSchedule)).find(
        (item) => item.key === registration.id,
      ),
    ).toMatchObject({ cron: spec.cron, timezone: spec.timezone });
    await queue.boss.unschedule(QUEUES.triggerSchedule, registration.id);
    await runner.recover();
    expect(
      (await queue.boss.getSchedules(QUEUES.triggerSchedule)).some(
        (item) => item.key === registration.id,
      ),
    ).toBe(true);
    await handle.db.update(trigger).set({ enabled: false }).where(eq(trigger.id, registration.id));
    await runner.recover();
    expect(
      (await queue.boss.getSchedules(QUEUES.triggerSchedule)).some(
        (item) => item.key === registration.id,
      ),
    ).toBe(false);
    await triggers.fireSchedule(registration.id, 'disabled');
    expect(
      await handle.sql`select seq from event where payload->>'occurrence_id' = 'disabled'`,
    ).toHaveLength(0);
  });

  test('invalid cron or timezone rejects without registering durable work', async () => {
    const { handle } = fixture();
    const row = await create();
    for (const spec of [
      { cron: 'invalid', timezone: 'UTC' },
      { cron: '* * * * *', timezone: 'Missing/Zone' },
    ])
      await rejects(
        () => triggers.create(row.id, { kind: 'schedule', ...spec }),
        'invalid_schedule',
      );
    expect(await handle.db.select().from(trigger)).toHaveLength(0);
  });

  test('the pg-boss schedule worker persists one occurrence and wakes its registered wait', async () => {
    const { queue, jobs, handle } = fixture();
    const row = await create();
    const registration = await triggers.create(row.id, {
      kind: 'schedule',
      cron: '0 0 1 1 *',
      timezone: 'UTC',
    });
    await waitFor(await claim(row), {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: null,
    });
    await triggers.start();
    const occurrence = await queue.boss.send(QUEUES.triggerSchedule, {
      trigger_id: registration.id,
    });
    const deadline = Date.now() + 3500;
    while ((await jobs.get(row.id)).state !== 'queued' && Date.now() < deadline)
      await Bun.sleep(25);
    expect((await jobs.get(row.id)).state).toBe('queued');
    if (!occurrence) throw new Error('Expected a scheduled occurrence');
    await triggers.fireSchedule(registration.id, occurrence);
    expect(
      await handle.sql`select seq from event where payload->>'occurrence_id' = ${occurrence}`,
    ).toHaveLength(1);
  });

  test.each(['approved', 'denied'] as const)(
    '%s is a durable input that wakes exactly once',
    async (decision) => {
      const { jobs, handle } = fixture();
      const admitted = await claim(await create());
      const proposal = await proposed(admitted);
      const waiting = await runner.commitOutcome(admitted.claims, {
        kind: 'waiting_for_approval',
        action_ids: [proposal.actionId],
      });
      expect(waiting.state).toBe('waiting_for_approval');
      const request = { decision, payload_hash: proposal.hash, note: 'Owner decision' };
      const receipt = await approvals.decide(proposal.approvalId, request, ownerId);
      expect(await approvals.decide(proposal.approvalId, request, ownerId)).toEqual(receipt);
      const ready = await jobs.get(waiting.id);
      expect(ready.state).toBe('queued');
      expect(ready.stateVersion).toBe(3);
      const next = await claim(ready);
      expect(next.bundle.inputs.approval_results).toEqual([
        { action_id: proposal.actionId, decision, note: 'Owner decision' },
      ]);
      expect(
        await handle.db.select().from(event).where(eq(event.type, 'approval_decided')),
      ).toHaveLength(1);
      expect(
        (await handle.db.select().from(action).where(eq(action.id, proposal.actionId)))[0]?.status,
      ).toBe(decision);
      await rejects(
        () =>
          approvals.decide(
            proposal.approvalId,
            { ...request, decision: decision === 'approved' ? 'denied' : 'approved' },
            ownerId,
          ),
        'already_decided',
      );
    },
  );

  test('decisions received before registration are consumed without parking a process', async () => {
    const admitted = await claim(await create());
    const proposal = await proposed(admitted);
    await approvals.decide(
      proposal.approvalId,
      { decision: 'approved', payload_hash: proposal.hash },
      ownerId,
    );
    const ready = await runner.commitOutcome(admitted.claims, {
      kind: 'waiting_for_approval',
      action_ids: [proposal.actionId],
    });
    expect(ready.state).toBe('queued');
  });

  test('multiple approval obligations wait for every decision, including a denial', async () => {
    const { jobs } = fixture();
    const admitted = await claim(await create());
    const first = await proposed(admitted);
    const second = await proposed(admitted);
    await runner.commitOutcome(admitted.claims, {
      kind: 'waiting_for_approval',
      action_ids: [first.actionId, second.actionId],
    });
    await approvals.decide(
      first.approvalId,
      { decision: 'denied', payload_hash: first.hash },
      ownerId,
    );
    expect((await jobs.get(admitted.claims.job_id)).state).toBe('waiting_for_approval');
    await approvals.decide(
      second.approvalId,
      { decision: 'approved', payload_hash: second.hash },
      ownerId,
    );
    expect((await jobs.get(admitted.claims.job_id)).state).toBe('queued');
  });

  test.each(['request_hash', 'stored_payload', 'revision', 'expired', 'cancelled'] as const)(
    'approval gate rejects %s without recording a decision',
    async (fault) => {
      const { jobs, handle } = fixture();
      const admitted = await claim(await create());
      const proposal = await proposed(
        admitted,
        fault === 'expired' ? new Date(Date.now() - 1000) : null,
      );
      if (fault === 'stored_payload')
        await handle.db
          .update(action)
          .set({ canonicalPayload: { tampered: true } })
          .where(eq(action.id, proposal.actionId));
      if (fault === 'revision')
        await jobs.revise(admitted.claims.job_id, { objective: 'Changed objective' });
      if (fault === 'cancelled') await jobs.cancel(admitted.claims.job_id);
      const expected = {
        request_hash: 'approval_hash_mismatch',
        stored_payload: 'approval_hash_mismatch',
        revision: 'revision_mismatch',
        expired: 'approval_expired',
        cancelled: 'already_terminal',
      }[fault];
      await rejects(
        () =>
          approvals.decide(
            proposal.approvalId,
            {
              decision: 'approved',
              payload_hash: fault === 'request_hash' ? 'b'.repeat(64) : proposal.hash,
            },
            ownerId,
          ),
        expected,
      );
      expect(
        (await handle.db.select().from(approval).where(eq(approval.id, proposal.approvalId)))[0]
          ?.decision,
      ).toBeNull();
      expect(
        await handle.db.select().from(event).where(eq(event.type, 'approval_decided')),
      ).toHaveLength(0);
    },
  );

  test('connector delivery, trigger creation and approval APIs require an owner session', async () => {
    const { handle, jobs } = fixture();
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: handle.db,
      jobs,
      triggers,
      approvals,
      checkDatabase: async () => 'ok',
    });
    const row = await create();
    for (const [path, method] of [
      [`/jobs/${row.id}/triggers`, 'POST'],
      ['/internal/events/deliver', 'POST'],
      ['/approvals', 'GET'],
      [`/approvals/${newId('apr')}`, 'POST'],
    ])
      expect((await app.request(path ?? '/', { method })).status).toBe(401);
    await handle.db.insert(session).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      ownerId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const headers = { Cookie: `melete_session=${token}`, 'Content-Type': 'application/json' };
    const response = await app.request(`/jobs/${row.id}/triggers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'event', connection_id: connectionId, event_name: 'mail.new' }),
    });
    expect(response.status).toBe(201);
    expect(
      (
        await app.request('/internal/events/deliver', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            connection_id: connectionId,
            event_name: 'mail.new',
            cursor: 'http',
            dedup_key: 'http',
            payload: {},
          }),
        })
      ).status,
    ).toBe(202);
    expect((await app.request('/approvals', { headers })).status).toBe(200);
  });
});
