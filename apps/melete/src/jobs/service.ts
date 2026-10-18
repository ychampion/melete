import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ATTACHMENT_LIMITS,
  CONTINUABLE_STATES,
  type CreateResponsibilityRequest,
  createResponsibilityRequest,
  isRunKind,
  isTerminal,
  type JobBudget,
  type JobConstraints,
  type JobState,
  type JsonObject,
  jobBudget,
  jobConstraints,
  type MessageSpan,
  REQUEST_FRAMING_TOKENS,
  responsibilityJob,
  schedulingClass,
  type TransitionInput,
  transition,
  type WaitSpec,
  waitSpec,
} from '@melete/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { ServiceError } from '../api/errors.ts';
import { bindAttachments } from '../attachments/store.ts';
import type { Database } from '../db/client.ts';
import { databaseNow } from '../db/clock.ts';
import { attempt, job, space, trigger } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { registerJobLearning } from '../learning/episodes.ts';
import type { ObjectiveOrigin } from '../learning/provenance.ts';
import { derivedScope } from '../learning/scope.ts';
import {
  requestPrincipal,
  requireJobAccess,
  spaceAuthority,
  visibleJob,
} from '../principals/authority.ts';
import { personSetSchedule } from './attention.ts';
import { knownZone } from './local-now.ts';
import { type AttemptWake, enqueueWake } from './queue.ts';
import { releaseReminder, reminderHeld } from './reminder-hold.ts';
import type { StandingWorkSettings } from './resting.ts';
import { opensWithMention, recordSteer } from './steer.ts';
import { ENDED_STATES, withdrawEndedJobPermissions, withdrawOpenQuestion } from './withdraw.ts';

export type JobRow = typeof job.$inferSelect;

/** What makes a new job a request of a room's agent; see `createInTransaction`. */
export type RoomRequest = { principalId: string; requestedBy: string; threadId: string };

/**
 * Set by the rooms module, around one input, to the request job it has checked
 * the speaker may speak in. Input to a room's request is refused without it.
 */
export const roomRequestInput = new AsyncLocalStorage<string>();
export const DEFAULT_BUDGET: JobBudget = {
  max_turns: 20,
  max_output_tokens: 8000,
  max_wall_ms: 120000,
  max_actions: 10,
  max_attempts: 5,
  max_usd_est: 1,
};

/**
 * What one conversation turn may use. A person is waiting on the answer and
 * can stop it at any time, so nothing here is meant to be reached by real
 * work: the wall time covers a long piece of work, and the call and output
 * limits only stop a runaway loop. Spending money keeps the job default.
 */
export const CONVERSATION_BUDGET: JobBudget = {
  ...DEFAULT_BUDGET,
  max_turns: 200,
  max_output_tokens: 400_000,
  max_wall_ms: 30 * 60_000,
  max_actions: 100,
};

/**
 * The wall time of a job whose agent has a computer with background
 * processes: one two-minute command with its workspace margins, then reading
 * or stopping a process, does not fit in the default.
 */
export const PROCESS_JOB_WALL_MS = 10 * 60_000;

const BUDGET_FIELDS = Object.keys(DEFAULT_BUDGET) as (keyof JobBudget)[];

/** A conversation that still carries the job default, from before it had its own. */
function isLegacyChatBudget(budget: unknown): boolean {
  const parsed = jobBudget.safeParse(budget);
  return (
    parsed.success &&
    Object.keys(parsed.data).length === BUDGET_FIELDS.length &&
    BUDGET_FIELDS.every((field) => parsed.data[field] === DEFAULT_BUDGET[field])
  );
}

/** The longest delay a timer holds; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Why no attempt could ever run under this budget, or null when one could.
 *
 * Only limits that fail for every model and every runtime are refused. The
 * output budget has no ceiling of its own: it is spent across the job's
 * requests, and each request sets aside only its own output from its window.
 */
