import { afterAll, describe, expect, test } from 'bun:test';
import { actionListResponse } from '@melete/contracts';
import { createActionReadApi } from '../../apps/melete/src/api/actions.ts';
import { loadAction } from '../../apps/melete/src/broker/records.ts';
import { createTestConnector } from '../../apps/melete/src/connectors/test.ts';
import { rejectionOf } from '../../apps/melete/test/helpers/broker.ts';
import { createConformanceFixture, deferred } from '../../apps/melete/test/helpers/conformance.ts';
import { scenario } from '../scenarios.ts';

const spec = scenario(4);
const fixture = await createConformanceFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  return fixture.setup();
}

describe(`conformance 4: ${spec.title}`, () => {
  databaseTest(
    'cancelled jobs still expose unknown and unresolved sends through the owner action API',
    async () => {
      const s = await setup();
      const first = await s.send({ body: 'Unknown send', drop_ack: true });
      const second = await s.send({ body: 'Unresolved send', drop_ack: true });
      await s.sql`update action set status = 'unresolved' where id = ${second.id}`;
      await s.broker.cancel(s.claims.job_id);
      const api = createActionReadApi({
        sql: s.sql,
        authorizeSpace: async (request) =>
          request.headers.get('authorization') === 'Bearer owner-read' ? s.claims.space_id : null,
      });
      const list = await api.request(`/actions?job_id=${s.claims.job_id}`, {
        headers: { authorization: 'Bearer owner-read' },
      });
      expect(list.status).toBe(200);
      const body = actionListResponse.parse(await list.json());
      expect(body.actions.map((action: { status: string }) => action.status).sort()).toEqual([
        'unknown',
        'unresolved',
      ]);
      expect(body.actions.map((action: { id: string }) => action.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      const denied = await api.request(`/actions?job_id=${s.claims.job_id}`, {
        headers: { authorization: 'Bearer runtime-capability' },
      });
      expect(denied.status).toBe(401);
      const other = await setup();
      const outside = await api.request(`/actions?job_id=${other.claims.job_id}`, {
        headers: { authorization: 'Bearer owner-read' },
      });
      expect(actionListResponse.parse(await outside.json()).actions).toEqual([]);
      const [job] = await s.sql`select state from job where id = ${s.claims.job_id}`;
      expect(job?.state).toBe('cancelled');
    },
  );

  databaseTest(
    'an authentic fenced receipt resolves an unknown action without reopening its attempt or cancelled job',
    async () => {
      const s = await setup();
      const action = await s.send({ body: 'Accepted before the fence', drop_ack: true });
      expect(action.status).toBe('unknown');
      await s.sql`update attempt set outcome = 'cancelled', ended_at = now() where id = ${s.claims.attempt_id}`;
      await s.broker.cancel(s.claims.job_id);
      const destination = createTestConnector(s.sql);
      const verified = await destination.verify(action, {
        job_id: s.claims.job_id,
        space_id: s.claims.space_id,
        idempotency_key: action.id,
        constraints: {
          public_compartment: false,
          allowed_domains: [],
          deliverable: { kind: 'none' },
        },
      });
      if (verified.decision !== 'succeeded' || !verified.receipt)
        throw new Error('No authentic receipt');
      const resolved = await s
        .restart()
        .recordResult(action.id, { outcome: 'succeeded', receipt: verified.receipt });
      expect(resolved.status).toBe('succeeded');
      expect(resolved.receipt?.late).toBe(true);
      expect(resolved.reconciliation).toMatchObject({
        decision: 'succeeded',
        source: 'authentic_receipt',
        late: true,
      });
      const [attempt] =
        await s.sql`select outcome, ended_at from attempt where id = ${s.claims.attempt_id}`;
      expect(attempt?.outcome).toBe('cancelled');
      expect(attempt?.ended_at).not.toBeNull();
      const [job] = await s.sql`select state, lease_epoch from job where id = ${s.claims.job_id}`;
      expect(job?.state).toBe('cancelled');
      expect(job?.lease_epoch).toBe(2);
      expect(
        await s.sql`select id from pgboss.job where data->>'job_id' = ${s.claims.job_id} and data->>'reason' = 'recovery'`,
      ).toHaveLength(0);
      expect(s.executions()).toBe(1);
    },
  );

  databaseTest(
    'admission is rejected when one payload byte no longer matches the approval, and the refusal is ledgered',
    async () => {
      const s = await setup();
      const proposal = await s.approve({ body: 'See you at 3pm.' });
      await s.sql`update action set canonical_payload = '{"body":"See you at 4pm."}'::jsonb where id = ${proposal.action_id}`;
      expect(
        await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
      ).toMatchObject({ code: 'approval_hash_mismatch' });
      expect((await loadAction(s.sql, proposal.action_id)).status).toBe('approved');
      const [refusal] =
        await s.sql`select payload from event where job_id = ${s.claims.job_id} and payload->>'phase' = 'admission_rejected'`;
      expect(refusal?.payload.code).toBe('approval_hash_mismatch');
      expect(
        await s.sql`select id from budget_ledger where action_id = ${proposal.action_id}`,
      ).toHaveLength(0);
      expect(
        await s.sql`select action_id from test_destination_ledger where action_id = ${proposal.action_id}`,
      ).toHaveLength(0);
      expect(s.executions()).toBe(0);
    },
  );

  databaseTest(
    'admission is rejected when the job revision has moved since the approval',
    async () => {
      const s = await setup();
      const proposal = await s.approve({ body: 'Approved for the old objective.' });
      await s.sql`update job set revision = revision + 1 where id = ${s.claims.job_id}`;
      // A fresh capability still cannot spend an approval for an earlier objective revision.
      expect(
        await rejectionOf(
          s.broker.admit({ ...s.claims, revision: 1 }, proposal.action_id, proposal.payload_hash),
        ),
      ).toMatchObject({ code: 'revision_mismatch' });
      const [refusal] =
        await s.sql`select payload from event where job_id = ${s.claims.job_id} and payload->>'phase' = 'admission_rejected'`;
      expect(refusal?.payload.code).toBe('revision_mismatch');
      expect(
        await s.sql`select id from budget_ledger where action_id = ${proposal.action_id}`,
      ).toHaveLength(0);
      expect(s.executions()).toBe(0);
    },
  );

  databaseTest(
    'editing the draft produces a new action with a new hash, not an amended one',
    async () => {
      const s = await setup();
      const first = await s.approve({ body: 'Meet at 3pm.' }, 'draft-one');
      const second = await s.broker.propose(s.claims, {
        kind: 'test.send',
        connection_id: s.connectionId,
        payload: { body: 'Meet at 4pm.' },
        client_ref: 'draft-two',
      });
      expect(second.action_id).not.toBe(first.action_id);
      expect(second.payload_hash).not.toBe(first.payload_hash);
      expect(second.status).toBe('needs_approval');
      expect((await loadAction(s.sql, first.action_id)).canonical_payload.body).toBe(
        'Meet at 3pm.',
      );
      expect((await loadAction(s.sql, first.action_id)).status).toBe('approved');
      expect(s.executions()).toBe(0);
    },
  );

  databaseTest(
    'after a cancel, nothing new is admitted past the fence even while admission races it',
    async () => {
      const s = await setup();
      const proposal = await s.approve({ body: 'Cancel race.' });
      const [cancelled, admitted] = await Promise.allSettled([
        s.broker.cancel(s.claims.job_id),
        s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash),
      ]);
      expect(cancelled.status).toBe('fulfilled');
      const events =
        await s.sql`select seq, type, payload from event where job_id = ${s.claims.job_id} order by seq`;
      const cancellation = events.find(
        (event) => event.type === 'job_state_changed' && event.payload.to === 'cancelled',
      );
      const admission = events.find(
        (event) => event.type === 'action_status_changed' && event.payload.to === 'admitted',
      );
      expect(cancellation).toBeDefined();
      if (admitted.status === 'fulfilled') {
        expect(admission).toBeDefined();
        expect(Number(admission?.seq)).toBeLessThan(Number(cancellation?.seq));
        const final = await s.broker.dispatch(proposal.action_id);
        expect(final.status).toBe('succeeded');
        expect(final.receipt?.late).toBe(true);
      } else {
        expect(admitted.reason).toMatchObject({ code: 'stale_epoch' });
        expect(admission).toBeUndefined();
        expect(s.executions()).toBe(0);
      }
      expect(
        await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
      ).toMatchObject({ code: 'stale_epoch' });
      const [job] = await s.sql`select state, lease_epoch from job where id = ${s.claims.job_id}`;
      expect(job?.state).toBe('cancelled');
      expect(job?.lease_epoch).toBe(2);
    },
  );

  for (const dropAck of [false, true]) {
    databaseTest(
      `an action admitted before cancel gets a truthful ${dropAck ? 'unknown' : 'final'} disposition`,
      async () => {
        if (!fixture) throw new Error('Postgres fixture unavailable');
        const entered = deferred();
        const release = deferred();
        const s = await fixture.setup({
          execute: async (action, ctx, destination) => {
            entered.resolve();
            await release.promise;
            return destination.execute(action, ctx);
          },
        });
        const proposal = await s.approve({
          body: 'Accepted despite cancellation.',
          drop_ack: dropAck,
        });
        await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
        const dispatch = s.broker.dispatch(proposal.action_id);
        await entered.promise;
        await s.broker.cancel(s.claims.job_id);
        release.resolve();
        const action = await dispatch;
        expect(action.status).toBe(dropAck ? 'unknown' : 'succeeded');
        expect(action.reconciliation?.late).toBe(true);
        if (!dropAck) expect(action.receipt?.late).toBe(true);
        expect(
          await s.sql`select action_id from test_destination_ledger where action_id = ${action.id}`,
        ).toHaveLength(1);
        if (dropAck) {
          const resolved = await s.restart().verify(action.id);
          expect(resolved.status).toBe('succeeded');
          expect(resolved.receipt?.late).toBe(true);
        }
        const [job] = await s.sql`select state, lease_epoch from job where id = ${s.claims.job_id}`;
        expect(job?.state).toBe('cancelled');
        expect(job?.lease_epoch).toBe(2);
        expect(s.executions()).toBe(1);
      },
    );
  }
});
