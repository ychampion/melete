import {
  experienceQuestion,
  quickAnswerRequest,
  quickOptions,
  unavailable,
} from '@melete/contracts';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { experienceTurn, job, question } from '../db/schema.ts';
import { serviceTransaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { QuestionService } from '../jobs/questions.ts';
import { ownedSpace, ownJob } from '../principals/authority.ts';
import { explainHandles } from './evidence.ts';
import { object, plainText } from './projectors.ts';
import { experienceMissing } from './service.ts';

type QuestionRow = typeof question.$inferSelect;

/**
 * Whether the person may answer in their own words. A memory question keeps
 * one of two revisions and the privacy question is a yes or a no; every
 * question a job asks takes free text beside its options.
 */
const freeText = (row: QuestionRow): boolean =>
  row.source !== 'memory' &&
  row.options
    .map((option) => option.id)
    .sort()
    .join(',') !== 'keep_private,send_redacted';

export class ExperienceQuestions {
  constructor(
    readonly db: Database,
    readonly questions?: QuestionService,
    readonly sql?: Sql,
    /** Stops long work for the person; left out, a run's question is not dismissed. */
    readonly stopRun?: (spaceId: string, runId: string) => Promise<void>,
  ) {}
  async find(spaceId: string, id?: string) {
    return this.db
      .select({ question, holder: { kind: job.kind, state: job.state } })
      .from(question)
      .leftJoin(job, eq(job.id, question.jobId))
      .where(
        and(
          // A job's question is its owner's; one without a job belongs to the space owner.
          or(
            and(eq(job.spaceId, spaceId), ownJob()),
            and(
              isNull(question.jobId),
              eq(question.spaceId, spaceId),
              ownedSpace(question.spaceId),
            ),
          ),
          id ? eq(question.id, id) : eq(question.state, 'open'),
        ),
      )
      .orderBy(question.createdAt)
      .limit(200);
  }
  async list(spaceId: string) {
    const items = [];
    for (const { question: row, holder } of await this.find(spaceId)) {
      const explained = this.sql ? await explainHandles(this.sql, spaceId, row.because) : [];
      const why = row.why
        ? [plainText(row.why, 'Your answer decides the next step.'), ...explained]
        : explained;
      items.push(
        experienceQuestion.parse({
          id: row.id,
          conversation_id: row.jobId,
          text: plainText(row.text, 'Which option would you prefer?'),
          why,
          if_ignored: plainText(row.ifIgnored, 'This will wait for your answer.'),
          options: quickOptions
            .parse(row.options)
            .map((option) => ({ ...option, label: plainText(option.label, 'Choose this option') })),
          free_text: freeText(row),
          needs_answer:
            row.source === 'memory' ||
            row.blocksExternalEffect ||
            !settledByDismissal(holder, Boolean(this.stopRun)),
          created_at: row.createdAt.toISOString(),
        }),
      );
    }
    return { questions: items };
  }
  async answer(spaceId: string, id: string, input: unknown) {
    const request = quickAnswerRequest.parse(input);
    const [entry] = await this.find(spaceId, id);
    if (!entry) throw experienceMissing();
    let text: string;
    let offered: { id: string; label: string } | undefined;
    if ('option_id' in request) {
      const option = quickOptions
        .parse(entry.question.options)
        .find((item) => item.id === request.option_id);
      if (!option)
        throw new ServiceError('invalid_choice', 'Choose one of the offered answers.', 400);
      text = option.label;
      offered = option;
    } else {
      if (!freeText(entry.question))
        throw new ServiceError('invalid_choice', 'Choose one of the offered answers.', 400);
      text = request.text;
    }
    if (!this.questions) return unavailable('Answers are not connected yet.');
    if (entry.question.source === 'memory')
      return unavailable('Open this memory item to choose the detail to keep.');
    const result = await this.questions.answer(id, { text }, offered);
    if (result.error)
      throw new ServiceError(
        'answer_not_accepted',
        'This answer could not be accepted. Try again.',
        409,
      );
    return { status: 'ok' };
  }
  /**
   * The person no longer wants to answer: the question leaves every list and
   * its card in the conversation closes. The conversation waits for their next
   * message, as it does after Stop. Long work that waited on the question has
   * nothing left to wait for, so it is stopped, keeping what it had so far.
   * A question about something that may already have gone out keeps waiting,
   * since only an answer settles it.
   */
  async dismiss(spaceId: string, id: string) {
    const [entry] = await this.find(spaceId, id);
    if (!entry) throw experienceMissing();
    const row = entry.question;
    if (row.state !== 'open') return { status: 'ok' as const };
    if (row.source === 'memory')
      throw new ServiceError(
        'question_needs_answer',
        'Open this memory item to choose the detail to keep.',
        409,
      );
    if (row.blocksExternalEffect || !settledByDismissal(entry.holder, Boolean(this.stopRun)))
      throw new ServiceError(
        'question_needs_answer',
        row.blocksExternalEffect
          ? 'This one is about something that may already have gone out, so it needs your answer.'
          : 'This work waits for your answer. Open it to answer or stop it.',
        409,
      );
    // Stopping the run withdraws its question with it.
    if (row.jobId && entry.holder?.kind === 'run' && entry.holder.state === 'waiting_for_input')
      await this.stopRun?.(spaceId, row.jobId);
    await serviceTransaction(this.db, async (tx) => {
      // The work first, then its question, in the order an answer takes them.
      const [holder] = row.jobId
        ? await tx.select().from(job).where(eq(job.id, row.jobId)).for('update')
        : [];
      const [closed] = await tx
        .update(question)
        .set({ state: 'withdrawn', answer: null, answerSubmissionId: null, answeredAt: new Date() })
        .where(and(eq(question.id, id), eq(question.state, 'open')))
        .returning();
      if (!closed?.jobId) return;
      await appendEvent(tx, {
        jobId: closed.jobId,
        type: 'notice',
        payload: {
          kind: 'question_closed',
          question_id: closed.id,
          state: closed.state,
          reason: 'dismissed',
          submission_id: null,
        },
        dedupKey: `${closed.id}:closed`,
      });
      if (holder?.kind !== 'chat' || holder.state !== 'waiting_for_input') return;
      // A chat waiting for the person to take over a browser or computer keeps that wait.
      if ('handoff' in object(holder.wait)) return;
      // The turn that asked has ended: the chat no longer reads as needing the
      // person, and nothing carries the dismissed question forward.
      await tx
        .update(job)
        .set({ wait: { kind: 'user_input', question: 'What would you like to do next?' } })
        .where(eq(job.id, holder.id));
      if (!holder.currentTurnId) return;
      const [turn] = await tx
        .update(experienceTurn)
        .set({ status: 'done' })
        .where(
          and(eq(experienceTurn.id, holder.currentTurnId), eq(experienceTurn.status, 'needs_you')),
        )
        .returning({ id: experienceTurn.id });
      if (turn)
        await appendEvent(tx, {
          jobId: holder.id,
          type: 'notice',
          payload: { kind: 'turn_settled', turn_id: turn.id, turn_status: 'done' },
          dedupKey: `${turn.id}:settled:${closed.id}`,
        });
    });
    return { status: 'ok' as const };
  }
}

/**
 * Whether dismissing leaves nothing waiting on an answer that will never come:
 * a chat goes back to waiting for the next message, a run is stopped, and work
 * resting until its next time or on a permission goes on as it was. Other work
 * that stopped to ask only moves on with an answer.
 */
function settledByDismissal(
  holder: { kind: string; state: string } | null,
  canStopRuns: boolean,
): boolean {
  if (holder?.state !== 'waiting_for_input') return true;
  return holder.kind === 'chat' || (holder.kind === 'run' && canStopRuns);
}
