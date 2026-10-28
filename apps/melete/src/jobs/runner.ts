import {
  type AttemptOutcome,
  attemptOutcome,
  attemptUsage,
  type CapabilityClaims,
  CONTINUABLE_STATES,
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
  type ProviderFailure,
  providerFailure,
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
import { withoutNarration, withoutUnbackedClaims } from '@melete/runtime-hermes';
import {
  and,
  asc,
  DrizzleQueryError,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { ArtifactRoots } from '../artifact/content.ts';
import { personQuestionKey } from '../broker/ask-person.ts';
import { redactSecrets } from '../connectors/faults.ts';
import { databaseNow } from '../db/clock.ts';
import {
  action,
  attempt,
  budgetLedger,
  connection,
  event,
  experienceTurn,
  job,
  question,
  space,
  trigger,
} from '../db/schema.ts';
import { databaseUnreachable, failureMessage } from '../db/sweep-failure.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { AckWriter } from '../experience/ack.ts';
import { checkCitations, sourcesRead } from '../experience/citations.ts';
import { withDeliveryNote } from '../experience/delivery-claims.ts';
import { plainText, STOPPED_NOTE } from '../experience/projectors.ts';
import { withdrawPendingPermissions } from '../experience/service.ts';
import {
  pagesVisited,
  withoutRepeatedLinks,
  withVisitedLinks,
} from '../experience/visited-links.ts';
import { skillsDone, skillsGiven } from '../gateway/given-skills.ts';
import { stopModelCalls } from '../gateway/inflight.ts';
import type { LimitReached } from '../gateway/spending.ts';
import { turnAcknowledged, turnEnded, turnSpoke, turnStarted } from '../gateway/turn-notes.ts';
import type { UsageClass } from '../gateway/usage-class.ts';
import { newId } from '../ids.ts';
import { captureAttemptVersions, captureCompletedEpisode } from '../learning/episodes.ts';
import { instanceName } from '../names.ts';
import { principalContext, requestPrincipal, spaceAuthority } from '../principals/authority.ts';
import type { RunService } from '../runs/service.ts';
import { EngineImageUnavailable } from '../runtime/cell-host.ts';
import { browserEventForPersistence, isBrowserTool } from '../workers/browser/privacy.ts';
import { type AnswerJoin, carriesOnAnswer } from './answer-join.ts';
import { type AttemptResult, attemptResult } from './attention.ts';
import { buildAttemptSkeleton, completionFacts } from './bundle.ts';
import { CAPABILITY_TTL_SECONDS, signCapability } from './capability.ts';
import { EventWrites } from './event-writes.ts';
import { FairScheduler } from './fair-scheduler.ts';
import { FenceReads, requireCurrentAttempt, requireCurrentAttemptFrom } from './fence.ts';
import { FirstLine } from './first-line.ts';
import { readGenerations, requireGenerations } from './generations.ts';
import { personWords } from './history-summary.ts';
import { HumanStream, humanOutcome } from './human-stream.ts';
import { LIMIT_REACHED_NOTE } from './limits.ts';
import { PROVIDER_FAILURE_NOTES } from './provider-notes.ts';
import { persistQuestions, resolveQuestions, withdrawSettledQuestion } from './questions.ts';
import {
  ATTEMPT_QUEUES,
  type AttemptWake,
  attemptQueue,
  QUEUES,
  RECOVERY_SCAN_SECONDS,
} from './queue.ts';
import { workQuiet } from './quiet.ts';
import { reminderHeld } from './reminder-hold.ts';
import { RUNAWAY_NOTE, RunawayReply, runawayWatch } from './runaway.ts';
import { connectionScopesForJob } from './scopes.ts';
import { type JobRow, type JobService, routineRest } from './service.ts';
import { SKILL_TRACE_KIND, skillTraceCall } from './skill-trace.ts';
import { carrySteers, pendingSteers, steersRead } from './steer.ts';
import { namingSteps, stepName, UNCONFIRMED_NOTE, unsettledQuestion } from './unsettled.ts';
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
import { openWakeTurn } from './wake-turn.ts';
import { withdrawOpenQuestion, withdrawOutdatedPermissions } from './withdraw.ts';

export const HEARTBEAT_MS = 15_000;
export const LEASE_MS = 45_000;
/**
 * What a conversation's turn ends with when its engine could not start because
 * the engine image the service started with is gone or refused.
 */
export const ENGINE_IMAGE_NOTE = `I couldn’t start the engine that does the work: the engine image ${instanceName()} started with is no longer available. Restart ${instanceName()}, or ask whoever runs it to, then send your message again.`;
/** What long work asks the person when its engine could not start that way. */
export const ENGINE_IMAGE_QUESTION = `I couldn’t start the engine that does the work: the engine image ${instanceName()} started with is no longer available. Restart ${instanceName()}, or ask whoever runs it to, then say "continue" to try again.`;
/** Why long work or a helper stopped that way, in its record. */
const ENGINE_IMAGE_WHY = `Its engine could not start: the engine image ${instanceName()} started with is no longer available.`;
/** The reason an attempt lost that way is recorded with. */
export const ENGINE_IMAGE_REASON = 'engine_image_unavailable';
/** What a conversation's turn ends with when its work was cut off and could not be resumed. */
export const LOST_NOTE = `This was interrupted before it could finish, for example because ${instanceName()} restarted while it was working. Nothing more will happen here until you send another message.`;
/** The same, when the work stopped because an app it was using was disconnected. */
export const DISCONNECTED_NOTE =
  'This stopped because an app it was using was disconnected. Nothing more will happen here until you send another message.';

/**
 * What a conversation's turn ends with when the work could not be put
 * together from what the chat has stored, so nothing was done.
 */
export const BUNDLE_FAILED_NOTE =
  'I couldn’t get started on this, so nothing was done. Send your message again to try once more.';
/** The reason such an attempt failed with, and the code the operator's log names. */
export const BUNDLE_FAILED_CODE = 'bundle_build_failed';

/** Whether a failure came from the database: a failed query, or one Postgres answered with. */
const fromDatabase = (error: unknown): boolean =>
  error instanceof DrizzleQueryError ||
  (error instanceof Error && (error.name === 'PostgresError' || 'query' in error));

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
   * `refused`, set, is the sentence that says no model the space's rules
   * allow can be used: the attempt then ends on it instead of starting.
   */
  resolveModel?: (
    tx: Transaction,
    row: JobRow,
    usageClass: UsageClass,
  ) => Promise<{ provider: string; model: string; vision?: boolean; refused?: string }>;
  scopes?: string[];
  liveConnectionScopes?: boolean;
  scopesForJob?: (tx: Transaction, row: JobRow) => Promise<string[]>;
  /** How many attempts run at once; one more waits for a free slot. */
  concurrency?: number;
  /** How many of them one person may run at once; unset, as many as there are slots. */
  concurrencyPerPerson?: number;
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
   *
   * It may read the pool, so the runner asks it before a transaction takes
   * the event order lock, never inside one.
   */
  spendingLimit?: (jobId: string, usageClass: UsageClass) => Promise<LimitReached | null>;
  /**
   * The first wait before an attempt the model provider turned away for being
   * busy or limited runs again; each later one doubles, up to four times it.
   */
  retryBackoffMs?: number;
  /**
   * A one-line acknowledgement for a conversation turn the person is waiting
   * on, shown when the agent has said nothing `afterMs` after it started.
   * Left out, or `afterMs` 0, there is none.
   */
  acknowledge?: { afterMs: number; writer: AckWriter };
  /**
   * Waits, for a few seconds at most, for what the job's newest message is
   * still having read (its pictures, `attachments/reading.ts`), so the turn it
   * starts is shown the reading. Asked before the attempt is claimed, never
   * inside its transaction; it never throws.
   */
  readings?: (jobId: string) => Promise<void>;
};

/** The spending limit a job's person has reached, for each class of work. */
type ReachedLimits = Readonly<Record<UsageClass, LimitReached | null>>;

const NO_LIMITS: ReachedLimits = { interactive: null, background: null };

/** An outcome that ends on a reached spending limit, when one holds, rather than as a failure. */
const endsOnLimit = (given: AttemptOutcome) =>
  given.kind === 'failed' || given.kind === 'budget_exhausted';

/** The first wait before a provider that was busy or limiting requests is asked again. */
export const PROVIDER_RETRY_MS = 15_000;
/** Provider failures that may clear on their own; every other one is not tried again. */
const PASSING_FAILURES: readonly ProviderFailure[] = ['rate_limited', 'provider_down'];

/**
 * A failed attempt, with the provider's refusal named when one ended it. The
 * engine may say so itself; otherwise the attempt's last model call, as the
 * gateway recorded it, does. A refusal that will not clear by waiting is not
 * tried again.
 */
async function namedFailure(
  tx: Transaction,
  attemptId: string,
  given: AttemptOutcome,
): Promise<AttemptOutcome> {
  if (given.kind !== 'failed') return given;
  let failure = given.failure;
  if (!failure) {
    const [last] = await tx
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.attemptId, attemptId),
          eq(event.type, 'notice'),
          sql`${event.payload}->>'phase' = 'model_receipt'`,
        ),
      )
      .orderBy(desc(event.seq))
      .limit(1);
    const recorded = providerFailure.safeParse((last?.payload as JsonObject | undefined)?.failure);
    if (!recorded.success) return given;
    failure = recorded.data;
  }
  return {
    ...given,
    failure,
    retryable: given.retryable && PASSING_FAILURES.includes(failure),
  };
}

