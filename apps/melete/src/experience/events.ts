import {
  type BecauseLink,
  type ConversationProgress,
  conversationProgress,
  type ExperienceEvent,
  experienceEvent,
  MEMORY_TOOL_NOTICE,
  TOOL_TRACE_NOTICE,
  type ToolCall,
  type TrailStep,
  toolCall,
} from '@melete/contracts';
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { reviewView } from '../broker/auto-review.ts';
import type { Database } from '../db/client.ts';
import {
  action,
  actionReview,
  approval,
  artifact,
  attempt,
  connection,
  event,
  experienceRule,
  job,
  question,
} from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { answerJoin } from '../jobs/answer-join.ts';
import { LIMIT_REACHED_NOTE, waitingForSlotNote } from '../jobs/limits.ts';
import { ownJob, requestPrincipal } from '../principals/authority.ts';
import { AnswerStream, answerText } from './answer-filter.ts';
import type { ExperienceEffects } from './effects.ts';
import {
  object,
  plainText,
  projectActionGroup,
  projectArtifact,
  projectCards,
  projectHeldReceipt,
  projectPermissionDecision,
  projectQuestionDecision,
  projectReceipt,
} from './projectors.ts';
import {
  actionCall,
  deviceWaitCall,
  memoryCall,
  modelCall,
  retryCall,
  runtimeCall,
  sentCalls,
  toolId,
  traceCall,
} from './tools.ts';

/**
 * What a person reads when the space's awake time for the day stopped this
 * conversation's background processes, e.g. "Your computer's awake time for
 * today is used up (6 of 6 hours). Processes stopped at 14:02 UTC."
 */
export function awakeAllowanceNote(payload: Record<string, unknown>): string {
  const seconds = Number(payload.allowance_seconds);
  const hours = Number.isFinite(seconds) && seconds > 0 ? seconds / 3600 : null;
  const amount =
    hours === null
      ? ''
      : ` (${Number.isInteger(hours) ? hours : hours.toFixed(1)} of ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours)`;
  const at = typeof payload.stopped_at === 'string' ? new Date(payload.stopped_at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? ` at ${at.toISOString().slice(11, 16)} UTC` : '';
  return `Your computer's awake time for today is used up${amount}. Processes stopped${when}.`;
}

type EventRow = typeof event.$inferSelect;
/** Resolves privacy placeholders in a value against its conversation's vault. */
export type Rehydrate = (jobId: string, attemptId: string, value: unknown) => Promise<unknown>;

/** Where a tool call's resolved arguments are kept: one call of one attempt. */
const callKey = (attemptId: string, callId: string) => `${attemptId}:${callId}`;

const hasPlaceholder = (value: unknown) => JSON.stringify(value ?? null).includes('⟦');

/**
 * What a projection pass looks up through other services, resolved before the
 * event order lock is taken. Those services read on their own pool connections;
 * awaiting one while holding the lock let every other connection queue on the
 * lock while the holder waited for a free connection, which froze the service.
 */
type Lookups = {
  /** The last event the lookups cover; the locked pass reads no further. */
  upTo: number;
  permissions: Map<
    string,
    Extract<ExperienceEvent['item'], { type: 'permission' }>['permission'] | undefined
  >;
  questions: Map<
    string,
    Extract<ExperienceEvent['item'], { type: 'question' }>['question'] | undefined
  >;
  because: Map<string, BecauseLink[]>;
  /** Tool arguments with their privacy placeholders resolved, by `callKey`. */
  arguments: Map<string, unknown>;
};

/**
 * An attempt's answer and reasoning, as streamed so far. `fresh` while none of
 * its answer has been seen, so its first piece can be joined to the turn's.
 * The answer stream holds the message being written now: each tool call the
 * model makes ends the message before it (`said` marks one has text), so the
 * words written before a call are shown before the call and the next message
 * starts on a paragraph of its own (`split`).
 */
type AttemptText = {
  answer: AnswerStream;
  reasoning: AnswerStream;
  fresh: boolean;
  said: boolean;
  split: boolean;
};

/**
 * Whether an event starts a piece of work the agent's message stops before: a
 * proposed tool call, or the trace of work the engine or memory ran itself.
 */
const endsMessage = (row: { type: string; payload: unknown }): boolean => {
  if (row.type === 'tool_call_proposed') return true;
  if (row.type !== 'notice') return false;
  const kind = object(row.payload).kind;
  return kind === TOOL_TRACE_NOTICE || kind === MEMORY_TOOL_NOTICE;
};

/**
 * Where an attempt's streamed text stood before `seq`: the message being
 * written, and its reasoning since the answer last moved, which is where
 * reasoning is flushed. Read from the saved events, so a later page of the
 * stream filters exactly as one long page would have.
 */
async function attemptText(tx: Transaction, attemptId: string, seq: number): Promise<AttemptText> {
  const rows = await tx
    .select({ type: event.type, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.attemptId, attemptId),
        or(
          inArray(event.type, ['text_delta', 'reasoning_delta', 'tool_call_proposed']),
          and(
            eq(event.type, 'notice'),
            inArray(sql`${event.payload}->>'kind'`, [TOOL_TRACE_NOTICE, MEMORY_TOOL_NOTICE]),
          ),
        ),
        sql`${event.seq} < ${seq}`,
      ),
    )
    .orderBy(asc(event.seq));
  let answer = '';
  let reasoning = '';
  let any = false;
  let split = false;
  for (const row of rows) {
    if (endsMessage(row)) {
      // The message before a call ended there; the next one starts afresh.
      if (answer !== '') split = true;
      answer = '';
      continue;
    }
    const text = object(row.payload).text;
    if (typeof text !== 'string') continue;
    if (row.type === 'text_delta') {
      answer += text;
      if (text) {
        any = true;
        split = false;
      }
      reasoning = '';
    } else reasoning += text;
  }
  return {
    answer: new AnswerStream(answer),
    reasoning: new AnswerStream(reasoning),
    fresh: !any,
    said: answer !== '',
    split,
  };
}
/** The statuses the runner can leave a turn in when an attempt ends. */
const TURN_ENDINGS = new Set(['done', 'failed', 'needs_you']);
/** The trail already tells broker actions, grouped; the model itself and retries stay off it. */
const offTrail = (tool: ToolCall) =>
  tool.id.startsWith('action:') || tool.kind === 'model' || tool.kind === 'retry';

