import { afterAll, describe, expect, test } from 'bun:test';
import type { SchedulingClass } from '@melete/contracts';
import { appendEvent as appendBrokerEvent, lockJob } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { appendEvent } from '../../src/events/store.ts';
import { EventStream } from '../../src/events/stream.ts';
import { type AttemptWake, attemptQueue, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
if (handle) await initializeTestLedger(handle.sql);
const databaseTest = handle ? test : test.skip;
afterAll(async () => {
  await queue?.stop();
  await handle?.close();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Broker/service condition timed out');
    await Bun.sleep(5);
  }
}

async function setup() {
  if (!handle || !queue) throw new Error('Postgres unavailable');
  const seed = await seedJob(handle.sql);
  const connector = createTestConnector(handle.sql);
  const broker = new BrokerService({
    sql: handle.sql,
    boss: queue.boss,
    connectors: { get: (id) => (id === seed.connectionId ? connector : undefined) },
  });
  const jobs = new JobService(handle.db, queue.boss);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'production-review-test-key-not-a-secret',
    scopes: seed.claims.scopes,
  });
  const request = {
    kind: 'test.send',
    connection_id: seed.connectionId,
    payload: { body: 'Once only.' },
  };
  return { ...seed, handle, queue, broker, runner, request, connector };
}

