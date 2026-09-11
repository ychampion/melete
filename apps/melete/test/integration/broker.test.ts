import { afterAll, describe, expect, test } from 'bun:test';
import {
  type ConnectorManifest,
  canonicalizePayload,
  type DispatchResult,
} from '@melete/contracts';
import { PgBoss } from 'pg-boss';
import type { EffectAuthority } from '../../src/broker/authority.ts';
import { loadAction, recordId } from '../../src/broker/records.ts';
import type { BrokerOptions } from '../../src/broker/service.ts';
import { BrokerService } from '../../src/broker/service.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
const boss = fixture ? new PgBoss({ connectionString: fixture.url, max: 2 }) : null;
if (boss) {
  boss.on('error', () => {});
  await boss.start();
  await boss.createQueue(QUEUES.attempt);
}
afterAll(async () => {
  await boss?.stop({ graceful: true });
  await fixture?.close();
});

const manifest: ConnectorManifest = {
  name: 'test',
  provider: 'test',
  version: '0.1.0',
  description: 'Lifecycle fixture',
  credentials: [],
  health: true,
  tools: ['send', 'read'].map((name) => ({
    name: `test.${name}`,
    description: name,
    input_schema: { type: 'object' },
    effect_class: name === 'send' ? 'write_external' : 'read',
    required_scopes: [`test.${name}`],
    requires_approval: name === 'send',
    verify: false,
  })),
};
async function setup(execute?: Connector['execute'], options: Partial<BrokerOptions> = {}) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const seed = await seedJob(fixture.sql);
  let calls = 0;
  const connector: Connector = {
    manifest,
    async execute(action, ctx) {
      calls++;
      const [stored] = await fixture.sql`select status from action where id = ${action.id}`;
      const [reserved] =
        await fixture.sql`select reserved, settled from budget_ledger where action_id = ${action.id}`;
      expect(stored?.status).toBe('dispatched');
      expect(reserved?.reserved).toBe(1);
      expect(reserved?.settled).toBeNull();
      expect(ctx.idempotency_key).toBe(action.id);
      if (execute) return execute(action, ctx);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          received_at: new Date().toISOString(),
          late: false,
          detail: {},
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
  const resolver = { get: (id: string) => (id === seed.connectionId ? connector : undefined) };
  const broker = new BrokerService({
    sql: fixture.sql,
    connectors: resolver,
    boss: boss ?? undefined,
    ...options,
  });
  return { ...seed, broker, connector, resolver, sql: fixture.sql, calls: () => calls };
}

describe('durable action lifecycle', () => {
  databaseTest(
    'external proposal records canonical payload and approval before any request',
    async () => {
      const s = await setup();
      const payload = { to: 'Zara <ZARA@Example.com>', body: ' Hello ' };
      const proposal = await s.broker.propose(s.claims, {
        kind: 'test.send',
        connection_id: s.connectionId,
        payload,
      });
      expect(proposal.status).toBe('needs_approval');
      expect(proposal.payload_hash).toBe(canonicalizePayload(payload).hash);
      expect(proposal.canonical_payload).toEqual({ body: 'Hello', to: 'zara@example.com' });
      expect(s.calls()).toBe(0);
      const [approval] = await s.sql`select * from approval where id = ${proposal.approval_id}`;
      expect(approval?.payload_hash).toBe(proposal.payload_hash);
      expect(approval?.job_revision).toBe(0);
      expect(
        await s.sql`select * from budget_ledger where action_id = ${proposal.action_id}`,
      ).toHaveLength(0);
    },
  );

  databaseTest(
    'read auto-admits with a durable reservation, persists receipt, and settles',
    async () => {
      const s = await setup();
      const proposal = await s.broker.propose(s.claims, {
        kind: 'test.read',
        connection_id: s.connectionId,
        payload: {},
        client_ref: 'read',
      });
      expect(proposal.status).toBe('succeeded');
      const stored = await s.broker.get(s.claims, proposal.action_id);
      expect(stored.receipt?.action_id).toBe(proposal.action_id);
      const [ledger] =
        await s.sql`select * from budget_ledger where action_id = ${proposal.action_id}`;
      expect(ledger?.settled).toBe(1);
      const events =
        await s.sql`select payload from event where job_id = ${s.claims.job_id} and type = 'action_status_changed' order by seq`;
      expect(events.map((row) => row.payload.to)).toEqual(['admitted', 'dispatched', 'succeeded']);
    },
  );

  databaseTest(
    'proposal retries reuse action identity across service restart and refuse edited content',
    async () => {
      const s = await setup();
      const request = {
        kind: 'test.read',
        connection_id: s.connectionId,
        payload: { body: 'one' },
        client_ref: 'stable',
      };
      const first = await s.broker.propose(s.claims, request);
      const restarted = new BrokerService({ sql: s.sql, connectors: s.resolver });
      const retried = await restarted.propose(s.claims, request);
      expect(retried.action_id).toBe(first.action_id);
      expect(s.calls()).toBe(1);
      let rejection: unknown;
      try {
        await restarted.propose(s.claims, { ...request, payload: { body: 'two' } });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({ code: 'approval_hash_mismatch' });
      expect(await s.sql`select * from action where job_id = ${s.claims.job_id}`).toHaveLength(1);
    },
  );

  databaseTest('denial is final and cannot reserve budget or dispatch', async () => {
    const s = await setup();
    const proposal = await s.broker.propose(s.claims, {
      kind: 'test.send',
      connection_id: s.connectionId,
      payload: {},
    });
    await s.broker.decide(proposal.action_id, {
      decision: 'denied',
      payload_hash: proposal.payload_hash,
    });
    expect(
      await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
    ).toMatchObject({ code: 'approval_denied' });
    expect((await s.broker.dispatch(proposal.action_id)).status).toBe('denied');
    expect(s.calls()).toBe(0);
  });

  databaseTest('approval and wake commit together in pg-boss', async () => {
    const s = await setup();
    const proposal = await s.broker.propose(s.claims, {
      kind: 'test.send',
      connection_id: s.connectionId,
      payload: {},
    });
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    const [job] = await s.sql`select state, next_wake_at from job where id = ${s.claims.job_id}`;
    const [wake] =
      await s.sql`select data from pgboss.job where data->>'job_id' = ${s.claims.job_id}`;
    expect(job?.state).toBe('queued');
    expect(job?.next_wake_at).not.toBeNull();
    expect(wake?.data.reason).toBe('approval');
    await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    await Promise.all([
      s.broker.dispatch(proposal.action_id),
      s.broker.dispatch(proposal.action_id),
    ]);
    expect(s.calls()).toBe(1);
    expect((await loadAction(s.sql, proposal.action_id)).status).toBe('succeeded');
  });

  databaseTest(
    'resumed attempt can admit the same approved action, while the old attempt is fenced',
    async () => {
      const s = await setup();
      const request = {
        kind: 'test.send',
        connection_id: s.connectionId,
        payload: {},
        client_ref: 'resume',
      };
      const proposal = await s.broker.propose(s.claims, request);
      await s.broker.decide(proposal.action_id, {
        decision: 'approved',
        payload_hash: proposal.payload_hash,
      });
      const newId = recordId('att');
      await s.sql`update job set state = 'running', lease_epoch = 2 where id = ${s.claims.job_id}`;
      await s.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model) values (${newId}, ${s.claims.job_id}, 2, 'fake', 'fake', 'scripted')`;
      expect(
        await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
      ).toMatchObject({ code: 'stale_epoch' });
      const resumed = await s.broker.propose({ ...s.claims, attempt_id: newId, epoch: 2 }, request);
      expect(resumed.action_id).toBe(proposal.action_id);
      expect(resumed.status).toBe('succeeded');
      expect((await loadAction(s.sql, proposal.action_id)).attempt_id).toBe(newId);
    },
  );

  databaseTest('expired approval cannot be admitted and refusal remains ledgered', async () => {
    const s = await setup();
    const proposal = await s.broker.propose(s.claims, {
      kind: 'test.send',
      connection_id: s.connectionId,
      payload: {},
    });
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await s.sql`update approval set expires_at = now() - interval '1 second' where id = ${proposal.approval_id}`;
    expect(
      await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
    ).toMatchObject({ code: 'approval_required' });
    const [event] =
      await s.sql`select payload from event where job_id = ${s.claims.job_id} and payload->>'phase' = 'admission_rejected'`;
    expect(event?.payload.code).toBe('approval_required');
  });

  databaseTest('late receipt after cancellation is stored without reopening work', async () => {
    let release: (result: DispatchResult) => void = () => {};
    let began: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const s = await setup(async () => {
      began();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const proposal = await s.broker.propose(s.claims, {
      kind: 'test.send',
      connection_id: s.connectionId,
      payload: {},
    });
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    const pending = s.broker.dispatch(proposal.action_id);
    await started;
    await s.broker.cancel(s.claims.job_id);
    release({
      outcome: 'succeeded',
      receipt: {
        action_id: proposal.action_id,
        connection_id: s.connectionId,
        external_ref: 'accepted',
        detail: {},
        received_at: new Date().toISOString(),
        late: false,
      },
    });
    const action = await pending;
    expect(action.status).toBe('succeeded');
    expect(action.receipt?.late).toBe(true);
    const [job] = await s.sql`select state, lease_epoch from job where id = ${s.claims.job_id}`;
    expect(job?.state).toBe('cancelled');
    expect(job?.lease_epoch).toBe(2);
  });

  databaseTest('frozen unknown dispatch recovers without invoking connector again', async () => {
    const s = await setup();
    const proposal = await s.broker.propose(s.claims, {
      kind: 'test.send',
      connection_id: s.connectionId,
      payload: {},
    });
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    await s.sql`update action set status = 'dispatched', dispatched_at = now() - interval '1 minute' where id = ${proposal.action_id}`;
    expect(await s.broker.recoverDispatched()).toBe(1);
    expect((await s.broker.dispatch(proposal.action_id)).status).toBe('unknown');
    expect(s.calls()).toBe(0);
    const [job] = await s.sql`select state from job where id = ${s.claims.job_id}`;
    expect(job?.state).toBe('needs_reconciliation');
  });

  databaseTest(
    'persisted connection scopes and job space gate catalog and action access',
    async () => {
      const s = await setup();
      const proposal = await s.broker.propose(s.claims, {
        kind: 'test.send',
        connection_id: s.connectionId,
        payload: {},
      });
      await s.sql`update connection set scopes = '["test.read"]'::jsonb where id = ${s.connectionId}`;
      expect((await s.broker.catalog(s.claims)).map((tool) => tool.name)).toEqual(['test.read']);
      await expect(s.broker.get(s.claims, proposal.action_id)).rejects.toMatchObject({
        code: 'scope_denied',
      });
      const other = await seedJob(s.sql);
      await expect(s.broker.get(other.claims, proposal.action_id)).rejects.toMatchObject({
        code: 'action_not_found',
      });
    },
  );
});

describe('full effect authority binding', () => {
  async function proposal(s: Awaited<ReturnType<typeof setup>>, revision = 0) {
    const result = await s.broker.propose(
      { ...s.claims, revision },
      {
        kind: 'test.send',
        connection_id: s.connectionId,
        payload: { to: 'Zara <ZARA@Example.com>', resource: 'mailbox-one', body: 'Approved bytes' },
      },
    );
    await s.broker.decide(result.action_id, {
      decision: 'approved',
      payload_hash: result.payload_hash,
    });
    return result;
  }

  databaseTest(
    'approval records action, bytes, resource, recipient, connection, principal and expiry together',
    async () => {
      const s = await setup();
      const p = await proposal(s);
      const [event] =
        await s.sql`select payload from event where dedup_key = ${`broker:binding:${p.action_id}`}`;
      const [approval] = await s.sql`select expires_at from approval where id = ${p.approval_id}`;
      expect(event?.payload.tuple).toMatchObject({
        action_id: p.action_id,
        payload_hash: p.payload_hash,
        connection_id: s.connectionId,
        acting_principal: 'owner',
        resource: { resource: 'mailbox-one', kind: 'test.send' },
        recipient: { to: 'zara@example.com' },
        expires_at: new Date(approval?.expires_at).toISOString(),
      });
      expect(event?.payload.policy_generation).toBe(0);
      expect(event?.payload.connection_generation).toBe(0);
    },
  );

  for (const [field, changed, code, reason] of [
    ['resource', { mailbox: 'replacement' }, 'approval_hash_mismatch', 'effect_binding'],
    ['recipient', { to: 'other@example.com' }, 'approval_hash_mismatch', 'effect_binding'],
    ['actingPrincipal', 'another-account', 'approval_hash_mismatch', 'effect_binding'],
    ['policyGeneration', 1, 'scope_denied', 'policy_generation'],
    ['connectionGeneration', 1, 'scope_denied', 'connection_generation'],
    ['allowed', false, 'scope_denied', 'Current policy rejects this effect'],
  ] as const) {
    databaseTest(
      `admission revalidates ${field} with the injected current authority and ledgers refusal`,
      async () => {
        const current: Partial<EffectAuthority> = {};
        const phases: string[] = [];
        const s = await setup(undefined, {
          resolveAuthority: async (_tx, input) => {
            phases.push(input.phase);
            return current;
          },
        });
        const p = await proposal(s);
        Object.assign(current, { [field]: changed });
        expect(
          await rejectionOf(s.broker.admit(s.claims, p.action_id, p.payload_hash)),
        ).toMatchObject({ code });
        const [event] =
          await s.sql`select payload from event where job_id = ${s.claims.job_id} and payload->>'phase' = 'admission_rejected'`;
        expect(event?.payload).toMatchObject({ code, reason });
        expect(phases).toContain('admission');
        expect(
          await s.sql`select id from budget_ledger where action_id = ${p.action_id}`,
        ).toHaveLength(0);
        expect(s.calls()).toBe(0);
      },
    );
  }

  databaseTest('changing an approval expiry cannot extend the reviewed authorization', async () => {
    const s = await setup();
    const p = await proposal(s);
    await s.sql`update approval set expires_at = expires_at + interval '1 day' where id = ${p.approval_id}`;
    expect(await rejectionOf(s.broker.admit(s.claims, p.action_id, p.payload_hash))).toMatchObject({
      code: 'approval_hash_mismatch',
    });
    expect(s.calls()).toBe(0);
  });

  databaseTest(
    'an approval cannot move to a different active connection with the same payload',
    async () => {
      const s = await setup();
      const p = await proposal(s);
      const replacement = recordId('conn');
      await s.sql`insert into connection (id, space_id, provider, label, scopes)
      values (${replacement}, ${s.claims.space_id}, 'test', 'Replacement', '["test.send"]'::jsonb)`;
      s.resolver.get = (id: string) =>
        id === replacement || id === s.connectionId ? s.connector : undefined;
      await s.sql`update action set connection_id = ${replacement} where id = ${p.action_id}`;
      expect(
        await rejectionOf(s.broker.admit(s.claims, p.action_id, p.payload_hash)),
      ).toMatchObject({ code: 'approval_hash_mismatch' });
      expect(s.calls()).toBe(0);
    },
  );

  databaseTest(
    'a binding copied from another action cannot authorize otherwise identical bytes',
    async () => {
      const s = await setup();
      const first = await proposal(s);
      // Identical bytes in the same job and revision are one intended effect,
      // so the only way to hold two actions over the same payload is to move
      // the objective under them. The bytes stay byte-for-byte equal.
      await s.sql`update job set revision = 1 where id = ${s.claims.job_id}`;
      const second = await proposal(s, 1);
      await s.sql`update event set payload = (select payload from event where dedup_key = ${`broker:binding:${first.action_id}`})
      where dedup_key = ${`broker:binding:${second.action_id}`}`;
      expect(first.payload_hash).toBe(second.payload_hash);
      expect(second.action_id).not.toBe(first.action_id);
      expect(second.intent_key).not.toBe(first.intent_key);
      expect(
        await rejectionOf(
          s.broker.admit({ ...s.claims, revision: 1 }, second.action_id, second.payload_hash),
        ),
      ).toMatchObject({ code: 'approval_hash_mismatch' });
      expect(s.calls()).toBe(0);
    },
  );

  for (const revocation of ['generation', 'disabled'] as const) {
    databaseTest(
      `execution fences a queued action after connection ${revocation} and never dispatches`,
      async () => {
        let generation = 4;
        const phases: string[] = [];
        const s = await setup(undefined, {
          resolveAuthority: async (_tx, input) => {
            phases.push(input.phase);
            return { connectionGeneration: generation, policyGeneration: 3 };
          },
        });
        const p = await proposal(s);
        await s.broker.admit(s.claims, p.action_id, p.payload_hash);
        if (revocation === 'generation') generation++;
        else await s.sql`update connection set status = 'disabled' where id = ${s.connectionId}`;
        const action = await s.broker.dispatch(p.action_id);
        expect(action.status).toBe('failed');
        expect(action.reconciliation).toMatchObject({
          reason: 'connection_generation',
          retryable: false,
        });
        expect(action.dispatched_at).toBeNull();
        expect(phases).toContain('execution');
        expect(s.calls()).toBe(0);
        const [ledger] =
          await s.sql`select settled from budget_ledger where action_id = ${action.id}`;
        expect(ledger?.settled).toBe(0);
        const [event] =
          await s.sql`select payload from event where job_id = ${s.claims.job_id} and payload->>'phase' = 'dispatch_rejected'`;
        expect(event?.payload).toMatchObject({
          outcome: 'fenced',
          reason: 'connection_generation',
        });
      },
    );
  }
});
