import {
  type ApprovalDecisionRequest,
  approvalDecisionRequest,
  canonicalizePayload,
  jsonObject,
  waitSpec,
} from '@melete/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { action, approval } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { visibleJob } from '../principals/authority.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobRow, JobService } from './service.ts';

/** Persisted owner decisions are inputs to a new attempt, never a suspended runtime call. */
export class ApprovalService {
  constructor(
    readonly jobs: JobService,
    runner: AttemptRunner,
  ) {
    runner.onApprovalWait = (tx, row) => this.registerWait(tx, row);
  }

  async registerWait(tx: Transaction, row: JobRow): Promise<JobRow> {
    const wait = waitSpec.parse(row.wait);
    if (row.state !== 'waiting_for_approval' || wait.kind !== 'approval') return row;
    const ids = [...new Set(wait.action_ids)];
    if (ids.length === 0)
      throw new ServiceError('invalid_wait', 'Approval waits must name an action.');
    const rows = await tx
      .select({ action, approval })
      .from(action)
      .innerJoin(approval, eq(approval.actionId, action.id))
      .where(and(eq(action.jobId, row.id), inArray(action.id, ids)));
    if (rows.length !== ids.length)
      throw new ServiceError('invalid_wait', 'Every approval must name an action in this job.');
    if (
      rows.some(
        ({ action: effect, approval: decision }) =>
          decision.jobRevision !== row.revision || decision.payloadHash !== effect.payloadHash,
      )
    )
      throw new ServiceError('revision_mismatch', 'An approval no longer matches this job.');
    if (rows.some(({ approval: decision }) => decision.decision === null)) return row;
    return this.jobs.move(
      tx,
      row,
      {
        kind: 'approval_decided',
        decision: rows.some(({ approval: decision }) => decision.decision === 'denied')
          ? 'denied'
          : 'approved',
      },
      { reason: 'approval' },
    );
  }

  async decide(id: string, input: ApprovalDecisionRequest, ownerId: string) {
    const request = approvalDecisionRequest.parse(input);
    return this.jobs.transaction(async (tx) => {
      const [lookup] = await tx
        .select({ jobId: action.jobId })
        .from(approval)
        .innerJoin(action, eq(approval.actionId, action.id))
        .where(eq(approval.id, id));
      if (!lookup) throw new ServiceError('not_found', 'Approval not found.', 404);
      const row = await this.jobs.lock(tx, lookup.jobId);
      const [current] = await tx
        .select({ action, approval })
        .from(approval)
        .innerJoin(action, eq(approval.actionId, action.id))
        .where(eq(approval.id, id));
      if (!row || !current) throw new ServiceError('not_found', 'Approval not found.', 404);
      const decision = current.approval;
      const effect = current.action;
      if (
        request.payload_hash !== decision.payloadHash ||
        effect.payloadHash !== decision.payloadHash ||
        canonicalizePayload(jsonObject.parse(effect.canonicalPayload)).hash !== effect.payloadHash
      )
        throw new ServiceError('approval_hash_mismatch', 'The action content changed.');
      if (row.revision !== decision.jobRevision)
        throw new ServiceError(
          'revision_mismatch',
          'The job changed after this approval was requested.',
        );
      if (row.state === 'cancelled' || row.state === 'failed' || row.state === 'completed')
        throw new ServiceError('already_terminal', 'This job is already finished.');
      if (decision.decision !== null) {
        if (decision.decision !== request.decision)
          throw new ServiceError(
            'already_decided',
            'This approval already has a different decision.',
          );
        return decision;
      }
      if (decision.expiresAt && decision.expiresAt.getTime() <= Date.now())
        throw new ServiceError('approval_expired', 'This approval has expired.');
      if (effect.status !== 'needs_approval')
        throw new ServiceError('action_not_admissible', 'This action is not awaiting approval.');
      const [updated] = await tx
        .update(approval)
        .set({ decision: request.decision, decidedAt: new Date(), decidedBy: ownerId })
        .where(eq(approval.id, id))
        .returning();
      if (!updated) throw new Error('locked approval disappeared');
      await tx
        .update(action)
        .set({ status: request.decision === 'approved' ? 'approved' : 'denied' })
        .where(eq(action.id, effect.id));
      await appendEvent(tx, {
        jobId: row.id,
        attemptId: effect.attemptId,
        type: 'approval_decided',
        payload: {
          approval_id: id,
          action_id: effect.id,
          decision: request.decision,
          note: request.note ?? null,
          payload_hash: effect.payloadHash,
        },
        dedupKey: `${id}:decision`,
      });
      await this.registerWait(tx, row);
      return updated;
    });
  }

  list() {
    return this.jobs.db
      .select({ action, approval })
      .from(approval)
      .innerJoin(action, eq(approval.actionId, action.id))
      .where(and(isNull(approval.decision), visibleJob(action.jobId)));
  }
}
