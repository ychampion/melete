import { type Action, canonicalizePayload, jobConstraints } from '@melete/contracts';
import type { ConnectorContext } from './types.ts';

export function connectorAction(
  kind: string,
  payload: Record<string, unknown>,
  id = 'act_01J00000000000000000000000',
): Action {
  const canonical = canonicalizePayload(payload);
  return {
    id,
    job_id: 'job_01',
    attempt_id: 'att_01',
    connection_id: 'conn_01J00000000000000000000000',
    kind,
    effect_class: kind === 'test.send' ? 'write_external' : 'read',
    canonical_payload: canonical.canonical,
    payload_hash: canonical.hash,
    intent_key: null,
    status: 'dispatched',
    authorization_ref: null,
    budget_reservation: null,
    idempotency_key: id,
    dispatched_at: new Date().toISOString(),
    receipt: null,
    resolved_at: null,
    reconciliation: null,
    created_at: new Date().toISOString(),
  };
}

export function connectorContext(action: Action): ConnectorContext {
  return {
    job_id: action.job_id,
    space_id: 'sp_01',
    idempotency_key: action.id,
    constraints: jobConstraints.parse({}),
  };
}
