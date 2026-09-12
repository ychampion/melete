import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { job } from '../db/schema.ts';
import { procedureCandidate, procedureEvaluation } from './schema.ts';

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
