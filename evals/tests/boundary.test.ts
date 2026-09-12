import { afterAll, describe, expect, test } from 'bun:test';
import type { AttemptBundle, CapabilityClaims, ConnectorManifest } from '@melete/contracts';
import { signCapability } from '../../apps/melete/src/broker/capability.ts';
import { createInternalServer } from '../../apps/melete/src/broker/internal-server.ts';
import { recordId } from '../../apps/melete/src/broker/records.ts';
import {
  pendingRuntimeWait,
  requestRuntimeWait,
} from '../../apps/melete/src/broker/runtime-wait.ts';
import { BrokerService } from '../../apps/melete/src/broker/service.ts';
import type { Connector } from '../../apps/melete/src/connectors/types.ts';
import { lexicalQuery } from '../../apps/melete/src/memory/recall.ts';
import { rejectionOf, seedJob } from '../../apps/melete/test/helpers/broker.ts';
import { testDatabase } from '../../apps/melete/test/helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});
const sql = () => {
  if (!fixture) throw new Error('Database unavailable');
  return fixture.sql;
};
const bundle = (claims: CapabilityClaims) =>
  ({
    attempt: {
      id: claims.attempt_id,
      job_id: claims.job_id,
      epoch: claims.epoch,
      revision: claims.revision,
    },
  }) as AttemptBundle;
