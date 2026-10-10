/**
 * Remote sandbox sessions and the commands run in them.
 *
 * A session row exists before its sandbox does: it is written as `opening`
 * with a placeholder provider id, so one live session per attempt and one live
 * workspace per space and agent are decided by Postgres before anything is
 * created. `sandbox_command` is keyed by the action, so the same action can be
 * dispatched into a sandbox only once; a second dispatch finds the row and
 * reattaches instead.
 *
 * A persistent workspace is a chain of rows for one space and agent, one row
 * per lease. Suspending ends a row as `paused` with its `resume_ref`; the next
 * attempt's row takes that reference over and the paused row is closed, so a
 * paused sandbox can appear on a closed row and on the live row after it. For
 * a `paused` row, `lease_expires_at` is when it was suspended: its lease ended
 * then, and retention counts from it.
 *
 * A `ready` workspace is held either by the attempt that opened it or, once
 * that attempt has ended, by the background processes still running in it
 * (`held_by = 'processes'`, `attempt_id` null). Held by processes, it is kept
 * running until they end, and the next attempt for the agent takes it over.
 */

import type { ProcessState } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { action, agent, attempt, connection, job, principal, space } from '../db/schema.ts';
import type { SessionPersistence } from './manifest.ts';
import type { EgressPolicy } from './types.ts';

export type SessionStatus = 'opening' | 'ready' | 'paused' | 'closing' | 'closed' | 'lost';
/** What keeps a ready session: its attempt, or the processes left running after it. */
export type SessionHolder = 'attempt' | 'processes';

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
    /** Null on rows written before processes could hold a computer: the attempt. */
    heldBy: text('held_by').$type<SessionHolder>(),
  },
  (t) => [
    uniqueIndex('sandbox_session_provider_idx')
      .on(t.adapter, t.providerSandboxId)
      .where(sql`${t.status} not in ('closed', 'lost')`),
    uniqueIndex('sandbox_session_attempt_idx')
      .on(t.attemptId)
      .where(sql`${t.attemptId} is not null and ${t.status} not in ('closed', 'lost')`),
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
    check(
      'sandbox_session_held_by_check',
      sql`${t.heldBy} is null or ${t.heldBy} in ('attempt', 'processes')`,
    ),
  ],
);

/**
 * The displays of a computer: each chat, and each background run, works on a
 * screen of its own in the same container, with its own browser, while the
 * files in `/work` and the person's sign-ins are the computer's. A display is
 * keyed by the computer (`provider_sandbox_id`) and a number; display 0 is the
 * screen the container starts with, and its control key is the computer's own
 * id, as before displays. `owner_job_id` is the chat or run it belongs to, so
 * every turn of a chat comes back to the same page; `attempt_id` is the
 * attempt using it now, and empties when that attempt ends. A display is ended
 * (`ended_at`) when its chat or run ends, when it has gone unused for a while,
 * when the chat is stopped, or with its computer.
 */
export const sandboxDisplay = pgTable(
  'sandbox_display',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id').notNull(),
    adapter: text('adapter').notNull(),
    providerSandboxId: text('provider_sandbox_id').notNull(),
    display: integer('display').notNull(),
    ownerJobId: text('owner_job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    attemptId: text('attempt_id').references(() => attempt.id, { onDelete: 'set null' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
  },
  (t) => [
    uniqueIndex('sandbox_display_number_idx')
      .on(t.providerSandboxId, t.display)
      .where(sql`${t.endedAt} is null`),
    uniqueIndex('sandbox_display_owner_idx')
      .on(t.providerSandboxId, t.ownerJobId)
      .where(sql`${t.endedAt} is null`),
    index('sandbox_display_attempt_idx').on(t.attemptId).where(sql`${t.endedAt} is null`),
    check('sandbox_display_number_check', sql`${t.display} >= 0 and ${t.display} < 64`),
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

/**
 * A background process in an agent's computer. It belongs to the computer,
 * which is the space and agent, and is attributed to the job and action that
 * started it; any job that may use that computer may list, read, write to and
 * stop it. The action is unique, so one admitted start is one process however
 * often it is dispatched. The output itself stays in the computer, in a ring;
 * the row keeps the cursor, the last line and the end.
 */
export const sandboxProcess = pgTable(
  'sandbox_process',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sandboxSession.id, { onDelete: 'set null' }),
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    actionId: text('action_id').references(() => action.id, { onDelete: 'set null' }),
    commandRedacted: text('command_redacted').notNull(),
    commandDigest: text('command_digest').notNull(),
    cwd: text('cwd').notNull(),
    name: text('name').notNull(),
    port: integer('port'),
    state: text('state').$type<ProcessState>().notNull(),
    exitCode: integer('exit_code'),
    signal: text('signal'),
    bootId: text('boot_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    outputCursor: bigint('output_cursor', { mode: 'number' }).notNull().default(0),
    outputBytes: bigint('output_bytes', { mode: 'number' }).notNull().default(0),
    lastLine: text('last_line'),
    lastOutputAt: timestamp('last_output_at', { withTimezone: true }),
    notify: jsonb('notify'),
    triggerId: text('trigger_id'),
    endReason: text('end_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sandbox_process_action_idx').on(t.actionId),
    index('sandbox_process_computer_idx').on(t.spaceId, t.agentId, t.state),
    index('sandbox_process_live_idx')
      .on(t.state, t.expiresAt)
      .where(sql`${t.state} in ('starting', 'running')`),
    check(
      'sandbox_process_state_check',
      sql`${t.state} in ('starting', 'running', 'exited', 'stopped', 'expired', 'lost')`,
    ),
  ],
);

/**
 * How long each day a space's computers were kept running by their processes
 * alone, after the attempts that used them ended: the time metered onto
 * sessions while `held_by = 'processes'`, in seconds, by UTC day. Every
 * provider counts, so the daily allowance is one number per space.
 */
export const sandboxAwakeDay = pgTable(
  'sandbox_awake_day',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    seconds: doublePrecision('seconds').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.day] })],
);

