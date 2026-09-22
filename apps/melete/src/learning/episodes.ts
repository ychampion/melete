import { createHash } from 'node:crypto';
import {
  type AttemptBundle,
  type AttemptOutcome,
  jobBudget,
  jobConstraints,
  memoryHandle,
} from '@melete/contracts';
import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { action, artifact, attempt, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { JobRow, JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { requireJobAccess, spaceAuthority, visibleJob } from '../principals/authority.ts';
import { revertDeliveredCanaries } from './canary.ts';
import {
  type Intervention,
  interventionRequest,
  type JobLearningScope,
  jobLearningScope,
  type ProcedureScope,
  type VersionEvidence,
} from './contracts.ts';
import { askToKeep, traceProcedureUse } from './notices.ts';
import { OBJECTIVE_ORIGINS, type ObjectiveOrigin } from './provenance.ts';
import { episode, learningAttempt, learningJob } from './schema.ts';
import { derivedScope } from './scope.ts';

export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unknownScope: ProcedureScope = {
  task_family: 'unclassified',
  app: 'unknown',
  app_version: 'unknown',
  role: 'owner',
  audience: 'private',
};
/** The recorded origin of a job's objective, or the closed answer when there is none. */
const objectiveOrigin = (row: { objectiveOrigin: string | null }): ObjectiveOrigin =>
  (OBJECTIVE_ORIGINS as readonly string[]).includes(row.objectiveOrigin ?? '')
    ? (row.objectiveOrigin as ObjectiveOrigin)
    : 'derived';

export type EpisodeRow = typeof episode.$inferSelect;

/**
 * The expiry of a correction behind a procedure the person kept by saying yes:
 * retention never reaches it, while forgetting still removes it like any other.
 */
export const KEPT_UNTIL = new Date('9999-12-31T00:00:00.000Z');

/** Admission calls this before enqueueing the first wake; optional metadata never grants authority. */
export async function registerJobLearning(tx: Transaction, row: JobRow, input: JobLearningScope) {
  await validateReferences(tx, row.spaceId, input);
  const [saved] = await tx
    .insert(learningJob)
    .values({
      jobId: row.id,
      spaceId: row.spaceId,
      scope: input.scope,
      templateId: input.template_id,
      inputRefs: input.input_refs,
    })
    .returning();
  if (!saved) throw new Error('Learning scope insert returned no row');
  return saved;
}

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
  // What the attempt was given from what the person taught is shown in its trail.
  await traceProcedureUse(tx, bundle.attempt.job_id, bundle.attempt.id, bundle.skills);
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
  // Kind and effect class are what an action-kind check reads; a receipt alone cannot say them.
  const receipts = await tx
    .select({
      action_id: action.id,
      kind: action.kind,
      effect_class: action.effectClass,
      status: action.status,
      receipt: action.receipt,
    })
    .from(action)
    .where(eq(action.jobId, row.id));
  return { versions, artifacts, receipts, inputRefs: await inputReferences(tx, row) };
}

export const MAX_RECORDED_OUTPUT = 32768;
/** The words a person actually saw, or nothing: a partial answer would grade as a whole one. */
const recordedOutput = (value: unknown) => {
  if (!value || typeof value !== 'object') return null;
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary.length
    ? summary.slice(0, MAX_RECORDED_OUTPUT)
    : null;
};

async function createEpisode(
  tx: Transaction,
  row: JobRow,
  segmentKey: string,
  actor: string,
  change: Intervention | null,
  judgement: string,
) {
  const [registration] = await tx.select().from(learningJob).where(eq(learningJob.jobId, row.id));
  // What the run had already produced when the owner objected to it.
  const [last] = change
    ? await tx
        .select({ detail: attempt.outcomeDetail })
        .from(attempt)
        .where(and(eq(attempt.jobId, row.id), isNotNull(attempt.endedAt)))
        .orderBy(desc(attempt.epoch))
        .limit(1)
    : [];
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
      intervention: change,
      actor,
      judgement,
      failureClass: change?.kind === 'correction' ? 'owner_correction' : null,
      priorOutput: recordedOutput(last?.detail),
      ...(await evidence(tx, row)),
    })
    .onConflictDoNothing({ target: [episode.jobId, episode.segmentKey] })
    .returning();
  return saved;
}

/**
 * A conversation never reaches `completed`: a finished turn rests on the person
 * for the next message. For learning, that finished turn is the job's completion.
 */
export const finishedAs = (row: JobRow, outcome: AttemptOutcome) =>
  row.kind === 'chat' && row.state === 'waiting_for_input' && outcome.kind === 'completed'
    ? 'completed'
    : row.state;

