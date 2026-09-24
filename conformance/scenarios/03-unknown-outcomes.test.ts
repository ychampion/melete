import { afterAll, describe, expect, test } from 'bun:test';
import { loadAction } from '../../apps/melete/src/broker/records.ts';
import { createConformanceFixture, deferred } from '../../apps/melete/test/helpers/conformance.ts';
import { scenario } from '../scenarios.ts';

const spec = scenario(3);
const fixture = await createConformanceFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => await fixture?.close());

/** Long beside a destination write, so the timeout can only fire after it. */
const DISPATCH_TIMEOUT_MS = 2_000;

/** A step the test waits on, which the destination can also report as failed. */
function outcome() {
  let succeed = () => {};
  let fail = (_reason: string) => {};
  const promise = new Promise<void>((resolve, reject) => {
    succeed = resolve;
    fail = (reason) => reject(new Error(reason));
  });
  return { promise, succeed, fail };
}

/** Waits at most `ms`, then fails with what did not happen instead of hanging. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function setup(verify = true) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  return fixture.setup({ verify });
}

describe(`conformance 3: ${spec.title}`, () => {
  databaseTest(
    'provider timeout after the destination write reconciles the original logical action identity',
    async () => {
      if (!fixture) throw new Error('Postgres fixture unavailable');
      // The dispatch timeout starts with the connector call and aborts it, and
      // the destination refuses an aborted call before it writes. The write
      // must land first, so the timeout is long beside the write, and the
      // destination then holds its reply until the timeout has fired.
      const write = outcome();
      const timedOut = outcome();
      const release = deferred();
      const s = await fixture.setup({
        dispatchTimeoutMs: DISPATCH_TIMEOUT_MS,
        execute: async (action, ctx, destination) => {
          if (ctx.signal?.aborted)
            write.fail('the dispatch timeout fired before the destination was called');
          const receipt = await destination.execute(action, ctx);
          write.succeed();
          if (ctx.signal?.aborted) timedOut.succeed();
          else ctx.signal?.addEventListener('abort', () => timedOut.succeed(), { once: true });
          await release.promise;
          return receipt;
        },
      });
      const payload = { body: 'Accept, then lose the provider response.' };
      const p = await s.approve(payload, 'provider-timeout-action');
      await s.broker.admit(s.claims, p.action_id, p.payload_hash);
      const dispatch = s.broker.dispatch(p.action_id);
      // A dispatch that fails before the write ends the wait with its reason.
      void dispatch.catch((error: unknown) => write.fail(`the dispatch failed: ${String(error)}`));
      try {
        await within(write.promise, DISPATCH_TIMEOUT_MS, 'the destination write did not land');
        await within(timedOut.promise, 2 * DISPATCH_TIMEOUT_MS, 'the dispatch timeout never fired');
        const unknown = await within(dispatch, DISPATCH_TIMEOUT_MS, 'the dispatch never returned');
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
        await within(dispatch, DISPATCH_TIMEOUT_MS, 'the dispatch never returned');
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
