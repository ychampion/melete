import { expect, mock, test } from 'bun:test';
import type { Action } from '@melete/contracts';
import type { Sql } from 'postgres';
import { BrokerService } from './service.ts';

test('a pending action still requires approval when no matching approval row exists', async () => {
  const intentKey = 'b'.repeat(64);
  const action: Action = {
    id: 'act_01J8ZP3QWABCDEFGHJKMNPQRST',
    job_id: 'job_01J8ZP3QWABCDEFGHJKMNPQRST',
    attempt_id: 'att_01J8ZP3QWABCDEFGHJKMNPQRST',
    connection_id: 'conn_01J8ZP3QWABCDEFGHJKMNPQRST',
    kind: 'test.send',
    effect_class: 'write_external',
    canonical_payload: { body: 'Awaiting approval' },
    payload_hash: 'a'.repeat(64),
    intent_key: intentKey,
    status: 'needs_approval',
    authorization_ref: null,
    budget_reservation: null,
    idempotency_key: 'act_01J8ZP3QWABCDEFGHJKMNPQRST',
    dispatched_at: null,
    receipt: null,
    resolved_at: null,
    reconciliation: null,
    repair_trace: [],
    repair_counters: {},
    repair_disposition: null,
    retry_after_at: null,
    created_at: '2026-09-12T00:00:00.000Z',
  };
  const query = mock(async () => []);
  const broker = new BrokerService({
    sql: query as unknown as Sql,
    connectors: { get: () => undefined },
  });

  // biome-ignore lint/complexity/useLiteralKeys: Bracket access tests the private projection without making it public.
  const proposal = await broker['proposalView'](action, intentKey, true);

  expect(query).toHaveBeenCalledWith(expect.anything(), action.id, action.payload_hash);
  expect(proposal).toMatchObject({
    action_id: action.id,
    status: 'needs_approval',
    requires_approval: true,
    approval_id: null,
    origin_warnings: [],
    repeated: true,
  });
});
