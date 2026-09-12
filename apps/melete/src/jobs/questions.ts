/**
 * Attention is a contract. A wake ends with at most one question, every job
 * contributes at most one entry to the owner's queue, and answering an entry
 * is an ordinary input submission, so the reply obligation and idempotency
 * machinery already in the service is what carries it.
 */
import {
  attentionHandle,
  type DeferredQuestion,
  deferredQuestion,
  isTerminal,
  type JobState,
  type OwnerQuestion,
  ownerQuestion,
  type QuestionSpecInput,
  questionAnswerRequest,
  questionSpec,
  type SubmissionReceipt,
  TERMINAL_STATES,
} from '@melete/contracts';
import { and, eq, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ServiceError } from '../api/errors.ts';
import { job, question } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import {
  ownedSpace,
  requestPrincipal,
  requireJobAccess,
  spaceAuthority,
  visibleJob,
} from '../principals/authority.ts';
import type { JobRow, JobService } from './service.ts';
import type { SubmissionService } from './submissions.ts';

export type QuestionRow = typeof question.$inferSelect;

/** The consequence of ignoring a question the runtime did not describe itself. */
export const UNANSWERED_CONSEQUENCE =
  'This responsibility stays waiting for your answer and makes no further progress until you reply.';

/** The submission ID an answer is admitted under, so a resent answer wakes the job once. */
export const answerKey = (questionId: string): string => `q:${questionId}`;

/** No deadline means last, not soonest. */
const deadlineRank = (at: string | null): number =>
  at ? Date.parse(at) : Number.POSITIVE_INFINITY;

export function questionView(row: QuestionRow, jobTitle: string | null): OwnerQuestion {
  // Older broker writers stored their explanation where the public contract
  // expects durable handles. Keep that explanation visible and cite the actual
  // question record so closing it cannot roll back a reconciliation wake.
  const handles = row.because.filter((value) => attentionHandle.safeParse(value).success);
  const explanation = row.because.filter((value) => !attentionHandle.safeParse(value).success);
  return ownerQuestion.parse({
    id: row.id,
    source: row.source,
    job_id: row.jobId,
    job_title: jobTitle,
    attempt_id: row.attemptId,
    space_id: row.spaceId,
    key: row.key,
    text: [row.text, ...explanation].join('\n\n').slice(0, 4000),
    because: handles.length > 0 ? handles : [`question:${row.id}`],
    if_ignored: row.ifIgnored,
    blocks_external_effect: row.blocksExternalEffect,
    deadline_at: row.deadlineAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    state: row.state,
    answer: row.answer,
    answered_at: row.answeredAt?.toISOString() ?? null,
  });
}

export function questionCandidate(spec: QuestionSpecInput, at: Date): DeferredQuestion {
  return deferredQuestion.parse({ ...questionSpec.parse(spec), created_at: at.toISOString() });
}

/** Whatever the job is still holding. Unreadable storage is treated as nothing held. */
export function readDeferred(row: Pick<JobRow, 'deferredQuestions'>): DeferredQuestion[] {
  const parsed = deferredQuestion.array().safeParse(row.deferredQuestions);
  return parsed.success ? parsed.data : [];
}

/**
 * The order the owner sees, and the order the service picks in: what blocks an
 * external effect first, then the nearest deadline, then the oldest. The text
 * breaks a remaining tie so the choice is the same on every run.
 */
export function rankQuestions(candidates: readonly DeferredQuestion[]): DeferredQuestion[] {
  return [...candidates].sort((left, right) => {
    if (left.blocks_external_effect !== right.blocks_external_effect)
      return left.blocks_external_effect ? -1 : 1;
    const first = left.deadline_at ? Date.parse(left.deadline_at) : Number.POSITIVE_INFINITY;
    const second = right.deadline_at ? Date.parse(right.deadline_at) : Number.POSITIVE_INFINITY;
    if (first !== second) return first < second ? -1 : 1;
    const raised = Date.parse(left.created_at) - Date.parse(right.created_at);
    return raised !== 0 ? raised : left.text.localeCompare(right.text);
  });
}

/** Asking the same thing twice is one question; the earliest occurrence keeps its age. */
function unique(candidates: readonly DeferredQuestion[]): DeferredQuestion[] {
  const seen = new Map<string, DeferredQuestion>();
  for (const candidate of candidates)
    if (!seen.has(candidate.text)) seen.set(candidate.text, candidate);
  return [...seen.values()];
}

export type QuestionResolution = { asked: DeferredQuestion | null; deferred: DeferredQuestion[] };

