/**
 * What Melete keeps to notice things on time.
 *
 * `clock` is a moment Melete will look at something again: a deadline coming
 * near, or a message that should have had an answer by now. There is at most
 * one live clock per rule and subject, so a meeting moved twice keeps one
 * clock, at its new time. A clock never trusts what it was made from: when it
 * fires it reads the subject again, and settles quietly when what it guards
 * is already done.
 *
 * `situation` is something Melete noticed that may need the person: a meeting
 * that moved, two that overlap, a deadline still unmet, a message nobody
 * answered. One live row per key: a second sighting adds to it. Its title and
 * reason are Melete's own words, never text quoted from mail.
 *
 * `subject_link` names the work that cares about a subject, so a situation
 * about it reaches that work.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { connection, job, principal, space } from '../db/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const situation = pgTable(
  'situation',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** The one person it is for: the account's owner, or whoever set the deadline. */
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    /** `meeting.changed`, `meeting.conflict`, `deadline.at_risk`, `reply.overdue`. */
    kind: text('kind').notNull(),
    /** What it is about: a calendar occurrence, a pair of them, a commitment, a sent message. */
    subjectKey: text('subject_key').notNull(),
    /** The account it was read from, when it came from one. */
    connectionId: text('connection_id').references(() => connection.id, { onDelete: 'cascade' }),
    /** Space, person, kind, subject and moment, hashed: one live situation per key. */
    key: text('key').notNull(),
    /**
     * What makes the latest sighting what it is (a meeting's times, a pair's
     * times, a due time). The same again changes nothing, and a dismissed
     * situation comes back only with a different one.
     */
    fingerprint: text('fingerprint').notNull().default(''),
    /** `normal` (Home only), `soon`, or `urgent`. */
    urgency: text('urgency').notNull().default('normal'),
    /** The deadline behind it was one the person set or accepted. Only then can it be urgent. */
    personSet: boolean('person_set').notNull().default(false),
    /** Melete's own short words for it. */
    title: text('title').notNull(),
    /** Why it matters, in plain words: the line a push carries under its title. */
    reason: text('reason').notNull(),
    /** Handles to what raised it: `event:<seq>`, `clock:<id>`. */
    because: jsonb('because').$type<string[]>().notNull(),
    /** A few typed fields that back it up: times, places, counts. Never a body. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    /** Where its facts came from: `external_content` (an account), `person`, or `service`. */
    origin: text('origin').notNull(),
    /** The work it was handed to. */
    routedJobIds: jsonb('routed_job_ids').$type<string[]>().notNull().default([]),
    /** How many sightings were folded into it. */
    sightings: integer('sightings').notNull().default(1),
    /** The deadline it is about, when it has one. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    /** `open`, `routed`, `dismissed`, `resolved` or `expired`. */
    state: text('state').notNull().default('open'),
    createdAt: created(),
    updatedAt: updated(),
    /** When it was put in front of the person or handed to work; null while only kept for Home. */
    firedAt: timestamp('fired_at', { withTimezone: true }),
    /** When the person saw it: opened its push, or said so. */
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** After this it is no longer worth showing, and it expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('situation_live_key_idx').on(t.key).where(sql`${t.state} in ('open', 'routed')`),
    index('situation_principal_idx').on(t.principalId, t.state, t.createdAt),
    index('situation_key_idx').on(t.key, t.createdAt),
    index('situation_space_idx').on(t.spaceId),
    index('situation_subject_idx').on(t.subjectKey),
    index('situation_connection_idx').on(t.connectionId),
    check(
      'situation_state',
      sql`${t.state} in ('open', 'routed', 'dismissed', 'resolved', 'expired')`,
    ),
    check('situation_urgency', sql`${t.urgency} in ('normal', 'soon', 'urgent')`),
    // Nothing a detector reads on its own can make a situation urgent.
    check('situation_urgent_is_person_set', sql`${t.urgency} <> 'urgent' or ${t.personSet}`),
    check('situation_because_not_empty', sql`jsonb_array_length(${t.because}) > 0`),
    check('situation_reason_not_empty', sql`length(${t.reason}) > 0`),
  ],
);

export const clock = pgTable(
  'clock',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    /** `deadline.at_risk` or `reply.overdue`. */
    rule: text('rule').notNull(),
    subjectKey: text('subject_key').notNull(),
    /** The account the subject is read from, when it lives in one. */
    connectionId: text('connection_id').references(() => connection.id, { onDelete: 'cascade' }),
    /** The provider's own id for the subject, to read it again at fire time. */
    subjectRef: text('subject_ref'),
    /** What the deadline is, in Melete's words: "The contract is signed". */
    title: text('title').notNull(),
    /** When it is due. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /** How long before it is due Melete looks. */
    leadSeconds: integer('lead_s').notNull(),
    /** When Melete looks: due less lead, moved with its subject. */
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    /**
     * When the deadline follows a subject's own time, such as "an hour before
     * the meeting": the field it follows and the offset in seconds.
     */
    anchor: jsonb('anchor').$type<{ field: string; offset_s: number } | null>(),
    /** The test that says it is still at risk, read against fresh fields at fire time. */
    check: jsonb('check').$type<Record<string, unknown>>().notNull(),
    /** The person set or accepted it. Only then may what it raises be urgent. */
    personSet: boolean('person_set').notNull().default(false),
    /** The work that set it, if any; a situation it raises reaches that work. */
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    /** `armed`, `checking`, `fired`, `met`, `cleared` or `missed`. */
    state: text('state').notNull().default('armed'),
    /** While `checking`: until when this check holds it. */
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    /** Checks that could not read the subject, so far. */
    tries: integer('tries').notNull().default(0),
    /** Why it settled the way it did, in plain words. */
    note: text('note'),
    situationId: text('situation_id'),
    createdAt: created(),
    updatedAt: updated(),
    firedAt: timestamp('fired_at', { withTimezone: true }),
  },
  (t) => [
    // One live clock per person, rule and subject.
    uniqueIndex('clock_live_idx')
      .on(t.spaceId, t.principalId, t.rule, t.subjectKey)
      .where(sql`${t.state} in ('armed', 'checking')`),
    index('clock_due_idx').on(t.fireAt).where(sql`${t.state} in ('armed', 'checking')`),
    index('clock_space_idx').on(t.spaceId),
    index('clock_subject_idx').on(t.subjectKey),
    index('clock_connection_idx').on(t.connectionId),
    check(
      'clock_state',
      sql`${t.state} in ('armed', 'checking', 'fired', 'met', 'cleared', 'missed')`,
    ),
    check('clock_lead', sql`${t.leadSeconds} >= 0`),
  ],
);

export const subjectLink = pgTable(
  'subject_link',
  {
    subjectKey: text('subject_key').notNull(),
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** `deadline` (the work set it), `watch` (it watches the subject), `handling` (it acts on it). */
    role: text('role').notNull(),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectKey, t.jobId] }),
    index('subject_link_job_idx').on(t.jobId),
    index('subject_link_space_idx').on(t.spaceId),
    check('subject_link_role', sql`${t.role} in ('deadline', 'watch', 'handling')`),
  ],
);
