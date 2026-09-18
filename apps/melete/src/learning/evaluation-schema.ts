import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { job, space } from '../db/schema.ts';
import { procedureCandidate, procedureEvaluation } from './schema.ts';

/**
 * One evaluation at a time in a space, recorded rather than held open.
 *
 * An advisory lock would have to be held for the whole run, which parks a pooled
 * connection idle in a transaction while the evaluation drives real jobs through
 * the runner. A row says the same thing, is visible to a person debugging, and
 * expires: a holder that crashed stops blocking the next evaluation once its
 * lease runs out, which is the same bound that lets the abandoned evaluation
 * itself be recorded as failed.
 */
export const learningEvaluationLease = pgTable('learning_evaluation_lease', {
  spaceId: text('space_id')
    .primaryKey()
    .references(() => space.id, { onDelete: 'cascade' }),
  candidateId: text('candidate_id').notNull(),
  holder: text('holder').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Only the trusted evaluator writes a trial grant, before its synthetic job is enqueued. */
export const learningTrial = pgTable('learning_trial', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => job.id, { onDelete: 'cascade' }),
  candidateId: text('candidate_id')
    .notNull()
    .references(() => procedureCandidate.id, { onDelete: 'cascade' }),
  evaluationId: text('evaluation_id')
    .notNull()
    .references(() => procedureEvaluation.id, { onDelete: 'cascade' }),
  bodyHash: text('body_hash').notNull(),
  useCandidate: boolean('use_candidate').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