/** The finish and episode update commit together; retries cannot duplicate a corrected segment. */
export async function captureCompletedEpisode(
  tx: Transaction,
  row: JobRow,
  outcome: AttemptOutcome,
  attemptId: string,
) {
  const finished = finishedAs(row, outcome);
  if (!['completed', 'failed'].includes(finished)) return;
  try {
    await liveJobEvidence(tx, row);
  } catch (error) {
    if (
      error instanceof ServiceError &&
      ['scope_denied', 'evidence_unavailable'].includes(error.code)
    )
      return;
    throw error;
  }
  const pending = await tx
    .select()
    .from(episode)
    .where(
      and(
        or(eq(episode.jobId, row.id), eq(episode.correctiveJobId, row.id)),
        eq(episode.judgement, 'pending'),
        eq(episode.restricted, false),
      ),
    );
  if (pending.length) {
    for (const segment of pending) {
      const current = await evidence(tx, row);
      const combined =
        segment.correctiveJobId === row.id
          ? {
              versions: [...segment.versions, ...current.versions],
              artifacts: [...segment.artifacts, ...current.artifacts],
              receipts: [...segment.receipts, ...current.receipts],
              inputRefs: [...new Set([...segment.inputRefs, ...current.inputRefs])],
            }
          : current;
      await tx
        .update(episode)
        .set({
          ...combined,
          judgement: finished === 'completed' ? 'corrected' : 'failed',
          failureClass: finished === 'failed' ? outcome.kind : segment.failureClass,
          // The answer the correction asked for, whether it came from the linked
          // corrective job or from the next completion of this same job.
          correctedOutput: recordedOutput(outcome) ?? segment.correctedOutput,
        })
        .where(eq(episode.id, segment.id));
    }
    return;
  }
  // A corrected job already has a segment record. A completion is its judgement, not a second lesson.
  const [existing] = await tx
    .select()
    .from(episode)
    .where(or(eq(episode.jobId, row.id), eq(episode.correctiveJobId, row.id)))
    .limit(1);
  if (!existing) await createEpisode(tx, row, `completion:${attemptId}`, 'runtime', null, finished);
  // A job that used something on trial and needed no correction earns the question.
  if (finished === 'completed') await askToKeep(tx, row, attemptId);
}

/** Owner authentication is supplied by the API. A requested space is checked, never trusted. */
export async function requireLearningSpace(tx: Transaction, ownerId: string, spaceId: string) {
  const access = await spaceAuthority(tx, spaceId, ownerId, true);
  if (access.role !== 'owner') throw new ServiceError('scope_denied', 'Space is unavailable.', 403);
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
      await requireJobAccess(tx, row.id, ownerId);
      const [old] = await tx.select().from(learningJob).where(eq(learningJob.jobId, jobId));
      const recorded =
        old &&
        digest(
          jobLearningScope.parse({
            scope: old.scope,
            template_id: old.templateId,
            input_refs: old.inputRefs,
          }),
        );
      // The scope the service derives for every job is a default, not the owner's
      // declaration, so a declaration still replaces it while the job is untouched.
      if (old && recorded !== digest(derivedScope(row.objective))) {
        if (recorded !== digest(input))
          throw new ServiceError('scope_frozen', 'The recorded task scope is immutable.');
        return old;
      }
      if (row.state !== 'queued')
        throw new ServiceError('scope_frozen', 'Set task scope before the first attempt.');
      const [previous] = await tx
        .select({ id: attempt.id })
        .from(attempt)
        .where(eq(attempt.jobId, jobId))
        .limit(1);
      if (previous)
        throw new ServiceError('scope_frozen', 'Set task scope before the first attempt.');
      if (old) await tx.delete(learningJob).where(eq(learningJob.jobId, jobId));
      return registerJobLearning(tx, row, input);
    });
  }

  async intervene(ownerId: string, jobId: string, raw: unknown) {
    const result = await this.jobs.transaction((tx) =>
      this.interveneInTransaction(tx, ownerId, jobId, raw),
    );
    this.interrupt?.(jobId);
    return result;
  }

  /**
   * The same correction, inside a transaction the caller already holds, for a
   * correction that arrives with something else: a message the person has just
   * sent is already on the job's stream, so `recordMessage` leaves it there
   * instead of writing the same words twice.
   */
  async interveneInTransaction(
    tx: Transaction,
    ownerId: string,
    jobId: string,
    raw: unknown,
    options: { recordMessage?: boolean } = {},
  ) {
    const { idempotency_key: key, ...change } = interventionRequest.parse(raw);
    const recordMessage = options.recordMessage ?? true;
    const result = await (async () => {
      let row = await this.jobs.lock(tx, jobId);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      await requireLearningSpace(tx, ownerId, row.spaceId);
      await requireJobAccess(tx, row.id, ownerId);
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
      const registration = await liveJobEvidence(tx, row);
      const saved = await createEpisode(tx, row, `intervention:${key}`, ownerId, change, 'pending');
      if (!saved) throw new Error('Episode insert returned no row');
      // A correction on a job that received a canary procedure ends that canary here.
      await revertDeliveredCanaries(tx, row, saved.id);
      if (['completed', 'failed', 'cancelled'].includes(row.state)) {
        // Terminal jobs are immutable. A linked correction cannot replay their effects.
        const corrective = await this.jobs.createInTransaction(
          tx,
          {
            space_id: row.spaceId,
            title: `Correction: ${row.title}`.slice(0, 200),
            objective: row.objective,
            constraints: jobConstraints.parse(row.constraints),
            budget: { ...jobBudget.parse(row.budget), max_actions: 0 },
            ...(registration
              ? {
                  learning: {
                    scope: registration.scope,
                    template_id: registration.templateId,
                    input_refs: registration.inputRefs,
                  },
                }
              : {}),
          },
          undefined,
          // The corrective job copies this objective; it copies where it came from too.
          objectiveOrigin(row),
        );
        await appendEvent(tx, {
          jobId: corrective.id,
          type: 'notice',
          payload: { kind: 'user_message', text: change.text, principal_id: ownerId },
          dedupKey: `${saved.id}:input`,
        });
        await appendEvent(tx, {
          jobId: row.id,
          type: 'notice',
          payload: { kind: 'corrective_job', job_id: corrective.id, episode_id: saved.id },
          dedupKey: `${saved.id}:corrective-job`,
        });
        const [linked] = await tx
          .update(episode)
          .set({ correctiveJobId: corrective.id })
          .where(eq(episode.id, saved.id))
          .returning();
        if (!linked) throw new Error('Corrective episode link failed');
        return linked;
      }
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
      if (!recordMessage) return saved;
      if (row.state === 'waiting_for_input') {
        await this.jobs.inputInTransaction(tx, jobId, change.text);
      } else {
        await appendEvent(tx, {
          jobId,
          type: 'notice',
          payload: { kind: 'user_message', text: change.text, principal_id: ownerId },
          dedupKey: `${saved.id}:input`,
        });
      }
      return saved;
    })();
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
            visibleJob(episode.jobId, ownerId),
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
          priorOutput: null,
          correctedOutput: null,
          generationState: 'restricted',
        })
        .where(
          and(eq(episode.id, id), eq(episode.spaceId, spaceId), visibleJob(episode.jobId, ownerId)),
        )
        .returning();
      if (!saved) throw new ServiceError('not_found', 'Episode not found.', 404);
      await tx.execute(sql`delete from procedure_candidate where episode_id = ${id}`);
      return { deleted: true };
    });
  }
}

