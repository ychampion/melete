import { type Action, canonicalizePayload, jobConstraints } from '@melete/contracts';
import type { ConnectorContext } from './types.ts';

export function mailAction(
  kind: string,
  payload: Record<string, unknown> = {},
  id = 'act_test',
): Action {
  const canonical = canonicalizePayload(payload);
  return {
    id,
    job_id: 'job_test',
    attempt_id: 'att_test',
    connection_id: 'con_test',
    kind,
    effect_class:
      kind.endsWith('.send') || kind.endsWith('.create') || kind.endsWith('.update')
        ? 'write_external'
        : 'read',
    canonical_payload: canonical.canonical,
    payload_hash: canonical.hash,
    intent_key: null,
    status: 'dispatched',
    authorization_ref: null,
    budget_reservation: null,
    idempotency_key: id,
    dispatched_at: '2026-09-11T08:00:00.000Z',
    receipt: null,
    resolved_at: null,
    reconciliation: null,
    repair_trace: [],
    repair_counters: {},
    repair_disposition: null,
    retry_after_at: null,
    created_at: '2026-09-11T08:00:00.000Z',
  };
}

export const mailContext = (id = 'act_test'): ConnectorContext => ({
  job_id: 'job_test',
  space_id: 'spc_test',
  idempotency_key: id,
  constraints: jobConstraints.parse({}),
});