export type ResolveOptions = {
  attemptId: string;
  carried: readonly QuestionSpecInput[];
  /** True when the job is about to rest on the owner, which is the only time it may ask. */
  askable: boolean;
  /** The frozen outcome's own question, when it has one. */
  fallback?: string;
  now?: Date;
};

/**
 * Decide what this wake asks. Everything the attempt raised joins whatever the
 * job was already holding; one is chosen and the rest stay for a later wake.
 */
export async function resolveQuestions(
  tx: Transaction,
  row: JobRow,
  options: ResolveOptions,
): Promise<QuestionResolution> {
  const at = options.now ?? new Date();
  const carried = options.carried.map((spec) => questionCandidate(spec, at));
  const derived =
    options.askable && options.fallback?.trim()
      ? [
          questionCandidate(
            {
              text: options.fallback,
              because: [`attempt:${options.attemptId}`],
              if_ignored: UNANSWERED_CONSEQUENCE,
            },
            at,
          ),
        ]
      : [];
  const pool = unique([...readDeferred(row), ...carried, ...derived]);
  if (!options.askable) return { asked: null, deferred: pool };
  const [open] = await tx
    .select({ id: question.id })
    .from(question)
    .where(and(eq(question.jobId, row.id), eq(question.state, 'open')))
    .limit(1);
  // One open question per job. A second one waits rather than queue-jumping.
  if (open) return { asked: null, deferred: pool };
  const [first, ...rest] = rankQuestions(pool);
  return { asked: first ?? null, deferred: rest };
}

async function closeOpen(
  tx: Transaction,
  jobId: string,
  changes: Pick<typeof question.$inferInsert, 'state' | 'answer' | 'answerSubmissionId'>,
  reason: string,
): Promise<QuestionRow | undefined> {
  const [open] = await tx
    .select()
    .from(question)
    .where(and(eq(question.jobId, jobId), eq(question.state, 'open')))
    .limit(1);
  if (!open) return undefined;
  const [closed] = await tx
    .update(question)
    .set({ ...changes, answeredAt: new Date() })
    .where(eq(question.id, open.id))
    .returning();
  if (!closed) throw new Error('Open question disappeared');
  await appendEvent(tx, {
    jobId,
    type: 'notice',
    payload: {
      kind: 'question_closed',
      question_id: closed.id,
      state: closed.state,
      reason,
      submission_id: closed.answerSubmissionId,
    },
    dedupKey: `${closed.id}:closed`,
  });
  return closed;
}

/**
 * Write the decision down. The asked question becomes the job's one queue entry;
 * the rest ride on the job row. A finished responsibility holds nothing: its
 * open question is withdrawn rather than left in the queue forever.
 */
export async function persistQuestions(
  tx: Transaction,
  row: JobRow,
  resolution: QuestionResolution,
  attemptId: string | null,
): Promise<void> {
  const finished = isTerminal(row.state as JobState);
  if (finished) {
    await closeOpen(
      tx,
      row.id,
      { state: 'withdrawn', answer: null, answerSubmissionId: null },
      'responsibility_finished',
    );
  } else if (resolution.asked) {
    const asked = resolution.asked;
    const id = newId('qst');
    await tx.insert(question).values({
      id,
      jobId: row.id,
      attemptId,
      text: asked.text,
      because: asked.because,
      ifIgnored: asked.if_ignored,
      blocksExternalEffect: asked.blocks_external_effect,
      deadlineAt: asked.deadline_at ? new Date(asked.deadline_at) : null,
      // A deferred question keeps the moment it was first raised, so waiting counts.
      createdAt: new Date(asked.created_at),
    });
    await appendEvent(tx, {
      jobId: row.id,
      attemptId: attemptId ?? undefined,
      type: 'notice',
      payload: {
        kind: 'question_asked',
        question_id: id,
        because: asked.because,
        if_ignored: asked.if_ignored,
        blocks_external_effect: asked.blocks_external_effect,
        deadline_at: asked.deadline_at,
      },
      dedupKey: `${id}:asked`,
    });
  }
  const deferred = finished ? [] : resolution.deferred;
  if (JSON.stringify(deferred) === JSON.stringify(readDeferred(row))) return;
  await tx.update(job).set({ deferredQuestions: deferred }).where(eq(job.id, row.id));
  if (!deferred.length) return;
  await appendEvent(tx, {
    jobId: row.id,
    attemptId: attemptId ?? undefined,
    type: 'notice',
    payload: {
      kind: 'questions_deferred',
      count: deferred.length,
      questions: deferred.map((item) => item.text),
    },
    dedupKey: `${row.id}:deferred:${row.stateVersion}`,
  });
}

