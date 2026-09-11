/**
 * Two properties of the effect boundary, against real Postgres.
 *
 * E5, effect identity: one action per intended effect, across attempts. A
 * runtime that dies and comes back proposes the same thing and is handed what
 * already exists, whatever state it rests in.
 *
 * E4, trust-class admission: a recipient, destination, amount or resource whose
 * origin Melete cannot vouch for needs a fresh approval taken with that doubt in
 * view, and no standing grant and no earlier answer substitutes for it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { loadAction, recordId } from '../../src/broker/records.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { createConformanceFixture } from '../helpers/conformance.ts';

const fixture = await createConformanceFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

const friday = {
  origin_trust: 'external_content' as const,
  handle: 'web:friday-page',
  description: 'This address came from a web page fetched on Friday.',
};

async function setup(options: Parameters<NonNullable<typeof fixture>['setup']>[0] = {}) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  return fixture.setup(options);
}

const send = (connectionId: string, payload: JsonObject) => ({
  kind: 'test.send',
  connection_id: connectionId,
  payload,
});

describe('E5: effect identity across attempts', () => {
  databaseTest(
    'an attempt killed before dispatch is replaced, and the same send happens once',
    async () => {
      const s = await setup();
      const payload = { body: 'Send this exactly once.' };
      const first = await s.approve(payload);
      expect(first.repeated).toBe(false);
      expect((await loadAction(s.sql, first.action_id)).status).toBe('approved');

      const next = await s.nextAttempt();
      const repeat = await s.broker.propose(next, send(s.connectionId, payload));
      expect(repeat.repeated).toBe(true);
      expect(repeat.action_id).toBe(first.action_id);
      expect(repeat.intent_key).toBe(first.intent_key);
      expect(repeat.status).toBe('succeeded');

      expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(1);
      expect(
        await s.sql`select action_id from test_destination_ledger where action_id = ${first.action_id}`,
      ).toHaveLength(1);
      expect(
        await s.sql`select seq from event where job_id = ${s.claims.job_id}
          and type = 'action_status_changed' and payload->>'to' = 'dispatched'`,
      ).toHaveLength(1);
      expect(s.executions()).toBe(1);
      const action = await loadAction(s.sql, first.action_id);
      expect(action.receipt?.external_ref).toBe(first.action_id);
      expect(action.intent_key).toBe(first.intent_key);
    },
  );

  databaseTest(
    'an attempt killed after dispatch with a lost acknowledgement re-proposes into unknown',
    async () => {
      const s = await setup();
      const payload = { body: 'Accept this and lose the reply.', drop_ack: true };
      const sent = await s.send(payload);
      expect(sent.status).toBe('unknown');

      const next = await s.nextAttempt();
      const repeat = await s.broker.propose(next, send(s.connectionId, payload));
      expect(repeat.repeated).toBe(true);
      expect(repeat.action_id).toBe(sent.id);
      expect(repeat.status).toBe('unknown');
      expect(repeat.message).toContain('Melete cannot confirm whether this was sent');
      expect(repeat.message).toContain('was not sent again');

      expect(s.executions()).toBe(1);
      expect(
        await s.sql`select action_id from test_destination_ledger where action_id = ${sent.id}`,
      ).toHaveLength(1);
      expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(1);

      const resolved = await s.restart().verify(sent.id);
      expect(resolved.status).toBe('succeeded');
      expect(resolved.receipt?.external_ref).toBe(sent.id);
      expect(s.executions()).toBe(1);
    },
  );

  databaseTest(
    'a re-proposal of a send that succeeded names the time and the receipt',
    async () => {
      const s = await setup();
      const payload = { body: 'This one goes through.' };
      const sent = await s.send(payload);
      expect(sent.status).toBe('succeeded');

      const next = await s.nextAttempt();
      const repeat = await s.broker.propose(next, send(s.connectionId, payload));
      expect(repeat.status).toBe('succeeded');
      expect(repeat.message).toContain(
        `already succeeded at ${sent.resolved_at}, receipt ${sent.id}`,
      );
      expect(s.executions()).toBe(1);
    },
  );

  databaseTest('one changed byte is a different effect that needs its own approval', async () => {
    const s = await setup();
    const first = await s.approve({ body: 'Meet at 3pm.' });
    const next = await s.nextAttempt();
    const edited = await s.broker.propose(next, send(s.connectionId, { body: 'Meet at 4pm.' }));

    expect(edited.repeated).toBe(false);
    expect(edited.action_id).not.toBe(first.action_id);
    expect(edited.intent_key).not.toBe(first.intent_key);
    expect(edited.payload_hash).not.toBe(first.payload_hash);
    expect(edited.status).toBe('needs_approval');
    expect(edited.approval_id).not.toBe(first.approval_id);
    expect((await loadAction(s.sql, first.action_id)).status).toBe('approved');
    expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(2);
    expect(s.executions()).toBe(0);
  });

  databaseTest('the database itself refuses a second action for one intent key', async () => {
    const s = await setup();
    const first = await s.approve({ body: 'Only one of these may exist.' });
    const action = await loadAction(s.sql, first.action_id);
    const duplicate = recordId('act');
    const rejection = await rejectionOf(
      s.sql`insert into action
        (id, job_id, attempt_id, connection_id, kind, effect_class, canonical_payload,
         payload_hash, idempotency_key, intent_key)
        values (${duplicate}, ${action.job_id}, ${action.attempt_id}, ${action.connection_id},
          ${action.kind}, ${action.effect_class}, ${JSON.stringify(action.canonical_payload)}::jsonb,
          ${action.payload_hash}, ${duplicate}, ${action.intent_key})`,
    );
    expect(String(rejection)).toContain('action_intent_key_idx');
    expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(1);
  });
});

describe('E4: trust-class admission', () => {
  databaseTest('a standing grant does not carry an address that came from a web page', async () => {
    const table = new Map([['stranger@example.com', friday]]);
    const s = await setup({
      resolveTrust: createTableTrustResolver(table),
      resolveStandingGrant: async () => true,
    });
    const payload = { to: 'stranger@example.com', body: 'Send the invoice here.' };
    const proposal = await s.broker.propose(s.claims, send(s.connectionId, payload));
    expect(proposal.status).toBe('needs_approval');
    expect(proposal.requires_approval).toBe(true);
    expect(proposal.origin_warnings).toEqual([
      {
        field: 'to',
        origin_trust: 'external_content',
        handle: 'web:friday-page',
        description: 'This address came from a web page fetched on Friday.',
      },
    ]);

    const refusal = await rejectionOf(
      s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash),
    );
    expect(refusal).toMatchObject({ code: 'untrusted_recipient_origin' });
    expect(String((refusal as Error).message)).toContain('external_content');

    const [request] = await s.sql`select payload from event where job_id = ${s.claims.job_id}
        and type = 'approval_requested'`;
    expect(request?.payload.origin_warnings[0].description).toContain('web page fetched on Friday');
    const [approval] =
      await s.sql`select decision, origin_warnings from approval where action_id = ${proposal.action_id}`;
    expect(approval?.decision).toBeNull();
    expect(approval?.origin_warnings).toHaveLength(1);
    const [rejected] = await s.sql`select payload from event where job_id = ${s.claims.job_id}
        and payload->>'phase' = 'admission_rejected'`;
    expect(rejected?.payload.code).toBe('untrusted_recipient_origin');
    expect(
      await s.sql`select id from budget_ledger where action_id = ${proposal.action_id}`,
    ).toHaveLength(0);
    expect(s.executions()).toBe(0);
  });

  databaseTest(
    'the same payload auto-admits under the grant when the owner supplied the address',
    async () => {
      const table = new Map([['stranger@example.com', { origin_trust: 'owner' as const }]]);
      const s = await setup({
        resolveTrust: createTableTrustResolver(table),
        resolveStandingGrant: async () => true,
      });
      const payload = { to: 'stranger@example.com', body: 'Send the invoice here.' };
      const proposal = await s.broker.propose(s.claims, send(s.connectionId, payload));

      expect(proposal.status).toBe('succeeded');
      expect(proposal.requires_approval).toBe(false);
      expect(proposal.approval_id).toBeNull();
      expect(proposal.origin_warnings).toEqual([]);
      expect(
        await s.sql`select id from approval where action_id = ${proposal.action_id}`,
      ).toHaveLength(0);
      expect(
        await s.sql`select action_id from test_destination_ledger where action_id = ${proposal.action_id}`,
      ).toHaveLength(1);
      const [authorized] = await s.sql`select payload from event where job_id = ${s.claims.job_id}
      and payload->>'phase' = 'execution_authorized'`;
      expect(authorized?.payload.standing_grant).toBe(true);
      expect(s.executions()).toBe(1);
    },
  );

  databaseTest('an approval given before the origin was known does not count', async () => {
    const table = new Map<string, { origin_trust: string; handle?: string; description?: string }>([
      ['zara@example.com', { origin_trust: 'owner' }],
    ]);
    const s = await setup({ resolveTrust: createTableTrustResolver(table as never) });
    const payload = { to: 'zara@example.com', body: 'Meet at 3pm.' };
    const proposal = await s.broker.propose(s.claims, send(s.connectionId, payload));
    expect(proposal.status).toBe('needs_approval');
    expect(proposal.origin_warnings).toEqual([]);
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    expect((await loadAction(s.sql, proposal.action_id)).status).toBe('approved');

    // The memory lane learns where that address actually came from.
    table.set('zara@example.com', friday);

    const refusal = await rejectionOf(
      s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash),
    );
    expect(refusal).toMatchObject({ code: 'untrusted_recipient_origin' });
    expect((await loadAction(s.sql, proposal.action_id)).status).toBe('needs_approval');
    const [approval] =
      await s.sql`select decision, origin_warnings from approval where action_id = ${proposal.action_id}`;
    expect(approval?.decision).toBeNull();
    expect(approval?.origin_warnings[0].handle).toBe('web:friday-page');
    const [superseded] = await s.sql`select payload from event where job_id = ${s.claims.job_id}
      and payload->>'phase' = 'approval_superseded'`;
    expect(superseded?.payload.superseded_decision).toBe('approved');
    expect(
      await s.sql`select id from budget_ledger where action_id = ${proposal.action_id}`,
    ).toHaveLength(0);
    expect(s.executions()).toBe(0);

    // The answer taken with the doubt in view does count.
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    const admitted = await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    expect(admitted.status).toBe('admitted');
    const final = await s.broker.dispatch(proposal.action_id);
    expect(final.status).toBe('succeeded');
    expect(s.executions()).toBe(1);
  });

  databaseTest('a value nobody can place is refused exactly as harshly', async () => {
    const s = await setup({ resolveTrust: createTableTrustResolver(new Map()) });
    const proposal = await s.broker.propose(
      s.claims,
      send(s.connectionId, { to: 'nobody@example.com', body: 'Where did this come from?' }),
    );
    expect(proposal.origin_warnings).toEqual([
      {
        field: 'to',
        origin_trust: 'unknown',
        handle: null,
        description: 'Melete cannot say where this value came from.',
      },
    ]);
    expect(
      await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
    ).toMatchObject({ code: 'untrusted_recipient_origin' });
    expect(s.executions()).toBe(0);
  });

  databaseTest('a payload that chooses nothing external is not gated at all', async () => {
    const s = await setup({ resolveTrust: createTableTrustResolver(new Map()) });
    const proposal = await s.approve({ body: 'No recipient, no destination, no amount.' });
    expect(proposal.origin_warnings).toEqual([]);
    const admitted = await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    expect(admitted.status).toBe('admitted');
    expect((await s.broker.dispatch(proposal.action_id)).status).toBe('succeeded');
    expect(s.executions()).toBe(1);
  });
});
