import { afterAll, describe, expect, test } from 'bun:test';
import type { ConnectorManifest, RuntimeEvent } from '@melete/contracts';
import { BrokerService } from '../../apps/melete/src/broker/service.ts';
import type { Connector } from '../../apps/melete/src/connectors/types.ts';
import { newId } from '../../apps/melete/src/ids.ts';
import { withCapability } from '../../apps/melete/src/jobs/fence.ts';
import { startQueue } from '../../apps/melete/src/jobs/queue.ts';
import { AttemptRunner } from '../../apps/melete/src/jobs/runner.ts';
import { JobService } from '../../apps/melete/src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../apps/melete/src/runtime/stub.ts';
import { rejectionOf } from '../../apps/melete/test/helpers/broker.ts';
import { testDatabase } from '../../apps/melete/test/helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const key = 'settlement-regression-key-0000000000000000';
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key, scopes: ['test.send'] })
  : null;
const databaseTest = handle ? test : test.skip;
afterAll(async () => {
  await runner?.stop();
  await queue?.stop();
  await handle?.close();
});
const manifest: ConnectorManifest = {
  name: 'settlement',
  provider: 'test',
  version: '1',
  description: 'Settlement race regression',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'test.send',
      description: 'External fixture',
      input_schema: { type: 'object' },
      effect_class: 'write_external',
      required_scopes: ['test.send'],
      requires_approval: true,
      verify: false,
    },
  ],
};
async function parked(unknown = false) {
  if (!handle || !jobs || !runner) throw new Error('Database unavailable');
  const spaceId = newId('sp');
  const connectionId = newId('conn');
  await handle.sql`INSERT INTO space(id,name,git_path) VALUES(${spaceId},'Settlement',${`spaces/${spaceId}`})`;
  await handle.sql`INSERT INTO connection(id,space_id,provider,label,scopes) VALUES(${connectionId},${spaceId},'test','Settlement','["test.send"]'::jsonb)`;
  const row = await jobs.create({
    space_id: spaceId,
    title: 'Settlement race',
    objective: 'Send one approved fixture note.',
  });
  const claim = await runner.claim({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'created',
  });
  if (!claim) throw new Error('Attempt was not admitted');
  let deliveries = 0;
  const connector: Connector = {
    manifest,
    async execute() {
      deliveries++;
      throw new Error('Acknowledgement lost after destination acceptance');
    },
    async verify() {
      return { decision: 'unsupported', reason: 'No safe lookup' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
  const broker = new BrokerService({
    sql: handle.sql,
    connectors: { get: (id) => (id === connectionId ? connector : undefined) },
  });
  const request = {
    kind: 'test.send',
    connection_id: connectionId,
    payload: { body: 'One note only.' },
  };
  const proposal = await broker.propose(claim.claims, request);
  if (unknown) {
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await broker.propose(claim.claims, request);
  }
  expect((await jobs.get(row.id)).state).toBe(
    unknown ? 'needs_reconciliation' : 'waiting_for_approval',
  );
  return { handle, jobs, runner, claim, proposal, broker, deliveries: () => deliveries };
}
function text(s: Awaited<ReturnType<typeof parked>>, seq = 0): RuntimeEvent {
  const id = s.claim.claims.attempt_id;
  return {
    type: 'text_delta',
    text: 'The outcome is unconfirmed; I have not repeated it.',
    at: new Date().toISOString(),
    attempt_id: id,
    local_seq: seq,
    dedup_key: `${id}:${seq}`,
  };
}

describe('broker parking must not truncate the current attempt settlement', () => {
  for (const unknown of [false, true]) {
    const state = unknown ? 'needs_reconciliation' : 'waiting_for_approval';
    databaseTest(`a live ${state} attempt can heartbeat and finish its reply`, async () => {
      const s = await parked(unknown);
      expect(await s.runner.heartbeat(s.claim.claims)).toBe(true);
      await s.runner.emit(s.claim.claims, text(s));
      const rows = await s.handle
        .sql`SELECT payload FROM event WHERE dedup_key=${text(s).dedup_key}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.text).toContain('unconfirmed');
      expect(s.deliveries()).toBe(unknown ? 1 : 0);
    });
    databaseTest(`settling ${state} closes the attempt without overruling the broker`, async () => {
      const s = await parked(unknown);
      await s.runner.commitOutcome(
        s.claim.claims,
        unknown
          ? {
              kind: 'completed',
              summary: 'The outcome is unconfirmed; it was not repeated.',
              evidence: [],
            }
          : { kind: 'waiting_for_approval', action_ids: [s.proposal.action_id] },
      );
      expect((await s.jobs.get(s.claim.claims.job_id)).state).toBe(state);
      const [attempt] = await s.handle
        .sql`SELECT outcome,ended_at,lease_status FROM attempt WHERE id=${s.claim.claims.attempt_id}`;
      expect(attempt?.ended_at).not.toBeNull();
      expect(attempt?.lease_status).toBe('ended');
      expect(await s.runner.heartbeat(s.claim.claims)).toBe(false);
      expect(s.deliveries()).toBe(unknown ? 1 : 0);
    });
    databaseTest(`${state} settlement does not reopen ordinary capability admission`, async () => {
      const s = await parked(unknown);
      let invoked = false;
      const failure = await rejectionOf(
        withCapability(s.jobs, s.claim.bundle.attempt.token, key, async () => {
          invoked = true;
        }),
      );
      expect(failure).toMatchObject({ code: 'stale_epoch' });
      expect(invoked).toBe(false);
    });
    databaseTest(
      `an expired ${state} attempt is sealed without requeueing its effects`,
      async () => {
        const s = await parked(unknown);
        await s.handle
          .sql`UPDATE attempt SET lease_expires_at=now()-interval '1 second' WHERE id=${s.claim.claims.attempt_id}`;
        await s.runner.recover();
        const [attempt] = await s.handle
          .sql`SELECT ended_at,lease_status FROM attempt WHERE id=${s.claim.claims.attempt_id}`;
        expect(attempt?.ended_at).not.toBeNull();
        expect(attempt?.lease_status).toBe('lost');
        expect((await s.jobs.get(s.claim.claims.job_id)).state).toBe(state);
        expect(s.deliveries()).toBe(unknown ? 1 : 0);
      },
    );
  }
  databaseTest('an owner revision still fences parked heartbeats and output', async () => {
    const s = await parked();
    const revised = await s.jobs.revise(s.claim.claims.job_id, {
      objective: 'Use the corrected recipient instead.',
    });
    expect(revised.revision).toBe(s.claim.claims.revision + 1);
    expect(await s.runner.heartbeat(s.claim.claims)).toBe(false);
    expect(await rejectionOf(s.runner.emit(s.claim.claims, text(s)))).toMatchObject({
      code: 'revision_mismatch',
    });
    expect(
      await rejectionOf(
        s.broker.decide(s.proposal.action_id, {
          decision: 'approved',
          payload_hash: s.proposal.payload_hash,
        }),
      ),
    ).toMatchObject({ code: 'revision_mismatch' });
    expect(s.deliveries()).toBe(0);
  });
  databaseTest('cancellation still fences a parked runtime immediately', async () => {
    const s = await parked();
    await s.jobs.cancel(s.claim.claims.job_id, 'Stop the fixture');
    expect(await s.runner.heartbeat(s.claim.claims)).toBe(false);
    expect(await rejectionOf(s.runner.emit(s.claim.claims, text(s)))).toMatchObject({
      code: 'stale_epoch',
    });
    expect(s.deliveries()).toBe(0);
  });
});