/**
 * How a memory question is settled. Memory owns the correction path; this is
 * the only thing the queue needs from it, so the queue never learns what a
 * claim is and memory never learns what a queue is.
 */
export type DisputeSettler = {
  settle(input: {
    spaceId: string;
    key: string;
    /** The revision the owner is keeping, as `k_…@7`. */
    choice: string;
    text: string;
    idempotencyKey: string;
  }): Promise<void>;
};

export type AnswerResult = {
  question: OwnerQuestion;
  job: JobRow | null;
  receipt: SubmissionReceipt | null;
  status: ContentfulStatusCode;
  error?: { code: string; message: string };
};

/** The owner's single queue. Every entry belongs to a job; answering wakes that job alone. */
export class QuestionService {
  private readonly answers = new Map<string, string>();

  constructor(
    readonly jobs: JobService,
    readonly submissions?: SubmissionService,
    /** Left out, a memory question can be read and ranked but not answered. */
    readonly disputes?: DisputeSettler,
  ) {
    if (!submissions) return;
    const previous = submissions.onAccepted;
    submissions.onAccepted = async (tx, receipt, row, kind) => {
      await previous?.(tx, receipt, row, kind);
      // Any accepted input moves the job off the owner, so its question is closed:
      // answered when it came through the queue, withdrawn when it did not.
      if (kind === 'input') await this.close(tx, receipt, row);
    };
  }

  private async close(tx: Transaction, receipt: SubmissionReceipt, row: JobRow): Promise<void> {
    const [open] = await tx
      .select({ id: question.id })
      .from(question)
      .where(and(eq(question.jobId, row.id), eq(question.state, 'open')))
      .limit(1);
    if (!open) return;
    const answered = receipt.submission_id === answerKey(open.id);
    await closeOpen(
      tx,
      row.id,
      {
        state: answered ? 'answered' : 'withdrawn',
        answer: answered ? (this.answers.get(receipt.submission_id) ?? null) : null,
        answerSubmissionId: receipt.submission_id,
      },
      answered ? 'answered' : 'superseded_by_input',
    );
  }

  private async read(id: string): Promise<{ row: QuestionRow; view: OwnerQuestion }> {
    const [found] = await this.jobs.db
      .select({ question, title: job.title })
      .from(question)
      .leftJoin(job, eq(job.id, question.jobId))
      .where(eq(question.id, id))
      .limit(1);
    if (!found) throw new ServiceError('not_found', 'Question not found.', 404);
    if (requestPrincipal()) {
      if (found.question.jobId) await requireJobAccess(this.jobs.db, found.question.jobId);
      else if (found.question.spaceId)
        await spaceAuthority(this.jobs.db, found.question.spaceId, requestPrincipal());
      else throw new ServiceError('scope_denied', 'Question is not accessible.', 403);
    }
    return { row: found.question, view: questionView(found.question, found.title) };
  }

  get(id: string): Promise<OwnerQuestion> {
    return this.read(id).then((found) => found.view);
  }

  /**
   * One queue across every job and every disputed key, in the order the rule
   * says the owner should see it. A memory question has no job, so it is never
   * excluded by a job's state; it is blocking when an action already admitted
   * rests on the key it disputes, which is the same rule read through memory.
   */
  async list(): Promise<OwnerQuestion[]> {
    const rows = await this.jobs.db
      .select({ question, title: job.title })
      .from(question)
      .leftJoin(job, eq(job.id, question.jobId))
      .where(
        and(
          eq(question.state, 'open'),
          requestPrincipal()
            ? or(
                visibleJob(question.jobId),
                and(isNull(question.jobId), ownedSpace(question.spaceId)),
              )
            : undefined,
          or(isNull(question.jobId), notInArray(job.state, [...TERMINAL_STATES])),
        ),
      );
    const blocking = await this.blockingKeys(rows.map((row) => row.question));
    return rows
      .map((row) => {
        const view = questionView(row.question, row.title);
        return view.source === 'memory' && blocking.has(JSON.stringify([view.space_id, view.key]))
          ? { ...view, blocks_external_effect: true }
          : view;
      })
      .sort(
        (a, b) =>
          Number(b.blocks_external_effect) - Number(a.blocks_external_effect) ||
          deadlineRank(a.deadline_at) - deadlineRank(b.deadline_at) ||
          Date.parse(a.created_at) - Date.parse(b.created_at),
      );
  }

