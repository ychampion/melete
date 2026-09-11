import { afterAll, describe, expect, test } from 'bun:test';
import { loadAction } from '../../apps/melete/src/broker/records.ts';
import { createConformanceFixture, deferred } from '../../apps/melete/test/helpers/conformance.ts';
import { scenario } from '../scenarios.ts';

const spec = scenario(3);
const fixture = await createConformanceFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => await fixture?.close());

async function setup(verify = true) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  return fixture.setup({ verify });
}

describe(`conformance 3: ${spec.title}`, () => {
  databaseTest(
    'provider timeout after the destination write reconciles the original logical action identity',
    async () => {
      if (!fixture) throw new Error('Postgres fixture unavailable');
      const wrote = deferred();
      const release = deferred();
      const s = await fixture.setup({
        dispatchTimeoutMs: 75,
        execute: async (action, ctx, destination) => {
          const receipt = await destination.execute(action, ctx);
          wrote.resolve();
          // The injected timeout is after durable acceptance, never before execute.
          await release.promise;
          return receipt;
        },
      });
      const payload = { body: 'Accept, then lose the provider response.' };
      const p = await s.approve(payload, 'provider-timeout-action');
      await s.broker.admit(s.claims, p.action_id, p.payload_hash);
      const dispatch = s.broker.dispatch(p.action_id);
      try {
        await wrote.promise;
        const unknown = await dispatch;
        expect(unknown.status).toBe('unknown');
        const [accepted] =
          await s.sql`select action_id, payload_hash from test_destination_ledger where action_id = ${p.action_id}`;
        expect(accepted).toMatchObject({ action_id: p.action_id, payload_hash: p.payload_hash });
        const restarted = s.restart();
        const retry = await restarted.propose(s.claims, {
          kind: 'test.send',
          connection_id: s.connectionId,
          payload,
          client_ref: 'provider-timeout-action',
        });
        expect(retry.action_id).toBe(p.action_id);
        expect(retry.status).toBe('unknown');
        const verified = await restarted.verify(p.action_id);
        expect(verified.status).toBe('succeeded');
        expect(verified.receipt?.external_ref).toBe(p.action_id);
        expect(s.executions()).toBe(1);
        expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(
          1,
        );
        expect(
          await s.sql`select action_id from test_destination_ledger where action_id = ${p.action_id}`,
        ).toHaveLength(1);
      } finally {
        release.resolve();
        await dispatch;
      }
    },
  );

  databaseTest(
    'the action rests at unknown and the job moves to needs_reconciliation',
    async () => {
      const s = await setup();
      const action = await s.send({ body: 'Accept this exactly once.', drop_ack: true });
      expect(action.status).toBe('unknown');
      expect(action.receipt).toBeNull();
      const [job] = await s.sql`SELECT state FROM job WHERE id = ${s.claims.job_id}`;
      expect(job?.state).toBe('needs_reconciliation');
      const [accepted] =
        await s.sql`SELECT action_id, payload_hash, payload FROM test_destination_ledger WHERE action_id = ${action.id}`;
      expect(accepted?.action_id).toBe(action.id);
      expect(accepted?.payload_hash).toBe(action.payload_hash);
      expect(accepted?.payload).toEqual(action.canonical_payload);
      const [reservation] =
        await s.sql`SELECT reserved, settled FROM budget_ledger WHERE action_id = ${action.id}`;
      expect(reservation?.reserved).toBe(1);
      expect(reservation?.settled).toBeNull();
      expect(s.executions()).toBe(1);
    },
  );

  databaseTest(
    'the action is never dispatched a second time, including after broker restart',
    async () => {
      const s = await setup();
      const payload = { body: 'Retry the proposal without sending again.', drop_ack: true };
      const action = await s.send(payload, 'same-send');
      const restarted = s.restart();
      const repeated = await restarted.propose(s.claims, {
        kind: 'test.send',
        connection_id: s.connectionId,
        payload,
        client_ref: 'same-send',
      });
      expect(repeated.action_id).toBe(action.id);
      expect(repeated.status).toBe('unknown');
      expect((await restarted.dispatch(action.id)).status).toBe('unknown');
      expect(await restarted.recoverDispatched()).toBe(0);
      expect((await s.broker.dispatch(action.id)).status).toBe('unknown');
      expect(s.executions()).toBe(1);
      expect(await s.sql`SELECT id FROM action WHERE job_id = ${s.claims.job_id}`).toHaveLength(1);
      expect(
        await s.sql`SELECT action_id FROM test_destination_ledger WHERE action_id = ${action.id}`,
      ).toHaveLength(1);
      const dispatches = await s.sql`SELECT seq FROM event WHERE job_id = ${s.claims.job_id}
      AND type = 'action_status_changed' AND payload->>'to' = 'dispatched'`;
      expect(dispatches).toHaveLength(1);
    },
  );

  databaseTest('verify resolves the action to succeeded and the job continues', async () => {
    const s = await setup();
    const action = await s.send({ body: 'Verify the destination ledger.', drop_ack: true });
    const resolved = await s.restart().verify(action.id);
    expect(resolved.status).toBe('succeeded');
    expect(resolved.receipt?.external_ref).toBe(action.id);
    expect(resolved.receipt?.late).toBe(false);
    expect(resolved.reconciliation?.decision).toBe('succeeded');
    expect(resolved.resolved_at).not.toBeNull();
    const [job] =
      await s.sql`SELECT state, next_wake_at, wait FROM job WHERE id = ${s.claims.job_id}`;
    expect(job?.state).toBe('queued');
    expect(job?.next_wake_at).not.toBeNull();
    expect(job?.wait).toEqual({ kind: 'none' });
    const [reservation] =
      await s.sql`SELECT reserved, settled FROM budget_ledger WHERE action_id = ${action.id}`;
    expect(reservation?.settled).toBe(reservation?.reserved);
    // Approval and reconciliation are distinct wakes; this assertion isolates the latter.
    const wakes = await s.sql`SELECT id FROM pgboss.job WHERE data->>'job_id' = ${s.claims.job_id}
      AND data->>'reason' = 'recovery'`;
    expect(wakes).toHaveLength(1);
    expect((await s.broker.dispatch(action.id)).status).toBe('succeeded');
    expect(s.executions()).toBe(1);
  });

  databaseTest(
    'against a destination with no verify, the action rests at unresolved and the owner is asked',
    async () => {
      const s = await setup(false);
      const action = await s.send(
        { body: 'The acceptance cannot be verified.', drop_ack: true },
        'unresolved-send',
      );
      const restarted = s.restart();
      const unresolved = await restarted.verify(action.id);
      expect(unresolved.status).toBe('unresolved');
      expect(unresolved.resolved_at).toBeNull();
      expect(unresolved.reconciliation?.decision).toBe('unsupported');
      const [job] = await s.sql`SELECT state, wait FROM job WHERE id = ${s.claims.job_id}`;
      expect(job?.state).toBe('needs_reconciliation');
      expect(job?.wait.kind).toBe('user_input');
      expect(job?.wait.question).toContain('Melete cannot confirm whether this was sent');
      expect((await restarted.verify(action.id)).status).toBe('unresolved');
      expect((await restarted.dispatch(action.id)).status).toBe('unresolved');
      expect((await loadAction(s.sql, action.id)).status).toBe('unresolved');
      expect(s.executions()).toBe(1);
      expect(
        await s.sql`SELECT action_id FROM test_destination_ledger WHERE action_id = ${action.id}`,
      ).toHaveLength(1);
    },
  );

  databaseTest(
    'the stored owner-facing text names the doubt: Melete cannot confirm whether this was sent',
    async () => {
      const s = await setup(false);
      const action = await s.send({ drop_ack: true });
      expect(action.reconciliation?.reason).toContain(
        'Melete cannot confirm whether this was sent',
      );
      const unresolved = await s.broker.verify(action.id);
      expect(unresolved.reconciliation?.question).toContain(
        'Melete cannot confirm whether this was sent',
      );
      expect(unresolved.reconciliation?.question).toContain('Check the destination');
      expect(s.executions()).toBe(1);
    },
  );
});