/**
 * Who drives each sandbox computer: the agent, or the person who took it
 * over. Keyed by the computer rather than a session, because a workspace
 * resumed by the next attempt is the same computer on a new row. Every change
 * moves `epoch` on and is made only from the epoch it was read at, so two
 * service instances never both take a computer over, and an action planned
 * under an older epoch can be told apart. Kept across restarts: a computer a
 * person holds stays theirs until they hand it back. No row means the agent,
 * at epoch 0. A hold whose live view has not been open for 30 minutes is
 * handed back by the sweep.
 */
export const sandboxControl = pgTable(
  'sandbox_control',
  {
    providerSandboxId: text('provider_sandbox_id').primaryKey(),
    control: text('control').$type<'agent' | 'human'>().notNull(),
    epoch: integer('epoch').notNull(),
    /** The person holding it, while `control` is `human`. */
    principalId: text('principal_id').references(() => principal.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the holder's live view was last open; a hold with no view for long is handed back. */
    seenAt: timestamp('seen_at', { withTimezone: true }),
  },
  (t) => [check('sandbox_control_control_check', sql`${t.control} in ('agent', 'human')`)],
);

/**
 * Who wrote each file in a persistent computer's `/work`, so deleting a chat
 * can take the files it made there and leave the rest. `/work` is one folder
 * for every chat of the agent in the space, so a file is recorded against the
 * computer (space, agent and connection), as it was found when a command's
 * changes were read back: its content hash and the chats that wrote it.
 * `shared` is set when anyone else also wrote it, or when who wrote it cannot
 * be shown (it was there before records were kept, it came back from a chat's
 * own copy, or another chat, a background process or the person was at work
 * on the computer meanwhile). Only a file one chat alone wrote, not shared,
 * goes when that chat is deleted. The writers are kept after their chats go.
 */
export const sandboxWorkFile = pgTable(
  'sandbox_work_file',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    /** Under `/work`, as a portable relative path. */
    path: text('path').notNull(),
    /** The sha256 of its content when last read back; null when it was never read. */
    hash: text('hash'),
    writers: text('writers').array().notNull().default(sql`'{}'::text[]`),
    shared: boolean('shared').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.agentId, t.connectionId, t.path] })],
);

/**
 * When a persistent computer's `/work` was last read back and recorded. A
 * change found later is the reading chat's only when nothing else could have
 * made it since; with no row, records start from a listing of what is there.
 */
export const sandboxWorkRead = pgTable(
  'sandbox_work_read',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.agentId, t.connectionId] })],
);

/**
 * Files a deleted chat alone made in a computer's `/work`, waiting to be
 * removed there. A running computer is cleaned by the sweep; a stopped one
 * when it next starts, never started for this. Each is removed only while it
 * is still a regular file inside `/work` with the content recorded.
 */
export const sandboxWorkRemoval = pgTable(
  'sandbox_work_removal',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    /** The deleted chat; the job row is gone, so no key. */
    jobId: text('job_id').notNull(),
    path: text('path').notNull(),
    hash: text('hash').notNull(),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sandbox_work_removal_computer_idx').on(t.spaceId, t.agentId, t.connectionId)],
);