  /**
   * The disputed keys an admitted action depends on, read through the manifests
   * the job declared. A key nothing has acted on yet is still a question; it
   * just is not the one holding an effect up.
   */
  private async blockingKeys(rows: readonly QuestionRow[]): Promise<Set<string>> {
    const disputed = rows.filter((row) => row.source === 'memory' && row.spaceId && row.key);
    if (disputed.length === 0) return new Set();
    // Every key here was written by an extraction proposal, so a key is data.
    // Each half of each pair is bound as its own parameter: no part of a key is
    // ever spliced into the statement, so nothing in one can be read as SQL and
    // there is no escaping to get right. The row comparison keeps the pairing
    // exact, so a space cannot borrow another space's key.
    const wanted = sql.join(
      disputed.map((row) => sql`(${String(row.spaceId)}::text, ${String(row.key)}::text)`),
      sql`, `,
    );
    const found = await this.jobs.db.execute(sql`
      select distinct c.space_id, c.key
      from action a
      join job j on j.id = a.job_id
      join memory_outputs o on o.job_id = a.job_id and o.space_id = j.space_id
      join memory_output_uses u on u.output_row_id = o.id
      join memory_claims c on c.id = u.claim_id and c.space_id = o.space_id
      where a.status in ('admitted', 'dispatched', 'succeeded')
        and (c.space_id, c.key) in (values ${wanted})`);
    return new Set(
      (found as unknown as Array<{ space_id: string; key: string }>).map((row) =>
        JSON.stringify([row.space_id, row.key]),
      ),
    );
  }

  /**
   * Settle a disputed key. The owner names the revision they are keeping and it
   * is committed through memory's correction path as a protected owner
   * correction, which is what closes the contradiction; the question is then
   * answered because the thing it asked about has an answer, not because
   * somebody typed into it.
   */
  private async settle(
    current: { row: QuestionRow; view: OwnerQuestion },
    value: { text: string; choice?: string },
  ): Promise<AnswerResult> {
    if (!this.disputes)
      throw new ServiceError('service_unavailable', 'Configure the memory service.', 503);
    if (current.row.state !== 'open')
      throw new ServiceError('question_closed', 'This question is no longer open.', 409);
    const { spaceId, key } = current.row;
    if (!spaceId || !key)
      throw new ServiceError('question_closed', 'This question names no key.', 409);
    // Prose cannot choose between two revisions, so the owner has to name one,
    // and it has to be one of the two the question said were in disagreement.
    const offered = current.view.because.map((handle) => handle.replace(/^claim:/, ''));
    if (!value.choice || !offered.includes(value.choice))
      throw new ServiceError(
        'invalid_choice',
        `Name which revision you are keeping: ${offered.join(' or ')}.`,
        400,
      );
    await this.disputes.settle({
      spaceId,
      key,
      choice: value.choice,
      text: value.text,
      idempotencyKey: answerKey(current.row.id),
    });
    await this.jobs.db
      .update(question)
      .set({ state: 'answered', answer: value.text, answeredAt: new Date() })
      .where(and(eq(question.id, current.row.id), eq(question.state, 'open')));
    const after = await this.read(current.row.id);
    return { question: after.view, job: null, receipt: null, status: 200 };
  }

  async answer(id: string, input: unknown): Promise<AnswerResult> {
    const value = questionAnswerRequest.parse(input);
    const first = await this.read(id);
    if (first.row.source === 'memory') return this.settle(first, value);
    const submissions = this.submissions;
    if (!submissions)
      throw new ServiceError('service_unavailable', 'Configure the submission service.', 503);
    const current = first;
    const key = answerKey(id);
    // A resent answer returns the original receipt instead of waking the job twice.
    if (current.row.state === 'answered' && current.row.answerSubmissionId === key)
      return {
        question: current.view,
        job: null,
        receipt: await submissions.get(key),
        status: 200,
      };
    if (current.row.state !== 'open')
      throw new ServiceError('question_closed', 'This question is no longer open.', 409);
    if (!current.row.jobId)
      throw new ServiceError('question_closed', 'This question has no responsibility.', 409);
    const owner = await this.jobs.get(current.row.jobId);
    if (isTerminal(owner.state as JobState))
      throw new ServiceError(
        'question_closed',
        'This responsibility has finished, so its question is no longer open.',
        409,
      );
    this.answers.set(key, value.text);
    let result: Awaited<ReturnType<SubmissionService['input']>>;
    try {
      result = await submissions.input(current.row.jobId, { text: value.text }, key);
    } finally {
      this.answers.delete(key);
    }
    const after = await this.read(id);
    return {
      question: after.view,
      job: result.job,
      receipt: result.receipt,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    };
  }
}
