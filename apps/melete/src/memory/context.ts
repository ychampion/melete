import {
  type AttemptBundle,
  type ContextRecord,
  claimHandleOf,
  contextRecord,
  type RecallResult,
  type RuntimeAdapter,
  recallRequest,
  type StyleViolation,
  styleViolations as styleViolationsSchema,
} from '@melete/contracts';
import { lockJob } from '../broker/records.ts';
import { memoryKeyLabel } from '../experience/evidence.ts';
import { appendMemoryTool } from '../experience/tools.ts';
import { buildBundle } from '../jobs/bundle.ts';
import { sharedRevisionEligible, withSharedItems } from '../rooms/shares.ts';
import { withStyleCheck } from '../runtime/style.ts';
import { chatIntent } from './capture.ts';
import { eligibleRevision } from './claims.ts';
import {
  iso,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  newId,
} from './db.ts';
import { onceForQueries, prefetchQuery } from './embedding.ts';
import { lockEventOrder, notifyInvalidated, registerMemoryAttempt } from './invalidate.ts';
import { recallNotes } from './notes.ts';
import { markRepairBriefsDelivered, pendingRepairBriefs } from './outputs.ts';
import { attemptRecallQuery, effectiveAudience, type RecallOptions, recall } from './recall.ts';

/**
 * Whether an attempt may hold this revision: one of its space's own, or a
 * detail someone shared into its room that the room may still read.
 */
async function heldRevision(tx: MemoryTx, scope: MemoryScope, claimId: string, revision: number) {
  return (
    (await eligibleRevision(tx, scope, claimId, revision)) ||
    (await sharedRevisionEligible(tx, scope.spaceId, claimId, revision))
  );
}

/**
 * What the agent is told when memory could not keep what the person just
 * wrote. Without it the agent only knows that Melete remembers what the person
 * says on its own, and answers "got it" to a request to remember.
 */
export const NOT_REMEMBERED_NOTE =
  'Memory has not kept what the person wrote in this turn and will not: this conversation is private and there is no local model set up to read it. If they asked you to remember something, tell them plainly that it was not saved; never say it was saved or that you will remember it.';

/**
 * What the agent is told about a request to forget in this turn. Memory acts on
 * the request itself, beside the attempt; without its answer the agent guessed,
 * and told the person "it's off the record" when nothing had been forgotten.
 * The agent may say a detail is forgotten only when memory's receipt says so.
 */
export const FORGET_NOTES = {
  forgot:
    "Memory carried out the person's request to forget: the detail is deleted, and the conversation shows the receipt. Tell them you forgot it, as they asked. It is missing from what you recall and from any search only because it was just deleted: never say you never had it, never knew it or that nothing was saved.",
  none: 'Memory found nothing saved that matches what the person asked to forget, so nothing was deleted. Tell them plainly that nothing matched and nothing was forgotten; never say it was forgotten, deleted or is off the record.',
  ask: 'Memory has not forgotten anything yet: the request matched no single saved detail, and the conversation shows which one memory needs named. Ask them which one; never say it was forgotten.',
  unconfirmed:
    "Memory has not confirmed the person's request to forget: it did not run, or it failed. Tell them plainly that it could not be done right now and that nothing was forgotten; never say it was forgotten, deleted or is off the record.",
} as const;
/** How long an attempt waits for memory to answer a request to forget made in its turn. */
export const FORGET_WAIT_MS = 8000;

/**
 * Memory's answer to a request to forget in this attempt's new messages, for
 * the agent, or null when there is none. Waits for the capture of the message
 * to settle, at most `waitMs`; unsettled by then counts as unconfirmed.
 */
