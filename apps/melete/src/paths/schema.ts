/**
 * What Melete knows works at each service: per path and kind of work, how
 * many tries there were and how they ended. Fed by outcomes as they land, and
 * read by the path policy (`policy.ts`).
 */
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { space } from '../db/schema.ts';

export const servicePath = pgTable(
  'service_path',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** `google:mail`, `opentable.com`: see `services.ts`. */
    serviceKey: text('service_key').notNull(),
    /** The action there, such as one form's address (`operations.ts`); misses are counted per action. */
    operationKey: text('operation_key').notNull(),
    /** The kind of work: an intent's kind, or `other`. */
    taskKind: text('task_kind').notNull(),
    /** `api`, `browser` or `person`. */
    path: text('path').notNull(),
    attempts: integer('attempts').notNull().default(0),
    successes: integer('successes').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    unknowns: integer('unknowns').notNull().default(0),
    /** Times the work went to the person from this path. */
    handed: integer('handed').notNull().default(0),
    /** Outcomes in a row that did not get through, since the last that did. */
    streak: integer('streak').notNull().default(0),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastFault: text('last_fault'),
    lastFaultAt: timestamp('last_fault_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.serviceKey, t.operationKey, t.taskKind, t.path] }),
    check('service_path_path', sql`${t.path} in ('api', 'browser', 'person')`),
    check(
      'service_path_counts',
      sql`${t.attempts} >= 0 and ${t.successes} >= 0 and ${t.failures} >= 0 and ${t.unknowns} >= 0 and ${t.handed} >= 0 and ${t.streak} >= 0`,
    ),
  ],
);