async function nextAttempt(claims: CapabilityClaims) {
  const db = sql();
  const next = { ...claims, attempt_id: recordId('att'), epoch: claims.epoch + 1 };
  await db`UPDATE attempt SET outcome='completed', ended_at=now() WHERE id=${claims.attempt_id}`;
  await db`UPDATE job SET lease_epoch=${next.epoch}, state='running' WHERE id=${claims.job_id}`;
  await db`INSERT INTO attempt(id,job_id,epoch,runtime_version,provider,model) VALUES(${next.attempt_id},${next.job_id},${next.epoch},'fixture','scripted','scripted')`;
  return next;
}
const manifest: ConnectorManifest = {
  name: 'eval-regression',
  provider: 'test',
  version: '1.0.0',
  description: 'Boundary regression',
  credentials: [],
  health: true,
  tools: ['read', 'send'].map((kind) => ({
    name: `test.${kind}`,
    description: kind,
    input_schema: { type: 'object' },
    effect_class: kind === 'read' ? 'read' : 'write_external',
    required_scopes: [`test.${kind}`],
    requires_approval: kind !== 'read',
    verify: false,
  })),
};
async function setup() {
  const db = sql();
  const seeded = await seedJob(db, { scopes: ['test.read', 'test.send', 'job.wait'] });
  let calls = 0;
  const connector: Connector = {
    manifest,
    async execute(action) {
      calls++;
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: `observation-${calls}`,
          detail: { observation: calls },
          received_at: new Date().toISOString(),
          late: false,
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
  return {
    ...seeded,
    calls: () => calls,
    broker: new BrokerService({
      sql: db,
      connectors: { get: (id) => (id === seeded.connectionId ? connector : undefined) },
    }),
  };
}
async function eventTrigger(jobId: string, enabled = true) {
  const db = sql();
  const id = recordId('trg');
  await db`INSERT INTO trigger(id,job_id,kind,spec,enabled) VALUES(${id},${jobId},'event','{}'::jsonb,${enabled})`;
  return { kind: 'event' as const, trigger_id: id, deadline_at: null };
}

describe('read freshness without weakening external effect identity', () => {
  databaseTest('the same attempt reuses an observation; a new attempt rereads', async () => {
    const s = await setup();
    const request = {
      kind: 'test.read',
      connection_id: s.connectionId,
      payload: { query: 'latest status' },
      client_ref: 'stable-read',
    };
    const first = await s.broker.propose(s.claims, request);
    const replay = await s.broker.propose(s.claims, request);
    expect(replay.action_id).toBe(first.action_id);
    expect(s.calls()).toBe(1);
    const newer = await nextAttempt(s.claims);
    const fresh = await s.broker.propose(newer, request);
    expect(fresh.action_id).not.toBe(first.action_id);
    expect(s.calls()).toBe(2);
    const stored = await s.broker.get(newer, fresh.action_id);
    expect(stored.receipt?.detail).toEqual({ observation: 2 });
  });
  databaseTest(
    'external reproposals retain one action and one approval across attempts',
    async () => {
      const s = await setup();
      const request = {
        kind: 'test.send',
        connection_id: s.connectionId,
        payload: { to: 'fixture@example.test', body: 'one send' },
        client_ref: 'stable-write',
      };
      const first = await s.broker.propose(s.claims, request);
      const newer = await nextAttempt(s.claims);
      const replay = await s.broker.propose(newer, request);
      expect(replay.action_id).toBe(first.action_id);
      expect(replay.status).toBe('needs_approval');
      expect(s.calls()).toBe(0);
      const rows = await sql()`SELECT id FROM approval WHERE action_id=${first.action_id}`;
      expect(rows).toHaveLength(1);
    },
  );
  databaseTest('a stale reader remains fenced after a new attempt starts', async () => {
    const s = await setup();
    await nextAttempt(s.claims);
    const failure = await rejectionOf(
      s.broker.propose(s.claims, { kind: 'test.read', connection_id: s.connectionId, payload: {} }),
    );
    expect(failure).toMatchObject({ code: 'stale_epoch' });
    expect(s.calls()).toBe(0);
  });
});

describe('typed lifecycle waits', () => {
  databaseTest(
    'the shared gateway routes only an authenticated scoped lifecycle wait',
    async () => {
      const s = await setup();
      const capabilityKey = 'lifecycle-http-fixture-signing-key-00000000';
      const internal = createInternalServer({
        sql: sql(),
        connectors: { get: () => undefined },
        broker: s.broker,
        capabilityKey,
        approvalKey: 'lifecycle-http-fixture-approval-key-0000000',
        providers: [],
        gatewayFetch: async () => {
          throw new Error('A lifecycle wait must never invoke a provider');
        },
      });
      await new Promise<void>((resolve) => internal.server.listen(0, '127.0.0.1', resolve));
      try {
        const address = internal.server.address();
        if (!address || typeof address === 'string') throw new Error('No fixture listener');
        const wait = await eventTrigger(s.claims.job_id);
        const post = (claims?: CapabilityClaims) =>
          fetch(`http://127.0.0.1:${address.port}/attempt/wait`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(claims
                ? { authorization: `Bearer ${signCapability(claims, capabilityKey)}` }
                : {}),
            },
            body: JSON.stringify(wait),
          });
        const anonymous = await post();
        expect(anonymous.status).toBe(401);
        await anonymous.arrayBuffer();
        const unscoped = await post({ ...s.claims, scopes: ['test.read'] });
        expect(unscoped.status).toBe(403);
        await unscoped.arrayBuffer();
        expect(await pendingRuntimeWait(sql(), bundle(s.claims))).toBeNull();
        const accepted = await post(s.claims);
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toMatchObject({ status: 'waiting_for_event_or_time', wait });
        expect(await pendingRuntimeWait(sql(), bundle(s.claims))).toEqual(wait);
        expect(s.calls()).toBe(0);
      } finally {
        await new Promise<void>((resolve) => internal.server.close(() => resolve()));
      }
    },
  );
  databaseTest('a registered event wait is durable and idempotent', async () => {
    const s = await setup();
    const wait = await eventTrigger(s.claims.job_id);
    expect(await requestRuntimeWait(sql(), s.claims, wait)).toMatchObject({
      status: 'waiting_for_event_or_time',
      wait,
    });
    await requestRuntimeWait(sql(), s.claims, wait);
    expect(await pendingRuntimeWait(sql(), bundle(s.claims))).toEqual(wait);
    const rows =
      await sql()`SELECT seq FROM event WHERE dedup_key=${`${s.claims.attempt_id}:runtime-wait`}`;
    expect(rows).toHaveLength(1);
    expect(s.calls()).toBe(0);
  });
  databaseTest('a future timer is accepted without an external approval', async () => {
    const s = await setup();
    const wait = { kind: 'timer' as const, wake_at: new Date(Date.now() + 60_000).toISOString() };
    await requestRuntimeWait(sql(), s.claims, wait);
    expect(await pendingRuntimeWait(sql(), bundle(s.claims))).toEqual(wait);
    expect(
      await sql()`SELECT p.id FROM approval p JOIN action a ON a.id=p.action_id WHERE a.job_id=${s.claims.job_id}`,
    ).toHaveLength(0);
  });
  databaseTest('the wait operation requires its own scope', async () => {
    const s = await setup();
    const wait = await eventTrigger(s.claims.job_id);
    const failure = await rejectionOf(
      requestRuntimeWait(sql(), { ...s.claims, scopes: ['test.read'] }, wait),
    );
    expect(failure).toMatchObject({ code: 'scope_denied' });
  });
  databaseTest('a trigger from another job cannot be awaited', async () => {
    const s = await setup();
    const other = await setup();
    const failure = await rejectionOf(
      requestRuntimeWait(sql(), s.claims, await eventTrigger(other.claims.job_id)),
    );
    expect(failure).toMatchObject({ code: 'scope_denied' });
  });
  databaseTest('disabled triggers cannot park a live attempt', async () => {
    const s = await setup();
    const failure = await rejectionOf(
      requestRuntimeWait(sql(), s.claims, await eventTrigger(s.claims.job_id, false)),
    );
    expect(failure).toMatchObject({ code: 'scope_denied' });
  });
  databaseTest('a past timer is refused', async () => {
    const s = await setup();
    const failure = await rejectionOf(
      requestRuntimeWait(sql(), s.claims, { kind: 'timer', wake_at: '2020-01-01T00:00:00Z' }),
    );
    expect(failure).toMatchObject({ code: 'payload_invalid' });
  });
  databaseTest('an attempt cannot replace its recorded wait with a different one', async () => {
    const s = await setup();
    await requestRuntimeWait(sql(), s.claims, await eventTrigger(s.claims.job_id));
    const failure = await rejectionOf(
      requestRuntimeWait(sql(), s.claims, await eventTrigger(s.claims.job_id)),
    );
    expect(failure).toMatchObject({ code: 'payload_invalid' });
  });
  databaseTest('a pending external effect takes priority over a wait', async () => {
    const s = await setup();
    await s.broker.propose(s.claims, {
      kind: 'test.send',
      connection_id: s.connectionId,
      payload: { body: 'not yet approved' },
    });
    const failure = await rejectionOf(
      requestRuntimeWait(sql(), s.claims, await eventTrigger(s.claims.job_id)),
    );
    expect(failure).toMatchObject({ code: 'payload_invalid' });
    expect(await pendingRuntimeWait(sql(), bundle(s.claims))).toBeNull();
  });
  databaseTest('a previous attempt cannot dictate the new attempt wait', async () => {
    const s = await setup();
    await requestRuntimeWait(sql(), s.claims, await eventTrigger(s.claims.job_id));
    const newer = await nextAttempt(s.claims);
    expect(await pendingRuntimeWait(sql(), bundle(s.claims))).toBeNull();
    expect(await pendingRuntimeWait(sql(), bundle(newer))).toBeNull();
  });
  databaseTest('catalog exposes a lifecycle wait only with its scope', async () => {
    const s = await setup();
    expect(
      (await s.broker.catalog(s.claims)).some(
        (tool) => tool.name === 'job.wait' && tool.connection_id === null,
      ),
    ).toBe(true);
    expect(
      (await s.broker.catalog({ ...s.claims, scopes: ['test.read'] })).some(
        (tool) => tool.name === 'job.wait',
      ),
    ).toBe(false);
  });
});

describe('typed memory-key lexical lookup', () => {
  test('normalizes typed preference keys to the index token boundaries', () => {
    expect(lexicalQuery('pref.calendar.duration')).toBe('pref calendar duration');
    expect(lexicalQuery('  pref.mail.signature  ')).toBe('pref mail signature');
  });
  test('leaves ordinary phrases, email addresses, and URLs unchanged', () => {
    for (const query of [
      'When did Alex reply?',
      'alex@example.test',
      'https://example.test/a.b',
      'Budget: 2.5',
    ])
      expect(lexicalQuery(query)).toBe(query);
  });
});