/** A late completion or fresh intervention cannot recreate evidence removed from an older job. */
async function liveJobEvidence(tx: Transaction, row: JobRow) {
  const state = await tx.execute(
    sql`select revoked, restore_ready from memory_spaces where space_id = ${row.spaceId}`,
  );
  const cleared = await tx.execute(
    sql`select id from memory_suppressions where space_id = ${row.spaceId}
      and operation = 'clear' and recorded_at >= ${row.createdAt.toISOString()} limit 1`,
  );
  if ((state[0] && (state[0].revoked || !state[0].restore_ready)) || cleared.length)
    throw new ServiceError('evidence_unavailable', 'The job evidence is no longer available.');
  const [registration] = await tx.select().from(learningJob).where(eq(learningJob.jobId, row.id));
  await validateReferences(tx, row.spaceId, {
    scope: registration?.scope ?? unknownScope,
    template_id: registration?.templateId ?? 'unclassified',
    input_refs: await inputReferences(tx, row, registration?.inputRefs ?? []),
  });
  return registration;
}

/** Context derivations record exact delivered claim/source versions without copying their private text. */
async function inputReferences(tx: Transaction, row: JobRow, declared?: string[]) {
  let references = declared;
  if (!references) {
    const [registration] = await tx.select().from(learningJob).where(eq(learningJob.jobId, row.id));
    references = registration?.inputRefs ?? [];
  }
  const observed =
    await tx.execute(sql`select distinct d.input_id || '@' || d.input_version as handle
    from memory_contexts c join memory_derivations d
      on d.space_id = c.space_id and d.output_kind = 'context' and d.output_id = c.id
    where c.space_id = ${row.spaceId} and c.job_id = ${row.id}
      and d.input_kind in ('claim', 'source')`);
  const handles = observed.map((value) => {
    const parsed = memoryHandle.safeParse(value.handle);
    if (!parsed.success)
      throw new ServiceError(
        'evidence_unavailable',
        'An input version cannot be represented as learning evidence.',
      );
    return parsed.data;
  });
  return [...new Set([...references, ...handles])];
}

async function validateReferences(tx: Transaction, spaceId: string, input: JobLearningScope) {
  for (const handle of input.input_refs) {
    const [id, version] = handle.split('@');
    const rows = id?.startsWith('src_')
      ? await tx.execute(
          sql`select s.id from memory_sources s where s.id = ${id} and s.source_version = ${version}
            and s.space_id = ${spaceId} and s.state = 'active' and not exists (
              select 1 from memory_suppressions r where r.space_id = s.space_id and r.source_id = s.id
            )`,
        )
      : await tx.execute(
          sql`select c.id from memory_claims c join memory_revisions r on r.claim_id = c.id where c.id = ${id} and r.revision = ${Number(version)} and c.space_id = ${spaceId} and not c.hidden`,
        );
    if (!rows.length)
      throw new ServiceError('scope_denied', 'An input reference is unavailable.', 403);
  }
}
