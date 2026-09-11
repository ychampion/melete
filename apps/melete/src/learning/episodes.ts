import { createHash } from 'node:crypto';
import type { AttemptBundle, AttemptOutcome } from '@melete/contracts';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { action, artifact, attempt, job, owner, space } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { JobRow, JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import {
  type Intervention,
  interventionRequest,
  type JobLearningScope,
  jobLearningScope,
  type ProcedureScope,
  type VersionEvidence,
} from './contracts.ts';
import { episode, learningAttempt, learningJob } from './schema.ts';

export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unknownScope: ProcedureScope = {
  task_family: 'unclassified',
  app: 'unknown',
  app_version: 'unknown',
  role: 'owner',
  audience: 'private',
};
export type EpisodeRow = typeof episode.$inferSelect;

/** Capture hashes of the exact delivered bodies/catalog, without retaining model deliberation. */
export async function captureAttemptVersions(
  tx: Transaction,
  bundle: AttemptBundle,
  runtime: string,
) {
  await tx
    .insert(learningAttempt)
    .values({
      attemptId: bundle.attempt.id,
      versions: {
        attempt_id: bundle.attempt.id,
        runtime,
        provider: bundle.model.provider,
        model_requested: bundle.model.model,
        model_actual: null,
        tools: bundle.tools.map((tool) => ({ name: tool.name, version: `sha256:${digest(tool)}` })),
        skills: bundle.skills.map((skill) => ({
          name: skill.name,
          version: `sha256:${digest(skill.body)}`,
        })),
      },
    })
    .onConflictDoNothing();
}

async function evidence(tx: Transaction, row: JobRow) {
  const executions = await tx
    .select()
    .from(attempt)
    .where(eq(attempt.jobId, row.id))
    .orderBy(asc(attempt.epoch));
  const versions: VersionEvidence[] = [];
  for (const execution of executions) {
    const [captured] = await tx
      .select()
      .from(learningAttempt)
      .where(eq(learningAttempt.attemptId, execution.id));
    versions.push({
      ...(captured?.versions ?? {
        attempt_id: execution.id,
        runtime: execution.runtimeVersion,
        provider: execution.provider,
        model_requested: execution.model,
        tools: [],
        skills: [],
      }),
      model_actual: execution.modelActual,
    });
  }
  const artifacts = await tx
    .select({ id: artifact.id, hash: artifact.contentHash, path: artifact.path })
    .from(artifact)
    .where(and(eq(artifact.jobId, row.id), eq(artifact.spaceId, row.spaceId)));
  const receipts = await tx
    .select({ action_id: action.id, status: action.status, receipt: action.receipt })
    .from(action)
    .where(eq(action.jobId, row.id));
  return { versions, artifacts, receipts };
}

async function createEpisode(
  tx: Transaction,
  row: JobRow,
  segmentKey: string,
  actor: string,
  change: Intervention | null,
  judgement: string,
) {
  const [registration] = await tx.select().from(learningJob).where(eq(learningJob.jobId, row.id));
  const [saved] = await tx
    .insert(episode)
    .values({
      id: newId('ep'),
      jobId: row.id,
      spaceId: row.spaceId,
      segmentKey,
      inputDigest: digest(change ?? { job_id: row.id, segment: segmentKey }),
      scope: registration?.scope ?? unknownScope,
      templateId: registration?.templateId ?? 'unclassified',
      inputRefs: registration?.inputRefs ?? [],
      intervention: change,
      actor,
      judgement,
      failureClass: change?.kind === 'correction' ? 'owner_correction' : null,
      ...(await evidence(tx, row)),
    })
    .onConflictDoNothing({ target: [episode.jobId, episode.segmentKey] })
    .returning();
  return saved;
}

/** The finish and episode update commit together; retries cannot duplicate a corrected segment. */
export async function captureCompletedEpisode(
  tx: Transaction,
  row: JobRow,
  outcome: AttemptOutcome,
  attemptId: string,
) {
  if (!['completed', 'failed'].includes(row.state)) return;
  const pending = await tx
    .select()
    .from(episode)
    .where(
      and(
        eq(episode.jobId, row.id),
        eq(episode.judgement, 'pending'),
        eq(episode.restricted, false),
      ),
    );
  if (pending.length) {
    for (const segment of pending) {
      await tx
        .update(episode)
        .set({
          ...(await evidence(tx, row)),
          judgement: row.state === 'completed' ? 'corrected' : 'failed',
          failureClass: row.state === 'failed' ? outcome.kind : segment.failureClass,
        })
        .where(eq(episode.id, segment.id));
    }
    return;
  }
  // A corrected job already has a segment record. A completion is its judgement, not a second lesson.
  const [existing] = await tx.select().from(episode).where(eq(episode.jobId, row.id)).limit(1);
  if (!existing)
    await createEpisode(tx, row, `completion:${attemptId}`, 'runtime', null, row.state);
}

/** Owner authentication is supplied by the API. A requested space is checked, never trusted. */
export async function requireLearningSpace(tx: Transaction, ownerId: string, spaceId: string) {
  const [person] = await tx.select({ id: owner.id }).from(owner).where(eq(owner.id, ownerId));
  const [parent] = await tx.select().from(space).where(eq(space.id, spaceId));
  if (!person || !parent) throw new ServiceError('scope_denied', 'Space is unavailable.', 403);
  const state = await tx.execute(
    sql`select owner_id, revoked, restore_ready from memory_spaces where space_id = ${spaceId}`,
  );
  const memory = state[0];
  if (memory && (memory.owner_id !== ownerId || memory.revoked || !memory.restore_ready))
    throw new ServiceError('scope_denied', 'Space is unavailable.', 403);
}

export class EpisodeService {
  constructor(
    readonly jobs: JobService,
    readonly interrupt?: (jobId: string) => void,
  ) {}

  async setScope(ownerId: string, jobId: string, raw: unknown) {
    const input = jobLearningScope.parse(raw);
    return this.jobs.transaction(async (tx) => {
      const row = await this.jobs.lock(tx, jobId);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      await requireLearningSpace(tx, ownerId, row.spaceId);
      const [old] = await tx.select().from(learningJob).where(eq(learningJob.jobId, jobId));
      if (old) {
        if (
          digest({ scope: old.scope, template_id: old.templateId, input_refs: old.inputRefs }) !==
          digest(input)
        )
          throw new ServiceError('scope_frozen', 'The recorded task scope is immutable.');
        return old;
      }
      if (row.state !== 'queued')
        throw new ServiceError('scope_frozen', 'Set task scope before the first attempt.');
      await validateReferences(tx, row.spaceId, input);
      const [saved] = await tx
        .insert(learningJob)
        .values({
          jobId,
          spaceId: row.spaceId,
          scope: input.scope,
          templateId: input.template_id,
          inputRefs: input.input_refs,
        })
        .returning();
      return saved;
    });
  }

  async intervene(ownerId: string, jobId: string, raw: unknown) {
    const { idempotency_key: key, ...change } = interventionRequest.parse(raw);
    const result = await this.jobs.transaction(async (tx) => {
      let row = await this.jobs.lock(tx, jobId);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      await requireLearningSpace(tx, ownerId, row.spaceId);
      const [old] = await tx
        .select()
        .from(episode)
        .where(and(eq(episode.jobId, jobId), eq(episode.segmentKey, `intervention:${key}`)));
      if (old) {
        if (old.inputDigest !== digest(change))
          throw new ServiceError(
            'idempotency_conflict',
            'This intervention key identifies different input.',
          );
        return old;
      }
      const saved = await createEpisode(
        tx,
        row,
        `intervention:${key}`,
        ownerId,
        change,
        ['completed', 'failed', 'cancelled'].includes(row.state) ? 'owner_judged' : 'pending',
      );
      if (!saved) throw new Error('Episode insert returned no row');
      // Every new correction invalidates old payload bindings, including while an approval is parked.
      await tx
        .update(job)
        .set({ revision: row.revision + 1 })
        .where(eq(job.id, jobId));
      row = { ...row, revision: row.revision + 1 };
      // A takeover fences the prior attempt before the corrected job is queued.
      if (row.state === 'running') {
        row = await this.jobs.move(
          tx,
          row,
          { kind: 'attempt_waiting_for_input' },
          {
            bumpEpoch: true,
            wait: { kind: 'user_input', question: 'Owner intervention recorded.' },
          },
        );
        await tx
          .update(attempt)
          .set({
            outcome: 'fenced',
            endedAt: new Date(),
            leaseExpiresAt: null,
            leaseStatus: 'ended',
          })
          .where(and(eq(attempt.jobId, jobId), isNull(attempt.endedAt)));
      }
      if (row.state === 'waiting_for_input') {
        await this.jobs.inputInTransaction(tx, jobId, change.text);
      } else {
        await appendEvent(tx, {
          jobId,
          type: 'notice',
          payload: { kind: 'user_message', text: change.text },
          dedupKey: `${saved.id}:input`,
        });
      }
      return saved;
    });
    this.interrupt?.(jobId);
    return result;
  }

  async list(ownerId: string, spaceId: string) {
    return this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, ownerId, spaceId);
      return tx
        .select()
        .from(episode)
        .where(
          and(
            eq(episode.spaceId, spaceId),
            eq(episode.restricted, false),
            gt(episode.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(episode.createdAt))
        .limit(100);
    });
  }

  async remove(ownerId: string, spaceId: string, id: string) {
    return this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, ownerId, spaceId);
      const [saved] = await tx
        .update(episode)
        .set({
          restricted: true,
          intervention: null,
          versions: [],
          artifacts: [],
          receipts: [],
          inputRefs: [],
          generationState: 'restricted',
        })
        .where(and(eq(episode.id, id), eq(episode.spaceId, spaceId)))
        .returning();
      if (!saved) throw new ServiceError('not_found', 'Episode not found.', 404);
      await tx.execute(sql`delete from procedure_candidate where episode_id = ${id}`);
      return { deleted: true };
    });
  }
}

async function validateReferences(tx: Transaction, spaceId: string, input: JobLearningScope) {
  for (const handle of input.input_refs) {
    const [id, version] = handle.split('@');
    const rows = id?.startsWith('src_')
      ? await tx.execute(
          sql`select id from memory_sources where id = ${id} and source_version = ${version} and space_id = ${spaceId} and state = 'active'`,
        )
      : await tx.execute(
          sql`select c.id from memory_claims c join memory_revisions r on r.claim_id = c.id where c.id = ${id} and r.revision = ${Number(version)} and c.space_id = ${spaceId} and not c.hidden`,
        );
    if (!rows.length)
      throw new ServiceError('scope_denied', 'An input reference is unavailable.', 403);
  }
}