/**
 * The tool entries one raw event changes. Each is a whole copy of the entry as
 * of that event, built from the durable rows the event names, so projecting
 * late or twice tells the same story.
 */
async function toolCalls(
  tx: Transaction,
  source: EventRow,
  jobs: string[],
  spaceId: string,
  arguments_: ReadonlyMap<string, unknown>,
): Promise<ToolCall[]> {
  const payload = object(source.payload);
  // What the model gave a tool can still carry a privacy placeholder; the
  // conversation's own stream shows its real value, and only that stream. The
  // real values were looked up before the event order lock was taken.
  const real = (callId: string, value: unknown) =>
    source.attemptId && arguments_.has(callKey(source.attemptId, callId))
      ? arguments_.get(callKey(source.attemptId, callId))
      : value;
  const effect = async (actionId: unknown) => {
    if (typeof actionId !== 'string') return undefined;
    const [row] = await tx
      .select({ action, connection })
      .from(action)
      .innerJoin(connection, eq(connection.id, action.connectionId))
      .where(
        and(eq(action.id, actionId), inArray(action.jobId, jobs), eq(connection.spaceId, spaceId)),
      );
    return row;
  };
  if (source.type === 'action_requested' || source.type === 'action_status_changed') {
    const row = await effect(payload.action_id);
    if (!row) return [];
    const raw = source.type === 'action_requested' ? 'proposed' : String(payload.to ?? '');
    const [pending] =
      raw === 'needs_approval'
        ? await tx
            .select({ id: approval.id })
            .from(approval)
            .where(eq(approval.actionId, row.action.id))
            .orderBy(desc(approval.requestedAt))
            .limit(1)
        : [];
    return [
      actionCall({ ...row, raw, at: source.createdAt, approvalId: pending?.id }),
      ...sentCalls(row.action, raw, source.createdAt),
    ];
  }
  if (source.type === 'notice' && payload.phase === 'admission_rejected') {
    const row = await effect(payload.action_id);
    return row
      ? [
          actionCall({
            ...row,
            raw: 'failed',
            at: source.createdAt,
            refusal: typeof payload.code === 'string' ? payload.code : '',
          }),
        ]
      : [];
  }
  if (source.type === 'notice' && payload.phase === 'repair_parked') {
    const row = await effect(payload.action_id);
    if (row?.connection.provider === 'device')
      return [
        deviceWaitCall({
          action: row.action,
          connection: row.connection,
          key: `${row.action.id}:${source.seq}`,
          at: source.createdAt,
        }),
      ];
    return row
      ? [
          retryCall(
            toolId('action', row.action.id),
            `${row.action.id}:${source.seq}`,
            source.createdAt,
          ),
        ]
      : [];
  }
  if (source.type === 'tool_call_proposed' && source.attemptId) {
    const call = runtimeCall({
      attemptId: source.attemptId,
      callId: String(payload.call_id ?? ''),
      tool: String(payload.tool ?? ''),
      arguments: real(String(payload.call_id ?? ''), payload.arguments),
      proposedAt: source.createdAt,
    });
    return call ? [call] : [];
  }
  if (source.type === 'tool_result' && source.attemptId && typeof payload.call_id === 'string') {
    const [proposal] = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.attemptId, source.attemptId),
          eq(event.type, 'tool_call_proposed'),
          sql`${event.payload}->>'call_id' = ${payload.call_id}`,
        ),
      )
      .orderBy(asc(event.seq))
      .limit(1);
    if (!proposal) return [];
    const proposed = object(proposal.payload);
    const call = runtimeCall({
      attemptId: source.attemptId,
      callId: payload.call_id,
      tool: String(proposed.tool ?? ''),
      arguments: real(payload.call_id, proposed.arguments),
      proposedAt: proposal.createdAt,
      result: { ok: payload.ok === true, at: source.createdAt },
    });
    return call ? [call] : [];
  }
  if (source.type === 'notice' && payload.phase === 'model_request')
    return typeof payload.reservation_id === 'string'
      ? [modelCall({ reservationId: payload.reservation_id, requestedAt: source.createdAt })]
      : [];
  if (source.type === 'notice' && payload.phase === 'model_receipt') {
    if (typeof payload.reservation_id !== 'string' || !source.jobId) return [];
    const [request] = await tx
      .select({ createdAt: event.createdAt })
      .from(event)
      .where(
        and(
          eq(event.jobId, source.jobId),
          sql`${event.payload}->>'phase' = 'model_request'`,
          sql`${event.payload}->>'reservation_id' = ${payload.reservation_id}`,
        ),
      )
      .limit(1);
    return [
      modelCall({
        reservationId: payload.reservation_id,
        requestedAt: request?.createdAt ?? source.createdAt,
        receipt: {
          status: payload.status,
          latencyMs: payload.latency_ms,
          at: source.createdAt,
          stopped: payload.stopped === true,
        },
      }),
    ];
  }
  if (source.type === 'notice' && payload.kind === TOOL_TRACE_NOTICE) {
    const call = traceCall(payload.call);
    return call ? [call] : [];
  }
  if (source.type === 'notice' && payload.kind === MEMORY_TOOL_NOTICE) {
    const call = memoryCall(payload);
    return call ? [call] : [];
  }
  return [];
}

