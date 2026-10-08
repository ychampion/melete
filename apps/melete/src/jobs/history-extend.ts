/**
 * Extends a conversation's summary before an attempt starts, when the messages
 * after it no longer fit.
 *
 * The claim builds the attempt's bundle inside its transaction, from the
 * newest stored summary and the messages after it, and says how many messages
 * it had to leave out (`earlier.left_out`). No model is called while a
 * transaction is open, so the summary is extended here instead: after the
 * claim has committed, while the attempt's lease is kept alive, before the
 * engine hears anything. The oldest messages are summarised (see
 * `history-summary.ts` for where the cut goes), the summary is stored as a
 * notice in the job's own events, which the chat shows as "Earlier messages
 * summarised", and the bundle's transcript is bounded again around it.
 *
 * When the summary cannot be made (a private conversation with no local
 * model, a spending limit, a provider failure) the attempt starts as it was
 * built, and the engine is told plainly how many earlier messages it cannot
 * see. The next turn tries again from the same place.
 */
import {
  type AttemptBundle,
  type CanonicalMessage,
  type ContextGenerations,
  type EventSink,
  jobBudget,
  type QuestioningRuntimeAdapter,
  type RuntimeAdapter,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { attempt, job } from '../db/schema.ts';
import { appendEvent } from '../events/store.ts';
import { estimateInputTokens } from '../gateway/metering.ts';
import { boundHistory, readConversation, transcriptLimits } from './bundle.ts';
import { attemptContextBudget } from './context-budget.ts';
import { readGenerations } from './generations.ts';
import { HISTORY_SUMMARY_LIMITS, type HistorySummariser } from './history-gateway.ts';
import {
  chunkMessages,
  EMPTY_SUMMARY,
  isToolIdentity,
  planExtension,
  renderSummary,
  type StoredSummary,
  summaryPayload,
} from './history-summary.ts';
import type { JobService } from './service.ts';

/** The most calls one attempt makes to extend the summary; the rest waits for the next turn. */
export const SUMMARY_CALLS_PER_ATTEMPT = 4;

/**
 * How long one attempt spends extending the summary before it starts without
 * the rest: at most this, and at most a quarter of the attempt's own wall time,
 * which is already running.
 */
export const SUMMARY_WALL_MS = 120_000;
const SUMMARY_WALL_SHARE = 0.25;

/** Room kept for the summary to grow into when it is extended. */
const SUMMARY_GROWTH_TOKENS = 1_000;

export type HistoryExtension = {
  jobs: JobService;
  summariser: HistorySummariser;
  /** The messages one call reads; the gateway's own size unless a test makes it smaller. */
  chunkTokens?: number;
  /** One plain line for the operator: what happened, never what was said. */
  log?: (line: string) => void;
};

/** The runtime with each attempt's summary extended first, when it needs to be. */
export function withHistorySummary<T extends RuntimeAdapter | QuestioningRuntimeAdapter>(
  runtime: T,
  deps: HistoryExtension,
): T {
  const start = async (bundle: AttemptBundle, sink: EventSink, signal: AbortSignal) => {
    let ready = bundle;
    if ((bundle.earlier?.left_out ?? 0) > 0) {
      try {
        ready = await extendHistory(bundle, deps, signal);
      } catch (error) {
        // The attempt still runs, with the gap it was built with and told of.
        deps.log?.(`history: summary_failed:${error instanceof Error ? error.name : 'error'}`);
      }
    }
    return (
      runtime.start as (
        bundle: AttemptBundle,
        sink: EventSink,
        signal: AbortSignal,
      ) => ReturnType<T['start']>
    )(ready, sink, signal);
  };
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'start') return start;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const messageKey = (message: CanonicalMessage) => `${message.at}\u0000${message.content}`;

/**
 * The bundle with its summary extended over the messages that no longer fit,
 * and its transcript bounded again around it; the bundle as it was when
 * nothing needed summarising or nothing could be.
 */
export async function extendHistory(
  bundle: AttemptBundle,
  deps: HistoryExtension,
  signal: AbortSignal,
): Promise<AttemptBundle> {
  const jobId = bundle.attempt.job_id;
  const read = await deps.jobs.transaction(async (tx) => {
    const [row] = await tx.select().from(job).where(eq(job.id, jobId));
    const [own] = await tx
      .select({ cursor: attempt.inputCursor })
      .from(attempt)
      .where(eq(attempt.id, bundle.attempt.id));
    if (!row || !own || row.audience === 'room') return null;
    const declared = bundle as AttemptBundle & Partial<ContextGenerations>;
    const generations: ContextGenerations =
      declared.policy_generation !== undefined && declared.connection_generations
        ? {
            policy_generation: declared.policy_generation,
            connection_generations: declared.connection_generations,
          }
        : await readGenerations(tx, row.spaceId);
    // Only what the claim saw: a message sent since is this attempt's next input.
    const conversation = await readConversation(tx, row, generations, Number(own.cursor));
    return { row, generations, ...conversation };
  });
  if (!read) return bundle;
  const limits = transcriptLimits(
    attemptContextBudget(bundle.model.model, jobBudget.parse(read.row.budget)),
  );
  const freshKeys = new Set(bundle.inputs.new_user_messages.map(messageKey));
  const fresh = read.full.filter(
    (message) => message.role === 'user' && freshKeys.has(messageKey(message)),
  );
  const isFresh = new Set(fresh);
  const through = read.stored ? Date.parse(read.stored.through) : Number.NEGATIVE_INFINITY;
  const prior = read.full.filter(
    (message) => !isFresh.has(message) && Date.parse(message.at) > through,
  );
  // Sized as the bound measures it: this turn's messages and the summary as
  // rendered take their room first, with some kept for the summary to grow.
  const plan = planExtension(
    prior,
    {
      tokens:
        limits.maxTokens -
        estimateInputTokens(JSON.stringify(fresh)) -
        (read.stored
          ? estimateInputTokens(JSON.stringify(renderSummary(read.stored.summary)))
          : 0) -
        SUMMARY_GROWTH_TOKENS,
      messages: limits.maxMessages - fresh.length,
    },
    Math.min(...fresh.map((message) => Date.parse(message.at))),
  );
  if (!plan) return bundle;
  // Tool results are not summarised: they are outside text, and what the
  // assistant made of them is in its own messages. Their identities stay.
  const said = plan.summarise.filter((message) => !isToolIdentity(message));
  const chunks = chunkMessages(said, deps.chunkTokens ?? HISTORY_SUMMARY_LIMITS.chunk_tokens);
  const deadline =
    Date.now() + Math.min(SUMMARY_WALL_MS, bundle.budget.max_wall_ms * SUMMARY_WALL_SHARE);
  let summary = read.stored?.summary ?? EMPTY_SUMMARY;
  let completed = 0;
  let calls = 0;
  for (const chunk of chunks) {
    const left = deadline - Date.now();
    if (calls >= SUMMARY_CALLS_PER_ATTEMPT || left <= 0 || signal.aborted) break;
    calls += 1;
    const answer = await deps.summariser.summarise(
      { spaceId: read.row.spaceId, jobId, principalId: read.row.principalId },
      { previous: summary, messages: chunk.text },
      AbortSignal.any([signal, AbortSignal.timeout(left)]),
    );
    if (!answer.ok) {
      deps.log?.(`history: summary_not_made:${answer.reason}`);
      break;
    }
    summary = answer.summary;
    completed = chunk.completes;
  }
  if (completed === 0 && said.length > 0) return bundle;
  // Every message the plan took is in, or the ones before the first that is not.
  const last = completed === said.length ? plan.through : said[completed - 1]?.at;
  if (!last) return bundle;
  const stored: StoredSummary = {
    through: last,
    summary,
    messages: (read.stored?.messages ?? 0) + completed,
    generations: read.generations,
  };
  await deps.jobs.transaction((tx) =>
    appendEvent(tx, {
      jobId,
      attemptId: bundle.attempt.id,
      type: 'notice',
      payload: summaryPayload(stored),
      dedupKey: `${jobId}:history-summary:${stored.through}`,
    }),
  );
  deps.log?.(`history: summarised ${completed} message(s) in ${calls} call(s)`);
  const bounded = boundHistory(read.full, fresh, stored, limits);
  const { earlier: _built, ...rest } = bundle;
  return {
    ...rest,
    transcript: bounded.transcript,
    ...(bounded.earlier ? { earlier: bounded.earlier } : {}),
  };
}