describe('broker and service share the production contracts', () => {
  for (const scheduling of ['interactive', 'background', 'quiet'] as SchedulingClass[]) {
    databaseTest(`approval wake is immediately claimable in the ${scheduling} queue`, async () => {
      const s = await setup();
      await s.handle.sql`update job set scheduling_class = ${scheduling}, state_version = 7
        where id = ${s.claims.job_id}`;
      const proposal = await s.broker.propose(s.claims, s.request);
      await s.broker.decide(proposal.action_id, {
        decision: 'approved',
        payload_hash: proposal.payload_hash,
      });
      const [job] = await s.handle.sql`select state_version, lease_epoch from job
        where id = ${s.claims.job_id}`;
      const [wake] = await s.handle.sql`select name, data from pgboss.job
        where data->>'job_id' = ${s.claims.job_id}`;
      expect(wake?.name).toBe(attemptQueue(scheduling));
      expect(wake?.data).toMatchObject({
        job_id: s.claims.job_id,
        expected_epoch: job?.lease_epoch,
        expected_version: job?.state_version,
        reason: 'approval',
      });
      const claimed = await s.runner.claim(wake?.data as AttemptWake);
      expect(claimed).not.toBeNull();
      expect(await s.runner.claim(wake?.data as AttemptWake)).toBeNull();
      if (!claimed) throw new Error('Wake did not start an attempt');
      const sent = await s.broker.propose(claimed.claims, s.request);
      expect(sent.status).toBe('succeeded');
      expect(sent.action_id).toBe(proposal.action_id);
      expect(sent.requires_approval).toBe(false);
      expect(
        await s.handle.sql`select action_id from test_destination_ledger
        where action_id = ${sent.action_id}`,
      ).toHaveLength(1);
    });
  }

  for (const resolution of ['verify', 'late_receipt'] as const) {
    databaseTest(
      `${resolution} creates a fresh claimable wake without replaying an unknown send`,
      async () => {
        const s = await setup();
        await s.handle.sql`update job set scheduling_class = 'quiet' where id = ${s.claims.job_id}`;
        const request = { ...s.request, payload: { ...s.request.payload, drop_ack: true } };
        const proposal = await s.broker.propose(s.claims, request);
        await s.broker.decide(proposal.action_id, {
          decision: 'approved',
          payload_hash: proposal.payload_hash,
        });
        await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
        const unknown = await s.broker.dispatch(proposal.action_id);
        expect(unknown.status).toBe('unknown');
        const repeat = await s.broker.propose(s.claims, request);
        expect(repeat.status).toBe('unknown');
        expect(repeat.requires_approval).toBe(false);
        const confirmation = await s.connector.verify(unknown, {
          job_id: s.claims.job_id,
          space_id: s.claims.space_id,
          idempotency_key: proposal.action_id,
          constraints: {
            deliverable: { kind: 'none' },
            public_compartment: false,
            allowed_domains: [],
          },
        });
        if (confirmation.decision !== 'succeeded' || !confirmation.receipt)
          throw new Error('Test destination did not confirm its one delivery');
        const resolved =
          resolution === 'verify'
            ? await s.broker.verify(proposal.action_id)
            : await s.broker.recordResult(proposal.action_id, {
                outcome: 'succeeded',
                receipt: confirmation.receipt,
              });
        expect(resolved.status).toBe('succeeded');
        const wakes = await s.handle.sql`select name, data from pgboss.job
        where data->>'job_id' = ${s.claims.job_id} order by created_on, id`;
        expect(wakes).toHaveLength(2);
        const prior = wakes.find((row) => row.data.reason === 'approval');
        const resumed = wakes.find((row) => row.data.reason === 'recovery');
        expect(resumed?.name).toBe(attemptQueue('quiet'));
        expect(resumed?.data.expected_version).toBeGreaterThan(prior?.data.expected_version);
        expect(await s.runner.claim(prior?.data as AttemptWake)).toBeNull();
        const claimed = await s.runner.claim(resumed?.data as AttemptWake);
        if (!claimed) throw new Error('Reconciled action did not wake its job');
        const result = await s.broker.propose(claimed.claims, request);
        expect(result.action_id).toBe(proposal.action_id);
        expect(result.status).toBe('succeeded');
        expect(
          await s.handle.sql`select action_id from test_destination_ledger
        where action_id = ${proposal.action_id}`,
        ).toHaveLength(1);
        expect(
          await s.handle.sql`select seq from event where job_id = ${s.claims.job_id}
        and type = 'action_status_changed' and payload->>'to' = 'dispatched'`,
        ).toHaveLength(1);
      },
    );
  }

  databaseTest(
    'a failed queue insert rolls back the approval, job transition, and events',
    async () => {
      const s = await setup();
      const proposal = await s.broker.propose(s.claims, s.request);
      const [before] = await s.handle
        .sql`select state, state_version from job where id = ${s.claims.job_id}`;
      // Exercise the real queue INSERT and transaction rollback, not a mocked PgBoss.send.
      await s.handle.sql.unsafe(`create function reject_review_wake() returns trigger language plpgsql as $$
      begin raise exception 'review queue failure'; end $$`);
      await s.handle.sql.unsafe(`create trigger reject_review_wake before insert on pgboss.job
      for each row execute function reject_review_wake()`);
      try {
        expect(
          String(
            await rejectionOf(
              s.broker.decide(proposal.action_id, {
                decision: 'approved',
                payload_hash: proposal.payload_hash,
              }),
            ),
          ),
        ).toContain('review queue failure');
        const [after] = await s.handle
          .sql`select state, state_version from job where id = ${s.claims.job_id}`;
        expect(after).toEqual(before);
        const [approval] = await s.handle
          .sql`select decision from approval where id = ${proposal.approval_id}`;
        expect(approval?.decision).toBeNull();
        const [action] = await s.handle
          .sql`select status from action where id = ${proposal.action_id}`;
        expect(action?.status).toBe('needs_approval');
        expect(
          await s.handle.sql`select seq from event where job_id = ${s.claims.job_id}
        and type = 'approval_decided'`,
        ).toHaveLength(0);
        expect(
          await s.handle.sql`select id from pgboss.job where data->>'job_id' = ${s.claims.job_id}`,
        ).toHaveLength(0);
      } finally {
        await s.handle.sql.unsafe('drop trigger reject_review_wake on pgboss.job');
        await s.handle.sql.unsafe('drop function reject_review_wake()');
      }
      await s.broker.decide(proposal.action_id, {
        decision: 'approved',
        payload_hash: proposal.payload_hash,
      });
      await s.broker.decide(proposal.action_id, {
        decision: 'approved',
        payload_hash: proposal.payload_hash,
      });
      expect(
        await s.handle.sql`select id from pgboss.job where data->>'job_id' = ${s.claims.job_id}`,
      ).toHaveLength(1);
    },
  );

  databaseTest('successful and denied re-proposals do not ask for an approval again', async () => {
    for (const decision of ['approved', 'denied'] as const) {
      const s = await setup();
      const proposal = await s.broker.propose(s.claims, s.request);
      expect(proposal.requires_approval).toBe(true);
      const pending = await s.broker.propose(s.claims, s.request);
      expect(pending.requires_approval).toBe(true);
      expect(pending.action_id).toBe(proposal.action_id);
      await s.broker.decide(proposal.action_id, { decision, payload_hash: proposal.payload_hash });
      const repeated = await s.broker.propose(s.claims, s.request);
      expect(repeated.status).toBe(decision === 'approved' ? 'succeeded' : 'denied');
      expect(repeated.requires_approval).toBe(false);
      expect(repeated.approval_id).toBe(proposal.approval_id);
    }
  });

  databaseTest(
    'broker events carry the job epoch so a reconnect does not reset valid history',
    async () => {
      const s = await setup();
      await s.broker.propose(s.claims, s.request);
      const rows = await s.handle.sql`select seq, epoch from event
      where job_id = ${s.claims.job_id} order by seq`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.epoch === s.claims.epoch)).toBe(true);
      const events = new EventStream(s.handle);
      try {
        const handshake = await events.protocol.handshake(Number(rows[0]?.seq), s.claims.job_id);
        expect(handshake.frames).toEqual([]);
      } finally {
        await events.close();
      }
    },
  );

  databaseTest('broker event notifications are commit-bound and deduplicated', async () => {
    const s = await setup();
    const seen: string[] = [];
    const listening = await s.handle.sql.listen('melete_events', (value) => {
      seen.push(value);
    });
    const key = `notify:${s.claims.job_id}`;
    try {
      await s.handle.sql.begin(async (tx) => {
        await lockJob(tx, s.claims.job_id);
        await appendBrokerEvent(tx, s.claims.job_id, null, 'notice', { test: true }, key);
        expect(seen).toEqual([]);
      });
      const [stored] = await s.handle.sql`select seq from event where dedup_key = ${key}`;
      await eventually(() => seen.includes(String(stored?.seq)));
      await s.handle.sql.begin(async (tx) => {
        await lockJob(tx, s.claims.job_id);
        await appendBrokerEvent(tx, s.claims.job_id, null, 'notice', { test: true }, key);
      });
      // A committed barrier makes a missing or duplicate NOTIFY observable without sleeping.
      await s.handle.sql`select pg_notify('melete_events', 'notification-barrier')`;
      await eventually(() => seen.includes('notification-barrier'));
      expect(seen.filter((seq) => seq === String(stored?.seq))).toHaveLength(1);
    } finally {
      await listening.unlisten();
    }
  });

  databaseTest(
    'rolling back a broker event neither notifies subscribers nor holds the ordering lock',
    async () => {
      const s = await setup();
      const key = `rollback:${s.claims.job_id}`;
      const seen: string[] = [];
      const listening = await s.handle.sql.listen('melete_events', (value) => {
        seen.push(value);
      });
      try {
        expect(
          String(
            await rejectionOf(
              s.handle.sql.begin(async (tx) => {
                await lockJob(tx, s.claims.job_id);
                await appendBrokerEvent(tx, s.claims.job_id, null, 'notice', {}, key);
                throw new Error('review rollback');
              }),
            ),
          ),
        ).toContain('review rollback');
        expect(await s.handle.sql`select seq from event where dedup_key = ${key}`).toHaveLength(0);
        const committed = await serviceTransaction(s.handle.db, (tx) =>
          appendEvent(tx, {
            jobId: s.claims.job_id,
            type: 'notice',
            payload: {},
            dedupKey: `${key}:committed`,
          }),
        );
        await s.handle.sql`select pg_notify('melete_events', 'rollback-barrier')`;
        await eventually(() => seen.includes('rollback-barrier'));
        expect(seen).toEqual([String(committed?.seq), 'rollback-barrier']);
      } finally {
        await listening.unlisten();
      }
    },
  );

  databaseTest('a slow broker commit cannot be overtaken by a service event cursor', async () => {
    const s = await setup();
    const other = await seedJob(s.handle.sql);
    const inserted = deferred();
    const release = deferred();
    const slowKey = `slow:${s.claims.job_id}`;
    const fastKey = `fast:${other.claims.job_id}`;
    let fastPid = 0;
    let fastCommitted = false;
    const slow = s.handle.sql.begin(async (tx) => {
      await lockJob(tx, s.claims.job_id);
      await appendBrokerEvent(tx, s.claims.job_id, null, 'notice', { writer: 'broker' }, slowKey);
      inserted.resolve();
      await release.promise;
    });
    await inserted.promise;
    const fast = serviceTransaction(s.handle.db, async (tx) => {
      await appendEvent(tx, {
        jobId: other.claims.job_id,
        type: 'notice',
        payload: { writer: 'service' },
        dedupKey: fastKey,
      });
    }).then(() => {
      fastCommitted = true;
    });
    try {
      // Wait for PostgreSQL to report the contender blocked, or for the bad commit.
      await eventually(async () => {
        const blocked = await s.handle.sql`select pid from pg_stat_activity
          where datname = current_database() and wait_event = 'advisory'`;
        fastPid = Number(blocked[0]?.pid ?? 0);
        return fastCommitted || fastPid > 0;
      });
      expect(fastCommitted).toBe(false);
      expect(await s.handle.sql`select seq from event where dedup_key = ${fastKey}`).toHaveLength(
        0,
      );
    } finally {
      release.resolve();
      await Promise.all([slow, fast]);
    }
    const rows = await s.handle.sql`select dedup_key from event
      where dedup_key in (${slowKey}, ${fastKey}) order by seq`;
    expect(rows.map((row) => row.dedup_key)).toEqual([slowKey, fastKey]);
  });
});

