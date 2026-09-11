import { afterAll, expect, test } from 'bun:test';
import {
  type Action,
  action as actionSchema,
  canonicalizePayload,
  jobConstraints,
} from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import {
  createTestConnector,
  initializeTestLedger,
  TestAcknowledgementDropped,
} from '../../src/connectors/test.ts';
import type { ConnectorContext } from '../../src/connectors/types.ts';
import { openDatabase } from '../../src/db/client.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
if (fixture) await initializeTestLedger(fixture.sql);
afterAll(async () => await fixture?.close());

function delivery(payload: Record<string, unknown>): { action: Action; ctx: ConnectorContext } {
  const canonical = canonicalizePayload(payload);
  const id = recordId('act');
  const action = actionSchema.parse({
    id,
    job_id: recordId('job'),
    attempt_id: recordId('att'),
    connection_id: recordId('conn'),
    kind: 'test.send',
    effect_class: 'write_external',
    canonical_payload: canonical.canonical,
    payload_hash: canonical.hash,
    status: 'dispatched',
    authorization_ref: null,
    budget_reservation: null,
    idempotency_key: id,
    dispatched_at: new Date().toISOString(),
    receipt: null,
    resolved_at: null,
    reconciliation: null,
    created_at: new Date().toISOString(),
  });
  return {
    action,
    ctx: {
      job_id: action.job_id,
      space_id: recordId('sp'),
      idempotency_key: action.id,
      constraints: jobConstraints.parse({}),
    },
  };
}

databaseTest('destination accepts nested JSON with the SQL client shared by Drizzle', async () => {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { action, ctx } = delivery({ message: 'quoted "text"', nested: { list: [1, true, null] } });
  const connector = createTestConnector(fixture.sql);
  const result = await connector.execute(action, ctx);
  expect(result.outcome).toBe('succeeded');
  const [stored] =
    await fixture.sql`SELECT payload, payload_hash FROM test_destination_ledger WHERE action_id = ${action.id}`;
  expect(stored?.payload).toEqual(action.canonical_payload);
  expect(stored?.payload_hash).toBe(action.payload_hash);
});

databaseTest('parallel destination retries retain exactly one durable acceptance', async () => {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { action, ctx } = delivery({ message: 'one effect' });
  const connector = createTestConnector(fixture.sql);
  const results = await Promise.all([
    connector.execute(action, ctx),
    connector.execute(action, ctx),
  ]);
  expect(results.map((result) => result.outcome)).toEqual(['succeeded', 'succeeded']);
  const rows =
    await fixture.sql`SELECT action_id FROM test_destination_ledger WHERE action_id = ${action.id}`;
  expect(rows).toHaveLength(1);
});

databaseTest(
  'lost acknowledgement survives a new database handle and verifies without another send',
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const { action, ctx } = delivery({ message: 'accepted before timeout', drop_ack: true });
    await expect(createTestConnector(fixture.sql).execute(action, ctx)).rejects.toBeInstanceOf(
      TestAcknowledgementDropped,
    );
    const restarted = openDatabase(fixture.url, 2);
    try {
      const result = await createTestConnector(restarted.sql).verify(action, ctx);
      expect(result.decision).toBe('succeeded');
      const rows =
        await restarted.sql`SELECT action_id FROM test_destination_ledger WHERE action_id = ${action.id}`;
      expect(rows).toHaveLength(1);
      expect(
        (await createTestConnector(restarted.sql, { verify: false }).verify(action, ctx)).decision,
      ).toBe('unsupported');
    } finally {
      await restarted.close();
    }
  },
);