export async function forgetOutcomeNote(
  sql: MemorySql,
  bundle: Pick<AttemptBundle, 'attempt' | 'inputs'>,
  waitMs = FORGET_WAIT_MS,
): Promise<string | null> {
  const asked = bundle.inputs.new_user_messages.filter(
    (message) => chatIntent(message.content).kind === 'forget',
  );
  if (!asked.length) return null;
  const times = asked.flatMap((message) => (message.at ? [Date.parse(message.at)] : []));
  const since = new Date(times.length ? Math.min(...times) : 0).toISOString();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const rows = await sql`select e.payload->>'text' as text, c.outcome from event e
      left join memory_capture c on c.event_seq = e.seq
      where e.job_id = ${bundle.attempt.job_id} and e.type = 'notice'
        and e.payload->>'kind' = 'user_message' and e.created_at >= ${since}::timestamptz
      order by e.seq`;
    const outcomes = rows
      .filter((row) => chatIntent(String(row.text ?? '')).kind === 'forget')
      .map((row) => (row.outcome as string | null) ?? 'pending');
    const settled = outcomes.length > 0 && outcomes.every((outcome) => outcome !== 'pending');
    if (settled || Date.now() >= deadline) {
      const last = settled ? outcomes.at(-1) : undefined;
      return last === 'forgot'
        ? FORGET_NOTES.forgot
        : last === 'forgot:none'
          ? FORGET_NOTES.none
          : last === 'forgot:ask'
            ? FORGET_NOTES.ask
            : FORGET_NOTES.unconfirmed;
    }
    await Bun.sleep(Math.min(200, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Whether memory will not keep this attempt's new messages because they came
 * from a private conversation with no local model to read them on. Decided
 * when the bundle is built, before memory has read anything, from two facts:
 * - `refusesRead`: the privacy router's own answer, the one memory's read
 *   would get, that a read of this conversation is refused now (private, no
 *   local model, and no agreement to a redacted cloud request);
 * - memory's record that it already refused one of these messages
 *   (`extraction_kept_private`), which covers a message read before the
 *   person agreed: it is not read again.
 * A message still waiting while reads are allowed may yet be kept, so it does
 * not count.
 */
export async function newMessagesNotRemembered(
  sql: MemorySql,
  scope: MemoryScope,
  bundle: Pick<AttemptBundle, 'attempt' | 'inputs'>,
  refusesRead?: (jobId: string) => Promise<boolean>,
): Promise<boolean> {
  const times = bundle.inputs.new_user_messages.flatMap((message) =>
    message.at ? [Date.parse(message.at)] : [],
  );
  if (!times.length) return false;
  if (refusesRead && (await refusesRead(bundle.attempt.job_id))) return true;
  // `at` is the message event's time cut to milliseconds, so the earliest one
  // is at or just before that event.
  const since = new Date(Math.min(...times)).toISOString();
  const [row] = await sql`select 1 from memory_capture c
    join event e on e.seq = c.event_seq
    join memory_work w on w.source_id = c.source_id
    where c.job_id = ${bundle.attempt.job_id} and w.space_id = ${scope.spaceId}
      and w.status = 'rejected' and w.error_code = 'extraction_kept_private'
      and e.created_at >= ${since}::timestamptz
    limit 1`;
  return Boolean(row);
}

export async function recordAttemptContext(
  sql: MemorySql,
  scope: MemoryScope,
  attemptId: string,
  jobId: string,
  result: RecallResult,
  startedAt?: Date,
): Promise<ContextRecord> {
  const context = await sql.begin(async (tx) => {
    // The order every event writer and the broker's admissions take their
    // locks: the event order, the job, its attempt, then the memory space.
    // Locking the attempt and job after the space deadlocked with an event
    // insert that held the job and waited for the attempt row.
    await lockEventOrder(tx);
    const [attempt] =
      await tx`select a.epoch, a.ended_at, j.lease_epoch, j.revision from job j join attempt a on a.job_id = j.id
      where a.id = ${attemptId} and j.id = ${jobId} and j.space_id = ${scope.spaceId} for update of j, a`;
    const space = await lockSpace(tx, scope, false);
    const audience = await effectiveAudience(tx, scope, jobId);
    if (!attempt || attempt.ended_at || attempt.epoch !== attempt.lease_epoch)
      throw new MemoryError('stale_attempt');
    if (
      result.snapshot &&
      (space.data_revision !== result.snapshot.data_revision ||
        space.policy_generation !== result.snapshot.policy_generation ||
        space.access_generation !== result.snapshot.access_generation)
    )
      throw new MemoryError('stale_context');
    if (audience.publicCompartment && result.items.length) throw new MemoryError('scope_denied');
    for (const item of result.items)
      if (!(await heldRevision(tx, scope, item.claim_id, item.revision)))
        throw new MemoryError('stale_context');
    const [prior] = await tx`select id from memory_contexts where attempt_id = ${attemptId}`;
    if (prior) throw new MemoryError('context_already_recorded');
    const context: ContextRecord = {
      style_violations: [],
      id: newId('ctx'),
      space_id: scope.spaceId,
      job_id: jobId,
      attempt_id: attemptId,
      job_revision: audience.jobRevision,
      policy_generation: space.policy_generation as number,
      data_revision: space.data_revision as number,
      access_generation: space.access_generation as number,
      audience: audience.audiences as ContextRecord['audience'],
      purpose: audience.purpose,
      items: result.items.map((item) => ({
        claim_id: item.claim_id,
        revision: item.revision,
        handle: claimHandleOf(item.claim_id, item.revision),
        key: item.key,
        origin_trust: item.origin_trust,
        sources: item.sources,
      })),
      unattributed: [],
      disputed_keys: result.disputed_keys,
      recipe: result.recipe,
      token_budget: result.token_budget,
      recall_status: result.status,
      invalidated_at: null,
      created_at: new Date().toISOString(),
    };
    await tx`insert into memory_contexts (id, space_id, job_id, attempt_id, job_revision, policy_generation, data_revision, access_generation, audience, purpose, items, recipe, token_budget, recall_status, disputed_keys, style_violations)
      values (${context.id}, ${scope.spaceId}, ${jobId}, ${attemptId}, ${context.job_revision}, ${context.policy_generation}, ${context.data_revision}, ${context.access_generation},
      ${JSON.stringify(context.audience)}::text::jsonb, ${context.purpose}, ${JSON.stringify(context.items)}::text::jsonb, ${context.recipe}, ${JSON.stringify(context.token_budget)}::text::jsonb, ${context.recall_status},
      ${JSON.stringify(context.disputed_keys)}::text::jsonb, '[]'::jsonb)`;
    await tx`update attempt set context_snapshot_ref = ${context.id} where id = ${attemptId}`;
    await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
      values (${scope.spaceId}, 'job', ${jobId}, ${String(audience.jobRevision)}, 'context', ${context.id}, '1') on conflict do nothing`;
    for (const item of context.items) {
      await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
        values (${scope.spaceId}, 'claim', ${item.claim_id}, ${String(item.revision)}, 'context', ${context.id}, '1') on conflict do nothing`;
      for (const source of item.sources)
        await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
        values (${scope.spaceId}, 'source', ${source.source_id}, ${source.source_version}, 'context', ${context.id}, '1') on conflict do nothing`;
    }
    return context;
  });
  if (context.items.length) await recordRecallEntry(sql, jobId, attemptId, context, startedAt);
  return context;
}

/**
 * The tool entry is written after the context commits, in its own short
 * transaction, so an event write never runs under the space lock. It takes the
 * job the way every event writer does (the event order lock, then the job row),
 * so a stream cursor cannot pass it. It only describes the recall: a failure is
 * logged and the attempt goes on with the context it already has.
 */
async function recordRecallEntry(
  sql: MemorySql,
  jobId: string,
  attemptId: string,
  context: ContextRecord,
  startedAt?: Date,
) {
  try {
    await sql.begin(async (tx) => {
      await lockJob(tx, jobId);
      // Details are named only in a personal space, to the person it belongs to.
      // In a shared space a detail may be someone else's, so only the count is told.
      const [owned] = await tx`select (s.kind = 'personal' and (j.principal_id is null
          or j.principal_id = coalesce(s.owner_principal_id, (select id from owner limit 1)))) as mine
        from job j join space s on s.id = j.space_id where j.id = ${jobId}`;
      await appendMemoryTool(tx, jobId, attemptId, {
        op: 'recall',
        id: `recall:${attemptId}`,
        status: 'done',
        started_at: startedAt?.toISOString() ?? context.created_at,
        ended_at: context.created_at,
        count: context.items.length,
        labels: owned?.mine ? context.items.map((item) => memoryKeyLabel(item.key)) : [],
        value: null,
        memory_item_id: null,
        parent: null,
      });
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error';
    process.stderr.write(`memory: recall entry for ${attemptId} was not written (${name})\n`);
  }
}
/**
 * Write down how the attempt talked. Measured, never enforced: the update runs
 * after the outcome is durable, touches one column, and cannot change what the
 * attempt did. A context that has already been invalidated keeps the record it
 * had, because a measurement of a discarded context proves nothing.
 */
export async function recordStyleViolations(
  sql: MemorySql,
  scope: MemoryScope,
  attemptId: string,
  violations: readonly StyleViolation[],
): Promise<void> {
  const value = styleViolationsSchema.parse([...violations]);
  await sql`update memory_contexts set style_violations = ${JSON.stringify(value)}::text::jsonb
    where attempt_id = ${attemptId} and space_id = ${scope.spaceId} and invalidated_at is null`;
}

/** Call before a consequential use; a normal unrelated fact does not invalidate this context. */
export async function assertContextCurrent(sql: MemorySql, scope: MemoryScope, attemptId: string) {
  return sql.begin(async (tx) => {
    const space = await lockSpace(tx, scope, false);
    const [row] =
      await tx`select c.*, j.revision as actual_job_revision, j.lease_epoch, a.epoch, a.ended_at from memory_contexts c
      join job j on j.id = c.job_id join attempt a on a.id = c.attempt_id where c.attempt_id = ${attemptId} and c.space_id = ${scope.spaceId}`;
    if (
      !row ||
      row.invalidated_at ||
      row.ended_at ||
      row.epoch !== row.lease_epoch ||
      row.job_revision !== row.actual_job_revision ||
      row.access_generation !== space.access_generation ||
      row.policy_generation !== space.policy_generation
    )
      throw new MemoryError('context_invalidated');
    for (const item of row.items as ContextRecord['items']) {
      if (!(await heldRevision(tx, scope, item.claim_id, item.revision)))
        throw new MemoryError('context_invalidated');
      const [head] = await tx`select head_revision from memory_claims where id = ${item.claim_id}`;
      if (head?.head_revision !== item.revision) throw new MemoryError('context_invalidated');
    }
    const context = contextRecord.parse({
      style_violations: row.style_violations,
      id: row.id,
      space_id: row.space_id,
      job_id: row.job_id,
      attempt_id: row.attempt_id,
      job_revision: row.job_revision,
      policy_generation: row.policy_generation,
      access_generation: row.access_generation,
      data_revision: row.data_revision,
      audience: row.audience,
      purpose: row.purpose,
      items: row.items,
      recipe: row.recipe,
      token_budget: row.token_budget,
      recall_status: row.recall_status,
      unattributed: row.unattributed,
      disputed_keys: row.disputed_keys,
      invalidated_at: null,
      created_at: iso(row.created_at),
    });
    return context;
  });
}
export async function assembleAttemptKnowledge(
  sql: MemorySql,
  scope: MemoryScope,
  attemptId: string,
  jobId: string,
  query: string,
  options: RecallOptions = {},
) {
  for (let retry = 0; retry < 3; retry++) {
    const startedAt = new Date();
    const result = await recall(
      sql,
      scope,
      recallRequest.parse({ job_id: jobId, query: query.slice(0, 2000) }),
      {
        ...options,
        includeProfile: true,
      },
    );
    // A room's request is also handed what people shared into the room.
    const recalled = await withSharedItems(sql, scope, jobId, result);
    try {
      const context = await recordAttemptContext(
        sql,
        scope,
        attemptId,
        jobId,
        recalled.recall,
        startedAt,
      );
      return { knowledge: recalled.knowledge, context, recall: recalled.recall };
    } catch (error) {
      if (!(error instanceof MemoryError) || error.code !== 'stale_context' || retry === 2)
        throw error;
    }
  }
  throw new MemoryError('stale_context');
}

/**
 * Gets an attempt's engine ready ahead of its start; the function it returns
 * gives that engine up when the attempt never starts.
 */
export type PrepareEngine = (bundle: AttemptBundle, signal: AbortSignal) => () => void;

/** Existing runtime contract stays unchanged; aborted context is discarded rather than resumed. */
export function withMemoryRuntime(
  runtime: RuntimeAdapter,
  sql: MemorySql,
  scopeForJob: (jobId: string) => Promise<MemoryScope>,
  options: Omit<RecallOptions, 'privateOrigin'> & {
    catalog?: (bundle: AttemptBundle) => Promise<AttemptBundle['tools']>;
    /**
     * Whether this attempt's requests stay on the person's own model, so what
     * memory learned in private conversations may be recalled into it. Left
     * out, it never is.
     */
    recallsPrivateMemory?: (
      jobId: string,
      attemptId: string,
      model?: { provider: string; model: string },
    ) => Promise<boolean>;
    /**
     * Whether memory's read of this job's conversation would be refused now,
     * as the privacy router decides it. Left out, only memory's own record of
     * a refusal tells the agent a message was not kept.
     */
    refusesMemoryRead?: (jobId: string) => Promise<boolean>;
    /**
     * Whether this job's words may be read by a cloud embedder: false for a
     * conversation that must stay private. Left out, a cloud embedder never
     * reads a request, and recall stays lexical; a local one always may.
     */
    embedsQuery?: (jobId: string, text: string) => Promise<boolean>;
    /**
     * Starts getting the attempt's engine ready while its memory is recalled,
     * and returns what gives that engine up if the attempt never starts. The
     * engine is told nothing of what is recalled until the attempt starts.
     */
    prepareEngine?: PrepareEngine;
  } = {},
): RuntimeAdapter {
  const recalling: RuntimeAdapter = {
    capabilities: () => runtime.capabilities(),
    async start(bundle, sink, signal) {
      const scope = await scopeForJob(bundle.attempt.job_id);
      let assembled: AttemptBundle | undefined;
      const privateOrigin =
        (await options.recallsPrivateMemory?.(
          bundle.attempt.job_id,
          bundle.attempt.id,
          bundle.model,
        )) ?? false;
      // An agent the person set not to read memory is given none of it: nothing
      // is recalled or recorded as used, no correction is briefed, and no handle
      // to a remembered source is passed on. The turn's own agent decides, the
      // way it decides which connections are offered.
      const [persona] = await sql`select a.reads_memory from job j
        left join experience_turn t on t.id = j.current_turn_id
        join agent a on a.id = coalesce(t.agent_id, j.agent_id) and a.space_id = j.space_id
        where j.id = ${bundle.attempt.job_id}`;
      const readsMemory = persona?.reads_memory !== false;
      const withheld = !readsMemory;
      // The request is embedded only where its words may go: on the person's
      // own model, or a cloud embedder for a conversation that need not stay private.
      const embedding =
        options.embedding &&
        (options.embedding.local ||
          (!privateOrigin &&
            (await options.embedsQuery?.(bundle.attempt.job_id, attemptRecallQuery(bundle))) ===
              true))
          ? onceForQueries(options.embedding)
          : undefined;
      // The request is embedded while the rest of the attempt is prepared, not before it.
      if (embedding && readsMemory)
        prefetchQuery(sql, embedding, {
          spaceId: scope.spaceId,
          query: attemptRecallQuery(bundle).slice(0, 2000),
          jobId: bundle.attempt.job_id,
          actor: scope.principalId ?? null,
        });
      // Memory's own answer to a request to forget, so the agent never claims one.
      // Settled before anything is recalled: the turn that asked to forget a
      // detail is never handed it, and is not restarted when it goes.
      const forgetNote = await forgetOutcomeNote(sql, bundle);
      const prepare = async () => {
        if (!options.catalog)
          return assembleAttemptKnowledge(
            sql,
            scope,
            bundle.attempt.id,
            bundle.attempt.job_id,
            attemptRecallQuery(bundle),
            { ...options, embedding, privateOrigin, withheld },
          );
        for (let retry = 0; retry < 3; retry++) {
          const startedAt = new Date();
          const built = await buildBundle(bundle, {
            sql,
            scope,
            catalog: options.catalog,
            privateOrigin,
            withheld,
            embedding,
          });
          try {
            const context = await recordAttemptContext(
              sql,
              scope,
              bundle.attempt.id,
              bundle.attempt.job_id,
              built.recall,
              startedAt,
            );
            assembled = built.bundle;
            return { knowledge: built.bundle.knowledge, context, recall: built.recall };
          } catch (error) {
            if (!(error instanceof MemoryError) || error.code !== 'stale_context' || retry === 2)
              throw error;
          }
        }
        throw new MemoryError('stale_context');
      };
      const prepared = await prepare();
      // The agent's own notes from earlier chats, labelled as its own. A note
      // that cannot be read now is simply not handed over this time.
      const notes = readsMemory
        ? await recallNotes(sql, scope, {
            query: attemptRecallQuery(bundle),
            jobId: bundle.attempt.job_id,
            privateOrigin,
            withheld,
            embedding,
          }).catch((error: unknown) => {
            process.stderr.write(
              `memory: notes_recall_failed:${error instanceof MemoryError ? error.code : 'unknown'}\n`,
            );
            return [];
          })
        : [];
      const [job] =
        await sql`select constraints, revision from job where id = ${bundle.attempt.job_id} and space_id = ${scope.spaceId}`;
      if (
        !job ||
        job.revision !== bundle.attempt.revision ||
        prepared.context.job_revision !== bundle.attempt.revision
      )
        throw new MemoryError('stale_attempt');
      // E1. What a correction broke since the last attempt, named precisely: the
      // handle that moved, the value before and after, and the outputs that cited
      // it. This is the reason the next attempt does not start from zero.
      // They stay pending for an agent that may read memory.
      const briefs = !readsMemory
        ? []
        : (assembled?.inputs.repair_briefs ??
          (await pendingRepairBriefs(sql, scope, bundle.attempt.job_id)));
      // Accepted action constraints come directly from job state, outside optional memory trimming.
      const since = (assembled ?? bundle).since_last;
      const unremembered = await newMessagesNotRemembered(
        sql,
        scope,
        bundle,
        options.refusesMemoryRead,
      );
      const next: AttemptBundle = {
        ...(assembled ?? bundle),
        job: {
          ...bundle.job,
          constraints: job.constraints,
          objective: [
            bundle.job.objective,
            unremembered ? NOT_REMEMBERED_NOTE : '',
            forgetNote ?? '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        inputs: { ...(assembled ?? bundle).inputs, repair_briefs: briefs },
        // The delta brief carries the same briefs as the inputs. The delta is
        // what an attempt reads to say what it did last time, and a correction
        // is the most important thing that can have happened since.
        since_last: {
          ...since,
          repair_briefs: briefs,
          evidence: readsMemory
            ? since.evidence
            : since.evidence.filter((item) => item.kind !== 'source'),
        },
        knowledge: readsMemory ? [...prepared.knowledge, ...notes] : [],
      };
      const controller = new AbortController();
      const unregister = registerMemoryAttempt(bundle.attempt.id, controller, () => {
        next.knowledge.length = 0;
      });
      // One check at a time: a slow database would otherwise gain a query per tick.
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void notifyInvalidated(sql, scope.spaceId)
          .catch(() => controller.abort('context_check_unavailable'))
          .finally(() => {
            checking = false;
          });
      }, 100);
      timer.unref();
      try {
        await assertContextCurrent(sql, scope, bundle.attempt.id);
        // How the attempt talked is written on the same context record that says
        // what it was given, so drift in one is readable beside the other.
        const measured = withStyleCheck(runtime, (attemptId, violations) =>
          recordStyleViolations(sql, scope, attemptId, violations),
        );
        const outcome = await measured.start(
          next,
          {
            async emit(event) {
              await assertContextCurrent(sql, scope, bundle.attempt.id);
              await sink.emit(event);
            },
          },
          AbortSignal.any([signal, controller.signal]),
        );
        await assertContextCurrent(sql, scope, bundle.attempt.id);
        // Delivered only once the attempt actually finished holding them.
        await markRepairBriefsDelivered(
          sql,
          scope,
          briefs.map((brief) => brief.id),
        );
        return outcome;
      } finally {
        clearInterval(timer);
        unregister();
        next.knowledge.length = 0;
      }
    },
  };
  const prepareEngine = options.prepareEngine;
  if (!prepareEngine) return recalling;
  return {
    capabilities: () => recalling.capabilities(),
    async start(bundle, sink, signal) {
      const giveUp = prepareEngine(bundle, signal);
      try {
        return await recalling.start(bundle, sink, signal);
      } finally {
        // Once the attempt took its engine, this does nothing.
        giveUp();
      }
    },
  };
}
