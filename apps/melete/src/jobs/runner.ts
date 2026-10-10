import {
  type AttemptOutcome,
  attemptOutcome,
  attemptUsage,
  type CapabilityClaims,
  type CommittedOutcome,
  type ContextAwareRuntimeAdapter,
  type ContextInvalidated,
  dedupKey,
  inputTokenCeiling,
  intentScopes,
  isOutcomeEnvelope,
  isRunKind,
  isTerminal,
  type JobState,
  type JsonObject,
  jobBudget,
  type QuestioningRuntimeAdapter,
  type QuestionSpec,
  questionSpec,
  type ResponsibilityAttemptBundle,
  type RuntimeAdapter,
  type RuntimeEvent,
  responsibilityAttemptOutcome,
  runScopes,
  runtimeEvent,
  type SchedulingClass,
  type TransitionInput,
  unavailable,
  type WaitSpec,
  waitSpec,
} from '@melete/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { ArtifactRoots } from '../artifact/content.ts';
import { personQuestionKey } from '../broker/ask-person.ts';
import { databaseNow } from '../db/clock.ts';
import {
  action,
  attempt,
  budgetLedger,
  event,
  experienceTurn,
  job,
  question,
  trigger,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { checkCitations, sourcesRead } from '../experience/citations.ts';
import { withDeliveryNote } from '../experience/delivery-claims.ts';
import { STOPPED_NOTE } from '../experience/projectors.ts';
import { withdrawPendingPermissions } from '../experience/service.ts';
import { pagesVisited, withVisitedLinks } from '../experience/visited-links.ts';
import { stopModelCalls } from '../gateway/inflight.ts';
import type { LimitReached } from '../gateway/spending.ts';
import type { UsageClass } from '../gateway/usage-class.ts';
import { newId } from '../ids.ts';
import { captureAttemptVersions, captureCompletedEpisode } from '../learning/episodes.ts';
import { spaceAuthority } from '../principals/authority.ts';
import type { RunService } from '../runs/service.ts';
import { browserEventForPersistence, isBrowserTool } from '../workers/browser/privacy.ts';
import { type AnswerJoin, answerJoin } from './answer-join.ts';
import { type AttemptResult, attemptResult } from './attention.ts';
import { buildAttemptSkeleton, completionFacts } from './bundle.ts';
import { CAPABILITY_TTL_SECONDS, signCapability } from './capability.ts';
import { FairScheduler } from './fair-scheduler.ts';
import { requireCurrentAttempt } from './fence.ts';
import { readGenerations, requireGenerations } from './generations.ts';
import { LIMIT_REACHED_NOTE } from './limits.ts';
import { persistQuestions, resolveQuestions } from './questions.ts';
import {
  ATTEMPT_QUEUES,
  type AttemptWake,
  attemptQueue,
  QUEUES,
  RECOVERY_SCAN_SECONDS,
} from './queue.ts';
import { connectionScopesForJob } from './scopes.ts';
import { type JobRow, type JobService, routineRest } from './service.ts';
import { SKILL_TRACE_KIND, skillTraceCall } from './skill-trace.ts';
import { UNCONFIRMED_NOTE, unsettledQuestion } from './unsettled.ts';
import {
  attemptCause,
  emptyWakes,
  guardPauses,
  pauseForWakes,
  tellOnce,
  usageClassOf,
  WAKE_GUARD_LIMIT,
  WAKE_GUARD_QUESTION,
} from './wake-guard.ts';
import { withdrawOpenQuestion, withdrawOutdatedPermissions } from './withdraw.ts';

export const HEARTBEAT_MS = 15_000;
export const LEASE_MS = 45_000;
/** What a conversation's turn ends with when its work was cut off and could not be resumed. */
export const LOST_NOTE =
  'This was interrupted before it could finish, for example because Melete restarted while it was working. Nothing more will happen here until you send another message.';

/** How many attempts run at once unless the service is told otherwise. */
export const DEFAULT_ATTEMPT_CONCURRENCY = 4;

export type RunnerOptions = {
  key: string;
  provider?: string;
  model?: string;
  /**
   * The model a new attempt runs on, read when it is claimed, so a model the
   * owner chooses in the app applies from the next attempt without a restart.
   * Left out, `provider` and `model` decide. It is given the job, whose
   * person may have moved scheduled work to their secondary model.
   */
  resolveModel?: (
    tx: Transaction,
    row: JobRow,
    usageClass: UsageClass,
  ) => Promise<{ provider: string; model: string; vision?: boolean }>;
  scopes?: string[];
  liveConnectionScopes?: boolean;
  scopesForJob?: (tx: Transaction, row: JobRow) => Promise<string[]>;
  /** How many attempts run at once; one more waits for a free slot. */
  concurrency?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  artifactRoots?: ArtifactRoots;
  loadCatalog?: (
    tx: Transaction,
    claims: CapabilityClaims,
    bundle: ResponsibilityAttemptBundle,
  ) => Promise<
    Pick<ResponsibilityAttemptBundle, 'tools' | 'skills' | 'skill_index' | 'connected_accounts'>
  >;
  /**
   * How long a finished attempt waits for an action it dispatched to report
   * back before its outcome is committed. Past it the turn rests with its
   * answer instead of running again.
   */
  dispatchWaitMs?: number;
  /**
   * The sentence for a spending limit this job's person has reached, or null.
   * An attempt is not started past it, and one that ends while it holds ends
   * with that sentence rather than as a failure to retry. A background
   * attempt is also held to the person's background limits; an interactive
   * one never is.
   */
  spendingLimit?: (jobId: string, usageClass: UsageClass) => Promise<LimitReached | null>;
};

/**
 * Past the broker's longest dispatch budget and its recovery sweep, so every
 * dispatch that still has a sender has settled by then.
 */
export const DISPATCH_WAIT_MS = 16 * 60_000;

/** The question a turn rests on when something it started has not reported back. */
export const STILL_RUNNING_NOTE =
  'Something this turn started has not reported back yet. Its result will show here once it does, so nothing was run again.';
export type ClaimedAttempt = { bundle: ResponsibilityAttemptBundle; claims: CapabilityClaims };
/** What the attempt raised besides its outcome, handed to every finish handler. */
export type OutcomeContext = {
  questions: readonly QuestionSpec[];
  result: AttemptResult | null;
};

class AttemptBudgetExceeded extends Error {}

/** An adapter invocation is disposable; every decision around it is a short database transaction. */
export class AttemptRunner {
  private readonly active = new Map<
    string,
    { jobId: string; attemptId: string; controller: AbortController; done: Promise<void> }
  >();
  /** Runtime calls that have not returned yet, by attempt. */
  private readonly running = new Map<string, { jobId: string; returned: Promise<void> }>();
  /** Attempts whose answer text has started, so only the first piece is joined. */
  private readonly answering = new Set<string>();
  private workerStarted = false;
  private stopping = false;
  scheduler: FairScheduler;
  private readonly wakes = new Set<Promise<void>>();
  /** Wait registration is supplied by the trigger service, inside the outcome transaction. */
  onWait?: (tx: Transaction, row: JobRow) => Promise<JobRow>;
  onApprovalWait?: (tx: Transaction, row: JobRow) => Promise<JobRow>;
  afterRecovery?: () => Promise<void>;
  /** Long work: decides between shifts what a run's ended attempt stands for. */
  runs?: RunService;
  /**
   * Called once an attempt this process ran has ended, however it ended:
   * finished, stopped, fenced, lost or cut short by shutdown. Outside any
   * transaction; a handler must not throw.
   */
  readonly onSettled: Array<(attemptId: string) => void> = [];
  /**
   * Told the job of each conversation turn a person stopped, after the stop
   * has committed, so what that turn started outside the runner can be ended
   * too. Called outside any transaction; a handler must not throw.
   */
  readonly onStopped: Array<(jobId: string) => void> = [];
  /**
   * Settles what an ended attempt left dispatched with nobody waiting on it,
   * where the broker runs in this process. Elsewhere the broker's own
   * recovery does it, and the wait below sees the result.
   */
  settleAbandoned?: (attemptId: string) => Promise<unknown>;
  readonly onFinished: Array<
    (
      tx: Transaction,
      row: JobRow,
      outcome: AttemptOutcome,
      attemptId: string,
      context: OutcomeContext,
    ) => Promise<void>
  > = [];

  constructor(
    readonly jobs: JobService,
    readonly runtime: RuntimeAdapter | QuestioningRuntimeAdapter,
    readonly options: RunnerOptions,
  ) {
    if (Buffer.byteLength(options.key) < 32)
      throw new Error('MELETE_CAPABILITY_KEY must be at least 32 bytes');
    this.scheduler = new FairScheduler(this.concurrency);
    jobs.onCancelled = (id) => this.interrupt(id);
    jobs.stopTurn = (tx, row) => this.stopTurn(tx, row);
  }

  private get concurrency() {
    return this.options.concurrency ?? DEFAULT_ATTEMPT_CONCURRENCY;
  }

  private get leaseMs() {
    return this.options.leaseMs ?? LEASE_MS;
  }

  async claim(wake: AttemptWake): Promise<ClaimedAttempt | null> {
    const capabilities = await this.runtime.capabilities();
    return this.jobs.transaction(async (tx) => {
      let row = await this.jobs.lock(tx, wake.job_id, true);
      // pg-boss delivers a wake by the database clock; judge it by the same
      // clock. A process clock a few milliseconds behind Postgres would otherwise
      // call every on-time wake early and drop it until the recovery scan.
      if (
        !row ||
        row.paused ||
        row.kind === 'command' ||
        row.leaseEpoch !== wake.expected_epoch ||
        row.stateVersion !== wake.expected_version ||
        !row.nextWakeAt ||
        row.nextWakeAt.getTime() > (await databaseNow(tx)).getTime()
      )
        return null;
      if (row.state === 'waiting_for_event_or_time') {
        row = await this.jobs.move(tx, row, { kind: 'timer_fired' }, { reason: 'timer' });
      }
      if (row.state !== 'queued') return null;
      const [previous] = await tx
        .select()
        .from(attempt)
        .where(eq(attempt.jobId, row.id))
        .orderBy(desc(attempt.epoch))
        .limit(1);
      const cause = await attemptCause(tx, row, previous, previous?.inputCursor ?? 0);
      // Work that keeps waking with nothing to show is stopped before this
      // wake does anything, and the person is told once: a run or a routine
      // is paused here; anything else asks the person, below.
      const guarded =
        cause.usageClass === 'background' && (await emptyWakes(tx, row.id)) >= WAKE_GUARD_LIMIT;
      if (guarded && guardPauses(row.kind)) {
        await pauseForWakes(tx, row);
        return null;
      }
      // A question left from before the request changed is closed first, so
      // this attempt is told it was withdrawn rather than that it is pending.
      await withdrawOutdatedPermissions(tx, row.id);
      const access = await spaceAuthority(tx, row.spaceId, row.principalId, true);
      const chosen: { provider: string; model: string; vision?: boolean } =
        (await this.options.resolveModel?.(tx, row, cause.usageClass)) ?? {
          provider: this.options.provider ?? 'stub',
          model: this.options.model ?? 'script',
        };
      const model = {
        provider: chosen.provider,
        model: chosen.model,
        fallback: null,
        ...(typeof chosen.vision === 'boolean' ? { vision: chosen.vision } : {}),
      };
      const budget = jobBudget.parse(row.budget);
      const [latest] = await tx
        .select({ seq: sql<number>`coalesce(max(${event.seq}), 0)::bigint` })
        .from(event)
        .where(eq(event.jobId, row.id));
      const attemptId = newId('att');
      const epoch = row.leaseEpoch + 1;
      const claims: CapabilityClaims = {
        ...(access.principalId
          ? { principal_id: access.principalId, membership_generation: access.generation }
          : {}),
        job_id: row.id,
        attempt_id: attemptId,
        space_id: row.spaceId,
        epoch,
        revision: row.revision,
        ...(this.options.liveConnectionScopes &&
        this.options.scopes === undefined &&
        access.principalId
          ? { live_connection_scopes: true }
          : {}),
        scopes: [
          ...new Set([
            ...(this.options.scopes ??
              (await this.options.scopesForJob?.(tx, row)) ??
              (await connectionScopesForJob(tx, row))),
            ...(this.runs ? [...runScopes(row.kind), ...intentScopes(row.kind)] : []),
          ]),
        ],
        budget: {
          max_actions: budget.max_actions,
          max_output_tokens: budget.max_output_tokens,
          max_input_tokens: inputTokenCeiling(model.model, budget),
          max_usd_est: budget.max_usd_est,
        },
        exp: Math.floor(Date.now() / 1000) + CAPABILITY_TTL_SECONDS,
      };
      const generations = await readGenerations(tx, row.spaceId);
      const bundle = await buildAttemptSkeleton(
        tx,
        row,
        {
          id: attemptId,
          epoch,
          revision: row.revision,
          token: signCapability(claims, this.options.key),
        },
        model,
        previous?.inputCursor ?? 0,
        generations,
        capabilities.version,
      );
      if (this.options.loadCatalog)
        Object.assign(bundle, await this.options.loadCatalog(tx, claims, bundle));
      await tx.insert(attempt).values({
        id: attemptId,
        principalId: access.principalId,
        membershipGeneration: access.generation,
        jobId: row.id,
        epoch,
        turnId: row.currentTurnId,
        revision: row.revision,
        policyGeneration: generations.policy_generation,
        connectionGenerations: generations.connection_generations,
        runtimeVersion: capabilities.version,
        provider: model.provider,
        model: model.model,
        usage: attemptUsage.parse({}),
        leaseExpiresAt: new Date((await databaseNow(tx)).getTime() + this.leaseMs),
        inputCursor: Number(latest?.seq ?? 0),
        usageClass: cause.usageClass,
        triggerId: cause.triggerId,
        situationId: cause.situationId,
      });
      await captureAttemptVersions(tx, bundle, capabilities.version, capabilities.workspace);
      // The attempt is told its wait was cancelled; this row is what lets its
      // outcome restore that wait, once, if it finishes without choosing another.
      if (bundle.inputs.cancelled_wait)
        await appendEvent(tx, {
          jobId: row.id,
          attemptId,
          type: 'notice',
          payload: { kind: 'wait_cancelled', wait: bundle.inputs.cancelled_wait },
          dedupKey: `${attemptId}:wait-cancelled`,
        });
      // The epoch bump below fences any attempt still open on this job. Its row
      // must say so: an open row with no end timestamp would otherwise outlive
      // the recovery scan, which only closes attempts of the current epoch.
      const superseded = await tx
        .update(attempt)
        .set({
          outcome: 'fenced',
          outcomeDetail: { kind: 'superseded', by: attemptId },
          endedAt: new Date(),
          leaseStatus: 'ended',
          leaseExpiresAt: null,
        })
        .where(and(eq(attempt.jobId, row.id), isNull(attempt.endedAt), ne(attempt.id, attemptId)))
        .returning({ id: attempt.id });
      for (const stale of superseded)
        await appendEvent(tx, {
          jobId: row.id,
          attemptId: stale.id,
          type: 'attempt_ended',
          payload: { kind: 'superseded', by: attemptId },
          dedupKey: `${stale.id}:ended`,
        });
      row = await this.jobs.move(
        tx,
        row,
        { kind: 'attempt_started' },
        { attemptId, bumpEpoch: true },
      );
      await appendEvent(tx, {
        jobId: row.id,
        attemptId,
        type: 'attempt_started',
        payload: { epoch, revision: row.revision },
        dedupKey: `${attemptId}:started`,
      });
      // Long work whose result has been through its check is given it here,
      // by an attempt that only records it: nothing for a model to do.
      const settled =
        this.runs && isRunKind(row.kind) ? await this.runs.settle(tx, row, attemptId) : null;
      if (settled) {
        await this.finish(tx, row, attemptId, settled);
        return null;
      }
      // An attempt that starts no engine reads none of its inputs: they are
      // left for the next attempt, so what woke this one is not lost.
      const unread = async () =>
        tx
          .update(attempt)
          .set({ inputCursor: previous?.inputCursor ?? 0 })
          .where(eq(attempt.id, attemptId));
      if (guarded) {
        await unread();
        await this.finish(tx, row, attemptId, {
          kind: 'waiting_for_input',
          question: WAKE_GUARD_QUESTION,
        });
        await tellOnce(tx, row, WAKE_GUARD_QUESTION, `wake-guard:${row.id}:${attemptId}`);
        return null;
      }
      // Past a spending limit no engine is started: the turn, routine run or
      // background job ends at once with the sentence that says when it resets.
      // Background long work instead rests until then, keeping what arrives
      // for it, and the person is told the limit once, in its own words.
      const capped = await this.options.spendingLimit?.(row.id, cause.usageClass);
      if (capped) await unread();
      if (capped && cause.usageClass === 'background' && isRunKind(row.kind)) {
        await this.finish(tx, row, attemptId, {
          kind: 'waiting_for_event_or_time',
          wait: { kind: 'timer', wake_at: capped.resetsAt.toISOString() },
        });
        await tellOnce(
          tx,
          row,
          capped.message,
          `spending-limit:${row.id}:${capped.resetsAt.toISOString()}`,
          'spending_limit',
        );
        return null;
      }
      if (capped) {
        await this.finish(tx, row, attemptId, {
          kind: 'budget_exhausted',
          summary: capped.message,
        });
        return null;
      }
      // The skills went into the instructions, where no tool call shows them.
      const followed = skillTraceCall(attemptId, bundle.skills, await databaseNow(tx));
      if (followed)
        await appendEvent(tx, {
          jobId: row.id,
          attemptId,
          type: 'notice',
          payload: { kind: SKILL_TRACE_KIND, call: followed },
          dedupKey: `tool:${followed.id}:${followed.status}`,
        });
      if (row.currentTurnId)
        await tx
          .update(experienceTurn)
          .set({ status: 'working' })
          .where(eq(experienceTurn.id, row.currentTurnId));
      return { bundle, claims };
    });
  }

  async heartbeat(claims: CapabilityClaims): Promise<boolean> {
    return this.jobs.transaction(async (tx) => {
      try {
        await requireCurrentAttempt(tx, claims, { settling: true });
      } catch (error) {
        if (error instanceof ServiceError) return false;
        throw error;
      }
      await tx
        .update(attempt)
        .set({ leaseExpiresAt: new Date((await databaseNow(tx)).getTime() + this.leaseMs) })
        .where(eq(attempt.id, claims.attempt_id));
      return true;
    });
  }

  async emit(claims: CapabilityClaims, input: RuntimeEvent): Promise<void> {
    const value = runtimeEvent.parse(input);
    if (
      value.attempt_id !== claims.attempt_id ||
      value.dedup_key !== dedupKey(claims.attempt_id, value.local_seq)
    )
      throw new ServiceError(
        'invalid_event',
        'Runtime event identity does not match this attempt.',
        400,
      );
    await this.jobs.transaction(async (tx) => {
      const row = await this.jobs.lock(tx, claims.job_id);
      const [execution] = await tx.select().from(attempt).where(eq(attempt.id, claims.attempt_id));
      if (!row || !execution || execution.jobId !== row.id)
        throw new ServiceError('stale_epoch', 'Attempt not found.');
      const [duplicate] = await tx.select().from(event).where(eq(event.dedupKey, value.dedup_key));
      if (duplicate) return;
      let current = true;
      try {
        await requireCurrentAttempt(tx, claims, { settling: true });
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        current = false;
        if (value.type !== 'tool_result') throw error;
      }
      let browserCall = false;
      if (value.type === 'tool_result') {
        const proposals = await tx
          .select({ payload: event.payload })
          .from(event)
          .where(
            and(
              eq(event.attemptId, execution.id),
              eq(event.type, 'tool_call_proposed'),
              sql`${event.payload}->>'call_id' = ${value.call_id}`,
            ),
          );
        if (!current && !proposals.length)
          throw new ServiceError('stale_epoch', 'An old attempt cannot create a new tool result.');
        // Durable identity survives restarts, and a second proposal cannot shadow
        // a browser call with a less restrictive name before its result arrives.
        browserCall = proposals.some((proposal) =>
          isBrowserTool((proposal.payload as JsonObject).tool),
        );
      }
      const persisted = browserEventForPersistence(value, browserCall);
      if (!current && persisted.type === 'tool_result') {
        await appendEvent(tx, {
          jobId: row.id,
          attemptId: execution.id,
          type: 'notice',
          payload: {
            kind: 'receipt',
            late: true,
            call_id: persisted.call_id,
            result: persisted.result,
          },
          dedupKey: `${value.dedup_key}:receipt`,
        });
      }
      if (value.local_seq <= execution.runtimeCursor)
        throw new ServiceError('invalid_event', 'Runtime events arrived out of order.', 400);
      if (value.local_seq > execution.runtimeCursor + 1) {
        await this.gap(
          tx,
          execution.id,
          row.id,
          `stream:${execution.runtimeCursor + 1}:${value.local_seq}`,
          { from_local_seq: execution.runtimeCursor + 1, to_local_seq: value.local_seq - 1 },
        );
      }
      if (value.type === 'turn_started' && current) {
        const [counts] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(event)
          .where(and(eq(event.attemptId, execution.id), eq(event.type, 'turn_started')));
        if (Number(counts?.n ?? 0) >= jobBudget.parse(row.budget).max_turns)
          throw new AttemptBudgetExceeded('The attempt turn budget is exhausted.');
      }
      if (
        value.type === 'attempt_outcome' &&
        value.usage &&
        value.usage.output_tokens > jobBudget.parse(row.budget).max_output_tokens
      )
        throw new AttemptBudgetExceeded('The attempt output-token budget is exhausted.');
      const type = value.type === 'attempt_outcome' ? 'notice' : value.type;
      if (current && row.currentTurnId && value.type === 'text_delta') {
        // A retried turn replaces the partial answer the lost attempt left; a
        // turn that carries on after a wait starts a new paragraph.
        const join = await this.firstAnswerJoin(tx, execution.id, row.id);
        await tx
          .update(experienceTurn)
          .set({
            answer:
              join === 'replace'
                ? value.text
                : join === 'separate'
                  ? sql`case when ${experienceTurn.answer} = '' then ${value.text}
                      else ${experienceTurn.answer} || ${`\n\n${value.text}`} end`
                  : sql`${experienceTurn.answer} || ${value.text}`,
            status: 'streaming',
          })
          .where(eq(experienceTurn.id, row.currentTurnId));
      }
      const payload: JsonObject =
        persisted.type === 'attempt_outcome'
          ? { ...persisted, kind: 'attempt_outcome' }
          : { ...persisted, late: !current };
      await appendEvent(tx, {
        jobId: row.id,
        attemptId: execution.id,
        type,
        payload,
        dedupKey: value.dedup_key,
      });
      await tx
        .update(attempt)
        .set({
          runtimeCursor: value.local_seq,
          ...(value.type === 'attempt_outcome' && value.usage ? { usage: value.usage } : {}),
        })
        .where(eq(attempt.id, execution.id));
    });
  }

  private async gap(
    tx: Transaction,
    attemptId: string,
    jobId: string,
    key: string,
    detail: JsonObject = {},
  ) {
    await appendEvent(tx, {
      jobId,
      attemptId,
      type: 'notice',
      payload: { kind: 'gap', reason: 'runtime_interrupted', ...detail },
      dedupKey: `${attemptId}:gap:${key}`,
    });
  }

  /**
   * An outcome alone, or an outcome with the questions the attempt wanted to
   * ask. A runtime that knows nothing about questions commits exactly what it
   * always did.
   */
  async commitOutcome(claims: CapabilityClaims, input: CommittedOutcome): Promise<JobRow> {
    const envelope = isOutcomeEnvelope(input)
      ? responsibilityAttemptOutcome.parse(input)
      : { outcome: attemptOutcome.parse(input), questions: [] as QuestionSpec[] };
    return this.jobs.transaction(async (tx) => {
      const active = await requireCurrentAttempt(tx, claims, { settling: true });
      return this.finish(tx, active.job, claims.attempt_id, envelope.outcome, envelope.questions);
    });
  }

  /**
   * The wait this attempt was told had been cancelled, if it can still fire:
   * its trigger is still registered and enabled on this job, or its timer is
   * still ahead, and no effect is pending that a wait would have to outrank.
   */
  private async restorableWait(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
  ): Promise<WaitSpec | null> {
    const [notice] = await tx
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.dedupKey, `${attemptId}:wait-cancelled`), eq(event.jobId, row.id)))
      .limit(1);
    const parsed = waitSpec.safeParse((notice?.payload as JsonObject | undefined)?.wait);
    if (!parsed.success) return null;
    const wait = parsed.data;
    const [pending] = await tx
      .select({ id: action.id })
      .from(action)
      .where(
        and(
          eq(action.jobId, row.id),
          inArray(action.status, [
            'needs_approval',
            'approved',
            'admitted',
            'dispatched',
            'unknown',
            'unresolved',
          ]),
        ),
      )
      .limit(1);
    if (pending) return null;
    if (wait.kind === 'timer')
      return Date.parse(wait.wake_at) > (await databaseNow(tx)).getTime() ? wait : null;
    if (wait.kind !== 'event') return null;
    const [registration] = await tx
      .select({ id: trigger.id })
      .from(trigger)
      .where(
        and(eq(trigger.id, wait.trigger_id), eq(trigger.jobId, row.id), eq(trigger.enabled, true)),
      );
    return registration ? wait : null;
  }

  /** The question this attempt put to the person, if it asked one. Prose cannot create one. */
  private async askedOfPerson(tx: Transaction, attemptId: string): Promise<QuestionSpec | null> {
    const [row] = await tx
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.dedupKey, personQuestionKey(attemptId)));
    const parsed = questionSpec.safeParse((row?.payload as { question?: unknown })?.question);
    return parsed.success ? parsed.data : null;
  }

  /**
   * A conversation's or a routine's answer keeps only the citations its turn
   * read: a source line, an attribution or a link no page it opened backs is
   * taken out, and named in a closing note (`experience/citations.ts`). An
   * answer that names results from pages the turn opened, and links none of
   * them, gets one short line of links to those pages (`visited-links.ts`).
   * One that says a file is attached when the turn delivered none says so
   * (`delivery-claims.ts`).
   */
  private async citedOnlyWhatWasRead(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    given: AttemptOutcome,
  ): Promise<AttemptOutcome> {
    if (given.kind !== 'completed' || !['chat', 'routine'].includes(row.kind)) return given;
    if (!given.summary.trim()) return given;
    const reads = await tx
      .select({ kind: action.kind, receipt: action.receipt, payload: action.canonicalPayload })
      .from(action)
      .innerJoin(attempt, eq(attempt.id, action.attemptId))
      .where(
        and(
          eq(action.jobId, row.id),
          eq(action.status, 'succeeded'),
          row.currentTurnId
            ? sql`(${attempt.turnId} = ${row.currentTurnId} or ${action.attemptId} = ${attemptId})`
            : eq(action.attemptId, attemptId),
        ),
      );
    const checked = checkCitations(given.summary, sourcesRead(reads));
    // A result found on a page is linked to that page, when the answer links nothing.
    // A file said to be attached that no action in the turn delivered is named as missing.
    const summary = withDeliveryNote(withVisitedLinks(checked.text, pagesVisited(reads)), reads);
    return summary !== given.summary ? { ...given, summary } : given;
  }

  private async finish(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    given: AttemptOutcome,
    raised: readonly QuestionSpec[] = [],
  ): Promise<JobRow> {
    // An attempt whose model calls were refused at a spending limit ends on
    // that limit, not as a failure to run again while it still holds.
    const capped =
      (given.kind === 'failed' || given.kind === 'budget_exhausted') && this.options.spendingLimit
        ? ((await this.options.spendingLimit(row.id, await usageClassOf(tx, attemptId)))?.message ??
          null)
        : null;
    const original: AttemptOutcome = capped
      ? { kind: 'budget_exhausted', summary: capped }
      : await this.citedOnlyWhatWasRead(tx, row, attemptId, given);
    let carried = raised;
    const brokerParked = ['waiting_for_approval', 'needs_reconciliation'].includes(row.state);
    const [counts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attempt)
      .where(
        and(
          eq(attempt.jobId, row.id),
          ['chat', 'routine'].includes(row.kind) && row.currentTurnId
            ? eq(attempt.turnId, row.currentTurnId)
            : undefined,
        ),
      );
    const shifts = this.runs && isRunKind(row.kind) ? this.runs : null;
    const remaining = shifts
      ? await shifts.failuresRemaining(tx, row, jobBudget.parse(row.budget))
      : Math.max(0, jobBudget.parse(row.budget).max_attempts - Number(counts?.n ?? 0));
    const [reconnect] = await tx
      .select({ text: question.text })
      .from(question)
      .innerJoin(
        action,
        and(
          eq(action.jobId, question.jobId),
          eq(action.attemptId, question.attemptId),
          eq(action.repairDisposition, 'needs_reconnect'),
        ),
      )
      .where(
        and(
          eq(question.jobId, row.id),
          eq(question.attemptId, attemptId),
          eq(question.state, 'open'),
          eq(question.blocksExternalEffect, true),
        ),
      )
      .limit(1);
    // A question the attempt put to the person through the broker. A turn that
    // ended tidily after asking waits for the answer instead of completing, and
    // its final words stay as the turn's text.
    const asked = await this.askedOfPerson(tx, attemptId);
    const posed: AttemptOutcome =
      asked &&
      !brokerParked &&
      (original.kind === 'completed' || original.kind === 'waiting_for_input')
        ? {
            kind: 'waiting_for_input',
            question: asked.text,
            ...(original.kind === 'completed' && original.summary.trim()
              ? { draft: original.summary }
              : original.kind === 'waiting_for_input' && original.draft
                ? { draft: original.draft }
                : {}),
          }
        : original;
    if (asked && posed !== original) carried = [asked, ...carried];
    // A wait that was cancelled before it fired comes back when the attempt told
    // about it completes without choosing another, and only while it can still
    // fire. A retryable failure hands it to the retry instead.
    const cancelled = brokerParked ? null : await this.restorableWait(tx, row, attemptId);
    const restored: AttemptOutcome =
      cancelled && posed.kind === 'completed'
        ? { kind: 'waiting_for_event_or_time', wait: cancelled }
        : posed;
    if (restored !== posed)
      await appendEvent(tx, {
        jobId: row.id,
        attemptId,
        type: 'notice',
        payload: { kind: 'wait_restored', wait: cancelled },
        dedupKey: `${attemptId}:wait-restored`,
      });
    // A runtime's final prose cannot withdraw the broker's unanswered revocation
    // question, even on the last budgeted attempt. Only owner input resolves it.
    // Long work decides from its record what a shift's ending stands for.
    const shifted =
      shifts && !brokerParked ? await shifts.shiftEnded(tx, row, attemptId, restored) : restored;
    const outcome: AttemptOutcome = reconnect
      ? { kind: 'waiting_for_input', question: reconnect.text }
      : remaining === 0 && shifted.kind.startsWith('waiting_') && !shifts
        ? { kind: 'budget_exhausted', summary: 'The job has used its attempt budget.' }
        : shifted;
    let input: TransitionInput;
    let wait: WaitSpec = { kind: 'none' };
    let artifactFailures: string[] = [];
    switch (outcome.kind) {
      case 'completed': {
        const facts = await completionFacts(tx, row, outcome, this.options.artifactRoots);
        artifactFailures = facts.artifact_failures;
        input = {
          kind: 'attempt_completed',
          all_actions_terminal: facts.all_actions_terminal,
          has_unknown_action: facts.has_unknown_action,
          deliverable_declared: facts.deliverable_declared,
          deliverable_satisfied: facts.deliverable_satisfied,
          artifact_validations_passed: facts.artifact_validations_passed,
        };
        break;
      }
      case 'waiting_for_input':
        input = { kind: 'attempt_waiting_for_input' };
        wait = { kind: 'user_input', question: outcome.question };
        break;
      case 'waiting_for_approval':
        input = { kind: 'attempt_waiting_for_approval' };
        wait = { kind: 'approval', action_ids: outcome.action_ids };
        break;
      case 'waiting_for_event_or_time':
        input = { kind: 'attempt_waiting_for_event_or_time' };
        wait = waitSpec.parse(outcome.wait);
        if (wait.kind !== 'timer' && wait.kind !== 'event')
          throw new ServiceError('invalid_wait', 'Event/time waits must name a timer or trigger.');
        break;
      case 'unknown_check':
        // An unreadable ledger cannot justify a replay or a completed job.
        input = { kind: 'attempt_waiting_for_input' };
        wait = { kind: 'user_input', question: outcome.message };
        break;
      case 'failed':
        input = {
          kind: 'attempt_failed',
          retryable: outcome.retryable,
          attempts_remaining: remaining,
        };
        // The retry is told again, from the wait its queued row still carries.
        if (cancelled && outcome.retryable && remaining > 0) wait = cancelled;
        break;
      case 'budget_exhausted':
        input = { kind: 'attempt_budget_exhausted' };
        break;
    }
    // Something this attempt sent is unconfirmed, and the turn rests on it: the
    // person is asked, with answers to press, rather than left with a state
    // and nothing to do about it. Where the broker parked the job already, the
    // question it asked, if any, stays the one asked.
    const unconfirmed =
      (outcome.kind === 'completed' &&
        input.kind === 'attempt_completed' &&
        input.has_unknown_action &&
        !brokerParked) ||
      (brokerParked && row.state === 'needs_reconciliation');
    if (unconfirmed) {
      if (!brokerParked) wait = { kind: 'user_input', question: UNCONFIRMED_NOTE };
      carried = [unsettledQuestion(attemptId, UNCONFIRMED_NOTE), ...carried];
    }
    const completionVerified =
      outcome.kind === 'completed' &&
      input.kind === 'attempt_completed' &&
      !input.has_unknown_action &&
      input.all_actions_terminal &&
      (!input.deliverable_declared || input.deliverable_satisfied);
    const chatComplete = row.kind === 'chat' && completionVerified;
    if (chatComplete) {
      input = { kind: 'attempt_waiting_for_input' };
      wait = { kind: 'user_input', question: 'What would you like to do next?' };
    }
    // A routine rests until its next scheduled run once this one is over,
    // whether it finished or failed: one bad run does not end the routine. A
    // paused routine rests the same way until it is resumed.
    const runOver =
      completionVerified ||
      input.kind === 'attempt_budget_exhausted' ||
      (input.kind === 'attempt_failed' && !(input.retryable && input.attempts_remaining > 0));
    const rest = runOver ? await routineRest(tx, row) : null;
    if (rest) {
      input = { kind: 'attempt_waiting_for_event_or_time' };
      wait = rest;
    }
    // A routine that asked the person something rests on its schedule as well:
    // the question waits in the person's queue, and the next run still comes
    // when it is due. The answer wakes the routine on its own.
    // A turn that parked for approval keeps its question: the person sees both,
    // and an answer given while the approval waits is read by the next attempt.
    // The park is either already on the job (the broker moved it) or is this
    // outcome (the broker left the move to the runner, as a deployment does).
    const parked = brokerParked || outcome.kind === 'waiting_for_approval';
    const explicit =
      (posed !== original && outcome.kind === 'waiting_for_input') || parked ? asked : null;
    const routineAsk = explicit && !parked ? await routineRest(tx, row) : null;
    if (routineAsk) {
      input = { kind: 'attempt_waiting_for_event_or_time' };
      wait = routineAsk;
    }
    if (
      outcome.kind === 'completed' &&
      input.kind === 'attempt_completed' &&
      input.deliverable_declared &&
      !input.deliverable_satisfied &&
      !input.has_unknown_action
    )
      wait = {
        kind: 'user_input',
        question: 'The declared deliverable has no verified evidence. What should happen next?',
      };
    // Name the check that failed. "Something went wrong with the artifact" is
    // not a question anybody can answer; "the amount column adds up to 91.50
    // but the total says 100.00" is.
    if (
      outcome.kind === 'completed' &&
      input.kind === 'attempt_completed' &&
      !input.artifact_validations_passed &&
      !input.has_unknown_action
    )
      wait = {
        kind: 'user_input',
        question: `A declared artifact check did not pass: ${artifactFailures.join('; ')}. Fix the file and finish, or say what should happen instead.`,
      };
    // Deciding the question before the move lets the wait name the one asked.
    const resolution = await resolveQuestions(tx, row, {
      attemptId,
      carried,
      askable:
        (parked && (explicit !== null || unconfirmed)) ||
        (!parked && (wait.kind === 'user_input' || routineAsk !== null) && !chatComplete),
      fallback: wait.kind === 'user_input' && !chatComplete ? wait.question : undefined,
      ...(explicit ? { explicit } : {}),
    });
    if (resolution.asked && wait.kind === 'user_input')
      wait = { kind: 'user_input', question: resolution.asked.text };
    // The broker owns the parked state; drain only this attempt's output and lease.
    let updated = brokerParked
      ? row
      : await this.jobs.move(tx, row, input, { attemptId, wait, payload: { outcome } });
    await tx
      .update(attempt)
      .set({
        outcome: outcome.kind,
        outcomeDetail: carried.length ? { ...outcome, questions: carried } : outcome,
        endedAt: new Date(),
        leaseStatus: 'ended',
        leaseExpiresAt: null,
      })
      .where(eq(attempt.id, attemptId));
    // Where the turn ends up, decided once: the saved turn takes it, and the
    // event carries it so the conversation's stream says the same thing.
    const turnStatus = row.currentTurnId
      ? outcome.kind === 'completed' && (row.kind !== 'chat' || chatComplete)
        ? 'done'
        : outcome.kind === 'failed' || outcome.kind === 'budget_exhausted'
          ? 'failed'
          : 'needs_you'
      : null;
    await appendEvent(tx, {
      jobId: row.id,
      attemptId,
      type: 'attempt_ended',
      payload: {
        outcome,
        ...(['chat', 'routine'].includes(row.kind)
          ? { experience_completed: completionVerified }
          : {}),
        ...(turnStatus ? { turn_status: turnStatus } : {}),
      },
      dedupKey: `${attemptId}:ended`,
    });
    if (updated.state === 'waiting_for_event_or_time' && this.onWait)
      updated = await this.onWait(tx, updated);
    if (updated.state === 'waiting_for_approval' && this.onApprovalWait)
      updated = await this.onApprovalWait(tx, updated);
    await persistQuestions(tx, updated, resolution, attemptId);
    updated = {
      ...updated,
      deferredQuestions: isTerminal(updated.state as JobState) ? [] : resolution.deferred,
    };
    // One reading of "is this news", shared by the attention counters and the outbox.
    const result = await attemptResult(tx, row, outcome, attemptId);
    await captureCompletedEpisode(tx, updated, outcome, attemptId);
    for (const handler of this.onFinished)
      await handler(tx, updated, outcome, attemptId, { questions: carried, result });
    if (row.currentTurnId && turnStatus)
      await tx
        .update(experienceTurn)
        .set({
          status: turnStatus,
          // A conversation turn that hit a limit keeps what it already said and
          // ends with a plain sentence, not the name of the limit.
          ...(row.kind === 'chat' && outcome.kind === 'budget_exhausted'
            ? {
                answer: sql`case when ${experienceTurn.answer} = '' then ${capped ?? LIMIT_REACHED_NOTE}
                  else ${experienceTurn.answer} || ${`\n\n${capped ?? LIMIT_REACHED_NOTE}`} end`,
              }
            : 'summary' in outcome
              ? { answer: outcome.summary }
              : outcome.kind === 'waiting_for_input' && outcome.draft
                ? { answer: outcome.draft }
                : {}),
          finishedAt: new Date(),
        })
        .where(eq(experienceTurn.id, row.currentTurnId));
    return updated;
  }

  /** Stop fences new effects before signalling the adapter, and retains each streamed byte. */
  async stopConversation(jobId: string): Promise<void> {
    const stopped = await this.jobs.transaction(async (tx) => {
      const row = await this.jobs.lock(tx, jobId);
      if (row?.kind !== 'chat') throw new ServiceError('not_found', 'Conversation not found.', 404);
      return this.stopTurn(tx, row);
    });
    this.interrupt(jobId);
    if (!stopped) return;
    for (const handler of this.onStopped) {
      try {
        handler(jobId);
      } catch {
        // A handler's failure is its own; the turn has stopped regardless.
      }
    }
  }

  /**
   * End the conversation's turn in flight, under the job lock the caller holds:
   * the conversation waits for its next message. False when no turn was in
   * flight. Stop and a cancelled conversation both end a turn this way.
   */
  async stopTurn(tx: Transaction, row: JobRow): Promise<boolean> {
    const jobId = row.id;
    if (!row.currentTurnId) return false;
    const [turn] = await tx
      .select()
      .from(experienceTurn)
      .where(eq(experienceTurn.id, row.currentTurnId));
    if (!turn || ['done', 'stopped', 'failed'].includes(turn.status)) return false;
    // An action parked until its destination is back (a computer that was off,
    // a rate limit) would otherwise go later by itself. Stopping ends it here,
    // recorded as the broker records a dispatch it refuses.
    const parked = await tx
      .select()
      .from(action)
      .where(
        and(
          eq(action.jobId, row.id),
          eq(action.status, 'admitted'),
          isNotNull(action.retryAfterAt),
        ),
      )
      .for('update');
    for (const effect of parked) {
      const reason = 'the conversation was stopped';
      await tx
        .update(action)
        .set({
          status: 'failed',
          resolvedAt: new Date(),
          reconciliation: { reason, retryable: false },
        })
        .where(eq(action.id, effect.id));
      await tx
        .update(budgetLedger)
        .set({ settled: 0 })
        .where(and(eq(budgetLedger.actionId, effect.id), isNull(budgetLedger.settled)));
      await appendEvent(tx, {
        jobId: row.id,
        attemptId: effect.attemptId,
        type: 'action_status_changed',
        payload: { action_id: effect.id, from: 'admitted', to: 'failed' },
        dedupKey: `${effect.id}:stopped:status`,
      });
      await appendEvent(tx, {
        jobId: row.id,
        attemptId: effect.attemptId,
        type: 'notice',
        payload: {
          action_id: effect.id,
          phase: 'dispatch_rejected',
          outcome: 'fenced',
          reason,
        },
        dedupKey: `${effect.id}:stopped`,
      });
    }
    await tx
      .update(job)
      .set({
        state: 'waiting_for_input',
        wait: { kind: 'user_input', question: 'What would you like to do next?' },
        leaseEpoch: row.leaseEpoch + 1,
        stateVersion: row.stateVersion + 1,
        nextWakeAt: null,
        paused: false,
        pauseRequested: false,
      })
      .where(eq(job.id, row.id));
    await tx
      .update(experienceTurn)
      .set({ status: 'stopped', finishedAt: new Date() })
      .where(eq(experienceTurn.id, turn.id));
    // Nothing the stopped turn asked for may still be allowed afterwards, and
    // nothing it asked the person is still waiting for an answer.
    await withdrawPendingPermissions(tx, jobId, STOPPED_NOTE);
    await withdrawOpenQuestion(tx, jobId, 'stopped');
    await tx
      .update(attempt)
      .set({
        outcome: 'fenced',
        outcomeDetail: { kind: 'cancelled' },
        endedAt: new Date(),
        leaseExpiresAt: null,
        leaseStatus: 'ended',
      })
      .where(and(eq(attempt.jobId, jobId), isNull(attempt.endedAt)));
    await appendEvent(tx, {
      jobId,
      type: 'notice',
      payload: { kind: 'experience_stopped', turn_id: turn.id },
      dedupKey: `${turn.id}:stopped`,
    });
    return true;
  }

  async pauseConversation(jobId: string, resume: boolean) {
    const row = await this.jobs.get(jobId);
    if (row.kind !== 'chat') throw new ServiceError('not_found', 'Conversation not found.', 404);
    const controls = this.runtime as RuntimeAdapter & {
      pause?: (id: string) => Promise<boolean>;
      resume?: (id: string) => Promise<boolean>;
    };
    if (row.state === 'running' && (!controls.pause || !controls.resume))
      return unavailable(
        'This assistant cannot pause and keep its place yet. You can stop this turn.',
      );
    if (!['queued', 'running'].includes(row.state))
      return unavailable('There is no active task to pause.');
    const [active] = await this.jobs.db
      .select()
      .from(attempt)
      .where(and(eq(attempt.jobId, jobId), isNull(attempt.endedAt)))
      .limit(1);
    if (active) {
      const accepted = resume
        ? await controls.resume?.(active.id)
        : await controls.pause?.(active.id);
      if (!accepted) return unavailable('The assistant could not keep its place.');
    }
    await this.jobs.transaction(async (tx) => {
      const current = await this.jobs.lock(tx, jobId);
      if (!current || current.leaseEpoch !== row.leaseEpoch)
        throw new ServiceError('state_changed', 'This turn has changed. Refresh it.', 409);
      const [updated] = await tx
        .update(job)
        .set({ paused: !resume, pauseRequested: !resume })
        .where(eq(job.id, jobId))
        .returning();
      await appendEvent(tx, {
        jobId,
        type: 'notice',
        payload: {
          kind: resume ? 'experience_resumed' : 'experience_paused',
          turn_id: row.currentTurnId,
        },
        dedupKey: `${row.currentTurnId}:${resume ? 'resumed' : 'paused'}`,
      });
      if (resume && updated?.state === 'queued') await this.jobs.enqueue(tx, updated, 'input');
    });
    return null;
  }

  async loseAttempt(attemptId: string, reason: string): Promise<boolean> {
    return this.jobs.transaction(async (tx) => {
      const [execution] = await tx.select().from(attempt).where(eq(attempt.id, attemptId));
      if (!execution || execution.endedAt) return false;
      const row = await this.jobs.lock(tx, execution.jobId);
      if (
        !row ||
        row.leaseEpoch !== execution.epoch ||
        !['running', 'waiting_for_approval', 'needs_reconciliation'].includes(row.state)
      )
        return false;
      return this.lose(tx, row, attemptId, reason);
    });
  }

  private async lose(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    reason: string,
  ): Promise<boolean> {
    // Long work that gave its result before the attempt was lost is done with
    // that result: running the shift again could only repeat it.
    const given =
      this.runs && isRunKind(row.kind) && row.state === 'running'
        ? await this.runs.recordedFinish(tx, row, attemptId)
        : null;
    if (given) {
      await this.finish(tx, row, attemptId, given);
      return true;
    }
    const [counts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attempt)
      .where(
        and(
          eq(attempt.jobId, row.id),
          ['chat', 'routine'].includes(row.kind) && row.currentTurnId
            ? eq(attempt.turnId, row.currentTurnId)
            : undefined,
        ),
      );
    await tx
      .update(attempt)
      .set({
        outcome: 'fenced',
        outcomeDetail: { kind: 'lost', reason },
        endedAt: new Date(),
        leaseStatus: 'lost',
        leaseExpiresAt: null,
      })
      .where(eq(attempt.id, attemptId));
    await this.gap(tx, attemptId, row.id, 'lost');
    const run = this.runs && isRunKind(row.kind) ? this.runs : null;
    const remaining = run
      ? await run.failuresRemaining(tx, row, jobBudget.parse(row.budget))
      : Math.max(0, jobBudget.parse(row.budget).max_attempts - Number(counts?.n ?? 0));
    // A routine whose run is lost for good goes back to its schedule.
    const rest = row.state === 'running' && remaining === 0 ? await routineRest(tx, row) : null;
    const moved =
      row.state !== 'running'
        ? row
        : // A helper has nobody to ask; it fails below and its run hears why.
          run && remaining === 0 && row.kind === 'run'
          ? await this.jobs.move(
              tx,
              row,
              { kind: 'attempt_waiting_for_input' },
              {
                attemptId,
                wait: {
                  kind: 'user_input',
                  question:
                    'My work on this keeps getting interrupted. Say "continue" to try again.',
                },
                reason: 'recovery',
              },
            )
          : rest
            ? await this.jobs.move(
                tx,
                row,
                { kind: 'attempt_waiting_for_event_or_time' },
                { attemptId, wait: rest, reason: 'recovery' },
              )
            : await this.jobs.move(
                tx,
                row,
                { kind: 'attempt_failed', retryable: true, attempts_remaining: remaining },
                { attemptId, reason: 'recovery' },
              );
    if (run && moved.kind === 'run_step' && moved.state === 'failed')
      await run.stepEnded(tx, moved, {
        kind: 'failed',
        retryable: false,
        reason: 'Its work kept getting interrupted.',
      });
    // A conversation whose last attempt was lost has ended: its turn says so,
    // in the saved copy and on the stream, instead of looking busy for ever.
    // So has a routine's run that went back to its schedule.
    const turnFailed = Boolean(row.currentTurnId) && (moved.state === 'failed' || rest !== null);
    await appendEvent(tx, {
      jobId: row.id,
      attemptId,
      type: 'attempt_ended',
      payload: {
        kind: 'lost',
        reason,
        ...(turnFailed
          ? {
              outcome: { kind: 'failed', reason: LOST_NOTE, retryable: false },
              turn_status: 'failed',
            }
          : {}),
      },
      dedupKey: `${attemptId}:ended`,
    });
    if (turnFailed && row.currentTurnId)
      await tx
        .update(experienceTurn)
        .set({
          status: 'failed',
          answer: sql`case when ${experienceTurn.answer} = '' then ${LOST_NOTE}
            else ${experienceTurn.answer} || ${`\n\n${LOST_NOTE}`} end`,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(experienceTurn.id, row.currentTurnId),
            inArray(experienceTurn.status, ['queued', 'working', 'streaming']),
          ),
        );
    if (moved.state === 'waiting_for_event_or_time') await this.onWait?.(tx, moved);
    return true;
  }

  async recover(): Promise<void> {
    const expired = await this.jobs.db
      .select({ id: attempt.id, jobId: attempt.jobId })
      .from(attempt)
      .where(and(isNull(attempt.endedAt), sql`${attempt.leaseExpiresAt} <= now()`));
    for (const candidate of expired) {
      const fenced = await this.jobs
        .transaction(async (tx) => {
          const row = await this.jobs.lock(tx, candidate.jobId, true);
          const [execution] = await tx.select().from(attempt).where(eq(attempt.id, candidate.id));
          if (
            !row ||
            !execution ||
            execution.endedAt ||
            !execution.leaseExpiresAt ||
            execution.leaseExpiresAt.getTime() > (await databaseNow(tx)).getTime()
          )
            return false;
          if (row.leaseEpoch !== execution.epoch) {
            // Already fenced by a later epoch: the job moved on without this
            // row. Close the row; the job's state is not this attempt's to change.
            await tx
              .update(attempt)
              .set({
                outcome: 'fenced',
                outcomeDetail: { kind: 'superseded' },
                endedAt: new Date(),
                leaseStatus: 'ended',
                leaseExpiresAt: null,
              })
              .where(eq(attempt.id, execution.id));
            await appendEvent(tx, {
              jobId: row.id,
              attemptId: execution.id,
              type: 'attempt_ended',
              payload: { kind: 'superseded' },
              dedupKey: `${execution.id}:ended`,
            });
            return false;
          }
          if (!['running', 'waiting_for_approval', 'needs_reconciliation'].includes(row.state))
            return false;
          const [committed] = await tx
            .select()
            .from(event)
            .where(
              and(
                eq(event.attemptId, execution.id),
                eq(event.type, 'notice'),
                sql`${event.payload}->>'kind' = 'attempt_outcome'`,
              ),
            )
            .orderBy(desc(event.seq))
            .limit(1);
          const parsed = attemptOutcome.safeParse(
            (committed?.payload as JsonObject | undefined)?.outcome,
          );
          await requireGenerations(tx, row.spaceId, {
            policy_generation: execution.policyGeneration,
            connection_generations: execution.connectionGenerations,
          });
          if (parsed.success && execution.revision === row.revision)
            await this.finish(tx, row, execution.id, parsed.data);
          else await this.lose(tx, row, execution.id, 'lease_expired');
          return true;
        })
        .catch(async (error: unknown) => {
          // A rejected persisted outcome must not starve the remaining recovery candidates.
          if (!(error instanceof ServiceError)) throw error;
          return this.loseAttempt(candidate.id, error.code);
        });
      if (fenced) this.interrupt(candidate.jobId, candidate.id);
    }
    const due = await this.jobs.db
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          inArray(job.state, ['queued', 'waiting_for_event_or_time']),
          sql`${job.nextWakeAt} <= now()`,
        ),
      );
    for (const candidate of due) {
      await this.jobs.transaction(async (tx) => {
        const row = await this.jobs.lock(tx, candidate.id, true);
        if (
          !row?.nextWakeAt ||
          row.nextWakeAt.getTime() > (await databaseNow(tx)).getTime() ||
          !['queued', 'waiting_for_event_or_time'].includes(row.state)
        )
          return;
        const live = await tx.execute(
          sql`select id from pgboss.job where name = ${attemptQueue(row.schedulingClass)} and state in ('created', 'retry', 'active') and data->>'job_id' = ${row.id} and (data->>'expected_epoch')::int = ${row.leaseEpoch} and (data->>'expected_version')::int = ${row.stateVersion} limit 1`,
        );
        if (live.length === 0) await this.jobs.enqueue(tx, row, 'recovery');
      });
    }
    await this.afterRecovery?.();
  }

  /**
   * End an attempt whose model call was refused at a spending limit. The call
   * that was refused made nothing; a call already answering is not cut off.
   */
  stopForSpending(jobId: string, attemptId: string, message: string): void {
    for (const active of this.active.values())
      if (active.jobId === jobId && active.attemptId === attemptId)
        active.controller.abort(new AttemptBudgetExceeded(message));
  }

  interrupt(jobId: string, attemptId?: string): void {
    for (const active of this.active.values())
      if (active.jobId === jobId && (!attemptId || active.attemptId === attemptId))
        active.controller.abort(new Error('Attempt interrupted'));
    // A model call the engine already made goes on until the provider finishes
    // unless the gateway ends it; ending the engine's run does not.
    stopModelCalls(jobId, attemptId);
  }

  /**
   * Stop these jobs' attempts and wait until the runtime has returned from
   * them, so a workspace they held open can be removed. Bounded: a runtime that
   * does not return in time is left to its own teardown, and whoever asked
   * finds the workspace still held.
   */
  async stopJobs(jobIds: readonly string[], timeoutMs = 10_000): Promise<void> {
    const ids = new Set(jobIds);
    for (const id of ids) this.interrupt(id);
    const held = [...this.running.values()].filter((entry) => ids.has(entry.jobId));
    if (!held.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.all(held.map((entry) => entry.returned)), late]);
    clearTimeout(timer);
  }

  async invalidateContext(control: ContextInvalidated): Promise<void> {
    const active = this.active.get(control.attempt_id);
    if (active?.jobId === control.job_id) active.controller.abort(control);
    try {
      await (this.runtime as ContextAwareRuntimeAdapter).contextInvalidated?.(control);
    } catch {
      process.stderr.write(
        `runtime context invalidation acknowledgement failed for ${control.attempt_id}\n`,
      );
    }
  }

  handleWake(wake: AttemptWake): Promise<void> {
    const pending = this.runWake(wake);
    this.wakes.add(pending);
    return pending.finally(() => this.wakes.delete(pending));
  }

  private async runWake(wake: AttemptWake): Promise<void> {
    if (this.stopping) return;
    const claim = await this.claim(wake);
    if (!claim) return;
    const { bundle, claims } = claim;
    if (this.stopping) {
      await this.loseAttempt(claims.attempt_id, 'service_stopping');
      return;
    }
    const controller = new AbortController();
    let finished = () => {};
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    // A replacement can start between a fence commit and delivery of its predecessor's abort.
    this.active.set(claims.attempt_id, {
      jobId: claims.job_id,
      attemptId: claims.attempt_id,
      controller,
      done,
    });
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.heartbeat(claims)
        .then((current) => {
          if (!current) controller.abort(new Error('Lease lost'));
        })
        .catch((error: unknown) => controller.abort(error))
        .finally(() => {
          heartbeatBusy = false;
        });
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let completed: Extract<AttemptOutcome, { kind: 'completed' }> | null = null;
    let abortListener = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const wallLimit = new Promise<AttemptOutcome>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort(new AttemptBudgetExceeded('The attempt wall-time budget is exhausted.'));
          resolve({
            kind: 'budget_exhausted',
            summary: 'The attempt wall-time budget is exhausted.',
          });
        }, bundle.budget.max_wall_ms);
      });
      const call = this.runtime.start(
        bundle,
        { emit: (event) => this.emit(claims, event) },
        controller.signal,
      );
      // The attempt ends when the race does; the runtime may still be tearing
      // down, holding the job's workspace open, until the call itself returns.
      const returned = call.then(
        () => undefined,
        () => undefined,
      );
      this.running.set(claims.attempt_id, { jobId: claims.job_id, returned });
      void returned.finally(() => this.running.delete(claims.attempt_id));
      const result = await Promise.race([call, wallLimit, interrupted]);
      // The runtime has answered: the wall clock covered its work, not the
      // wait for what that work started, which must not be cut short into a
      // lost attempt and a rerun. Only Stop or a fence ends the wait early.
      clearTimeout(timeout);
      const outcome = isOutcomeEnvelope(result) ? result.outcome : result;
      if (outcome.kind === 'completed') {
        completed = outcome;
        await this.awaitDispatched(claims, controller.signal);
      }
      await this.commitOutcome(claims, result);
    } catch (error) {
      if (
        completed &&
        error instanceof ServiceError &&
        error.code === 'actions_not_terminal' &&
        !controller.signal.aborted
      ) {
        // The work is done and its answer written; what it started is still
        // out. Running the turn again would do every step a second time, so
        // the turn rests on its answer until that action reports back.
        // The person is asked what to do about it, with answers to press.
        const draft = completed.summary;
        await this.commitOutcome(claims, {
          outcome: {
            kind: 'waiting_for_input',
            question: STILL_RUNNING_NOTE,
            ...(draft.trim() ? { draft } : {}),
          },
          questions: [unsettledQuestion(claims.attempt_id, STILL_RUNNING_NOTE)],
        }).catch(async (failure: unknown) => {
          await this.loseAttempt(
            claims.attempt_id,
            failure instanceof Error ? failure.message : 'runtime_crashed',
          );
        });
      } else if (error instanceof AttemptBudgetExceeded) {
        await this.commitOutcome(claims, {
          kind: 'budget_exhausted',
          summary: error.message,
        }).catch(async (failure: unknown) => {
          if (!(failure instanceof ServiceError)) throw failure;
        });
      } else if (
        !(
          error instanceof ServiceError && ['stale_epoch', 'revision_mismatch'].includes(error.code)
        )
      ) {
        await this.loseAttempt(
          claims.attempt_id,
          error instanceof Error ? error.message : 'runtime_crashed',
        );
      }
    } finally {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abortListener);
      if (this.active.get(claims.attempt_id)?.controller === controller)
        this.active.delete(claims.attempt_id);
      this.answering.delete(claims.attempt_id);
      for (const settled of this.onSettled) {
        try {
          settled(claims.attempt_id);
        } catch {
          // A handler's failure is its own; the attempt has ended regardless.
        }
      }
      finished();
    }
  }

  /** How this attempt's answer text joins the turn's, for its first piece only. */
  private async firstAnswerJoin(
    tx: Transaction,
    attemptId: string,
    jobId: string,
  ): Promise<AnswerJoin> {
    if (this.answering.has(attemptId)) return 'none';
    this.answering.add(attemptId);
    const [earlier] = await tx
      .select({ seq: event.seq })
      .from(event)
      .where(
        and(eq(event.jobId, jobId), eq(event.attemptId, attemptId), eq(event.type, 'text_delta')),
      )
      .limit(1);
    return earlier ? 'none' : answerJoin(tx, attemptId);
  }

  /**
   * Before a finished attempt commits, the actions it dispatched settle. One
   * whose tool call already returned has no sender left and is settled now;
   * one the broker is still running is waited for, up to its budget, while
   * the attempt keeps its lease. Whatever is still out after that is left to
   * the commit, which rests the turn rather than running it again.
   */
  private async awaitDispatched(claims: CapabilityClaims, signal: AbortSignal): Promise<void> {
    try {
      await this.settleAbandoned?.(claims.attempt_id);
    } catch (error) {
      process.stderr.write(
        `abandoned action settlement failed: ${error instanceof Error ? error.message : 'error'}\n`,
      );
    }
    const deadline = Date.now() + (this.options.dispatchWaitMs ?? DISPATCH_WAIT_MS);
    for (;;) {
      // A plain read: no transaction and no event order lock is held while
      // waiting, so the broker's own settlement is never queued behind it.
      const [pending] = await this.jobs.db
        .select({ id: action.id })
        .from(action)
        .where(and(eq(action.jobId, claims.job_id), eq(action.status, 'dispatched')))
        .limit(1);
      const left = deadline - Date.now();
      if (!pending || signal.aborted || left <= 0) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(500, left));
        function done() {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        }
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  async start(): Promise<void> {
    if (this.workerStarted) return;
    this.workerStarted = true;
    this.stopping = false;
    this.scheduler = new FairScheduler(this.concurrency);
    await this.recover();
    // Each queue hands over more wakes than can run, so one that has to wait
    // waits here, in the scheduler's fair order, where its conversation can be
    // told so, rather than unseen in the queue.
    for (const [scheduling, queue] of Object.entries(ATTEMPT_QUEUES))
      await this.jobs.boss.work<AttemptWake>(
        queue,
        { batchSize: 1, localConcurrency: this.concurrency * 2, pollingIntervalSeconds: 0.5 },
        async (wakes) => {
          for (const wake of wakes)
            await this.scheduledWake(scheduling as SchedulingClass, wake.data);
        },
      );
    // Existing queued hints can drain after an upgrade; all new and recovered hints use the persisted class.
    await this.jobs.boss.work<AttemptWake>(
      QUEUES.legacyAttempt,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (wakes) => {
        for (const wake of wakes) await this.scheduledWake('interactive', wake.data);
      },
    );
    await this.jobs.boss.work(
      QUEUES.recoveryScan,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async () => this.recover(),
    );
    await this.jobs.boss.schedule(QUEUES.recoveryScan, '* * * * *', {
      interval_seconds: RECOVERY_SCAN_SECONDS,
    });
  }

  private async scheduledWake(scheduling: SchedulingClass, wake: AttemptWake) {
    try {
      const running = this.scheduler.activeCount;
      if (running >= this.scheduler.capacity)
        void this.noteWaiting(wake, running).catch((error: unknown) =>
          process.stderr.write(`waiting note not recorded: ${String(error)}
`),
        );
      await this.scheduler.run(scheduling, () => this.handleWake(wake));
    } catch (error) {
      if (!this.stopping) throw error;
    }
  }

  /**
   * Tells the job's conversation that its turn waits for a free slot. Only a
   * wake that would still start the job does, and once per wake.
   */
  async noteWaiting(wake: AttemptWake, running: number): Promise<void> {
    await this.jobs.transaction(async (tx) => {
      const [row] = await tx
        .select({ state: job.state, epoch: job.leaseEpoch, version: job.stateVersion })
        .from(job)
        .where(eq(job.id, wake.job_id));
      if (
        row?.state !== 'queued' ||
        row.epoch !== wake.expected_epoch ||
        row.version !== wake.expected_version
      )
        return;
      await appendEvent(tx, {
        jobId: wake.job_id,
        type: 'notice',
        payload: { kind: 'waiting_for_slot', running },
        dedupKey: `${wake.job_id}:${wake.expected_epoch}:${wake.expected_version}:waiting_for_slot`,
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.scheduler.close();
    const active = [...this.active.values()];
    for (const { controller } of active) controller.abort(new Error('Service stopping'));
    if (this.workerStarted) {
      for (const name of [...Object.values(ATTEMPT_QUEUES), QUEUES.legacyAttempt])
        await this.jobs.boss.offWork(name, { wait: false });
      await this.jobs.boss.offWork(QUEUES.recoveryScan, { wait: false });
      this.workerStarted = false;
    }
    await Promise.all(active.map(({ done }) => done));
    await Promise.allSettled([...this.wakes]);
    await this.scheduler.idle();
  }
}