/** The copy of a tool entry this conversation last showed, as a live entry or a trail step. */
async function shownTool(tx: Transaction, jobId: string, id: string, item: 'tool' | 'action') {
  const [row] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.jobId, jobId),
        sql`${event.payload}->>'kind' = 'experience'`,
        sql`${event.payload}->'item'->>'type' = ${item}`,
        sql`${event.payload}->'item'->'tool'->>'id' = ${id}`,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(1);
  const parsed = toolCall.safeParse(object(object(row?.payload).item).tool);
  return parsed.success ? parsed.data : undefined;
}

/** Something that says an event may have been committed; see `EventStream.subscribe`. */
export type EventChanges = { subscribe(listener: () => void): () => void };
/** How long a stream waits for new events when nothing says one was committed. */
export const EXPERIENCE_POLL_MS = 1000;
/** The least time between two reads of one stream, so a burst of commits is read as one page. */
export const EXPERIENCE_READ_GAP_MS = 50;

/** Projection has its own durable rows on the existing stream; reconnects never re-label history. */
export class ExperienceEvents {
  constructor(
    readonly db: Database,
    readonly projections?: {
      permission: (
        spaceId: string,
        id: string,
      ) => Promise<
        Extract<ExperienceEvent['item'], { type: 'permission' }>['permission'] | undefined
      >;
      question: (
        spaceId: string,
        id: string,
      ) => Promise<Extract<ExperienceEvent['item'], { type: 'question' }>['question'] | undefined>;
      /** A receipt's Undo, the change it took back, or the hold a message waits in. */
      receiptState?: ExperienceEffects['receiptState'];
      /** What an action rested on, named on its receipt. */
      because?: (spaceId: string, actionId: string) => Promise<BecauseLink[]>;
      /** Real values for placeholders in what the model gave a tool. */
      rehydrate?: Rehydrate;
    },
    /** Commit notifications, so a live stream reads new events when they land rather than on its next poll. */
    readonly changes?: EventChanges,
  ) {}