describe('the owner answers for an effect Melete could not confirm', () => {
  /** A send whose acknowledgement was lost: unknown, its job waiting for reconciliation. */
  async function unconfirmed() {
    const s = await setup();
    await s.handle.sql`insert into owner (id, email)
      select ${`own_${s.claims.job_id.slice(4)}`}, 'answer@example.test'
      where not exists (select 1 from owner)`;
    const [row] = await s.handle.sql`select id from owner limit 1`;
    const ownerId = String(row?.id);
    const request = { ...s.request, payload: { ...s.request.payload, drop_ack: true } };
    const proposal = await s.broker.propose(s.claims, request);
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    const unknown = await s.broker.dispatch(proposal.action_id);
    expect(unknown.status).toBe('unknown');
    const [job] = await s.handle.sql`select state from job where id = ${s.claims.job_id}`;
    expect(job?.state).toBe('needs_reconciliation');
    const receipt = async () => {
      const confirmation = await s.connector.verify(unknown, {
        job_id: s.claims.job_id,
        space_id: s.claims.space_id,
        idempotency_key: proposal.action_id,
        constraints: {
          deliverable: { kind: 'none' },
          public_compartment: false,
          allowed_domains: [],
        },
      });
      if (confirmation.decision !== 'succeeded' || !confirmation.receipt)
        throw new Error('Test destination did not confirm its one delivery');
      return confirmation.receipt;
    };
    const wakes = async () =>
      (
        await s.handle.sql`select data from pgboss.job where data->>'job_id' = ${s.claims.job_id}
          and data->>'reason' = 'recovery'`
      ).length;
    const settled = async () => {
      const [ledger] = await s.handle.sql`select reserved, settled from budget_ledger
        where action_id = ${proposal.action_id}`;
      return ledger;
    };
    const notices = async (phase: string) =>
      (
        await s.handle.sql`select payload from event where job_id = ${s.claims.job_id}
          and type = 'notice' and payload->>'phase' = ${phase}
          and payload->>'action_id' = ${proposal.action_id}`
      ).map((entry) => entry.payload as Record<string, unknown>);
    const resolve = async (resolution: 'succeeded' | 'failed' | 'unresolved', actor = ownerId) => {
      const answered = await s.broker.resolveByOwner(actor, proposal.action_id, {
        resolution,
        note: 'Checked the destination.',
      });
      if (answered.status !== 'resolved') throw new Error(`Not resolved: ${answered.status}`);
      return answered.action;
    };
    return {
      ...s,
      ownerId,
      actionId: proposal.action_id,
      receipt,
      wakes,
      settled,
      notices,
      resolve,
    };
  }

  databaseTest('an answer of sent settles it, its budget, and wakes the waiting job', async () => {
    const s = await unconfirmed();
    const action = await s.resolve('succeeded');
    expect(action.status).toBe('succeeded');
    expect(action.resolved_at).not.toBeNull();
    expect(action.reconciliation).toMatchObject({
      decided_by: 'owner',
      resolution: 'succeeded',
      late: false,
    });
    const ledger = await s.settled();
    expect(ledger?.settled).toBe(ledger?.reserved);
    expect(await s.wakes()).toBe(1);
    expect(await s.notices('owner_resolved')).toEqual([
      expect.objectContaining({ resolution: 'succeeded', late: false }),
    ]);
  });

  databaseTest('an answer of not sent settles it as failed', async () => {
    const s = await unconfirmed();
    const action = await s.resolve('failed');
    expect(action.status).toBe('failed');
    expect(action.resolved_at).not.toBeNull();
    const ledger = await s.settled();
    expect(ledger?.settled).toBe(ledger?.reserved);
    expect(await s.wakes()).toBe(1);
  });

  databaseTest('an answer that it cannot be told leaves it open and the job waiting', async () => {
    const s = await unconfirmed();
    const action = await s.resolve('unresolved');
    expect(action.status).toBe('unresolved');
    expect(action.resolved_at).toBeNull();
    expect((await s.settled())?.settled).toBeNull();
    expect(await s.wakes()).toBe(0);
    // It can still be answered.
    expect((await s.resolve('succeeded')).status).toBe('succeeded');
  });

  databaseTest('an answer for an attempt already replaced does not wake the job', async () => {
    const s = await unconfirmed();
    await s.handle.sql`update job set lease_epoch = lease_epoch + 1 where id = ${s.claims.job_id}`;
    const action = await s.resolve('succeeded');
    expect(action.reconciliation).toMatchObject({ decided_by: 'owner', late: true });
    expect(await s.wakes()).toBe(0);
  });

  databaseTest('only the principal the job belongs to can answer', async () => {
    const s = await unconfirmed();
    const refused = await s.broker.resolveByOwner('own_01J8ZP3QWABCDEFGHJKMNPQRST', s.actionId, {
      resolution: 'succeeded',
    });
    expect(refused.status).toBe('not_found');
    const [action] = await s.handle.sql`select status from action where id = ${s.actionId}`;
    expect(action?.status).toBe('unknown');
  });

  databaseTest(
    'a receipt that arrives after the owner said not sent is what happened',
    async () => {
      const s = await unconfirmed();
      await s.resolve('failed');
      const landed = await s.broker.recordResult(s.actionId, {
        outcome: 'succeeded',
        receipt: await s.receipt(),
      });
      expect(landed.status).toBe('succeeded');
      expect(landed.receipt).not.toBeNull();
      expect(landed.reconciliation).toMatchObject({
        decision: 'succeeded',
        source: 'authentic_receipt',
        superseded_owner_answer: { decided_by: 'owner', resolution: 'failed' },
      });
      expect(await s.notices('provider_evidence')).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          owner_answer: 'failed',
          status: 'succeeded',
        }),
      ]);
      // The same evidence again changes nothing and tells nobody twice.
      await s.broker.recordResult(s.actionId, { outcome: 'succeeded', receipt: await s.receipt() });
      expect(await s.notices('provider_evidence')).toHaveLength(1);
    },
  );

  databaseTest('verification that finds it sent overrides the owner too', async () => {
    const s = await unconfirmed();
    await s.resolve('failed');
    const verified = await s.broker.verify(s.actionId);
    expect(verified.status).toBe('succeeded');
    expect(verified.reconciliation).toMatchObject({
      superseded_owner_answer: { resolution: 'failed' },
    });
  });

  databaseTest('a provider failure after the owner said sent is recorded beside it', async () => {
    const s = await unconfirmed();
    await s.resolve('succeeded');
    const landed = await s.broker.recordResult(s.actionId, {
      outcome: 'failed',
      reason: 'The destination bounced it.',
      retryable: false,
    });
    expect(landed.status).toBe('succeeded');
    expect(landed.reconciliation).toMatchObject({
      decided_by: 'owner',
      resolution: 'succeeded',
      provider_answer: { decision: 'failed', reason: 'The destination bounced it.' },
    });
    expect(await s.notices('provider_evidence')).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        owner_answer: 'succeeded',
        status: 'succeeded',
      }),
    ]);
  });
});
