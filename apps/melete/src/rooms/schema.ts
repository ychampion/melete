/**
 * A room is a shared space where several people talk to one agent in threads.
 * The space, its members and its generations live in the main schema; these
 * tables hold what is said in the room.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { connection, job, principal, space, trigger } from '../db/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const roomThread = pgTable(
  'room_thread',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => principal.id),
    createdAt: created(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('room_thread_space_idx').on(t.spaceId, t.lastActivityAt)],
);

/**
 * The room's transcript: every person's message, with its author. The agent's
 * answers are not copied here; they are read from the request jobs.
 */
export const roomMessage = pgTable(
  'room_message',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => roomThread.id, { onDelete: 'cascade' }),
    authorPrincipalId: text('author_principal_id')
      .notNull()
      .references(() => principal.id),
    kind: text('kind').notNull().default('person'),
    /** Posted for a person by their own agent, after they approved the exact text. */
    viaAgent: boolean('via_agent').notNull().default(false),
    text: text('text').notNull(),
    /** Who the message named, in the order it named them. */
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    /**
     * `none`: conversation between people. `pending`: it asks the agent and waits
     * its turn in the thread. `started`: it reached a request job.
     */
    requestState: text('request_state').notNull().default('none'),
    requestJobId: text('request_job_id').references(() => job.id, { onDelete: 'set null' }),
    submissionId: text('submission_id').notNull().unique(),
    /**
     * The sequence number of the newest event about this message, so a thread's
     * live stream sends it again, in commit order, whenever it changes.
     */
    streamSeq: bigint('stream_seq', { mode: 'number' }).notNull().default(0),
    /** Where the message was written: `web`, or the chat platform it came from. */
    surface: text('surface').notNull().default('web'),
    /** The platform's own id for the message, so its replies can thread under it. */
    externalRef: text('external_ref'),
    createdAt: created(),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
  },
  (t) => [
    index('room_message_thread_idx').on(t.threadId, t.createdAt),
    index('room_message_stream_idx').on(t.threadId, t.streamSeq),
    index('room_message_pending_idx')
      .on(t.spaceId, t.requestState)
      .where(sql`${t.requestState} = 'pending'`),
    check('room_message_kind', sql`${t.kind} in ('person', 'handoff_result', 'system')`),
    check('room_message_request_state', sql`${t.requestState} in ('none', 'pending', 'started')`),
    check(
      'room_message_external_ref',
      sql`${t.externalRef} is null or length(${t.externalRef}) between 1 and 200`,
    ),
  ],
);

/**
 * How a room works, set by its owners. A room without a row works by the
 * defaults: the person who asked decides their request's permissions, the
 * agent answers when asked, guests may ask, and asks are limited per hour.
 */
export const roomPolicy = pgTable(
  'room_policy',
  {
    spaceId: text('space_id')
      .primaryKey()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** Who decides a request's permissions: `requester`, `any_member` or `owners`. */
    approvers: text('approvers').notNull().default('requester'),
    /** `asked`: the agent answers when asked. `every_message`: every message asks it. */
    agentTurns: text('agent_turns').notNull().default('asked'),
    guestsMayAsk: boolean('guests_may_ask').notNull().default(true),
    requestsPerHour: integer('requests_per_hour').notNull().default(30),
    requestsPerPersonHour: integer('requests_per_person_hour').notNull().default(10),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by').references(() => principal.id, { onDelete: 'set null' }),
  },
  (t) => [
    check('room_policy_approvers', sql`${t.approvers} in ('requester', 'any_member', 'owners')`),
    check('room_policy_agent_turns', sql`${t.agentTurns} in ('asked', 'every_message')`),
    check(
      'room_policy_limits',
      sql`${t.requestsPerHour} between 1 and 1000 and ${t.requestsPerPersonHour} between 1 and ${t.requestsPerHour}`,
    ),
  ],
);

/** Who is looking at a room now. Display only: it never decides what anyone may read. */
export const roomPresence = pgTable(
  'room_presence',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.principalId] })],
);

/**
 * An invitation for a guest to join one room. Only the SHA-256 of its token is
 * kept; the token itself is shown once, to the owner who made it. It works
 * once, until `expires_at`, which is also when the guest's place in the room
 * ends.
 */
export const roomInvite = pgTable(
  'room_invite',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('guest'),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => principal.id),
    createdAt: created(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    /** The account that accepted it. */
    principalId: text('principal_id').references(() => principal.id),
    /** An owner took it back before it was used. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (t) => [
    check('room_invite_role', sql`${t.role} in ('guest')`),
    index('room_invite_space_idx').on(t.spaceId, t.createdAt),
  ],
);

/**
 * Work a room's agent asked one person to run with their own setup. The task
 * is stored whole and runs verbatim once they accept it; the result reaches
 * the room only after they approve that exact text.
 */
export const roomHandoff = pgTable(
  'room_handoff',
  {
    id: text('id').primaryKey(),
    /** The room's space. */
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** The room's request that asked for it. */
    roomJobId: text('room_job_id').references(() => job.id, { onDelete: 'set null' }),
    /** The turn of that request that asked: stopping it withdraws the handoff. */
    roomTurnId: text('room_turn_id'),
    threadId: text('thread_id')
      .notNull()
      .references(() => roomThread.id, { onDelete: 'cascade' }),
    /** The action that asked; one handoff per action, however often it is sent. */
    actionId: text('action_id').notNull().unique(),
    /** The room's own connection the outcome is delivered through. */
    connectionId: text('connection_id').references(() => connection.id, { onDelete: 'set null' }),
    /** What the room's request waits on to hear the outcome. */
    triggerId: text('trigger_id').references(() => trigger.id, { onDelete: 'set null' }),
    targetPrincipalId: text('target_principal_id')
      .notNull()
      .references(() => principal.id),
    taskText: text('task_text').notNull(),
    taskHash: text('task_hash').notNull(),
    state: text('state').notNull().default('pending'),
    /** The work it started in the person's own space. */
    personalJobId: text('personal_job_id').references(() => job.id, { onDelete: 'set null' }),
    resultText: text('result_text'),
    resultHash: text('result_hash'),
    createdAt: created(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('room_handoff_target_idx').on(t.targetPrincipalId, t.createdAt),
    index('room_handoff_personal_job_idx').on(t.personalJobId),
    index('room_handoff_room_idx').on(t.spaceId),
    index('room_handoff_due_idx').on(t.state, t.expiresAt),
    check(
      'room_handoff_state',
      sql`${t.state} in ('pending', 'accepted', 'declined', 'running', 'settled', 'shared', 'kept', 'expired')`,
    ),
  ],
);

/**
 * An account on a chat platform, linked to the person it belongs to here. A
 * platform's message or button press counts only through one of these links:
 * an account with no link is refused, and never becomes a guest. A link is made
 * once the platform has proved who holds the account and the person, signed in
 * here, has said it is theirs.
 */
export const principalIdentity = pgTable(
  'principal_identity',
  {
    /** The platform, as its surface names itself. `web` is never one: the web signs people in itself. */
    provider: text('provider').notNull(),
    /** The platform's own id for the account, never its display name. */
    externalId: text('external_id').notNull(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.externalId] }),
    index('principal_identity_principal_idx').on(t.principalId),
    check(
      'principal_identity_provider',
      sql`${t.provider} ~ '^[a-z][a-z0-9_-]{0,31}$' and ${t.provider} <> 'web'`,
    ),
    check('principal_identity_external_id', sql`length(${t.externalId}) between 1 and 200`),
  ],
);
