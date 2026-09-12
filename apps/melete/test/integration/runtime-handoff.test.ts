import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendEvent } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { newId } from '../../src/ids.ts';
import { ApprovalService } from '../../src/jobs/approvals.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';
import { createScope } from './postgres.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
afterAll(async () => {
  await queue?.stop();
  await handle?.close();
}, 30_000);

(handle && queue ? describe : describe.skip)('broker and attempt-runner handoff', () => {
  test('a parked tool leaves the lease live until the runner records its outcome', async () => {
    if (!handle || !queue) return;
    const scope = await createScope({ ...handle, boss: queue.boss });
    const connectionId = newId('conn');
    await handle.sql`insert into connection (id, space_id, provider, label, scopes, status)
      values (${connectionId}, ${scope.spaceId}, 'test', 'Test', '["test.send"]'::jsonb, 'active')`;
    const connectors = await configuredConnectors({
      sql: handle.sql,
      workRoot: '.',
      spacesRoot: '.',
      enableTestConnector: true,
    });
    const broker = new BrokerService({
      sql: handle.sql,
      connectors,
      deferApprovalWaitToRunner: true,
    });
    const jobs = new JobService(handle.db, queue.boss);
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'w15-handoff-key-32-characters-long',
      scopes: ['test.send'],
    });
    new ApprovalService(jobs, runner);
    const job = await jobs.create({
      space_id: scope.spaceId,
      title: 'Handoff',
      objective: 'Send a test message',
    });
    const claim = await runner.claim({
      job_id: job.id,
      expected_epoch: job.leaseEpoch,
      expected_version: job.stateVersion,
      reason: 'created',
    });
    if (!claim) throw new Error('No claimed attempt');
    const proposed = await broker.propose(claim.claims, {
      kind: 'test.send',
      connection_id: connectionId,
      payload: { message: 'Hello' },
      client_ref: 'handoff',
    });
    expect(proposed.status).toBe('needs_approval');
    expect((await jobs.get(job.id)).state).toBe('running');
    expect(await runner.heartbeat(claim.claims)).toBe(true);
    const finished = await runner.commitOutcome(claim.claims, {
      kind: 'waiting_for_approval',
      action_ids: [proposed.action_id],
    });
    expect(finished.state).toBe('waiting_for_approval');
    const [attempt] =
      await handle.sql`select ended_at, outcome from attempt where id = ${claim.bundle.attempt.id}`;
    expect(attempt?.ended_at).not.toBeNull();
    expect(attempt?.outcome).toBe('waiting_for_approval');

    // The correction module advances both revision and epoch before requeueing.
    await handle.sql`update job set revision = revision + 1, lease_epoch = lease_epoch + 1,
      state_version = state_version + 1, state = 'queued', next_wake_at = now() where id = ${job.id}`;
    const changed = await jobs.get(job.id);
    const replacement = await runner.claim({
      job_id: changed.id,
      expected_epoch: changed.leaseEpoch,
      expected_version: changed.stateVersion,
      reason: 'recovery',
    });
    if (!replacement) throw new Error('No replacement attempt');
    const fresh = await broker.propose(replacement.claims, {
      kind: 'test.send',
      connection_id: connectionId,
      payload: { message: 'Hello' },
      client_ref: 'handoff',
    });
    expect(fresh.action_id).not.toBe(proposed.action_id);
    const [old] =
      await handle.sql`select status, reconciliation from action where id = ${proposed.action_id}`;
    expect(old?.status).toBe('failed');
    expect(old?.reconciliation.reason).toBe('job_revision_changed');
    expect(
      (
        await runner.commitOutcome(replacement.claims, {
          kind: 'waiting_for_approval',
          action_ids: [fresh.action_id],
        })
      ).state,
    ).toBe('waiting_for_approval');

    // A failed dispatch is still an attempted effect. A correction cannot turn
    // the same stable client reference into another action with another send.
    await handle.sql`update action set status = 'failed', dispatched_at = now(),
      resolved_at = now() where id = ${fresh.action_id}`;
    await handle.sql`update job set revision = revision + 1, lease_epoch = lease_epoch + 1,
      state_version = state_version + 1, state = 'queued', next_wake_at = now() where id = ${job.id}`;
    const revised = await jobs.get(job.id);
    const retry = await runner.claim({
      job_id: revised.id,
      expected_epoch: revised.leaseEpoch,
      expected_version: revised.stateVersion,
      reason: 'recovery',
    });
    if (!retry) throw new Error('No retry attempt');
    const repeated = await broker.propose(retry.claims, {
      kind: 'test.send',
      connection_id: connectionId,
      payload: { message: 'Hello' },
      client_ref: 'handoff',
    });
    expect(repeated.action_id).toBe(fresh.action_id);
    expect(repeated.status).toBe('failed');
    const [count] =
      await handle.sql`select count(*)::int as total from action where job_id = ${job.id}`;
    expect(count?.total).toBe(2);
    // '_' in a job id must match itself, never a lookalike event prefix.
    const literalRef = 'literal_ref';
    const lookalike = `broker:proposal:${job.id.replace('_', 'X')}:${createHash('sha256').update(literalRef).digest('hex')}:revision:2`;
    await appendEvent(
      handle.sql,
      job.id,
      retry.claims.attempt_id,
      'notice',
      { action_id: fresh.action_id },
      lookalike,
    );
    const independent = await broker.propose(retry.claims, {
      kind: 'test.send',
      connection_id: connectionId,
      payload: { message: 'An independent proposal' },
      client_ref: literalRef,
    });
    expect(independent.action_id).not.toBe(fresh.action_id);
    expect(independent.status).toBe('needs_approval');
  }, 20_000);
});
