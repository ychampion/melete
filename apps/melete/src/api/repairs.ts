/**
 * What was repaired, and what stopped safely.
 *
 * A failure that was fixed and a failure that stopped are different facts and
 * this is where they stay different. Every action that met a typed fault
 * carries the classes it met, the decisions the policy took, and where it came
 * to rest; a drift mapping appears here as the proposal it is, with the test it
 * had to pass. `completed` is the only disposition that means the effect
 * happened, and everything else is a safe stop rather than a failure.
 */
import {
  type ActionRepairView,
  actionRepairView,
  isSafeStop,
  jobRepairsResponse,
  repairCandidateView,
  repairCounters,
  repairDisposition,
  repairTrace,
} from '@melete/contracts';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Database } from '../db/client.ts';
import { action, job, repairCandidate } from '../db/schema.ts';
import { ServiceError } from './errors.ts';

type CandidateRow = typeof repairCandidate.$inferSelect;

const candidateView = (row: CandidateRow) =>
  repairCandidateView.parse({
    id: row.id,
    action_id: row.actionId,
    job_id: row.jobId,
    connection_id: row.connectionId,
    kind: row.kind,
    fault_kind: row.faultKind,
    state: row.state,
    observed_schema: row.observedSchema ?? null,
    proposed_mapping: row.proposedMapping,
    test: row.test,
    evaluation: row.evaluation ?? null,
    safe: row.safe,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });

export class RepairReadService {
  constructor(private readonly db: Database) {}

  /** Every action of one responsibility that met a fault, oldest first. */
  async forJob(jobId: string): Promise<ActionRepairView[]> {
    const [owner] = await this.db
      .select({ id: job.id })
      .from(job)
      .where(eq(job.id, jobId))
      .limit(1);
    if (!owner) throw new ServiceError('not_found', 'No such responsibility.', 404);
    const rows = await this.db
      .select()
      .from(action)
      .where(
        and(
          eq(action.jobId, jobId),
          or(
            sql`jsonb_array_length(${action.repairTrace}) > 0`,
            sql`${action.repairDisposition} is not null`,
          ),
        ),
      )
      .orderBy(asc(action.createdAt), asc(action.id));
    if (rows.length === 0) return [];
    const candidates = await this.db
      .select()
      .from(repairCandidate)
      .where(
        inArray(
          repairCandidate.actionId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(repairCandidate.createdAt), asc(repairCandidate.id));
    return rows.map((row) => {
      const disposition = row.repairDisposition
        ? repairDisposition.parse(row.repairDisposition)
        : null;
      return actionRepairView.parse({
        action_id: row.id,
        job_id: row.jobId,
        kind: row.kind,
        effect_class: row.effectClass,
        status: row.status,
        payload_hash: row.payloadHash,
        intent_key: row.intentKey,
        disposition,
        // A stop is its own state. Nothing here lets a client read it as failure.
        safe_stop: disposition !== null && isSafeStop(disposition),
        retry_after_at: row.retryAfterAt?.toISOString() ?? null,
        counters: repairCounters.parse(row.repairCounters ?? {}),
        trace: repairTrace.parse(row.repairTrace ?? []),
        candidates: candidates
          .filter((candidate) => candidate.actionId === row.id)
          .map(candidateView),
      });
    });
  }
}

export function mountRepairs(app: Hono, repairs: RepairReadService): void {
  app.get('/jobs/:id/repairs', async (c) => {
    const jobId = c.req.param('id');
    return c.json(
      jobRepairsResponse.parse({ job_id: jobId, repairs: await repairs.forJob(jobId) }),
    );
  });
}