/** What a turn that stopped without a question asks, when no step failed. */
export const STOPPED_QUESTION = 'I stopped before finishing. What should I do next?';

/**
 * The words a failed step gave for failing, as the person may read them: the
 * first line, cut where a raw body (JSON or a page) begins, with address
 * query strings and anything shaped like a credential taken out. A provider's
 * error often quotes the request, its key included; that never reaches the
 * question.
 */
export function failureWords(result: JsonObject): string {
  const error = result.error;
  const said =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && !Array.isArray(error)
        ? (error as JsonObject).message
        : (result.message ?? result.reason);
  const first = (plainText(said, '', 400).split(/\r?\n/, 1)[0] ?? '').replace(
    /(https?:\/\/[^\s'"?#]+)[?#][^\s'"]*/gi,
    '$1',
  );
  // A body is cut where it starts; the "[hidden]" left for a secret is not one.
  const line = /^\s*\[(?!hidden\])/.test(first) ? '' : (first.split(/[{<]/, 1)[0] ?? '');
  const text = redactSecrets(line, 400)
    .replace(/\s+/g, ' ')
    .replace(/[\s:;,-]+$/, '')
    .trim();
  if (!text) return '';
  if (text.length <= 160) return text.replace(/[.!?]+$/, '');
  return `${text.slice(0, 159).trimEnd()}…`;
}

/**
 * The question for a turn that stopped without one: why it stopped, from the
 * last step of the attempt that failed, and what the person wants done.
 */
async function stoppedQuestion(tx: Transaction, attemptId: string): Promise<string> {
  const [failed] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.attemptId, attemptId),
        eq(event.type, 'tool_result'),
        sql`${event.payload}->>'ok' = 'false'`,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(1);
  const payload = (failed?.payload ?? {}) as JsonObject;
  const result = payload.result;
  const why =
    result && typeof result === 'object' && !Array.isArray(result)
      ? failureWords(result as JsonObject)
      : '';
  return failed
    ? `I stopped because a step failed${why ? `: ${why}` : ''}. What should I do?`
    : STOPPED_QUESTION;
}

/**
 * Past the broker's longest dispatch budget and its recovery sweep, so every
 * dispatch that still has a sender has settled by then.
 */
export const DISPATCH_WAIT_MS = 16 * 60_000;

/** Turn statuses that say work is under way. */
const UNDER_WAY_TURNS = ['queued', 'working', 'streaming', 'stalled'];
/** Job states in which only the person moves the work on. */
const PERSON_WAITS = ['waiting_for_input', 'waiting_for_approval', 'needs_reconciliation'];
/**
 * How long a turn may read as under way while its job waits on the person and
 * nothing runs, before it is settled: longer than any move between the two.
 */
export const ORPHAN_TURN_MS = 30_000;

/** What the agent does that shows a stalled turn is moving again. */
const PROGRESS_EVENTS = new Set<RuntimeEvent['type']>([
  'text_delta',
  'reasoning_delta',
  'tool_call_proposed',
  'tool_result',
]);

/** Action statuses that are not settled yet: waiting to be sent, sent, or unsure. */
const OPEN_STEPS = [
  'needs_approval',
  'approved',
  'admitted',
  'dispatched',
  'unknown',
  'unresolved',
];

/**
 * Whether this wake of a conversation only brings news of its answered turn's
 * steps, all of it good: the turn's last attempt finished with its answer,
 * nothing new came from the person or anything else, no step is open, and
 * every step that settled after that answer went through.
 */
async function answeredTurnSettled(
  tx: Transaction,
  row: JobRow,
  previous: typeof attempt.$inferSelect | undefined,
  bundle: ResponsibilityAttemptBundle,
): Promise<boolean> {
  if (row.kind !== 'chat' || !row.currentTurnId || !previous?.endedAt) return false;
  if (previous.turnId !== row.currentTurnId || previous.outcome !== 'completed') return false;
  const { inputs } = bundle;
  if (
    inputs.new_user_messages.length ||
    inputs.approval_results.length ||
    inputs.trigger_events.length ||
    inputs.repair_briefs.length ||
    inputs.cancelled_wait
  )
    return false;
  return stepsWentThrough(tx, row.id, previous.endedAt);
}

/** No step is open, and every step that settled after `answeredAt` went through. */
async function stepsWentThrough(tx: Transaction, jobId: string, answeredAt: Date) {
  const steps = await tx
    .select({ status: action.status, resolvedAt: action.resolvedAt })
    .from(action)
    .where(eq(action.jobId, jobId));
  return steps.every(
    (step) =>
      !OPEN_STEPS.includes(step.status) &&
      (!step.resolvedAt ||
        step.resolvedAt.getTime() < answeredAt.getTime() ||
        step.status === 'succeeded'),
  );
}

/**
 * `answeredTurnSettled` for a wake whose bundle could not be built, read from
 * the rows the bundle would have read its inputs from. It leans toward "not
 * settled": anything that could be news for the turn (a message, a decision, a
 * trigger, a wait the wake cancelled) leaves it to fail as an unbuilt turn does.
 */
async function answeredTurnSettledUnbuilt(
  tx: Transaction,
  row: JobRow,
  previous: typeof attempt.$inferSelect | undefined,
): Promise<boolean> {
  if (row.kind !== 'chat' || !row.currentTurnId || !previous?.endedAt) return false;
  if (previous.turnId !== row.currentTurnId || previous.outcome !== 'completed') return false;
  const wait = waitSpec.safeParse(row.wait);
  if (!wait.success || wait.data.kind === 'event' || wait.data.kind === 'timer') return false;
  const [news] = await tx
    .select({ seq: event.seq })
    .from(event)
    .where(
      and(
        eq(event.jobId, row.id),
        gt(event.seq, previous.inputCursor),
        or(
          eq(event.type, 'approval_decided'),
          and(
            eq(event.type, 'notice'),
            sql`${event.payload}->>'kind' in ('user_message', 'trigger_event')`,
          ),
        ),
      ),
    )
    .limit(1);
  if (news) return false;
  return stepsWentThrough(tx, row.id, previous.endedAt);
}

/**
 * The saved answer of a turn whose attempt carried on from an answer already
 * in (`carriesOnAnswer`): what the turn said before this attempt, then what
 * this attempt added, the way a finished turn keeps an attempt's final words
 * rather than everything it streamed (a reply cut back after it looped keeps
 * its first copy). An attempt that added nothing leaves the turn as it is;
 * so does one whose streamed words cannot be told apart from the rest.
 */
async function carriedOnAnswer(
  tx: Transaction,
  turnId: string,
  attemptId: string,
  added: string,
): Promise<{ answer?: string }> {
  if (!added.trim()) return {};
  const [turn] = await tx
    .select({ answer: experienceTurn.answer })
    .from(experienceTurn)
    .where(eq(experienceTurn.id, turnId));
  const current = turn?.answer ?? '';
  // Only words written while this attempt was current reached the turn.
  const pieces = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.attemptId, attemptId), eq(event.type, 'text_delta')))
    .orderBy(asc(event.seq));
  const streamed = pieces
    .map((piece) => piece.payload as { text?: unknown; late?: unknown } | null)
    .filter((payload) => payload?.late !== true && typeof payload?.text === 'string')
    .map((payload) => String(payload?.text))
    .join('');
  // This attempt's words joined the turn's as a paragraph of their own.
  const before = !streamed
    ? current
    : current === streamed
      ? ''
      : current.endsWith(`\n\n${streamed}`)
        ? current.slice(0, current.length - streamed.length - 2)
        : null;
  if (before === null) return {};
  return { answer: before.trim() ? `${before}\n\n${added}` : added };
}

/** The question a turn rests on when something it started has not reported back. */
export const STILL_RUNNING_NOTE =
  'Something this turn started has not reported back yet. Its result will show here once it does, so nothing was run again.';
export type ClaimedAttempt = {
  bundle: ResponsibilityAttemptBundle;
  claims: CapabilityClaims;
  /** Set when the attempt answers a turn of a person's conversation. */
  turn?: ConversationTurn;
};
/** The conversation turn an attempt answers. */
type ConversationTurn = {
  turnId: string;
  spaceId: string;
  principalId?: string;
  /** The person is waiting on it: their message started it. */
  interactive: boolean;
  /**
   * An earlier attempt of the turn showed the acknowledgement and nothing has
   * been said in the turn since: this attempt's first words are judged
   * against it (`FirstLine`).
   */
  acknowledged?: boolean;
};