export function impossibleBudget(budget: JobBudget): string | null {
  if (budget.max_input_tokens !== undefined && budget.max_input_tokens <= REQUEST_FRAMING_TOKENS)
    return `max_input_tokens must be more than ${REQUEST_FRAMING_TOKENS}: every model request carries ${REQUEST_FRAMING_TOKENS} tokens of framing before any conversation.`;
  if (budget.max_wall_ms > MAX_TIMER_MS)
    return `max_wall_ms must be at most ${MAX_TIMER_MS} (about 24 days): a longer attempt timer fires at once and ends the attempt.`;
  return null;
}

export function jobView(row: JobRow) {
  return responsibilityJob.parse({
    id: row.id,
    space_id: row.spaceId,
    principal_id: row.principalId,
    requested_by: row.requestedByPrincipalId,
    title: row.title,
    objective: row.objective,
    constraints: row.constraints,
    state: row.state,
    revision: row.revision,
    lease_epoch: row.leaseEpoch,
    next_wake_at: row.nextWakeAt?.toISOString() ?? null,
    wait: row.wait,
    substrate_disposition: row.substrateDisposition,
    scheduling_class: row.schedulingClass,
    importance: row.importance,
    unread_results: row.unreadResults,
    unread_threshold: row.unreadThreshold,
    cadence_multiplier: row.cadenceMultiplier,
    attention_status: row.attentionStatus,
    visible_status: row.attentionStatus === 'normal' ? row.state : row.attentionStatus,
    deferred_questions: row.deferredQuestions,
    budget: row.budget,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    state_version: row.stateVersion,
  });
}

export type TransitionOptions = {
  attemptId?: string;
  wait?: WaitSpec;
  payload?: JsonObject;
  reason?: AttemptWake['reason'];
  bumpEpoch?: boolean;
  /** For a move back to queued: how long the next attempt waits before it may start. */
  retryAfterMs?: number;
  /**
   * The wait is one a turn had set aside, put back by itself as the turn ends
   * (`AttemptRunner.restorableWait`): a conversation's reminder cancelled from
   * another conversation comes back still held. Any other wait was chosen
   * afresh, and releases a hold on its time (`reminder-hold.ts`).
   */
  restoring?: boolean;
};

export type JobFaults = {
  /** Tests kill or throw here, after state/event writes and before enqueue. */
  afterTransitionBeforeEnqueue?: (tx: Transaction, row: JobRow) => Promise<void>;
};

export class JobService {
  onCancelled?: (id: string) => void;
  /** Called inside the transaction that cancelled a job, with its cancelled row. */
  readonly cancelledInTransaction: Array<(tx: Transaction, row: JobRow) => Promise<void>> = [];
  /** Run in the transaction of every state change, after its event; rooms release a thread's next request here. */
  readonly afterMove: ((tx: Transaction, before: JobRow, after: JobRow) => Promise<void>)[] = [];
  /** Ends a conversation's turn in flight as Stop does; see `AttemptRunner.stopTurn`. */
  stopTurn?: (tx: Transaction, row: JobRow) => Promise<boolean>;
  /** The most files one message may carry, as the operator sets it. */
  attachmentsPerMessage: number = ATTACHMENT_LIMITS.per_message;
  /** When standing work rests for someone away, and how much one person may keep, as the operator sets it. */
  standingWork: StandingWorkSettings = {};
  constructor(
    readonly db: Database,
    readonly boss: PgBoss,
    readonly faults: JobFaults = {},
  ) {}

  transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return serviceTransaction(this.db, operation);
  }

  async lock(tx: Transaction, id: string, skipLocked = false): Promise<JobRow | undefined> {
    const [row] = await tx
      .select()
      .from(job)
      .where(eq(job.id, id))
      .for('update', skipLocked ? { skipLocked: true } : {});
    if (row && requestPrincipal()) await spaceAuthority(tx, row.spaceId, requestPrincipal(), true);
    return row;
  }

  async get(id: string): Promise<JobRow> {
    return requireJobAccess(this.db, id);
  }

  async list(filters: { space_id?: string; state?: string; limit: number }): Promise<JobRow[]> {
    return this.db
      .select()
      .from(job)
      .where(
        and(
          visibleJob(job.id),
          filters.space_id ? eq(job.spaceId, filters.space_id) : undefined,
          filters.state ? eq(job.state, filters.state) : undefined,
        ),
      )
      .orderBy(desc(job.createdAt), desc(job.id))
      .limit(filters.limit);
  }

  async create(
    input: CreateResponsibilityRequest,
    objectiveOrigin?: ObjectiveOrigin,
  ): Promise<JobRow> {
    return this.transaction((tx) =>
      this.createInTransaction(tx, input, undefined, objectiveOrigin),
    );
  }

  /** Submission admission composes its receipt with the same job/wake transaction. */
  async createInTransaction(
    tx: Transaction,
    input: CreateResponsibilityRequest,
    experience?: {
      kind: 'responsibility' | 'chat' | 'plan' | 'routine' | 'milestone' | 'run' | 'run_step';
      agentId?: string;
      planId?: string;
      scheduledAt?: Date;
      dormant?: boolean;
    },
    /**
     * Whose words this objective is. Only an entry point where the person types
     * the objective passes `owner_request`; every other job, including one built
     * from a company's mail or a copy of another job's objective, is `derived`.
     */
    objectiveOrigin: ObjectiveOrigin = 'derived',
    /**
     * A request made of a room's agent: the job is the room principal's, and
     * records who asked and in which thread. Only the rooms module passes this,
     * after it has checked the person asking is in the room.
     */
    room?: RoomRequest,
  ): Promise<JobRow> {
    const value = createResponsibilityRequest.parse(input);
    const [parent] = await tx
      .select({ id: space.id })
      .from(space)
      .where(eq(space.id, value.space_id));
    if (!parent) throw new ServiceError('not_found', 'Space not found.', 404);
    const access = await spaceAuthority(
      tx,
      value.space_id,
      room ? room.principalId : requestPrincipal(),
      true,
    );
    if (room && access.role !== 'agent')
      throw new ServiceError('scope_denied', 'Space is not accessible.', 403);
    // A member's own job in a shared space is allowed on purpose: it reads what
    // the space shares (its knowledge and the procedures its people taught it)
    // for the member's own task. It acts through none of the space's
    // connections (`connectionServesJob`): the owner's serve only the owner's
    // jobs, and the room's serve only requests made of the room's agent. So
    // every effect in a shared space is either the owner's own work or a room
    // request, and both appear in the space's audit log. Guests make no jobs
    // of their own at all; they ask the room.
    const base = experience?.kind === 'chat' ? CONVERSATION_BUDGET : DEFAULT_BUDGET;
    // A job offered background processes gets the wall time to use them,
    // unless its creator named one.
    const processes =
      experience?.agentId &&
      value.budget?.max_wall_ms === undefined &&
      base.max_wall_ms < PROCESS_JOB_WALL_MS &&
      (
        await tx.execute(
          sql`select 1 from connection where space_id = ${value.space_id}
            and provider = 'sandbox' and status = 'active' and scopes ? 'process.start' limit 1`,
        )
      ).length > 0;
    const budget = jobBudget.parse({
      ...base,
      ...(processes ? { max_wall_ms: PROCESS_JOB_WALL_MS } : {}),
      ...value.budget,
    });
    const impossible = impossibleBudget(budget);
    if (impossible) throw new ServiceError('invalid_budget', impossible, 400);
    const [row] = await tx
      .insert(job)
      .values({
        id: newId('job'),
        spaceId: value.space_id,
        principalId: access.principalId,
        title: value.title,
        objective: value.objective,
        objectiveOrigin,
        constraints: jobConstraints.parse(value.constraints ?? {}),
        budget,
        nextWakeAt:
          experience && (experience.dormant || ['chat', 'plan'].includes(experience.kind))
            ? null
            : (experience?.scheduledAt ?? (await databaseNow(tx))),
        ...(experience
          ? {
              kind: experience.kind,
              agentId: experience.agentId,
              planId: experience.planId,
              ...(experience.dormant || ['chat', 'plan'].includes(experience.kind)
                ? {
                    state: 'waiting_for_input',
                    wait: { kind: 'user_input', question: 'What would you like to do next?' },
                  }
                : experience.scheduledAt
                  ? {
                      state: 'waiting_for_event_or_time',
                      wait: { kind: 'timer', wake_at: experience.scheduledAt.toISOString() },
                    }
                  : {}),
            }
          : {}),
        schedulingClass: value.scheduling_class,
        importance: value.importance,
        unreadThreshold: value.unread_threshold,
        ...(room
          ? {
              audience: 'room',
              requestedByPrincipalId: room.requestedBy,
              roomThreadId: room.threadId,
            }
          : {}),
      })
      .returning();
    if (!row) throw new Error('job insert returned no row');
    // Learning is a person's own: a room's request teaches nothing.
    if (!room && value.learning) await registerJobLearning(tx, row, value.learning);
    // A correction made on an ordinary request has to be able to teach something.
    else if (!room && row.principalId && !jobConstraints.parse(row.constraints).public_compartment)
      await registerJobLearning(tx, row, derivedScope(row.objective));
    await appendEvent(tx, {
      jobId: row.id,
      type: 'job_created',
      payload: { title: row.title },
      dedupKey: `${row.id}:created`,
    });
    await this.enqueue(tx, row, 'created');
    return row;
  }

  async enqueue(tx: Transaction, row: JobRow, reason: AttemptWake['reason']): Promise<void> {
    if (!row.nextWakeAt) return;
    await enqueueWake(
      this.boss,
      tx,
      {
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason,
      },
      row.nextWakeAt,
      schedulingClass.parse(row.schedulingClass),
    );
  }

  /** Whether a waiting job has an attempt left to wake into. */
  async attemptsLeft(tx: Transaction, row: JobRow): Promise<boolean> {
    // A run counts failed shifts in a row instead, when each shift ends.
    if (isRunKind(row.kind)) return true;
    const [used] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(attempt)
      .where(
        and(
          eq(attempt.jobId, row.id),
          ['chat', 'routine'].includes(row.kind)
            ? row.currentTurnId
              ? eq(attempt.turnId, row.currentTurnId)
              : sql`false`
            : undefined,
        ),
      );
    return Number(used?.count ?? 0) < jobBudget.parse(row.budget).max_attempts;
  }

  /** The only production write to job.state, including cancellation and recovery. */
  async move(
    tx: Transaction,
    row: JobRow,
    input: TransitionInput,
    options: TransitionOptions = {},
  ): Promise<JobRow> {
    const result = transition(row.state as JobState, input);
    if (!result.ok) throw new ServiceError(result.error.code, result.error.message);
    if (result.value === 'queued' && row.state !== 'running' && !(await this.attemptsLeft(tx, row)))
      throw new ServiceError('budget_exhausted', 'This job has used its attempt budget.');
    let wait = options.wait ?? { kind: 'none' };
    // A conversation's reminder cancelled from another conversation comes back
    // from a set-aside wait still held, resting with no wake until it is
    // turned back on. A job.wait for that time asks for it again and releases
    // the hold (`reminder-hold.ts`).
    const reminderAt =
      row.kind === 'chat' && result.value === 'waiting_for_event_or_time' && wait.kind === 'timer'
        ? wait.wake_at
        : null;
    const onHold = reminderAt !== null && (await reminderHeld(tx, row.id, reminderAt));
    if (onHold && !options.restoring)
      await releaseReminder(tx, row.id, reminderAt, options.attemptId ?? null);
    const held = onHold && options.restoring === true;
    const baseWakeAt = held
      ? null
      : result.value === 'queued'
        ? new Date((await databaseNow(tx)).getTime() + Math.max(0, options.retryAfterMs ?? 0))
        : result.value === 'waiting_for_event_or_time' && wait.kind === 'timer'
          ? new Date(wait.wake_at)
          : result.value === 'waiting_for_event_or_time' &&
              wait.kind === 'event' &&
              wait.deadline_at
            ? new Date(wait.deadline_at)
            : null;
    // Unread results slow work down by stretching its timers, except a
    // schedule the person asked for, which keeps its time.
    const nextWakeAt =
      result.value === 'waiting_for_event_or_time' &&
      wait.kind === 'timer' &&
      baseWakeAt &&
      row.cadenceMultiplier > 1 &&
      !(await personSetSchedule(tx, row))
        ? new Date(
            Date.now() + Math.max(0, baseWakeAt.getTime() - Date.now()) * row.cadenceMultiplier,
          )
        : baseWakeAt;
    // Only a job going to rest on its timer takes the stretched time. A queued
    // job that keeps a wait it has not reached yet keeps it as it was set.
    if (result.value === 'waiting_for_event_or_time' && wait.kind === 'timer' && nextWakeAt)
      wait = { ...wait, wake_at: nextWakeAt.toISOString() };
    const [updated] = await tx
      .update(job)
      .set({
        state: result.value,
        stateVersion: row.stateVersion + 1,
        leaseEpoch: row.leaseEpoch + (options.bumpEpoch || input.kind === 'cancelled' ? 1 : 0),
        wait,
        substrateDisposition:
          result.value === 'running' ? 'local_process_interrupted' : 'timer_or_event',
        nextWakeAt,
        attentionBaseWakeAt: baseWakeAt,
        updatedAt: new Date(),
      })
      .where(eq(job.id, row.id))
      .returning();
    if (!updated) throw new Error('locked job disappeared');
    await appendEvent(tx, {
      jobId: row.id,
      attemptId: options.attemptId,
      type: 'job_state_changed',
      payload: {
        from: row.state,
        to: updated.state,
        input: input.kind,
        state_version: updated.stateVersion,
        ...options.payload,
      },
      dedupKey: `${row.id}:transition:${updated.stateVersion}`,
    });
    // Nothing an ended job proposed can run, so nothing it asked may stay waiting.
    if (ENDED_STATES.includes(updated.state) && !ENDED_STATES.includes(row.state)) {
      await withdrawEndedJobPermissions(tx, row.id);
      await withdrawOpenQuestion(tx, row.id, 'responsibility_finished');
    }
    for (const hook of this.afterMove) await hook(tx, row, updated);
    await this.faults.afterTransitionBeforeEnqueue?.(tx, updated);
    await this.enqueue(tx, updated, options.reason ?? 'recovery');
    return updated;
  }

  async input(id: string, text: string, pasted?: readonly MessageSpan[]): Promise<JobRow> {
    return this.transaction((tx) => this.inputInTransaction(tx, id, text, undefined, [], pasted));
  }

  async inputInTransaction(
    tx: Transaction,
    id: string,
    text: string,
    /** The answer the person marked this message as correcting, recorded as they sent it. */
    corrects?: string,
    /** Files the person uploaded for this message; each must be theirs and unsent. */
    attachments: readonly string[] = [],
    /** Stretches of `text` the person pasted rather than typed, as their composer saw them. */
    pasted: readonly MessageSpan[] = [],
    /** The zone the sender's device reported; time is read in it until the profile's is confirmed. */
    clientTimeZone?: string,
  ): Promise<JobRow> {
    const deviceZone = knownZone(clientTimeZone);
    const row = await this.lock(tx, id);
    if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
    // Words in a job are its own principal's. Membership of the job's space lets
    // a person work there, not speak in somebody else's job, and whatever reads
    // this message later takes it as said by the principal it records.
    const speaker = requestPrincipal();
    if (row.audience === 'room') {
      // A room's request is the room's job, and only the person who asked it
      // speaks in it, through the room's own routes and while still in the room.
      // Every other path reaches this refusal.
      if (
        !speaker ||
        roomRequestInput.getStore() !== id ||
        speaker !== row.requestedByPrincipalId ||
        (await spaceAuthority(tx, row.spaceId, speaker, true)).role === 'agent'
      )
        throw new ServiceError('scope_denied', 'Job is not accessible.', 403);
    } else if (speaker) await requireJobAccess(tx, id, speaker);
    if (row.kind === 'chat' && (row.state === 'running' || row.state === 'queued' || row.paused))
      throw new ServiceError('turn_in_progress', 'Wait for this turn to finish.', 409);
    // A conversation goes on after a turn that failed, finished or left an
    // effect to reconcile. A turn the broker parked may still have its attempt
    // open, and that turn is still in progress.
    const continuing =
      row.kind === 'chat' && (CONTINUABLE_STATES as readonly string[]).includes(row.state);
    if (continuing) {
      const [open] = await tx
        .select({ id: attempt.id })
        .from(attempt)
        .where(and(eq(attempt.jobId, row.id), isNull(attempt.endedAt)))
        .limit(1);
      if (open) throw new ServiceError('turn_in_progress', 'Wait for this turn to finish.', 409);
    }
    // A new conversation turn has its own attempt allowance. Earlier receipts remain durable.
    if (row.kind === 'chat') {
      row.currentTurnId = null;
      // A conversation started before conversations had their own limits still
      // carries the job default; its next turn gets the conversation's.
      if (isLegacyChatBudget(row.budget)) {
        await tx.update(job).set({ budget: CONVERSATION_BUDGET }).where(eq(job.id, row.id));
        row.budget = CONVERSATION_BUDGET;
      }
    }
    // Checked before anything moves: a file that is not the speaker's refuses the message.
    const files = attachments.length
      ? await bindAttachments(tx, {
          jobId: id,
          spaceId: row.spaceId,
          principalId: speaker ?? null,
          ids: attachments,
          perMessage: this.attachmentsPerMessage,
        })
      : [];
    if (!text && !files.length)
      throw new ServiceError('invalid_request', 'A message needs words or a file.', 400);
    // A conversation resting until a reminder is due answers the message now and
    // keeps the reminder: the queued row carries the wait, so the reply is told
    // it was set aside and the runner puts it back when the reply is done.
    const kept =
      continuing && row.state === 'waiting_for_event_or_time'
        ? waitSpec.parse(row.wait)
        : undefined;
    const updated = await this.move(
      tx,
      row,
      { kind: continuing ? 'conversation_continued' : 'user_input_received' },
      { reason: 'input', ...(kept ? { wait: kept } : {}) },
    );
    await appendEvent(tx, {
      jobId: id,
      type: 'notice',
      payload: {
        kind: 'user_message',
        text,
        principal_id: speaker ?? row.principalId ?? null,
        ...(corrects ? { corrects } : {}),
        ...(files.length ? { attachments: files } : {}),
        ...(pasted.length ? { pasted: pasted.map(({ start, end }) => ({ start, end })) } : {}),
        ...(deviceZone ? { client_time_zone: deviceZone } : {}),
      },
      dedupKey: `${id}:input:${updated.stateVersion}`,
    });
    return updated;
  }

  /**
   * Words for a conversation's turn that is still running: recorded at once,
   * shown at once, and delivered to that turn (`steer.ts`). Null when no turn
   * is running, so the words go as an ordinary next message instead. A paused
   * turn and a room's request are not steered.
   */
  async steer(
    id: string,
    input: { id: string; text: string; clientTimeZone?: string | undefined },
  ): Promise<{ row: JobRow; steer: { id: string; seq: number; at: Date } } | null> {
    return this.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      return this.steerWithin(tx, row, input);
    });
  }

  /** `steer`, for a job the caller has locked, inside the caller's transaction. */
  async steerWithin(
    tx: Transaction,
    row: JobRow,
    input: { id: string; text: string; clientTimeZone?: string | undefined },
  ): Promise<{ row: JobRow; steer: { id: string; seq: number; at: Date } } | null> {
    if (row.kind !== 'chat' || row.audience === 'room' || row.paused || !input.text.trim())
      return null;
    if (opensWithMention(input.text)) return null;
    const speaker = requestPrincipal();
    if (speaker) await requireJobAccess(tx, row.id, speaker);
    // Only a turn that is running or about to: a conversation the broker
    // parked refuses new words until it is settled.
    if (row.state !== 'running' && row.state !== 'queued') return null;
    const steer = await recordSteer(tx, row, {
      id: input.id,
      text: input.text,
      principalId: speaker ?? row.principalId ?? null,
      clientTimeZone: knownZone(input.clientTimeZone),
    });
    return { row, steer };
  }

  async cancel(id: string, reason?: string): Promise<JobRow> {
    const cancelled = await this.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      return this.cancelInTransaction(tx, row, reason);
    });
    // The fence commits before a potentially slow runtime is signalled.
    this.onCancelled?.(id);
    return cancelled;
  }

  /**
   * Cancel a job the caller has locked, inside the caller's transaction. The
   * caller signals `onCancelled` once the transaction commits. A conversation
   * mid-turn has its turn stopped; with `end`, the conversation then ends too.
   */
  async cancelInTransaction(
    tx: Transaction,
    locked: JobRow,
    reason?: string,
    options: { end?: boolean } = {},
  ): Promise<JobRow> {
    let row = locked;
    const id = row.id;
    // Cancelling a conversation mid-turn ends that turn the way Stop does, so
    // the conversation settles and takes the next message. Ending the job
    // instead left the turn working and every new message refused.
    if (row.kind === 'chat' && (await this.stopTurn?.(tx, row))) {
      const [stopped] = await tx.select().from(job).where(eq(job.id, id));
      if (!stopped) throw new Error('locked job disappeared');
      if (!options.end || isTerminal(stopped.state as JobState)) return stopped;
      row = stopped;
    }
    const updated = await this.move(
      tx,
      row,
      { kind: 'cancelled' },
      { payload: { reason: reason ?? null } },
    );
    for (const handler of this.cancelledInTransaction) await handler(tx, updated);
    const interrupted = await tx
      .update(attempt)
      .set({
        outcome: 'fenced',
        outcomeDetail: { kind: 'cancelled', reason: reason ?? null },
        endedAt: new Date(),
        leaseExpiresAt: null,
        leaseStatus: 'ended',
      })
      .where(and(eq(attempt.jobId, id), isNull(attempt.endedAt)))
      .returning({ id: attempt.id });
    for (const execution of interrupted)
      await appendEvent(tx, {
        jobId: id,
        attemptId: execution.id,
        type: 'attempt_ended',
        payload: { kind: 'cancelled', reason: reason ?? null },
        dedupKey: `${execution.id}:ended`,
      });
    return updated;
  }

  /** Objective edits invalidate approval bindings even if the state is unchanged. */
  async revise(
    id: string,
    changes: { objective?: string; constraints?: JobConstraints },
  ): Promise<JobRow> {
    return this.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      const constraints = changes.constraints
        ? jobConstraints.parse(changes.constraints)
        : row.constraints;
      const objective = changes.objective ?? row.objective;
      if (!objective.trim())
        throw new ServiceError('invalid_request', 'Objective cannot be empty.', 400);
      if (
        objective === row.objective &&
        JSON.stringify(constraints) === JSON.stringify(row.constraints)
      )
        return row;
      const [updated] = await tx
        .update(job)
        .set({ objective, constraints, revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(job.id, id))
        .returning();
      if (!updated) throw new Error('locked job disappeared');
      await appendEvent(tx, {
        jobId: id,
        type: 'notice',
        payload: { kind: 'job_revised', revision: updated.revision },
        dedupKey: `${id}:revision:${updated.revision}`,
      });
      return updated;
    });
  }
}

/**
 * Where a routine goes when a run is over, finished or failed: back to waiting
 * for its own schedule, paused or not. One bad run does not end a routine.
 * Null for any other job, or a routine whose schedule was deleted.
 */
export async function routineRest(
  tx: Transaction,
  row: JobRow,
): Promise<Extract<WaitSpec, { kind: 'event' }> | null> {
  if (row.kind !== 'routine') return null;
  const [schedule] = await tx
    .select({ id: trigger.id })
    .from(trigger)
    .where(and(eq(trigger.jobId, row.id), eq(trigger.kind, 'schedule')))
    .limit(1);
  return schedule ? { kind: 'event', trigger_id: schedule.id, deadline_at: null } : null;
}
