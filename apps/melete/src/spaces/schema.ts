/**
 * The record of a removal. It outlives the space it names, which is why
 * `space_id` carries no foreign key: the row has to survive both the deletion
 * of the space and the restore of a backup that predates it.
 */

import type { RemovalCounts, RemovalPhase, RemovalProvider } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const spaceRemoval = pgTable(
  'space_removal',
  {
    id: text('id').primaryKey(),
    /** Deliberately not a foreign key. See the note above. */
    spaceId: text('space_id').notNull(),
    /** Kept verbatim so a finished report can still name what was removed. */
    spaceName: text('space_name').notNull(),
    gitPath: text('git_path').notNull(),
    kind: text('kind').notNull(),
    requestedBy: text('requested_by').notNull(),
    state: text('state').notNull().default('pending'),
    phase: text('phase').$type<RemovalPhase>().notNull().default('fence'),
    /**
     * Captured at the fence, because job workspaces are keyed by job id and
     * those ids are gone by the time the filesystem sweep runs.
     */
    jobIds: jsonb('job_ids').$type<string[]>().notNull().default([]),
    /**
     * Also captured at the fence: the connection rows are deleted in phase 8,
     * and the finished report has to name the services where a key of theirs
     * keeps working until the person revokes it there.
     */
    providers: jsonb('providers').$type<RemovalProvider[]>().notNull().default([]),
    counts: jsonb('counts').$type<RemovalCounts | Record<string, never>>().notNull().default({}),
    blockedReason: text('blocked_reason'),
    attempts: integer('attempts').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('space_removal_kind', sql`${t.kind} in ('removed','emptied')`),
    check('space_removal_state', sql`${t.state} in ('pending','running','blocked','complete')`),
    check(
      'space_removal_phase',
      sql`${t.phase} in ('fence','sessions','journal','sandboxes','browser','files','operational','principals','memory','verify','space')`,
    ),
    // One live removal per space, so a second request joins the sweep already
    // running instead of starting a rival one.
    uniqueIndex('space_removal_live_idx').on(t.spaceId).where(sql`${t.state} <> 'complete'`),
    index('space_removal_ready_idx').on(t.state, t.leaseExpiresAt),
  ],
);

export type SpaceRemovalRow = typeof spaceRemoval.$inferSelect;