  /**
   * The principal is an argument, not ambient state: a stream keeps polling
   * after the request that opened it has returned, and must keep its fence.
   */
  async sync(spaceId: string, jobId?: string, principalId = requestPrincipal()): Promise<void> {
    // Space-wide polling only revisits recent conversations; explicit requests can replay old history.
    const recentSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ids = await this.db
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          eq(job.spaceId, spaceId),
          // A routine's thread is read like a chat, so its runs project the same way.
          inArray(job.kind, ['chat', 'routine']),
          jobId ? eq(job.id, jobId) : gt(job.updatedAt, recentSince),
          ownJob(job.principalId, principalId),
        ),
      );
    // Projection appends events, so it takes the event order first like every
    // other writer; otherwise a slow commit here lands behind a later sequence
    // number that a live stream has already read past. Everything it asks
    // other services is looked up first, so nothing under the lock needs a
    // second connection, and a job with nothing new never takes the lock.
    for (const { id } of ids) {
      const lookups = await this.lookups(spaceId, id);
      if (!lookups) continue;
      await serviceTransaction(this.db, async (tx) => {
        const [row] = await tx
          .select()
          .from(job)
          .where(and(eq(job.id, id), eq(job.spaceId, spaceId)))
          .for('update');
        if (!row) return;
        const linked = await tx
          .select({ id: job.id })
          .from(job)
          .where(and(eq(job.experienceParentId, id), eq(job.spaceId, spaceId)));
        const jobs = [id, ...linked.map((item) => item.id)];
        const raw = await tx
          .select()
          .from(event)
          .where(
            and(
              inArray(event.jobId, jobs),
              gt(event.seq, row.experienceCursor),
              lte(event.seq, lookups.upTo),
              sql`coalesce(${event.payload}->>'kind', '') <> 'experience'`,
            ),
          )
          .orderBy(asc(event.seq))
          .limit(1000);
        if (!raw.length) return;
        let group = [...row.experienceGroup];
        const streams = new Map<string, AttemptText>();
        const streamed = async (source: EventRow): Promise<AttemptText> => {
          // Text with no attempt is filtered piece by piece; it has nothing to join.
          if (!source.attemptId)
            return {
              answer: new AnswerStream(),
              reasoning: new AnswerStream(),
              fresh: false,
              said: false,
              split: false,
            };
          let found = streams.get(source.attemptId);
          if (!found) {
            found = await attemptText(tx, source.attemptId, source.seq);
            streams.set(source.attemptId, found);
          }
          return found;
        };
        const emit = async (
          source: typeof event.$inferSelect,
          item: ExperienceEvent['item'],
          suffix: string = item.type,
        ) => {
          const [execution] = source.attemptId
            ? await tx
                .select({ turnId: attempt.turnId })
                .from(attempt)
                .where(eq(attempt.id, source.attemptId))
            : [];
          await appendEvent(tx, {
            jobId: id,
            attemptId: source.attemptId,
            type: 'notice',
            payload: {
              kind: 'experience',
              item,
              turn_id:
                execution?.turnId ??
                (typeof object(source.payload).turn_id === 'string'
                  ? String(object(source.payload).turn_id)
                  : row.currentTurnId),
              source_seq: source.seq,
              at: source.createdAt.toISOString(),
            },
            dedupKey: `experience:${source.seq}:${suffix}`,
          });
        };
        const flush = async (source: typeof event.$inferSelect) => {
          if (!group.length) return;
          const effects = await tx
            .select({ action, connection })
            .from(action)
            .innerJoin(connection, eq(connection.id, action.connectionId))
            .where(
              and(
                inArray(action.jobId, jobs),
                eq(connection.spaceId, spaceId),
                inArray(action.id, group),
              ),
            );
          const projected = projectActionGroup(effects);
          if (projected) await emit(source, projected, 'group');
          group = effects
            .filter(({ action }) => !['succeeded', 'failed', 'denied'].includes(action.status))
            .map(({ action }) => action.id);
        };
        for (const source of raw) {
          const payload = object(source.payload);
          // A tool call ends the message the model wrote before it: what it still
          // held back is shown now, ahead of the call, and the next words start
          // a new paragraph. Work the engine runs itself is traced before the
          // call is proposed, so its trace ends the message too.
          if (endsMessage(source) && source.attemptId) {
            const text = await streamed(source);
            if (text.said) {
              const rest = text.answer.end();
              if (rest) await emit(source, { type: 'text_delta', text: rest }, 'message_end');
              text.said = false;
              text.split = true;
            }
          }
          for (const tool of await toolCalls(tx, source, jobs, spaceId, lookups.arguments)) {
            const shown = await shownTool(tx, id, tool.id, 'tool');
            if (JSON.stringify(shown) !== JSON.stringify(tool))
              await emit(source, { type: 'tool', tool }, `tool:${tool.id}`);
            // The trail keeps one finished step for each entry it does not already tell.
            if (
              ['done', 'failed', 'unknown'].includes(tool.status) &&
              !offTrail(tool) &&
              !(await shownTool(tx, id, tool.id, 'action'))
            )
              await emit(
                source,
                {
                  type: 'action',
                  label: tool.title,
                  meta: tool.output_summary?.text ?? '',
                  sources: [],
                  tool,
                },
                `trail:${tool.id}`,
              );
          }
          const boundary =
            source.type === 'turn_started' ||
            source.type === 'attempt_ended' ||
            source.type === 'text_delta' ||
            payload.kind === 'experience_say';
          if (boundary) await flush(source);
          if (
            source.type === 'action_requested' &&
            typeof payload.action_id === 'string' &&
            !group.includes(payload.action_id)
          )
            group.push(payload.action_id);
          if (payload.kind === 'experience_say') {
            const text = plainText(payload.text, '', 600);
            if (text) await emit(source, { type: 'say', text });
          } else if (
            source.type === 'approval_requested' &&
            typeof payload.approval_id === 'string'
          ) {
            const permission = lookups.permissions.get(payload.approval_id);
            if (permission) await emit(source, { type: 'permission', permission });
          } else if (
            source.type === 'approval_decided' &&
            typeof payload.approval_id === 'string'
          ) {
            // "Always" is the approval that saved its standing rule in the same decision.
            const [rule] = await tx
              .select({ id: experienceRule.id })
              .from(experienceRule)
              .where(
                and(
                  eq(experienceRule.id, `rule_${payload.approval_id}`),
                  eq(experienceRule.spaceId, spaceId),
                ),
              );
            const decision = projectPermissionDecision({
              approvalId: payload.approval_id,
              decision: payload.decision,
              ruleSaved: Boolean(rule),
              note: payload.note,
              at: source.createdAt,
            });
            await emit(source, { type: 'decision', decision }, `decision:${decision.id}`);
          } else if (payload.kind === 'question_asked' && typeof payload.question_id === 'string') {
            const question = lookups.questions.get(payload.question_id);
            if (question) await emit(source, { type: 'question', question });
          } else if (
            payload.kind === 'question_closed' &&
            typeof payload.question_id === 'string'
          ) {
            const [closed] = await tx
              .select({ id: question.id, state: question.state, answer: question.answer })
              .from(question)
              .where(and(eq(question.id, payload.question_id), inArray(question.jobId, jobs)));
            if (closed) {
              const decision = projectQuestionDecision({
                questionId: closed.id,
                state: closed.state,
                answer: closed.answer,
                at: source.createdAt,
              });
              await emit(source, { type: 'decision', decision }, `decision:${decision.id}`);
            }
          } else if (source.type === 'text_delta') {
            // The last word of each piece waits for the next one, so a key cut across
            // two pieces is still seen whole; the attempt's end shows what is left.
            const text = await streamed(source);
            const reasoning = text.reasoning.end();
            if (reasoning) await emit(source, { type: 'reasoning', text: reasoning });
            const piece = typeof payload.text === 'string' ? payload.text : '';
            // A turn run again replaces what the lost attempt said; a turn that
            // carries on after a wait starts a new paragraph.
            const join =
              text.fresh && source.attemptId ? await answerJoin(tx, source.attemptId) : 'none';
            text.fresh = false;
            if (join === 'replace')
              await emit(source, { type: 'text_delta', text: '', restart: true }, 'answer_join');
            else if (join === 'separate' || (text.split && piece))
              await emit(source, { type: 'text_delta', text: '\n\n' }, 'answer_join');
            if (piece) {
              text.said = true;
              text.split = false;
            }
            await emit(source, {
              type: 'text_delta',
              text: source.attemptId ? text.answer.push(piece) : answerText(piece),
            });
          } else if (source.type === 'reasoning_delta') {
            // The same filter as the answer: reasoning is shown, so it is content.
            const text = await streamed(source);
            const piece = typeof payload.text === 'string' ? payload.text : '';
            const shown = source.attemptId ? text.reasoning.push(piece) : answerText(piece);
            if (shown) await emit(source, { type: 'reasoning', text: shown });
          } else if (
            source.type === 'action_status_changed' &&
            typeof payload.action_id === 'string' &&
            (payload.to === 'succeeded' ||
              // A message held before sending, and one cancelled in its hold.
              ((payload.to === 'admitted' || payload.to === 'failed') &&
                this.projections?.receiptState !== undefined))
          ) {
            const [effect] = await tx
              .select({ action, connection })
              .from(action)
              .innerJoin(connection, eq(connection.id, action.connectionId))
              .where(
                and(
                  eq(action.id, payload.action_id),
                  inArray(action.jobId, jobs),
                  eq(connection.spaceId, spaceId),
                ),
              );
            const state =
              effect &&
              this.projections?.receiptState &&
              (payload.to === 'succeeded' || effect.action.effectClass !== 'read')
                ? // A receipt whose Undo cannot be worked out is drawn without one.
                  await this.projections
                    .receiptState(spaceId, effect.action.id)
                    .catch(() => ({}) as Awaited<ReturnType<ExperienceEffects['receiptState']>>)
                : {};
            if (effect && payload.to !== 'succeeded') {
              if (state.held) {
                const held = projectHeldReceipt(
                  effect.action,
                  effect.connection,
                  'until' in state.held
                    ? { until: state.held.until, ...(state.undo ? { undo: state.undo } : {}) }
                    : state.held,
                );
                await emit(source, { type: 'receipt', receipt: held }, `held:${source.seq}`);
              }
            } else if (effect) {
              const [review] = await tx
                .select()
                .from(actionReview)
                .where(eq(actionReview.actionId, effect.action.id));
              const receipt = projectReceipt(
                effect.action,
                effect.connection,
                state.undo,
                review
                  ? reviewView({
                      decided_by: review.decidedBy,
                      outcome: review.outcome,
                      risk: review.risk,
                      reason: review.reason,
                      created_at: review.createdAt,
                    })
                  : null,
                lookups.because.get(effect.action.id),
                state.reverses,
              );
              if (receipt)
                await emit(source, {
                  type: 'receipt',
                  receipt: state.what ? { ...receipt, what: state.what } : receipt,
                });
              // A card is projected once, when its draft is freshly prepared; its
              // later status reaches the person through the conversation's drafts.
              for (const card of projectCards(effect.action, effect.connection, 'draft'))
                await emit(source, { type: 'card', card }, `card:${card.id}`);
              if (source.jobId !== id) await flush(source);
            }
          } else if (source.type === 'attempt_ended') {
            if (source.attemptId) {
              const text = await streamed(source);
              const reasoning = text.reasoning.end();
              if (reasoning) await emit(source, { type: 'reasoning', text: reasoning });
              const rest = text.answer.end();
              if (rest) await emit(source, { type: 'text_delta', text: rest });
            }
            const [execution] = source.attemptId
              ? await tx.select().from(attempt).where(eq(attempt.id, source.attemptId))
              : [];
            const outcome = object(payload.outcome);
            // Where the runner left this conversation's turn, as its saved copy has it.
            const settled =
              source.jobId === id && TURN_ENDINGS.has(String(payload.turn_status))
                ? (payload.turn_status as 'done' | 'failed' | 'needs_you')
                : null;
            if (outcome.kind === 'completed' && payload.experience_completed !== false) {
              const effects = await tx
                .select({ action, connection })
                .from(action)
                .innerJoin(connection, eq(connection.id, action.connectionId))
                .where(
                  and(
                    eq(action.jobId, id),
                    source.attemptId ? eq(action.attemptId, source.attemptId) : undefined,
                    eq(connection.spaceId, spaceId),
                  ),
                );
              const done: Extract<TrailStep, { type: 'done' }> = {
                type: 'done',
                summary: plainText(outcome.summary, 'Finished this turn.'),
                elapsed_ms: Math.max(
                  0,
                  (execution?.endedAt ?? source.createdAt).getTime() -
                    (execution?.startedAt ?? source.createdAt).getTime(),
                ),
                apps: [
                  ...new Set(
                    projectActionGroup(effects)?.sources.map((source) => source.app) ?? [],
                  ),
                ],
                source_count: projectActionGroup(effects)?.sources.length ?? 0,
              };
              await emit(source, done);
              const files = await tx
                .select()
                .from(artifact)
                .where(and(eq(artifact.jobId, id), eq(artifact.spaceId, spaceId)));
              for (const file of files)
                await emit(
                  source,
                  { type: 'card', card: projectArtifact(file) },
                  `file:${file.id}`,
                );
            } else if (payload.experience_completed === false) {
              // The saved turn ends with this sentence; a page following live reads it too.
              if (source.jobId === id && outcome.kind === 'budget_exhausted')
                await emit(source, { type: 'note', text: LIMIT_REACHED_NOTE });
              if (!settled)
                await emit(source, { type: 'status', status: 'needs_you', composer: 'send' });
            } else if (outcome.kind === 'failed')
              await emit(source, {
                type: 'note',
                text: 'I stopped before finishing. Your progress is saved.',
              });
            // The turn settles on the stream as its saved copy does, so a page
            // that followed it live reads what a reload would.
            if (settled) await emit(source, { type: 'status', status: settled, composer: 'send' });
          } else if (source.type === 'attempt_started' && source.jobId === id) {
            await emit(source, { type: 'status', status: 'working', composer: 'pause' });
          } else if (
            payload.kind === 'experience_stopped' ||
            payload.kind === 'experience_paused' ||
            payload.kind === 'experience_resumed'
          ) {
            await emit(source, {
              type: 'status',
              status:
                payload.kind === 'experience_stopped'
                  ? 'stopped'
                  : payload.kind === 'experience_paused'
                    ? 'paused'
                    : 'working',
              composer:
                payload.kind === 'experience_stopped'
                  ? 'send'
                  : payload.kind === 'experience_paused'
                    ? 'resume'
                    : 'pause',
            });
          } else if (
            source.type === 'notice' &&
            payload.kind === 'waiting_for_slot' &&
            source.jobId === id &&
            typeof payload.running === 'number'
          ) {
            await emit(source, { type: 'note', text: waitingForSlotNote(payload.running) });
          } else if (
            source.type === 'hook_event' &&
            source.jobId === id &&
            payload.name === 'on_compaction' &&
            (payload.outcome === 'succeeded' || payload.outcome === 'observed')
          ) {
            // The engine summarised the conversation so far to make room. The
            // page marks where; the summary's words never leave the engine.
            await emit(source, { type: 'compacted' });
          } else if (source.type === 'notice' && payload.kind === 'gap') {
            await emit(source, {
              type: 'note',
              text: 'Part of the answer was interrupted. The saved progress is still here.',
            });
          } else if (source.type === 'notice' && payload.kind === 'computer_busy') {
            const holder =
              typeof payload.held_by === 'string' && payload.held_by.trim()
                ? plainText(payload.held_by, 'another conversation', 120)
                : null;
            await emit(source, {
              type: 'note',
              text: holder
                ? `Waiting for the agent's computer: it is in use by "${holder}".`
                : "Waiting for the agent's computer: another conversation is using it.",
            });
          } else if (
            source.type === 'notice' &&
            payload.kind === 'processes_stopped' &&
            payload.reason === 'awake_allowance_used'
          ) {
            await emit(source, { type: 'note', text: awakeAllowanceNote(payload) });
          }
        }
        await tx
          .update(job)
          .set({
            experienceCursor: raw.at(-1)?.seq ?? row.experienceCursor,
            experienceGroup: group,
          })
          .where(eq(job.id, id));
      });
    }
  }

  /**
   * Read, without the lock, what the next projection pass of this job will
   * cover and look up what it needs from other services. Null when there is
   * nothing new. Events at or below `upTo` are already committed in sequence
   * order (every event writer takes the event order lock), so the locked pass
   * sees no event in this window that was not looked up here.
   */
  private async lookups(spaceId: string, id: string): Promise<Lookups | null> {
    const [row] = await this.db
      .select({ cursor: job.experienceCursor })
      .from(job)
      .where(and(eq(job.id, id), eq(job.spaceId, spaceId)));
    if (!row) return null;
    const linked = await this.db
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.experienceParentId, id), eq(job.spaceId, spaceId)));
    const raw = await this.db
      .select()
      .from(event)
      .where(
        and(
          inArray(event.jobId, [id, ...linked.map((item) => item.id)]),
          gt(event.seq, row.cursor),
          sql`coalesce(${event.payload}->>'kind', '') <> 'experience'`,
        ),
      )
      .orderBy(asc(event.seq))
      .limit(1000);
    const last = raw.at(-1);
    if (!last) return null;
    const lookups: Lookups = {
      upTo: last.seq,
      permissions: new Map(),
      questions: new Map(),
      because: new Map(),
      arguments: new Map(),
    };
    const projections = this.projections;
    const rehydrate = projections?.rehydrate;
    const resolve = async (source: EventRow, callId: string, value: unknown) => {
      if (!rehydrate || !source.jobId || !source.attemptId || !hasPlaceholder(value)) return;
      try {
        lookups.arguments.set(
          callKey(source.attemptId, callId),
          await rehydrate(source.jobId, source.attemptId, value),
        );
      } catch {
        // The placeholder stays as it is, as it would if nothing could resolve it.
      }
    };
    for (const source of raw) {
      const payload = object(source.payload);
      if (source.type === 'approval_requested' && typeof payload.approval_id === 'string') {
        if (projections && !lookups.permissions.has(payload.approval_id))
          lookups.permissions.set(
            payload.approval_id,
            await projections.permission(spaceId, payload.approval_id),
          );
      } else if (payload.kind === 'question_asked' && typeof payload.question_id === 'string') {
        if (projections && !lookups.questions.has(payload.question_id))
          lookups.questions.set(
            payload.question_id,
            await projections.question(spaceId, payload.question_id),
          );
      } else if (
        source.type === 'action_status_changed' &&
        payload.to === 'succeeded' &&
        typeof payload.action_id === 'string'
      ) {
        if (projections?.because && !lookups.because.has(payload.action_id))
          lookups.because.set(
            payload.action_id,
            await projections.because(spaceId, payload.action_id),
          );
      } else if (source.type === 'tool_call_proposed' && source.attemptId) {
        await resolve(source, String(payload.call_id ?? ''), payload.arguments);
      } else if (
        rehydrate &&
        source.type === 'tool_result' &&
        source.attemptId &&
        typeof payload.call_id === 'string'
      ) {
        const [proposal] = await this.db
          .select({ payload: event.payload })
          .from(event)
          .where(
            and(
              eq(event.attemptId, source.attemptId),
              eq(event.type, 'tool_call_proposed'),
              sql`${event.payload}->>'call_id' = ${payload.call_id}`,
            ),
          )
          .orderBy(asc(event.seq))
          .limit(1);
        if (proposal) await resolve(source, payload.call_id, object(proposal.payload).arguments);
      }
    }
    return lookups;
  }

  /**
   * How far a conversation's current turn has got, told from its tool entries:
   * the steps that finished and the one under way. The model's own thinking
   * and retries are not steps; thinking can still be the step under way.
   */
  async progress(
    spaceId: string,
    jobId: string,
    turnId: string,
    stage: 'under_way' | 'waiting' | 'ended',
    principalId = requestPrincipal(),
  ): Promise<ConversationProgress> {
    await this.sync(spaceId, jobId, principalId);
    const rows = await this.db
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.jobId, jobId),
          sql`${event.payload}->>'kind' = 'experience'`,
          sql`${event.payload}->>'turn_id' = ${turnId}`,
          sql`${event.payload}->'item'->>'type' = 'tool'`,
        ),
      )
      .orderBy(asc(event.seq));
    const latest = new Map<string, ToolCall>();
    for (const row of rows) {
      const parsed = toolCall.safeParse(object(object(row.payload).item).tool);
      if (!parsed.success) continue;
      // Re-inserting keeps the map in order of each entry's latest change.
      latest.delete(parsed.data.id);
      latest.set(parsed.data.id, parsed.data);
    }
    const calls = [...latest.values()];
    // While the turn runs, the latest running or waiting entry is the step under
    // way. While it waits on the person, only the entry asking for approval is.
    // Once it has ended nothing is under way, whatever was left running.
    const live =
      stage === 'under_way'
        ? ['running', 'needs_approval']
        : stage === 'waiting'
          ? ['needs_approval']
          : [];
    const current = [...calls].reverse().find((call) => live.includes(call.status));
    return conversationProgress.parse({
      steps_done: calls.filter(
        (call) =>
          !['model', 'retry'].includes(call.kind) &&
          ['done', 'failed', 'unknown'].includes(call.status),
      ).length,
      current: current?.title ?? null,
    });
  }

  async page(
    spaceId: string,
    after: number,
    jobId?: string,
    limit = 100,
    principalId = requestPrincipal(),
  ) {
    await this.sync(spaceId, jobId, principalId);
    const rows = await this.db
      .select({ event })
      .from(event)
      .innerJoin(job, eq(job.id, event.jobId))
      .where(
        and(
          eq(job.spaceId, spaceId),
          gt(event.seq, after),
          jobId ? eq(job.id, jobId) : undefined,
          ownJob(job.principalId, principalId),
          sql`${event.payload}->>'kind' = 'experience'`,
        ),
      )
      .orderBy(asc(event.seq))
      .limit(limit + 1);
    const events = rows.slice(0, limit).map(({ event: row }) => {
      const payload = object(row.payload);
      return experienceEvent.parse({
        seq: row.seq,
        conversation_id: row.jobId,
        turn_id: payload.turn_id ?? null,
        created_at: payload.at ?? row.createdAt.toISOString(),
        item: payload.item,
      });
    });
    return { events, next_cursor: events.at(-1)?.seq ?? after, has_more: rows.length > limit };
  }

  async response(
    spaceId: string,
    after: number,
    signal: AbortSignal,
    jobId?: string,
    principalId = requestPrincipal(),
  ): Promise<Response> {
    const initial = await this.page(spaceId, after, jobId, 100, principalId);
    let cursor = after;
    let buffered = initial.events;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const encoder = new TextEncoder();
    // A commit anywhere may be one of this conversation's; the read decides.
    // One that lands while a read is under way is remembered, not lost.
    let changed = false;
    const unsubscribe = this.changes?.subscribe(() => {
      changed = true;
      wake?.();
    });
    let lastRead = Date.now();
    let lastWrite = Date.now();
    const close = () => {
      closed = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      wake?.();
      signal.removeEventListener('abort', close);
    };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    const self = this;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          while (!closed) {
            if (buffered.length) {
              const next = buffered.shift();
              if (!next) continue;
              cursor = next.seq;
              controller.enqueue(
                encoder.encode(
                  `id: ${next.seq}\nevent: ${next.item.type}\ndata: ${JSON.stringify(next)}\n\n`,
                ),
              );
              lastWrite = Date.now();
              return;
            }
            if (!changed)
              await new Promise<void>((resolve) => {
                wake = resolve;
                timer = setTimeout(resolve, EXPERIENCE_POLL_MS);
              });
            wake = undefined;
            if (timer) clearTimeout(timer);
            const since = Date.now() - lastRead;
            if (since < EXPERIENCE_READ_GAP_MS) await Bun.sleep(EXPERIENCE_READ_GAP_MS - since);
            if (closed) break;
            changed = false;
            lastRead = Date.now();
            const page = await self.page(spaceId, cursor, jobId, 100, principalId);
            buffered = page.events;
            // Another conversation's commits wake this stream too; a keepalive
            // goes out at the polling pace, not on each of those.
            if (!buffered.length && Date.now() - lastWrite >= EXPERIENCE_POLL_MS) {
              controller.enqueue(encoder.encode(': keepalive\n\n'));
              lastWrite = Date.now();
              return;
            }
          }
          controller.close();
        },
        cancel: close,
      },
      { highWaterMark: 1 },
    );
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }
}
