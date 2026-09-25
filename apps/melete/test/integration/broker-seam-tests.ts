/**
 * The seam between the broker and memory, end to end and with nothing stubbed.
 *
 * Everywhere else the broker's admission rule is tested against a table that
 * says what an address is. Here memory is the one answering: an address is read
 * off a fetched page, classed `external_content` because of how it arrived, and
 * declared by the job as something it used. The broker then proposes a send to
 * that address and is refused, having asked memory rather than a fixture.
 *
 * If this passes and the table-driven tests pass, the interface both sides
 * were written against is the same interface.
 */
import { describe, expect, test } from 'bun:test';
import { PgBoss } from 'pg-boss';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { createMemoryTrustResolver } from '../../src/memory/broker-trust.ts';
import { recordOutput } from '../../src/memory/outputs.ts';
import { createScope, type TestDatabase } from './postgres.ts';
import { head, record } from './properties-fixtures.ts';

/** A job, its connection and a live attempt, inside a space memory already knows. */
async function seedJobInSpace(db: TestDatabase, spaceId: string) {
  const jobId = recordId('job');
  const attemptId = recordId('att');
  const connectionId = recordId('conn');
  const scopes = ['test.send'];
  await db.sql`insert into connection (id, space_id, provider, label, scopes)
    values (${connectionId}, ${spaceId}, 'test', 'Seam', ${JSON.stringify(scopes)}::jsonb)`;
  await db.sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget, constraints)
    values (${jobId}, ${spaceId}, 'Seam', 'Pay the invoice', 'running', 1,
      ${JSON.stringify({ max_actions: 4, max_output_tokens: 4000, max_usd_est: 1, max_wall_ms: 120_000, max_turns: 8 })}::jsonb,
      ${JSON.stringify({ public_compartment: false, allowed_domains: [] })}::jsonb)`;
  await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
  return {
    connectionId,
    claims: {
      job_id: jobId,
      attempt_id: attemptId,
      space_id: spaceId,
      epoch: 1,
      revision: 0,
      scopes,
      budget: { max_actions: 4, max_output_tokens: 4000, max_usd_est: 1 },
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

export function registerBrokerSeamTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('the broker asks memory where a value came from', () => {
    test('an address read off a page is refused as untrusted_recipient_origin', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const seed = await seedJobInSpace(db, scope.spaceId);
      const address = 'billing@vendor.example';

      // Memory learns the address the way a page teaches it: not from the owner.
      await record(
        db,
        scope,
        {
          identity: 'invoice-page-1',
          text: `Pay invoices to ${address} within 30 days.`,
          eventAt: '2026-09-11T09:00:00Z',
          sourceType: 'document',
          author: 'external',
          stream: 'web',
        },
        [
          {
            key: 'contact.vendor.email',
            content: address,
            quote: address,
            kind: 'document_assertion',
          },
        ],
      );
      const claim = await head(db, scope, 'contact.vendor.email');
      expect(claim?.origin_trust).toBe('external_content');

      // The job declares that this is what it used, which is what lets the
      // broker's question reach the claim at all.
      await recordOutput(db.sql, scope, {
        job_id: seed.claims.job_id,
        attempt_id: seed.claims.attempt_id,
        kind: 'action',
        output_id: 'seam-send-1',
        output_version: '1',
        location: 'to',
        uses: [`${claim?.id}@${claim?.head_revision}`],
      });

      await initializeTestLedger(db.sql);
      const boss = new PgBoss({ connectionString: db.url, max: 2 });
      boss.on('error', () => {});
      await boss.start();
      await boss.createQueue(QUEUES.attempt);
      const destination: Connector = createTestConnector(db.sql, { verify: false });
      try {
        const broker = new BrokerService({
          sql: db.sql,
          connectors: {
            get: (id: string) => (id === seed.connectionId ? destination : undefined),
          },
          boss,
          // No table. The real resolver, reading the claims recorded above.
          resolveTrust: createMemoryTrustResolver(),
          // A grant is deliberately in force: a doubt about the address must
          // survive it, or the grant would be a way around the rule.
          resolveStandingGrant: async () => true,
        });

        const proposal = await broker.propose(seed.claims, {
          kind: 'test.send',
          connection_id: seed.connectionId,
          payload: { to: address, body: 'Invoice attached.' },
        });
        expect(proposal.status).toBe('needs_approval');
        expect(proposal.origin_warnings).toHaveLength(1);
        expect(proposal.origin_warnings?.[0]).toMatchObject({
          field: 'to',
          origin_trust: 'external_content',
        });
        // The handle names the revision the address was read from, so the
        // approval card can point at the evidence rather than assert.
        expect(proposal.origin_warnings?.[0]?.handle).toBe(`${claim?.id}@${claim?.head_revision}`);

        let refused: unknown;
        try {
          await broker.admit(seed.claims, proposal.action_id, proposal.payload_hash);
        } catch (error) {
          refused = error;
        }
        expect(refused).toMatchObject({ code: 'untrusted_recipient_origin' });
        expect(String((refused as Error).message)).toContain('external_content');

        const [approval] = await db.sql`select decision, origin_warnings from approval
          where action_id = ${proposal.action_id}`;
        expect(approval?.decision).toBeNull();
        expect(approval?.origin_warnings).toHaveLength(1);
        const [ledger] =
          await db.sql`select id from budget_ledger where action_id = ${proposal.action_id}`;
        expect(ledger).toBeUndefined();
      } finally {
        await boss.stop({ graceful: true, timeout: 5_000 });
      }
    });
  });
}
