/**
 * Remote sandbox sessions and the commands run in them.
 *
 * A session row exists before its sandbox does: it is written as `opening`
 * with a placeholder provider id, so one live session per attempt and one live
 * workspace per space and agent are decided by Postgres before anything is
 * created. `sandbox_command` is keyed by the action, so the same action can be
 * dispatched into a sandbox only once; a second dispatch finds the row and
 * reattaches instead.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { action, agent, attempt, connection, job, space } from '../db/schema.ts';
import type { SessionPersistence } from './manifest.ts';
import type { EgressPolicy } from './types.ts';

export type SessionStatus = 'opening' | 'ready' | 'paused' | 'closing' | 'closed' | 'lost';

export const sandboxSession = pgTable(
  'sandbox_session',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'restrict' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    attemptId: text('attempt_id').references(() => attempt.id, { onDelete: 'set null' }),
    agentId: text('agent_id').references(() => agent.id, { onDelete: 'set null' }),
    adapter: text('adapter').notNull(),
    providerSandboxId: text('provider_sandbox_id').notNull(),
    imageRef: text('image_ref').notNull(),
    imageDigest: text('image_digest'),
    region: text('region'),
    egressPolicy: jsonb('egress_policy').$type<EgressPolicy>().notNull(),
    persistence: text('persistence').$type<SessionPersistence>().notNull(),
    resumeRef: text('resume_ref'),
    status: text('status').$type<SessionStatus>().notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    secondsCharged: doublePrecision('seconds_charged'),
    budgetLedgerId: text('budget_ledger_id'),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('sandbox_session_provider_idx').on(t.adapter, t.providerSandboxId),
    uniqueIndex('sandbox_session_attempt_idx')
      .on(t.attemptId)
      .where(sql`${t.attemptId} is not null and ${t.status} <> 'closed'`),
    uniqueIndex('sandbox_workspace_idx')
      .on(t.spaceId, t.agentId)
      .where(sql`${t.agentId} is not null and ${t.status} in ('ready', 'paused')`),
    index('sandbox_session_lease_idx').on(t.leaseExpiresAt).where(sql`${t.status} <> 'closed'`),
    check(
      'sandbox_session_status_check',
      sql`${t.status} in ('opening', 'ready', 'paused', 'closing', 'closed', 'lost')`,
    ),
    check(
      'sandbox_session_persistence_check',
      sql`${t.persistence} in ('ephemeral', 'pause', 'snapshot')`,
    ),
  ],
);

export const sandboxCommand = pgTable('sandbox_command', {
  actionId: text('action_id')
    .primaryKey()
    .references(() => action.id, { onDelete: 'cascade' }),
  sessionId: text('session_id')
    .notNull()
    .references(() => sandboxSession.id, { onDelete: 'cascade' }),
  marker: text('marker').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  outcome: text('outcome'),
  exitCode: integer('exit_code'),
  reattached: boolean('reattached').notNull().default(false),
});
