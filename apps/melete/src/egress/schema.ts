/**
 * Where the agent's computer reached: one row per connection it opened, or
 * tried to open, through the service's egress guard.
 *
 * A row names the session and space, and the job, attempt and command when the
 * connection carried that command's token. A connection with no token, or one
 * whose command had already ended, is `unattributed`. A tunnel to a host of a
 * connected command-line account is `credentialed`, with its reads, its writes
 * and the writes' actions.
 * Rows are kept for `MELETE_EGRESS_RECORD_DAYS` and go with their space.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { space } from '../db/schema.ts';
import { sandboxSession } from '../sandbox/schema.ts';

/**
 * `suppressed` counts, on one record per computer per minute, the connections
 * past that minute's record budget.
 */
export type EgressVerdict = 'tunnel' | 'refused' | 'credentialed' | 'unattributed' | 'suppressed';

export const egressRecord = pgTable(
  'egress_record',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sandboxSession.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    jobId: text('job_id'),
    attemptId: text('attempt_id'),
    actionId: text('action_id'),
    /** `command` or `process`; null when the connection carried no live token. */
    tokenKind: text('token_kind'),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    verdict: text('verdict').$type<EgressVerdict>().notNull(),
    /** Why a connection was refused, as the guard told the computer. */
    reason: text('reason'),
    /** How many connections the record stands for: repeated refusals within a minute share one. */
    count: integer('count').notNull().default(1),
    connectionId: text('connection_id'),
    reads: integer('reads').notNull().default(0),
    writes: integer('writes').notNull().default(0),
    /** The actions of the writes a credentialed tunnel carried, each admitted on its own. */
    writeActionIds: jsonb('write_action_ids').$type<string[]>().notNull().default([]),
    bytesUp: bigint('bytes_up', { mode: 'number' }).notNull().default(0),
    bytesDown: bigint('bytes_down', { mode: 'number' }).notNull().default(0),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('egress_record_job_idx').on(t.jobId, t.openedAt),
    index('egress_record_space_idx').on(t.spaceId, t.openedAt),
    // The session's cascade reaches records through this.
    index('egress_record_session_idx').on(t.sessionId),
    // The retention sweep removes by age across every space.
    index('egress_record_opened_idx').on(t.openedAt),
    index('egress_record_action_idx').on(t.actionId).where(sql`${t.actionId} is not null`),
    check(
      'egress_record_verdict_check',
      sql`${t.verdict} in ('tunnel', 'refused', 'credentialed', 'unattributed', 'suppressed')`,
    ),
    check(
      'egress_record_token_kind_check',
      sql`${t.tokenKind} is null or ${t.tokenKind} in ('command', 'process')`,
    ),
  ],
);

/**
 * The installation's egress certificate authority: one current row, the rest
 * superseded. Its key is ECDSA P-256, sealed with the master key for the
 * purpose `egress-ca`, and never leaves the service. Its name constraints are
 * the DNS subtrees of the command-line adapters this installation offers, so
 * the certificate a computer trusts can vouch for those names and no other.
 */
export const egressCa = pgTable(
  'egress_ca',
  {
    id: text('id').primaryKey(),
    certPem: text('cert_pem').notNull(),
    sealedKey: text('sealed_key').notNull(),
    nameConstraints: jsonb('name_constraints').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => [index('egress_ca_current_idx').on(t.supersededAt, t.createdAt)],
);
