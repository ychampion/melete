import {
  approvalDecisionRequest,
  approvalDecisionResponse,
  approvalListResponse,
} from '@melete/contracts';
import type { Hono } from 'hono';
import type { ApprovalService } from '../jobs/approvals.ts';

export function mountApprovals(app: Hono, approvals: ApprovalService): void {
  app.get('/approvals', async (c) => {
    const rows = await approvals.list();
    return c.json(
      approvalListResponse.parse({
        approvals: rows.map(({ action, approval }) => ({
          approval_id: approval.id,
          action_id: action.id,
          job_id: action.jobId,
          job_revision: approval.jobRevision,
          kind: action.kind,
          effect_class: action.effectClass,
          connection_id: action.connectionId,
          canonical_payload: action.canonicalPayload,
          payload_hash: approval.payloadHash,
          requested_at: approval.requestedAt.toISOString(),
          expires_at: approval.expiresAt?.toISOString() ?? null,
        })),
      }),
    );
  });
  app.post('/approvals/:id', async (c) => {
    const request = approvalDecisionRequest.parse(await c.req.json());
    const value = await approvals.decide(c.req.param('id'), request, c.get('owner').id);
    return c.json(
      approvalDecisionResponse.parse({
        approval_id: value.id,
        action_id: value.actionId,
        decision: value.decision,
        payload_hash: value.payloadHash,
        decided_at: value.decidedAt?.toISOString(),
      }),
    );
  });
}