/**
 * Whether the turn's acknowledgement has been shown and is still the last
 * thing the person read in it: no words of the agent's, and no line it said,
 * since. A dropped plan line was recorded as empty text and counts as nothing.
 */
async function acknowledgedInSilence(
  tx: Transaction,
  jobId: string,
  turnId: string,
): Promise<boolean> {
  const [said] = await tx
    .select({
      acknowledged: sql<boolean>`coalesce(bool_or(${event.type} = 'notice' and ${event.payload}->>'acknowledgement' = 'true'), false)`,
      spoken: sql<boolean>`coalesce(bool_or(not (${event.type} = 'notice' and ${event.payload}->>'acknowledgement' = 'true')), false)`,
    })
    .from(event)
    .innerJoin(attempt, eq(attempt.id, event.attemptId))
    .where(
      and(
        eq(event.jobId, jobId),
        eq(attempt.turnId, turnId),
        sql`((${event.type} = 'text_delta' and btrim(${event.payload}->>'text') <> '')
          or (${event.type} = 'notice' and ${event.payload}->>'kind' = 'experience_say'))`,
      ),
    );
  return Boolean(said?.acknowledged) && !said?.spoken;
}
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
  /** Only record callbacks share a transaction here; none changes authority. */
  private readonly fenceReads = new WeakMap<Transaction, FenceReads>();
  private readonly eventWrites = new EventWrites((operation) => this.jobs.transaction(operation));
  private workerStarted = false;
  private stopping = false;
  scheduler: FairScheduler;
  private readonly wakes = new Set<Promise<void>>();
  /** Wakes waiting in the scheduler for their person's own limit, by job, epoch and version. */
  private readonly held = new Set<string>();
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
    this.scheduler = new FairScheduler(this.concurrency, this.perPerson);
    jobs.onCancelled = (id) => this.interrupt(id);
    jobs.stopTurn = (tx, row) => this.stopTurn(tx, row);
  }

  private get concurrency() {
    return this.options.concurrency ?? DEFAULT_ATTEMPT_CONCURRENCY;
  }

  private get perPerson() {
    return this.options.concurrencyPerPerson ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Whose turn a wake is, for sharing slots fairly: the person whose calls it
   * will make, as spending charges them (`PERSON_FOR_JOB` in
   * gateway/spending.ts): whoever spoke last in its conversation, else the
   * job's person, else its space's owner. A job that is gone has nobody, and
   * its wake is dropped when it runs.
   */
  async personForWake(jobId: string): Promise<string | undefined> {
    const [row] = await this.jobs.db
      .select({
        person: sql<string | null>`coalesce(
          (select ${event.payload}->>'principal_id' from ${event}
            where ${event.jobId} = ${job.id} and ${event.type} = 'notice'
              and ${event.payload}->>'kind' = 'user_message'
              and ${event.payload}->>'principal_id' is not null
            order by ${event.seq} desc limit 1),
          ${job.principalId}, ${space.ownerPrincipalId})`,
      })
      .from(job)
      .innerJoin(space, eq(space.id, job.spaceId))
      .where(eq(job.id, jobId));
    return row?.person ?? undefined;
  }

  private get leaseMs() {
    return this.options.leaseMs ?? LEASE_MS;
  }

  /**
   * The spending limits this job's person has reached, for either class of
   * work. The totals are read on the pool, so this runs before a transaction
   * takes the event order lock: a pool read while it is held waits behind
   * every event writer queued on it. The guard keeps its totals for a moment
   * anyway, so a reading taken just before the lock is as current as one
   * taken under it.
   */
  private async reachedLimits(jobId: string): Promise<ReachedLimits> {
    const read = this.options.spendingLimit;
    if (!read) return NO_LIMITS;
    // One after the other, so the second is answered from the totals the first read.
    const interactive = await read(jobId, 'interactive');
    const background = await read(jobId, 'background');
    return { interactive, background };
  }

  async claim(wake: AttemptWake): Promise<ClaimedAttempt | null> {
    await this.options.readings?.(wake.job_id);
    const capabilities = await this.runtime.capabilities();
    const limits = await this.reachedLimits(wake.job_id);
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
      // The state version the timer's own transition made: one per firing.
      let timerFired: number | null = null;
      if (row.state === 'waiting_for_event_or_time') {
        row = await this.jobs.move(tx, row, { kind: 'timer_fired' }, { reason: 'timer' });
        timerFired = row.stateVersion;
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
      // A conversation's own timer answers in a new message, at the time it fired.
      if (timerFired) row = await openWakeTurn(tx, row, `timer:${timerFired}`);
      // A question left from before the request changed is closed first, so
      // this attempt is told it was withdrawn rather than that it is pending.
      await withdrawOutdatedPermissions(tx, row.id);
      // So is a conversation's question about steps that have all settled since:
      // whatever this wake does, nothing is left to ask about them.
      if (row.kind === 'chat') await withdrawSettledQuestion(tx, row.id);
      const access = await spaceAuthority(tx, row.spaceId, row.principalId, true);
      const chosen: { provider: string; model: string; vision?: boolean; refused?: string } =
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
      // A bundle that cannot be built from what is stored would fail the same
      // way on every wake, so the turn ends on it below instead of waiting
      // queued for ever. A failed statement has already ended the transaction
      // and may well pass next time: that is retried as before.
      let bundle: ResponsibilityAttemptBundle | null = null;
      let unbuilt = 'Error';
      try {
        bundle = await buildAttemptSkeleton(
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
      } catch (error) {
        if (fromDatabase(error)) throw error;
        // The class's name, never a message; a name that is not one is not logged.
        if (error instanceof Error && /^\w{1,64}$/.test(error.name)) unbuilt = error.name;
      }
      if (bundle && this.options.loadCatalog)
        Object.assign(bundle, await this.options.loadCatalog(tx, claims, bundle));
      await tx.insert(attempt).values({
        id: attemptId,
        principalId: access.principalId,
        // A room request runs as the room; this keeps who asked for it.
        requestedByPrincipalId: row.requestedByPrincipalId,
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
      if (bundle)
        await captureAttemptVersions(tx, bundle, capabilities.version, capabilities.workspace);
      // The attempt is told its wait was cancelled; this row is what lets its
      // outcome restore that wait, once, if it finishes without choosing another.
      if (bundle?.inputs.cancelled_wait)
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
        await this.finish(tx, row, attemptId, settled, limits);
        return null;
      }
      // A conversation turn whose answer is in, woken only because steps it
      // left open have since gone through, has nothing for a model to do: the
      // steps show on the turn's record and the answer stands. Running the
      // turn would answer it a second time. A step that failed instead goes to
      // an attempt, which is shown what was already said (`said_this_turn`).
      // A bundle that could not be built is no reason to fail a turn already
      // answered: the same question is asked of the rows instead.
      if (
        bundle
          ? await answeredTurnSettled(tx, row, previous, bundle)
          : await answeredTurnSettledUnbuilt(tx, row, previous)
      ) {
        await this.finish(
          tx,
          row,
          attemptId,
          { kind: 'completed', summary: '', evidence: [] },
          limits,
        );
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
        await this.finish(
          tx,
          row,
          attemptId,
          { kind: 'waiting_for_input', question: WAKE_GUARD_QUESTION },
          limits,
        );
        await tellOnce(tx, row, WAKE_GUARD_QUESTION, `wake-guard:${row.id}:${attemptId}`);
        return null;
      }
      // A space whose rules allow no model that can be used starts no engine
      // either: the turn ends on the sentence that says so, as it would at a
      // spending limit, rather than as a failure to run again.
      if (chosen.refused) {
        await unread();
        await this.finish(
          tx,
          row,
          attemptId,
          { kind: 'budget_exhausted', summary: chosen.refused },
          limits,
          [],
          chosen.refused,
        );
        return null;
      }
      // Past a spending limit no engine is started: the turn, routine run or
      // background job ends at once with the sentence that says when it resets.
      // Background long work instead rests until then, keeping what arrives
      // for it, and the person is told the limit once, in its own words.
      const capped = limits[cause.usageClass];
      if (capped) await unread();
      if (capped && cause.usageClass === 'background' && isRunKind(row.kind)) {
        await this.finish(
          tx,
          row,
          attemptId,
          {
            kind: 'waiting_for_event_or_time',
            wait: { kind: 'timer', wake_at: capped.resetsAt.toISOString() },
          },
          limits,
        );
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
        await this.finish(
          tx,
          row,
          attemptId,
          { kind: 'budget_exhausted', summary: capped.message },
          limits,
        );
        return null;
      }
      // No engine starts on a bundle that could not be built. The work fails
      // once, with a plain sentence where the person reads the turn, and the
      // operator's log names what failed, never what was said.
      if (!bundle) {
        console.error(`attempt: ${BUNDLE_FAILED_CODE}:${unbuilt} (job ${row.id})`);
        // Nothing read what the person sent, so the next turn reads it as new.
        await unread();
        await this.finish(
          tx,
          row,
          attemptId,
          { kind: 'failed', reason: BUNDLE_FAILED_CODE, retryable: false },
          limits,
          [],
          BUNDLE_FAILED_NOTE,
        );
        if (row.currentTurnId)
          await tx
            .update(experienceTurn)
            .set({
              answer: sql`case when ${experienceTurn.answer} = '' then ${BUNDLE_FAILED_NOTE}
                else ${experienceTurn.answer} || ${`\n\n${BUNDLE_FAILED_NOTE}`} end`,
            })
            .where(
              and(eq(experienceTurn.id, row.currentTurnId), eq(experienceTurn.status, 'failed')),
            );
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
      // Words sent while the job waited to start are this attempt's new messages.
      await steersRead(tx, row.id, attemptId, Number(latest?.seq ?? 0));
      const turn: ConversationTurn | undefined =
        row.kind === 'chat' && row.currentTurnId
          ? {
              turnId: row.currentTurnId,
              spaceId: row.spaceId,
              ...(access.principalId ? { principalId: access.principalId } : {}),
              interactive: cause.usageClass === 'interactive',
              ...((await acknowledgedInSilence(tx, row.id, row.currentTurnId))
                ? { acknowledged: true }
                : {}),
            }
          : undefined;
      return { bundle, claims, ...(turn ? { turn } : {}) };
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
    const value = this.runtimeValue(claims, input);
    await this.write(claims, [value]);
  }

  /**
   * Several runtime events of one attempt, in order, recorded in one
   * transaction: one turn of the event order lock instead of one each. Each
   * place in the result is that event's failure, or null once it is recorded.
   * When any of them fails, the shared transaction keeps none of them and each
   * is recorded again on its own, so each fails or is kept exactly as it would
   * have been alone.
   */
  async emitMany(
    claims: CapabilityClaims,
    inputs: readonly RuntimeEvent[],
  ): Promise<({ error: unknown } | null)[]> {
    const alone = async (input: RuntimeEvent) =>
      this.emit(claims, input).then(
        () => null,
        (error: unknown) => ({ error }),
      );
    if (inputs.length === 1 && inputs[0]) return [await alone(inputs[0])];
    try {
      const values = inputs.map((input) => this.runtimeValue(claims, input));
      await this.write(claims, values);
      return inputs.map(() => null);
    } catch {
      const results: ({ error: unknown } | null)[] = [];
      for (const input of inputs) results.push(await alone(input));
      return results;
    }
  }

  /** Ready runtime writes share a commit; each caller keeps its request authority. */
  private write(claims: CapabilityClaims, values: readonly RuntimeEvent[]): Promise<void> {
    const principal = requestPrincipal();
    let answering = false;
    return this.eventWrites.write(
      (tx) => {
        const record = () => {
          // Capture when this operation runs, after any preceding write of the
          // same attempt. A shared rollback restores these snapshots in reverse.
          answering = this.answering.has(claims.attempt_id);
          return this.record(tx, claims, values);
        };
        // Clear an inherited caller for trusted internal writes without leaving
        // the transaction's separate lock-guard scope.
        return principal ? principalContext.run(principal, record) : principalContext.exit(record);
      },
      () => {
        if (!answering) this.answering.delete(claims.attempt_id);
      },
    );
  }

  private runtimeValue(claims: CapabilityClaims, input: RuntimeEvent): RuntimeEvent {
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
    return value;
  }

  /** Record runtime events of one attempt, in order, in the transaction given. */
  private async record(
    tx: Transaction,
    claims: CapabilityClaims,
    values: readonly RuntimeEvent[],
  ): Promise<void> {
    const records = await this.jobs.lockRuntime(
      tx,
      claims.job_id,
      claims.attempt_id,
      values.map((value) => value.dedup_key),
    );
    if (!records?.attempt) throw new ServiceError('stale_epoch', 'Attempt not found.');
    const { job: row, attempt: execution } = records;
    const recorded = new Set(records.recorded);
    const fresh = values.filter((value) => !recorded.has(value.dedup_key));
    if (!fresh.length) return;
    let current = true;
    let fenced: unknown;
    try {
      let reads = this.fenceReads.get(tx);
      if (!reads) {
        reads = new FenceReads(tx);
        this.fenceReads.set(tx, reads);
      }
      await requireCurrentAttemptFrom(
        tx,
        claims,
        { job: row, attempt: execution },
        { settling: true },
        reads,
      );
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      current = false;
      fenced = error;
    }
    if (
      current &&
      fresh.every(
        (value, index): value is Extract<RuntimeEvent, { type: 'text_delta' }> =>
          value.type === 'text_delta' && value.local_seq === execution.runtimeCursor + index + 1,
      )
    ) {
      await this.recordText(tx, row, execution.id, fresh);
      return;
    }
    // Where the attempt's stream stands, event by event; saved once, after the last.
    let cursor = execution.runtimeCursor;
    let usage: Extract<RuntimeEvent, { type: 'attempt_outcome' }>['usage'];
    for (const value of fresh) {
      if (!current && value.type !== 'tool_result') throw fenced;
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
          epoch: row.leaseEpoch,
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
      if (value.local_seq <= cursor)
        throw new ServiceError('invalid_event', 'Runtime events arrived out of order.', 400);
      if (value.local_seq > cursor + 1) {
        await this.gap(tx, execution.id, row, `stream:${cursor + 1}:${value.local_seq}`, {
          from_local_seq: cursor + 1,
          to_local_seq: value.local_seq - 1,
        });
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
      if (current && row.currentTurnId) {
        if (value.type === 'text_delta')
          await this.recordAnswer(tx, row, execution.id, value, value.text);
        else await this.liveness(tx, row, execution.id, value);
      }
      const payload: JsonObject =
        persisted.type === 'attempt_outcome'
          ? { ...persisted, kind: 'attempt_outcome' }
          : { ...persisted, late: !current };
      await appendEvent(tx, {
        jobId: row.id,
        epoch: row.leaseEpoch,
        attemptId: execution.id,
        type,
        payload,
        dedupKey: value.dedup_key,
      });
      cursor = value.local_seq;
      if (value.type === 'attempt_outcome' && value.usage) usage = value.usage;
    }
    await tx
      .update(attempt)
      .set({ runtimeCursor: cursor, ...(usage ? { usage } : {}) })
      .where(eq(attempt.id, execution.id));
  }

  /** Each chunk records its answer, original events and cursor together in one statement. */
  private async recordText(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    values: readonly Extract<RuntimeEvent, { type: 'text_delta' }>[],
  ): Promise<void> {
    // Bound the parameters of each statement even for a caller handing over a long stream.
    for (let start = 0; start < values.length; start += 64) {
      const chunk = values.slice(start, start + 64);
      const first = chunk[0];
      const last = chunk.at(-1);
      if (!first || !last) return;
      const joining = Boolean(row.currentTurnId) && !this.answering.has(attemptId);
      if (joining) this.answering.add(attemptId);
      const join = joining
        ? this.answerJoinQuery(attemptId, row.id)
        : sql`select 'none'::text as mode`;
      const text = chunk.map((value) => value.text).join('');
      const mode = sql`coalesce((select mode from join_mode), 'none')`;
      const answer = sql`case when ${mode} = 'replace' then ${text}
        when ${mode} = 'separate' then case when ${experienceTurn.answer} = '' then ${text}
          else ${experienceTurn.answer} || ${`\n\n${text}`} end
        else ${experienceTurn.answer} || ${text} end`;
      const words = sql.join(
        chunk.map(
          (value, index) => sql`(${index}::integer, 'text_delta'::text,
            ${JSON.stringify({ ...value, late: false })}::jsonb, ${value.dedup_key}::text)`,
        ),
        sql`, `,
      );
      // The resumed notice and words share one ordered insert: no empty notice
      // insert, and no later writer can commit until this transaction ends.
      await tx.execute(sql`with join_mode as materialized (${join}), prior as materialized (
          select id, status from ${experienceTurn}
          where ${experienceTurn.id} = ${row.currentTurnId} for update
        ), updated_turn as (
          update ${experienceTurn} set answer = ${answer}, status = 'streaming'
          from prior where ${experienceTurn.id} = prior.id returning prior.status
        ), source(ordinal, type, payload, dedup_key) as (
          select -1, 'notice'::text,
            ${JSON.stringify({ kind: 'turn_resumed', turn_id: row.currentTurnId })}::jsonb,
            ${`${first.dedup_key}:resumed`}::text
          from updated_turn where status = 'stalled'
          union all
          select * from (values ${words}) as words(ordinal, type, payload, dedup_key)
        ), inserted as (
          insert into ${event} (job_id, epoch, attempt_id, type, payload, dedup_key)
          select ${row.id}, ${row.leaseEpoch}, ${attemptId}, type, payload, dedup_key
          from source order by ordinal
          on conflict (dedup_key) do nothing returning seq
        ), advanced as (
          update ${attempt} set runtime_cursor = ${last.local_seq} where id = ${attemptId}
        )
        select pg_notify('melete_events', max(seq)::text) from inserted having count(*) > 0`);
    }
  }

  /** Preserve the first answer join and a stalled turn's notice in the same turn-row write. */
  private async recordAnswer(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    first: Extract<RuntimeEvent, { type: 'text_delta' }>,
    text: string,
  ): Promise<void> {
    if (!row.currentTurnId) return;
    // Only the first piece replaces a lost answer or starts a new paragraph.
    const join = await this.firstAnswerJoin(tx, attemptId, row.id);
    const answer =
      join === 'replace'
        ? sql`${text}`
        : join === 'separate'
          ? sql`case when ${experienceTurn.answer} = '' then ${text}
              else ${experienceTurn.answer} || ${`\n\n${text}`} end`
          : sql`${experienceTurn.answer} || ${text}`;
    const [prior] = await tx.execute<{ status: string }>(sql`with prior as materialized (
        select id, status from ${experienceTurn} where ${experienceTurn.id} = ${row.currentTurnId} for update
      )
      update ${experienceTurn} set answer = ${answer}, status = 'streaming'
      from prior where ${experienceTurn.id} = prior.id returning prior.status`);
    if (prior?.status === 'stalled')
      await appendEvent(tx, {
        jobId: row.id,
        epoch: row.leaseEpoch,
        attemptId,
        type: 'notice',
        payload: { kind: 'turn_resumed', turn_id: row.currentTurnId },
        dedupKey: `${first.dedup_key}:resumed`,
      });
  }

  /**
   * A turn whose agent went quiet reads as stalled, not working, until the
   * agent shows progress again: words, reasoning or a step. The stream is told
   * both ways, so a page following it live shows what a reload would.
   */
  private async liveness(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    value: RuntimeEvent,
  ): Promise<void> {
    const turnId = row.currentTurnId;
    if (!turnId) return;
    if (value.type === 'stalled') {
      await tx
        .update(experienceTurn)
        .set({ status: 'stalled' })
        .where(
          and(
            eq(experienceTurn.id, turnId),
            inArray(experienceTurn.status, ['queued', 'working', 'streaming']),
          ),
        );
      return;
    }
    if (!PROGRESS_EVENTS.has(value.type)) return;
    const [resumed] = await tx
      .update(experienceTurn)
      .set({ status: value.type === 'text_delta' ? 'streaming' : 'working' })
      .where(and(eq(experienceTurn.id, turnId), eq(experienceTurn.status, 'stalled')))
      .returning({ id: experienceTurn.id });
    if (resumed)
      await appendEvent(tx, {
        jobId: row.id,
        epoch: row.leaseEpoch,
        attemptId,
        type: 'notice',
        payload: { kind: 'turn_resumed', turn_id: turnId },
        dedupKey: `${value.dedup_key}:resumed`,
      });
  }

  private async gap(
    tx: Transaction,
    attemptId: string,
    row: Pick<JobRow, 'id' | 'leaseEpoch'>,
    key: string,
    detail: JsonObject = {},
  ) {
    await appendEvent(tx, {
      jobId: row.id,
      epoch: row.leaseEpoch,
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
    const limits = endsOnLimit(envelope.outcome)
      ? await this.reachedLimits(claims.job_id)
      : NO_LIMITS;
    return this.jobs.transaction(async (tx) => {
      const active = await requireCurrentAttempt(tx, claims, { settling: true });
      const row = await this.finish(
        tx,
        active.job,
        claims.attempt_id,
        envelope.outcome,
        limits,
        envelope.questions,
      );
      return (await this.carrySteers(tx, row)) ?? row;
    });
  }

  /**
   * A conversation whose turn ended with words the person sent during it
   * still unread: they become its next turn, queued now. A turn that rests on
   * the person (an approval, a reconciliation) or will run again keeps them
   * for that attempt, which reads them as new messages.
   */
  private async carrySteers(tx: Transaction, row: JobRow): Promise<JobRow | null> {
    if (row.kind !== 'chat' || row.paused) return null;
    const ended = row.state === 'waiting_for_input' || row.state === 'completed';
    if (!ended) return null;
    return carrySteers(tx, row, (current) =>
      this.jobs.move(
        tx,
        current,
        {
          kind: (CONTINUABLE_STATES as readonly string[]).includes(current.state)
            ? 'conversation_continued'
            : 'user_input_received',
        },
        { reason: 'input' },
      ),
    );
  }

  /**
   * Hand the conversation's running attempt the words the person sent during
   * it, when this process runs that attempt. What it cannot take is carried
   * when the turn ends (`carrySteers`).
   */
  async steer(jobId: string): Promise<void> {
    const running = [...this.active.values()].find((entry) => entry.jobId === jobId);
    if (!running || !this.runtime.steer) return;
    const [current] = await this.jobs.db
      .select({ cursor: attempt.inputCursor })
      .from(attempt)
      .where(eq(attempt.id, running.attemptId));
    if (!current) return;
    const waiting = await pendingSteers(this.jobs.db, jobId);
    for (const message of waiting)
      if (message.seq > current.cursor)
        await this.runtime.steer(running.attemptId, { id: message.id, text: message.text });
  }

  /**
   * The wait this attempt was told had been cancelled, if it can still fire:
   * its trigger is still registered and enabled on this job, or its timer is
   * still ahead (a conversation's reminder that fell due meanwhile fires at
   * once), and no effect is pending that a wait would have to outrank.
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
    // The person cancelled it during this attempt (run.stop): it stays gone,
    // for a retry of this turn too.
    const [dropped] = await tx
      .select({ seq: event.seq })
      .from(event)
      .where(and(eq(event.dedupKey, `${attemptId}:wait-dropped`), eq(event.jobId, row.id)))
      .limit(1);
    if (dropped) return null;
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
    // A conversation's reminder is its own message to the person: one that came
    // due while a reply was written is put back all the same and fires at once,
    // late but never lost. Other work woken after its timer's time has nothing
    // left to wait for.
    // A reminder held from another conversation comes back still held (the
    // move is told it is restoring), and one whose time passed while held has
    // nothing left to come back to.
    if (wait.kind === 'timer') {
      const ahead = Date.parse(wait.wake_at) > (await databaseNow(tx)).getTime();
      if (row.kind === 'chat' && !ahead && (await reminderHeld(tx, row.id, wait.wake_at)))
        return null;
      return row.kind === 'chat' || ahead ? wait : null;
    }
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
   * (`delivery-claims.ts`), and a sentence that says it sent, saved, added,
   * booked or closed something, or worked in the browser, with no action in
   * the turn that did, is taken out (`claims.ts` in the runtime package).
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
    // A closing links line names each page once.
    // A sentence that still claims a step no action in the turn took is taken out,
    // and so is a line about the agent's own workings ("Let me check…").
    const summary = withoutNarration(
      withoutUnbackedClaims(
        withDeliveryNote(
          withoutRepeatedLinks(withVisitedLinks(checked.text, pagesVisited(reads))),
          reads,
        ),
        reads.map((read) => read.kind),
      ),
    );
    return summary !== given.summary ? { ...given, summary } : given;
  }

  private async finish(
    tx: Transaction,
    row: JobRow,
    attemptId: string,
    given: AttemptOutcome,
    /** The spending limits reached for this job, read before the transaction (`reachedLimits`). */
    limits: ReachedLimits,
    raised: readonly QuestionSpec[] = [],
    /**
     * The sentence a conversation turn stopped short ends on, in place of the
     * general one, when the reason is one the person can act on: a limit it
     * reached, or a failure that ends it.
     */
    limitNote?: string,
  ): Promise<JobRow> {
    // An attempt whose model calls were refused at a spending limit ends on
    // that limit, not as a failure to run again while it still holds.
    const capped = endsOnLimit(given)
      ? (limits[await usageClassOf(tx, attemptId)]?.message ?? null)
      : null;
    // The saved answer reads as the person saw it stream: the same plain-text
    // pass, last, after the answer's links and notes are settled.
    const original: AttemptOutcome = capped
      ? { kind: 'budget_exhausted', summary: capped }
      : humanOutcome(
          await this.citedOnlyWhatWasRead(
            tx,
            row,
            attemptId,
            await namedFailure(tx, attemptId, given),
          ),
        );
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
    let retryAfterMs = 0;
    let artifactFailures: string[] = [];
    switch (outcome.kind) {
      case 'completed': {
        const facts = await completionFacts(
          tx,
          row,
          outcome,
          this.options.artifactRoots,
          attemptId,
        );
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
        // A provider that is busy or limiting requests is given time before
        // it is asked again, longer each time.
        if (outcome.retryable && remaining > 0 && outcome.failure) {
          const base = this.options.retryBackoffMs ?? PROVIDER_RETRY_MS;
          const tried = Math.max(1, Number(counts?.n ?? 1));
          retryAfterMs = Math.min(base * 4, base * 2 ** (tried - 1));
        }
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
      const asked = namingSteps(UNCONFIRMED_NOTE, await this.openSteps(tx, attemptId));
      if (!brokerParked) wait = { kind: 'user_input', question: asked };
      carried = [unsettledQuestion(attemptId, asked), ...carried];
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
    // A conversation never waits on the person without saying what for: a turn
    // that stopped with no question asks one, naming the step that failed.
    if (row.kind === 'chat' && !parked && wait.kind === 'user_input' && !wait.question.trim())
      wait = { kind: 'user_input', question: await stoppedQuestion(tx, attemptId) };
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
      : await this.jobs.move(tx, row, input, {
          attemptId,
          wait,
          payload: { outcome },
          ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
          // Put back by itself, not chosen by this attempt: a hold on it stays.
          ...(restored !== posed && outcome === restored ? { restoring: true } : {}),
        });
    // The work runs again by itself: the turn is still under way, not failed.
    const retrying = outcome.kind === 'failed' && updated.state === 'queued';
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
    const turnStatus =
      row.currentTurnId && !retrying
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
        // A page following the turn live reads the sentence its saved copy ends on.
        ...(outcome.kind === 'budget_exhausted' && (capped ?? limitNote)
          ? { limit_note: capped ?? limitNote }
          : {}),
        ...(outcome.kind === 'failed' && !retrying && limitNote ? { failed_note: limitNote } : {}),
        ...(retrying && updated.nextWakeAt ? { retry_at: updated.nextWakeAt.toISOString() } : {}),
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
                answer: sql`case when ${experienceTurn.answer} = '' then ${capped ?? limitNote ?? LIMIT_REACHED_NOTE}
                  else ${experienceTurn.answer} || ${`\n\n${capped ?? limitNote ?? LIMIT_REACHED_NOTE}`} end`,
              }
            : row.kind === 'chat' && outcome.kind === 'failed' && outcome.failure
              ? {
                  answer: sql`case when ${experienceTurn.answer} = '' then ${PROVIDER_FAILURE_NOTES[outcome.failure]}
                  else ${experienceTurn.answer} || ${`\n\n${PROVIDER_FAILURE_NOTES[outcome.failure]}`} end`,
                }
              : // One that carried on from an answer already in keeps that
                // answer, with what it added after it, as the person saw them.
                row.kind === 'chat' && (await carriesOnAnswer(tx, attemptId))
                ? await carriedOnAnswer(
                    tx,
                    row.currentTurnId,
                    attemptId,
                    'summary' in outcome
                      ? outcome.summary
                      : outcome.kind === 'waiting_for_input'
                        ? (outcome.draft ?? '')
                        : '',
                  )
                : // A conversation's attempt that adds nothing keeps the answer its turn has.
                  'summary' in outcome && (outcome.summary || row.kind !== 'chat')
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
      // A recorded result is the work's own, never a refusal, so no spending limit applies.
      await this.finish(tx, row, attemptId, given, NO_LIMITS);
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
    await this.gap(tx, attemptId, row, 'lost');
    const run = this.runs && isRunKind(row.kind) ? this.runs : null;
    // Without its engine image every further attempt would fail the same way
    // until the service starts again, so none is made.
    const remaining =
      reason === ENGINE_IMAGE_REASON
        ? 0
        : run
          ? await run.failuresRemaining(tx, row, jobBudget.parse(row.budget))
          : Math.max(0, jobBudget.parse(row.budget).max_attempts - Number(counts?.n ?? 0));
    // A routine whose run is lost for good goes back to its schedule.
    const rest = row.state === 'running' && remaining === 0 ? await routineRest(tx, row) : null;
    // A wait the lost attempt was told had been set aside goes to its retry, as
    // it does when an attempt fails and is tried again.
    const setAside =
      row.state === 'running' && remaining > 0
        ? await this.restorableWait(tx, row, attemptId)
        : null;
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
                    reason === ENGINE_IMAGE_REASON
                      ? ENGINE_IMAGE_QUESTION
                      : 'My work on this keeps getting interrupted. Say "continue" to try again.',
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
                { attemptId, reason: 'recovery', ...(setAside ? { wait: setAside } : {}) },
              );
    const why =
      reason === ENGINE_IMAGE_REASON ? ENGINE_IMAGE_WHY : 'Its work kept getting interrupted.';
    // Long work that stops to ask gives the person what it has first.
    if (
      run &&
      row.state === 'running' &&
      moved.kind === 'run' &&
      moved.state === 'waiting_for_input'
    )
      await run.giveSoFar(tx, moved, attemptId, why);
    if (run && moved.kind === 'run_step' && moved.state === 'failed')
      await run.stepEnded(tx, moved, { kind: 'failed', retryable: false, reason: why });
    // A conversation whose last attempt was lost has ended: its turn says so,
    // in the saved copy and on the stream, instead of looking busy for ever.
    // So has a routine's run that went back to its schedule.
    const turnFailed = Boolean(row.currentTurnId) && (moved.state === 'failed' || rest !== null);
    // A disconnected app is said as such, not as a restart; so is a missing engine image.
    const note =
      reason === ENGINE_IMAGE_REASON
        ? ENGINE_IMAGE_NOTE
        : turnFailed && (await disconnectedDuring(tx, row.id, attemptId))
          ? DISCONNECTED_NOTE
          : LOST_NOTE;
    await appendEvent(tx, {
      jobId: row.id,
      attemptId,
      type: 'attempt_ended',
      payload: {
        kind: 'lost',
        reason,
        ...(turnFailed
          ? {
              outcome: { kind: 'failed', reason: note, retryable: false },
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
          answer: sql`case when ${experienceTurn.answer} = '' then ${note}
            else ${experienceTurn.answer} || ${`\n\n${note}`} end`,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(experienceTurn.id, row.currentTurnId),
            inArray(experienceTurn.status, ['queued', 'working', 'streaming', 'stalled']),
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
      // A committed outcome finished below may be a refusal at a spending limit.
      const limits = await this.reachedLimits(candidate.jobId);
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
            await this.finish(tx, row, execution.id, parsed.data, limits);
          else await this.lose(tx, row, execution.id, 'lease_expired');
          return true;
        })
        .catch(async (error: unknown) => {
          // A rejected persisted outcome must not starve the remaining recovery candidates.
          if (error instanceof ServiceError) return this.loseAttempt(candidate.id, error.code);
          throw error;
        })
        .catch((error: unknown) => {
          // Nor may any other failure: this one is logged and the rest are still recovered.
          if (databaseUnreachable(error)) throw error;
          process.stderr.write(
            `attempt recovery: ${candidate.id} not recovered: ${failureMessage(error)}\n`,
          );
          return false;
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
      await this.jobs
        .transaction(async (tx) => {
          const row = await this.jobs.lock(tx, candidate.id, true);
          if (
            !row?.nextWakeAt ||
            row.nextWakeAt.getTime() > (await databaseNow(tx)).getTime() ||
            !['queued', 'waiting_for_event_or_time'].includes(row.state)
          )
            return;
          // Held here for its person's own limit: it starts from this process,
          // and a copy would only be dropped (and kept by the queue for days).
          if (this.held.has(`${row.id}:${row.leaseEpoch}:${row.stateVersion}`)) return;
          const live = await tx.execute(
            sql`select id from pgboss.job where name = ${attemptQueue(row.schedulingClass)} and state in ('created', 'retry', 'active') and data->>'job_id' = ${row.id} and (data->>'expected_epoch')::int = ${row.leaseEpoch} and (data->>'expected_version')::int = ${row.stateVersion} limit 1`,
          );
          if (live.length === 0) await this.jobs.enqueue(tx, row, 'recovery');
        })
        .catch((error: unknown) => {
          if (databaseUnreachable(error)) throw error;
          process.stderr.write(
            `job recovery: ${candidate.id} not requeued: ${failureMessage(error)}\n`,
          );
        });
    }
    await this.settleOrphanTurns();
    await this.afterRecovery?.();
  }

  /**
   * A turn still reading as under way while its job waits on the person and
   * nothing runs it. Its attempt was ended outside the runner (a takeover, a
   * hand-off), so no outcome ever settled it, and the page would say
   * "working" for as long as nobody looked. It settles as waiting for them.
   */
  async settleOrphanTurns(graceMs = ORPHAN_TURN_MS): Promise<number> {
    const orphans = await this.jobs.db
      .select({ jobId: job.id, turnId: experienceTurn.id })
      .from(experienceTurn)
      .innerJoin(job, eq(job.currentTurnId, experienceTurn.id))
      .where(
        and(
          inArray(experienceTurn.status, UNDER_WAY_TURNS),
          inArray(job.state, PERSON_WAITS),
          sql`${job.updatedAt} <= now() - make_interval(secs => ${graceMs / 1000})`,
          sql`not exists (select 1 from ${attempt} where ${attempt.jobId} = ${job.id} and ${attempt.endedAt} is null)`,
        ),
      );
    let settled = 0;
    for (const orphan of orphans)
      await this.jobs.transaction(async (tx) => {
        const row = await this.jobs.lock(tx, orphan.jobId);
        if (!row || row.currentTurnId !== orphan.turnId || !PERSON_WAITS.includes(row.state))
          return;
        const [open] = await tx
          .select({ id: attempt.id })
          .from(attempt)
          .where(and(eq(attempt.jobId, row.id), isNull(attempt.endedAt)))
          .limit(1);
        if (open) return;
        const [turn] = await tx
          .update(experienceTurn)
          .set({ status: 'needs_you' })
          .where(
            and(
              eq(experienceTurn.id, orphan.turnId),
              inArray(experienceTurn.status, UNDER_WAY_TURNS),
            ),
          )
          .returning({ id: experienceTurn.id });
        if (!turn) return;
        await appendEvent(tx, {
          jobId: row.id,
          type: 'notice',
          payload: { kind: 'turn_settled', turn_id: turn.id, turn_status: 'needs_you' },
          dedupKey: `${turn.id}:settled:${row.stateVersion}`,
        });
        settled++;
      });
    return settled;
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
    // The gateway keeps the turn's notes while it runs (gateway/turn-notes.ts).
    if (claim.turn) turnStarted(claims.attempt_id);
    // A read of a skill given in full is a pointer while the agent still holds it.
    skillsGiven(claims.attempt_id, bundle.skills);
    // The turn's first line is said once: by the acknowledgement or by the
    // agent, never both (first-line.ts). One already shown in this turn, with
    // nothing said since, has this attempt's first words judged against it.
    const acknowledged = Boolean(claim.turn?.acknowledged);
    const acknowledging = Boolean(
      !acknowledged && claim.turn?.interactive && this.acknowledges(bundle),
    );
    // A conversation's reply that starts saying the same thing over and over
    // is stopped and cut back to its first copy (`runaway.ts`). It counts the
    // words as they are recorded, so what it keeps is what was shown.
    const runaway = claim.turn ? runawayWatch() : null;
    // The agent's words reach the record as a person would write them, the
    // same live as saved (`human-stream.ts`).
    // Stopped only once the words that showed the loop are stored, so the
    // turn's end, written next, is the last thing said.
    const watchRunaway = (event: RuntimeEvent) => {
      const loop = runaway && event.type === 'text_delta' ? runaway.see(event.text) : null;
      if (loop && !controller.signal.aborted)
        controller.abort(new RunawayReply(loop.kept, loop.copies));
    };
    const human = new HumanStream(
      async (event) => {
        await this.emit(claims, event);
        watchRunaway(event);
      },
      // What arrives while a write is under way is written together after it.
      async (events) => {
        const results = await this.emitMany(claims, events);
        for (const [index, event] of events.entries()) if (!results[index]) watchRunaway(event);
        return results;
      },
    );
    const firstLine = new FirstLine((event) => human.emit(event), acknowledging, acknowledged);
    const acknowledgement =
      acknowledging && claim.turn
        ? this.acknowledgeLater(claims, claim.turn, bundle, firstLine)
        : null;
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
        {
          emit: async (event) => {
            if (claim.turn && event.type === 'text_delta' && event.text.trim()) {
              // The agent's own words come first: no acknowledgement is needed.
              acknowledgement?.cancel();
              turnSpoke(claims.attempt_id);
            }
            return firstLine.emit(event);
          },
        },
        controller.signal,
      );
      // Words sent after this attempt was claimed and before it started reach it now.
      void this.steer(claims.job_id).catch(() => undefined);
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
      // Words still held behind an acknowledgement, then words the pass still
      // held, reach the record before the outcome does. A failure to record one
      // was the runtime's to report.
      acknowledgement?.cancel();
      await firstLine.drain().catch(() => undefined);
      await human.drain();
      // Words held until now can be the ones that show a loop: the reply is
      // still cut back to its first copy, as one seen while it streamed is.
      if (controller.signal.reason instanceof RunawayReply) throw controller.signal.reason;
      // The answer is saved as the person saw it, without a line dropped from it.
      const outcome = firstLine.settled(isOutcomeEnvelope(result) ? result.outcome : result);
      if (outcome.kind === 'completed') {
        completed = outcome;
        await this.awaitDispatched(claims, controller.signal);
      }
      await this.commitOutcome(
        claims,
        isOutcomeEnvelope(result) ? { ...result, outcome } : outcome,
      );
    } catch (error) {
      // Whatever ends the attempt, the words already said are kept as shown.
      await human.drain().catch(() => undefined);
      if (controller.signal.reason instanceof RunawayReply) {
        await this.endRunaway(claims, controller.signal.reason, controller.signal);
      } else if (
        completed &&
        error instanceof ServiceError &&
        error.code === 'actions_not_terminal' &&
        !controller.signal.aborted
      ) {
        await this.restOnOpenSteps(claims, completed.summary);
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
          error instanceof EngineImageUnavailable
            ? ENGINE_IMAGE_REASON
            : error instanceof Error
              ? error.message
              : 'runtime_crashed',
        );
      }
    } finally {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      acknowledgement?.cancel();
      if (claim.turn) turnEnded(claims.attempt_id);
      skillsDone(claims.attempt_id);
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

  /** Whether this attempt's turn may get an acknowledgement: it is on, and the person wrote something new. */
  private acknowledges(bundle: ResponsibilityAttemptBundle): boolean {
    const options = this.options.acknowledge;
    const message = [...bundle.inputs.new_user_messages]
      .reverse()
      .find((entry) => entry.role === 'user');
    return Boolean(options && options.afterMs > 0 && message?.content.trim());
  }

  /**
   * The work is done and its answer written; what it started is still out.
   * Running the turn again would do every step a second time, so the turn
   * rests on its answer until that action reports back. The person is asked
   * what to do about it, with answers to press.
   */
  private async restOnOpenSteps(claims: CapabilityClaims, draft: string): Promise<void> {
    const asked = namingSteps(
      STILL_RUNNING_NOTE,
      await this.jobs.transaction((tx) => this.openSteps(tx, claims.attempt_id)),
    );
    await this.commitOutcome(claims, {
      outcome: {
        kind: 'waiting_for_input',
        question: asked,
        ...(draft.trim() ? { draft } : {}),
      },
      questions: [unsettledQuestion(claims.attempt_id, asked)],
    }).catch(async (failure: unknown) => {
      await this.loseAttempt(
        claims.attempt_id,
        failure instanceof Error ? failure.message : 'runtime_crashed',
      );
    });
  }

  /**
   * A reply that kept repeating itself ends after its first copy, with a plain
   * line saying why, as a finished answer: the conversation waits for the
   * person's next message, and nothing is run again. The log line says only
   * that it happened, never the words.
   */
  private async endRunaway(
    claims: CapabilityClaims,
    loop: RunawayReply,
    signal: AbortSignal,
  ): Promise<void> {
    process.stderr.write(
      `runaway_reply_stopped job=${claims.job_id} attempt=${claims.attempt_id} copies=${loop.copies}\n`,
    );
    const summary = loop.kept.trim() ? `${loop.kept}\n\n${RUNAWAY_NOTE}` : RUNAWAY_NOTE;
    await this.awaitDispatched(claims, signal);
    try {
      await this.commitOutcome(claims, { kind: 'completed', summary, evidence: [] });
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'actions_not_terminal')
        await this.restOnOpenSteps(claims, summary);
      else if (
        !(
          error instanceof ServiceError && ['stale_epoch', 'revision_mismatch'].includes(error.code)
        )
      )
        await this.loseAttempt(
          claims.attempt_id,
          error instanceof Error ? error.message : 'runtime_crashed',
        );
    }
  }

  /**
   * Shows the person a one-line acknowledgement if the agent is still silent
   * `acknowledge.afterMs` after the attempt started. The line is written from
   * the person's new message alone, starting as the attempt does, so it is
   * ready by the deadline; it is shown then, or as soon as it is ready after,
   * and only while the agent has said nothing. A turn gets at most one. Once it
   * is shown, the agent's own opening line gives way to it (`firstLine`), and
   * the agent is told what was said, so it does not say it again. `cancel`
   * stops it, the call included.
   */
  private acknowledgeLater(
    claims: CapabilityClaims,
    turn: ConversationTurn,
    bundle: ResponsibilityAttemptBundle,
    firstLine: FirstLine,
  ): { cancel(): void } | null {
    const options = this.options.acknowledge;
    if (!options || !this.acknowledges(bundle)) return null;
    const stop = new AbortController();
    // Anything the person already heard in this turn, from any of its attempts:
    // the agent's words, a line it said, or an earlier acknowledgement.
    const spokeInTurn = async (tx: Transaction) => {
      const [spoken] = await tx
        .select({ seq: event.seq })
        .from(event)
        .innerJoin(attempt, eq(attempt.id, event.attemptId))
        .where(
          and(
            eq(event.jobId, claims.job_id),
            eq(attempt.turnId, turn.turnId),
            sql`((${event.type} = 'text_delta' and btrim(${event.payload}->>'text') <> '')
              or (${event.type} = 'notice' and ${event.payload}->>'kind' = 'experience_say'))`,
          ),
        )
        .limit(1);
      return Boolean(spoken);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.afterMs);
      stop.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const writing = (async () => {
      // Only what the person wrote themselves: an attached file's text or a
      // pasted email is someone else's words, and a line written from them
      // would put those words in the agent's voice.
      const own = await this.jobs.transaction(async (tx) => {
        if (await spokeInTurn(tx)) return '';
        const [sent] = await tx
          .select({ payload: event.payload })
          .from(event)
          .where(
            and(
              eq(event.jobId, claims.job_id),
              eq(event.type, 'notice'),
              sql`${event.payload}->>'kind' = 'user_message'`,
            ),
          )
          .orderBy(desc(event.seq))
          .limit(1);
        const payload = (sent?.payload ?? {}) as JsonObject;
        return typeof payload.text === 'string'
          ? personWords({ text: payload.text, pasted: payload.pasted, chosen: payload.chosen })
          : '';
      });
      if (!own.trim() || stop.signal.aborted || !firstLine.silent) return null;
      return options.writer.write({
        spaceId: turn.spaceId,
        conversationId: claims.job_id,
        ...(turn.principalId ? { principalId: turn.principalId } : {}),
        message: own.trim(),
        signal: stop.signal,
      });
    })();
    void (async () => {
      const [said] = await Promise.all([writing, deadline]);
      // The agent's words that came first win, even over a line already written.
      if (!said || stop.signal.aborted || !firstLine.beginShow()) return;
      let shown = false;
      try {
        shown = await this.jobs.transaction(async (tx) => {
          const row = await this.jobs.lock(tx, claims.job_id);
          if (!row || row.currentTurnId !== turn.turnId) return false;
          // Only while the attempt is working: once it waits on an approval or
          // a check, the person has a card in front of them already.
          await requireCurrentAttempt(tx, claims);
          // Words that reached the record while the line was written win.
          if ((await spokeInTurn(tx)) || stop.signal.aborted) return false;
          const added = await appendEvent(tx, {
            jobId: row.id,
            attemptId: claims.attempt_id,
            type: 'notice',
            payload: { kind: 'experience_say', text: said, acknowledgement: true },
            dedupKey: `ack:${turn.turnId}`,
          });
          return Boolean(added);
        });
      } finally {
        if (shown) turnAcknowledged(claims.attempt_id, said);
        // What the agent said meanwhile goes out now: held behind the line
        // when it was shown, as it came when it was not.
        void firstLine.endShow(shown).catch(() => undefined);
      }
    })().catch((error: unknown) => {
      // An acknowledgement that could not be shown is no loss: the agent's
      // own words follow, and the attempt goes on regardless. An attempt
      // that has already ended is the expected case and is not reported.
      if (error instanceof ServiceError) return;
      process.stderr.write(
        `acknowledgement not shown for ${claims.attempt_id}: ${error instanceof Error ? error.message : 'unknown error'}\n`,
      );
    });
    return {
      cancel() {
        clearTimeout(timer);
        firstLine.cancel();
        stop.abort();
      },
    };
  }

  /** How this attempt's answer text joins the turn's, for its first piece only. */
  private async firstAnswerJoin(
    tx: Transaction,
    attemptId: string,
    jobId: string,
  ): Promise<AnswerJoin> {
    if (this.answering.has(attemptId)) return 'none';
    this.answering.add(attemptId);
    const [joined] = await tx.execute<{ mode: AnswerJoin }>(this.answerJoinQuery(attemptId, jobId));
    return joined?.mode ?? 'none';
  }

  private answerJoinQuery(attemptId: string, jobId: string) {
    // The attempt and all earlier outcomes are read in the same post-lock
    // snapshot, without three client round trips for the first answer piece.
    return sql`select case
        when exists (select 1 from ${event}
          where ${event.jobId} = ${jobId} and ${event.attemptId} = ${attemptId}
            and ${event.type} = 'text_delta') then 'none'
        when not exists (select 1 from ${attempt} earlier
          where earlier.job_id = ${attempt.jobId} and earlier.turn_id = ${attempt.turnId}
            and earlier.epoch < ${attempt.epoch}) then 'none'
        when exists (select 1 from ${attempt} earlier
          where earlier.job_id = ${attempt.jobId} and earlier.turn_id = ${attempt.turnId}
            and earlier.epoch < ${attempt.epoch}
            and coalesce(earlier.outcome, 'fenced') <> 'fenced') then 'separate'
        else 'replace' end as mode
      from ${attempt} where ${attempt.id} = ${attemptId}`;
  }

  /** What this attempt's steps that have not settled are, in the person's words. */
  private async openSteps(tx: Transaction, attemptId: string): Promise<string[]> {
    const rows = await tx
      .select({ action, connection })
      .from(action)
      .leftJoin(connection, eq(connection.id, action.connectionId))
      .where(
        and(
          eq(action.attemptId, attemptId),
          inArray(action.status, ['dispatched', 'unknown', 'unresolved']),
        ),
      );
    return rows.map((row) => stepName(row.action, row.connection ?? undefined));
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
        // Only this attempt's own: a step an earlier one left out is already a
        // question to the person, and waiting on it held every later turn.
        .where(
          and(
            eq(action.jobId, claims.job_id),
            eq(action.attemptId, claims.attempt_id),
            eq(action.status, 'dispatched'),
          ),
        )
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
    this.scheduler = new FairScheduler(this.concurrency, this.perPerson);
    await this.recover();
    // Each queue hands over more wakes than can run, so one that has to wait
    // waits here, in the scheduler's fair order, where its conversation can be
    // told so, rather than unseen in the queue. One held by its person's own
    // limit lets its worker go (`scheduledWake`).
    for (const [scheduling, queue] of Object.entries(ATTEMPT_QUEUES))
      await workQuiet<AttemptWake>(
        this.jobs.boss,
        queue,
        { batchSize: 1, localConcurrency: this.concurrency * 2, pollingIntervalSeconds: 0.5 },
        async (wakes) => {
          for (const wake of wakes)
            await this.scheduledWake(scheduling as SchedulingClass, wake.data);
        },
      );
    // Existing queued hints can drain after an upgrade; all new and recovered hints use the persisted class.
    await workQuiet<AttemptWake>(
      this.jobs.boss,
      QUEUES.legacyAttempt,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (wakes) => {
        for (const wake of wakes) await this.scheduledWake('interactive', wake.data);
      },
    );
    await workQuiet(
      this.jobs.boss,
      QUEUES.recoveryScan,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async () => this.recover(),
    );
    await this.jobs.boss.schedule(QUEUES.recoveryScan, '* * * * *', {
      interval_seconds: RECOVERY_SCAN_SECONDS,
    });
  }

  private async scheduledWake(scheduling: SchedulingClass, wake: AttemptWake) {
    const key = `${wake.job_id}:${wake.expected_epoch}:${wake.expected_version}`;
    // A copy of a wake already held here (the recovery scan sent it again) is done.
    if (this.held.has(key)) return;
    try {
      const person = await this.personForWake(wake.job_id);
      const reason = this.scheduler.waitReason(person, scheduling);
      if (reason) {
        // What holds it back: every slot, or this person's own limit.
        const running =
          reason === 'person' ? this.scheduler.activeFor(person) : this.scheduler.activeCount;
        void this.noteWaiting(wake, running).catch((error: unknown) =>
          process.stderr.write(`waiting note not recorded: ${String(error)}
`),
        );
      }
      if (this.held.has(key)) return;
      if (this.scheduler.heldByOwnLimit(scheduling, person)) {
        // It waits for its person's own limit, which could take as long as
        // their running work does. It waits here instead of in the queue's
        // fetch worker, so the worker goes on to fetch other people's wakes
        // while slots are free. Its queue job is done; until it starts, the
        // recovery scan sends it again each minute, as for any wake not in the
        // queue, so one lost with this process is found again, and a copy that
        // reaches this process is dropped above.
        this.held.add(key);
        void this.scheduler
          .run(
            scheduling,
            () => {
              this.held.delete(key);
              return this.handleWake(wake);
            },
            person,
          )
          .catch((error: unknown) => {
            if (!this.stopping)
              process.stderr.write(`held wake for ${wake.job_id} failed: ${String(error)}
`);
          })
          .finally(() => this.held.delete(key));
        return;
      }
      await this.scheduler.run(scheduling, () => this.handleWake(wake), person);
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

/** Whether this attempt was fenced because a connection its job used was revoked. */
async function disconnectedDuring(tx: Transaction, jobId: string, attemptId: string) {
  const [fenced] = await tx
    .select({ seq: event.seq })
    .from(event)
    .where(
      and(
        eq(event.jobId, jobId),
        eq(event.type, 'context_invalidated'),
        sql`${event.payload}->>'attempt_id' = ${attemptId}`,
        sql`${event.payload}->>'reason' = 'connection_revoked'`,
      ),
    )
    .limit(1);
  return Boolean(fenced);
}
