import {
  type AttemptBundle,
  type AttemptOutcome,
  attemptBundle,
  attemptOutcome,
  type CanonicalMessage,
  CONTEXT_LIMITS,
  type ContextGenerations,
  canonicalTimeZone,
  type Deliverable,
  describeTrigger,
  inputTokenCeiling,
  jobBudget,
  jobConstraints,
  jsonObject,
  QUESTION_GUIDANCE,
  type RecallResult,
  type ResponsibilityAttemptBundle,
  receipt,
  receipt as receiptContract,
  responsibilityAttemptBundle,
  type SinceLast,
  sinceLast as sinceLastContract,
  TERMINAL_ACTION_STATUSES,
  triggerSpec,
  waitSpec,
} from '@melete/contracts';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { ArtifactRoots } from '../artifact/content.ts';
import { artifactGate } from '../artifact/gate.ts';
import { databaseNow } from '../db/clock.ts';
import {
  action,
  agent,
  approval,
  artifact,
  attempt,
  connection,
  event,
  experienceProfile,
  experienceTurn,
  knowledgeRecord,
  question,
  trigger,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { agentIdentity, agentView } from '../experience/agents.ts';
import { procedureReach, selectProcedureSkills } from '../learning/selection.ts';
import type { MemoryScope, MemorySql } from '../memory/db.ts';
import { pendingRepairBriefs } from '../memory/outputs.ts';
import { asKnowledge, recall } from '../memory/recall.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { selectedContext } from '../principals/context.ts';
import { readGenerations, requireGenerations } from './generations.ts';
import { questionView, readDeferred } from './questions.ts';
import type { JobRow } from './service.ts';

export const TRANSCRIPT_MAX_MESSAGES = 100;
export const TRANSCRIPT_MAX_CHARACTERS = 32_000;
const omitted = '[Content omitted from bounded context; the durable record remains stored.]';
const toolResult = z.object({ call_id: z.string().min(1), ok: z.boolean(), result: jsonObject });

export class BundleContextLimitError extends Error {
  override name = 'BundleContextLimitError';
}

/**
 * Completed tool identities outrank ordinary conversation: dropping one would
 * let a replacement stub replay its effect. Large tool bodies may be explicitly
 * abbreviated, but their call IDs remain exact. If identities alone do not fit,
 * refuse the attempt instead of silently discarding its replay protection.
 */
export function boundTranscript(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
  const tools = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool' && message.tool_call_id) tools.set(message.tool_call_id, index);
  }
  if (tools.size > TRANSCRIPT_MAX_MESSAGES) {
    throw new BundleContextLimitError(
      'completed tool identities exceed the transcript message limit',
    );
  }
  const required = new Set(tools.values());
  const selected = new Set(required);
  for (
    let index = messages.length - 1;
    index >= 0 && selected.size < TRANSCRIPT_MAX_MESSAGES;
    index--
  ) {
    const message = messages[index];
    if (!message || (message.role === 'tool' && message.tool_call_id)) continue;
    selected.add(index);
  }
  const indices = [...selected].sort((a, b) => a - b);
  const bounded = indices.map((index) => {
    const message = messages[index];
    if (!message) throw new Error('transcript index disappeared');
    return { ...message, content: omitted };
  });
  while (JSON.stringify(bounded).length > TRANSCRIPT_MAX_CHARACTERS) {
    const removable = indices.findIndex((index) => !required.has(index));
    if (removable < 0) {
      throw new BundleContextLimitError(
        'completed tool identities exceed the transcript character limit',
      );
    }
    indices.splice(removable, 1);
    bounded.splice(removable, 1);
  }
  // Recent material gets the remaining budget after every required identity has
  // reserved its place. The marker keeps truncation distinct from actual history.
  for (let index = bounded.length - 1; index >= 0; index--) {
    const message = bounded[index];
    const sourceIndex = indices[index];
    const original = sourceIndex === undefined ? undefined : messages[sourceIndex];
    if (!message || !original) throw new Error('transcript index disappeared');
    const previousLength = JSON.stringify(message.content).length;
    const available = TRANSCRIPT_MAX_CHARACTERS - JSON.stringify(bounded).length + previousLength;
    if (JSON.stringify(original.content).length <= available) {
      message.content = original.content;
      continue;
    }
    let low = 0;
    let high = original.content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = `${original.content.slice(0, middle)}\n${omitted}`;
      if (JSON.stringify(candidate).length <= available) low = middle;
      else high = middle - 1;
    }
    const shortened = `${original.content.slice(0, low)}\n${omitted}`;
    if (JSON.stringify(shortened).length <= available) message.content = shortened;
  }
  return bounded;
}

type HistoryEvent = Pick<typeof event.$inferSelect, 'seq' | 'type' | 'payload' | 'createdAt'>;
type HistoryAttempt = Pick<
  typeof attempt.$inferSelect,
  'outcome' | 'outcomeDetail' | 'endedAt' | 'startedAt'
>;

/** Pure assembly is shared by the database reader and focused replay tests. */
export function assembleHistory(
  events: readonly HistoryEvent[],
  attempts: readonly HistoryAttempt[],
  afterSeq: number,
): Pick<AttemptBundle, 'inputs' | 'transcript'> & { progressSummary: string } {
  const inputs: AttemptBundle['inputs'] = {
    new_user_messages: [],
    approval_results: [],
    trigger_events: [],
    repair_briefs: [],
  };
  const transcript: CanonicalMessage[] = [];
  for (const row of events) {
    const parsed = jsonObject.safeParse(row.payload);
    if (!parsed.success) {
      if (row.type === 'tool_result') throw new Error('invalid persisted tool result');
      continue;
    }
    const payload = parsed.data;
    if (
      row.type === 'notice' &&
      payload.kind === 'user_message' &&
      typeof payload.text === 'string'
    ) {
      const message: CanonicalMessage = {
        role: 'user',
        content: payload.text,
        at: row.createdAt.toISOString(),
      };
      transcript.push(message);
      if (row.seq > afterSeq) inputs.new_user_messages.push(message);
    } else if (row.type === 'tool_result') {
      const result = toolResult.parse(payload);
      transcript.push({
        role: 'tool',
        tool_call_id: result.call_id,
        content: JSON.stringify({ ok: result.ok, result: result.result }),
        at: row.createdAt.toISOString(),
      });
    } else if (row.seq > afterSeq && row.type === 'approval_decided') {
      const decision = attemptBundle.shape.inputs.shape.approval_results.element.safeParse({
        ...payload,
        note: payload.note ?? null,
      });
      if (decision.success) inputs.approval_results.push(decision.data);
    } else if (row.seq > afterSeq && row.type === 'notice' && payload.kind === 'trigger_event') {
      const delivered = jsonObject.safeParse(payload.event);
      if (delivered.success) inputs.trigger_events.push(delivered.data);
    }
  }
  let progressSummary = '';
  let latestSummaryAt = Number.NEGATIVE_INFINITY;
  for (const row of attempts) {
    if (!row.endedAt || !row.outcome || row.outcome === 'fenced') continue;
    const parsed = attemptOutcome.safeParse(row.outcomeDetail);
    if (!parsed.success || parsed.data.kind !== row.outcome) continue;
    const outcome = parsed.data;
    const content =
      'summary' in outcome ? outcome.summary : 'draft' in outcome ? outcome.draft : undefined;
    if (content) transcript.push({ role: 'assistant', content, at: row.endedAt.toISOString() });
    if ('summary' in outcome && row.endedAt.getTime() >= latestSummaryAt) {
      progressSummary = outcome.summary;
      latestSummaryAt = row.endedAt.getTime();
    }
  }
  transcript.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return { inputs, transcript: boundTranscript(transcript), progressSummary };
}

/**
 * The delta brief, built from durable rows only.
 *
 * An attempt is disposable and the responsibility is not, so every wake would
 * otherwise reread the whole history to learn the one thing it needs: what
 * happened while it was not running. Nothing here is remembered by a process;
 * it is all read back from the tables that already had to be right.
 */
export async function buildSinceLast(
  tx: Transaction,
  jobId: string,
  spaceId: string,
  previous: { id: string; endedAt: Date | null } | null,
  deferred: readonly { text: string }[] = [],
): Promise<SinceLast> {
  if (!previous?.endedAt) return sinceLastContract.parse({});
  const since = previous.endedAt;
  const actions = await tx
    .select()
    .from(action)
    .where(and(eq(action.jobId, jobId), gt(action.createdAt, since)))
    .orderBy(asc(action.createdAt));
  const settled = await tx
    .select()
    .from(action)
    .where(and(eq(action.jobId, jobId), isNotNull(action.resolvedAt), gt(action.resolvedAt, since)))
    .orderBy(asc(action.createdAt));
  const seen = new Map<string, (typeof actions)[number]>();
  for (const row of [...actions, ...settled]) seen.set(row.id, row);
  const artifacts = await tx
    .select()
    .from(artifact)
    .where(and(eq(artifact.jobId, jobId), gt(artifact.createdAt, since)))
    .orderBy(asc(artifact.createdAt));
  const records = await tx
    .select()
    .from(knowledgeRecord)
    .where(and(eq(knowledgeRecord.spaceId, spaceId), gt(knowledgeRecord.updatedAt, since)))
    .orderBy(asc(knowledgeRecord.updatedAt));
  const open = await tx
    .select()
    .from(question)
    .where(and(eq(question.jobId, jobId), eq(question.state, 'open')));
  const waiting = await tx
    .select({
      id: approval.id,
      actionId: approval.actionId,
      requestedAt: approval.requestedAt,
      kind: action.kind,
    })
    .from(approval)
    .innerJoin(action, eq(action.id, approval.actionId))
    .where(and(eq(action.jobId, jobId), isNull(approval.decidedAt)))
    .orderBy(asc(approval.requestedAt));

  // A receipt is what makes "it was sent" a fact. Say the connector's own
  // handle, not the action id, because that is the thing a person can look up.
  const receiptRef = (value: unknown): string | null => {
    const parsed = receiptContract.safeParse(value);
    return parsed.success ? parsed.data.external_ref : null;
  };

  return sinceLastContract.parse({
    attempt_id: previous.id,
    ended_at: since.toISOString(),
    actions: [...seen.values()].slice(0, 50).map((row) => ({
      action_id: row.id,
      kind: row.kind,
      status: row.status,
      receipt_ref: receiptRef(row.receipt),
      at: (row.resolvedAt ?? row.createdAt).toISOString(),
    })),
    evidence: [
      ...artifacts.map((row) => ({
        kind: 'artifact' as const,
        handle: `artifact:${row.id}`,
        label: row.path,
        at: row.createdAt.toISOString(),
      })),
      ...records.map((row) => ({
        kind: 'knowledge' as const,
        handle: `knowledge:${row.id}`,
        label: row.path,
        at: row.updatedAt.toISOString(),
      })),
    ].slice(0, 50),
    pending_questions: [
      ...open.map((row) => ({ id: row.id, text: row.text, state: 'asked' as const })),
      ...deferred.map((row, index) => ({
        id: `deferred:${index}`,
        text: row.text,
        state: 'held' as const,
      })),
    ].slice(0, 50),
    pending_approvals: waiting.slice(0, 50).map((row) => ({
      approval_id: row.id,
      action_id: row.actionId,
      kind: row.kind,
      requested_at: row.requestedAt.toISOString(),
    })),
  });
}

/** Reserve the durable attempt first; its capability is usable only after commit. */
export async function buildAttemptSkeleton(
  tx: Transaction,
  row: JobRow,
  attemptIdentity: { id: string; epoch: number; revision: number; token: string },
  model: AttemptBundle['model'],
  afterSeq: number,
  expected?: ContextGenerations,
  runtimeVersion?: string,
): Promise<ResponsibilityAttemptBundle> {
  const access = await spaceAuthority(tx, row.spaceId, row.principalId, true);
  const generations = expected
    ? await requireGenerations(tx, row.spaceId, expected)
    : await readGenerations(tx, row.spaceId);
  const events = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.jobId, row.id),
        inArray(event.type, ['notice', 'tool_result', 'approval_decided']),
      ),
    )
    .orderBy(asc(event.seq));
  const attempts = await tx
    .select()
    .from(attempt)
    .where(and(eq(attempt.jobId, row.id), isNotNull(attempt.endedAt)))
    .orderBy(desc(attempt.epoch));
  const provenance = await tx
    .select({
      id: attempt.id,
      policyGeneration: attempt.policyGeneration,
      connectionGenerations: attempt.connectionGenerations,
    })
    .from(attempt)
    .where(eq(attempt.jobId, row.id));
  const contextMatches = (entry: {
    policyGeneration: number;
    connectionGenerations: Record<string, number>;
  }) =>
    entry.policyGeneration === generations.policy_generation &&
    Object.entries(entry.connectionGenerations).every(
      ([id, generation]) => generations.connection_generations[id] === generation,
    );
  const currentAttempts = new Set(provenance.filter(contextMatches).map((entry) => entry.id));
  const usableEvents = events.flatMap((entry) => {
    const payload = jsonObject.parse(entry.payload);
    const current = entry.attemptId
      ? currentAttempts.has(entry.attemptId)
      : generations.policy_generation === 0;
    if (entry.type === 'tool_result' && !current) {
      const result = toolResult.parse(payload);
      // Keep the completed identity to prevent replay, while discarding revoked context bytes.
      return [
        {
          ...entry,
          payload: {
            call_id: result.call_id,
            ok: result.ok,
            result: { context_invalidated: true },
          },
        },
      ];
    }
    if (entry.type === 'approval_decided' && payload.decision === 'approved' && !current) return [];
    if (entry.type === 'notice' && payload.kind === 'trigger_event') {
      const source = jsonObject.safeParse(payload.event);
      if (
        source.success &&
        (source.data.kind === 'connector_event' || source.data.kind === 'operation_event')
      ) {
        if ((source.data.policy_generation ?? 0) !== generations.policy_generation) return [];
        if (
          typeof source.data.connection_id === 'string' &&
          generations.connection_generations[source.data.connection_id] !==
            (source.data.connection_generation ?? 0)
        )
          return [];
      }
    }
    return [entry];
  });
  const history = assembleHistory(usableEvents, attempts.filter(contextMatches), afterSeq);
  // A decision names an action id; the attempt needs to know what that action
  // is. The row is this job's own, and the payload is the one the owner read.
  const decided = history.inputs.approval_results.map((entry) => entry.action_id);
  const decidedActions = decided.length
    ? await tx
        .select({
          id: action.id,
          kind: action.kind,
          status: action.status,
          payload: action.canonicalPayload,
        })
        .from(action)
        .where(and(eq(action.jobId, row.id), inArray(action.id, decided)))
    : [];
  history.inputs.approval_results = history.inputs.approval_results.map((entry) => {
    const stored = decidedActions.find((candidate) => candidate.id === entry.action_id);
    const payload = jsonObject.safeParse(stored?.payload);
    return stored
      ? {
          ...entry,
          kind: stored.kind,
          status: stored.status,
          ...(payload.success ? { payload: payload.data } : {}),
        }
      : entry;
  });
  // What a wait can name. The attempt reads the id, the event and one plain
  // sentence; the spec itself stays on the row.
  const registered = await tx
    .select({ id: trigger.id, kind: trigger.kind, spec: trigger.spec })
    .from(trigger)
    .where(and(eq(trigger.jobId, row.id), eq(trigger.enabled, true)))
    .orderBy(asc(trigger.createdAt), asc(trigger.id))
    .limit(50);
  const triggers = registered.flatMap((entry) => {
    const spec = triggerSpec.safeParse(entry.spec);
    if (!spec.success) return [];
    return [
      {
        id: entry.id,
        kind: spec.data.kind,
        event_name: spec.data.kind === 'schedule' ? null : spec.data.event_name,
        description: describeTrigger(spec.data),
      },
    ];
  });
  const constraints = jobConstraints.parse(row.constraints);
  const procedures = await selectProcedureSkills(tx, row, model, runtimeVersion);
  const context = await selectedContext(
    tx,
    row.spaceId,
    access.principalId,
    row.objective,
    history.inputs.new_user_messages.at(-1)?.content ?? '',
    constraints.public_compartment,
    await procedureReach(tx, procedures),
  );
  const wait = waitSpec.parse(row.wait);
  // A transition into queued clears the wait. A queued job that still holds an
  // event wait, or a timer not yet due, was requeued before that wait fired: a
  // correction to a relied-on claim does this, and a retry carries it forward.
  // Due is asked of the database, the clock the restore is decided against, so
  // a skewed host cannot tell an attempt about a wait nothing will bring back.
  const now = (await databaseNow(tx)).getTime();
  const cancelledWait =
    row.state === 'queued' &&
    (wait.kind === 'event' || (wait.kind === 'timer' && Date.parse(wait.wake_at) > now))
      ? wait
      : undefined;
  const [open] = await tx
    .select()
    .from(question)
    .where(and(eq(question.jobId, row.id), eq(question.state, 'open')))
    .limit(1);
  // The newest attempt that actually finished, current context only: a delta
  // measured from an attempt whose context was revoked would name work the
  // next attempt is not allowed to build on.
  const [previous] = attempts.filter(contextMatches);
  const delta = await buildSinceLast(
    tx,
    row.id,
    row.spaceId,
    previous ? { id: previous.id, endedAt: previous.endedAt } : null,
    readDeferred(row),
  );
  const [activeTurn] = row.currentTurnId
    ? await tx.select().from(experienceTurn).where(eq(experienceTurn.id, row.currentTurnId))
    : [];
  const personaId = activeTurn?.agentId ?? row.agentId;
  const [persona] = personaId
    ? await tx
        .select()
        .from(agent)
        .where(and(eq(agent.id, personaId), eq(agent.spaceId, row.spaceId)))
    : [];
  const [profile] = await tx
    .select({ timeZone: experienceProfile.timeZone })
    .from(experienceProfile)
    .where(eq(experienceProfile.spaceId, row.spaceId));
  return responsibilityAttemptBundle.parse({
    ...(persona ? { identity: agentIdentity(agentView(persona)) } : {}),
    ...(profile?.timeZone ? { time_zone: canonicalTimeZone(profile.timeZone) } : {}),
    ...(access.principalId
      ? { principal_id: access.principalId, membership_generation: access.generation }
      : {}),
    ...generations,
    attempt: { ...attemptIdentity, job_id: row.id },
    job: {
      title: row.title,
      objective: row.objective,
      constraints,
      progress_summary: history.progressSummary,
      unresolved_questions: wait.kind === 'user_input' ? [wait.question] : [],
      deliverable: constraints.deliverable,
      triggers,
    },
    inputs: { ...history.inputs, ...(cancelledWait ? { cancelled_wait: cancelledWait } : {}) },
    since_last: delta,
    transcript: history.transcript,
    tools: [],
    skills: mergeSkills(procedures, context.skills),
    knowledge: context.knowledge,
    workspace: { mount: '/work', files: [] },
    // The budget is one question per wake, stated rather than implied.
    attention: {
      questions_allowed: open ? 0 : 1,
      guidance: QUESTION_GUIDANCE,
      open_question: open ? questionView(open, row.title) : null,
      deferred_questions: readDeferred(row),
    },
    budget: {
      ...jobBudget.parse(row.budget),
      max_input_tokens: inputTokenCeiling(model.model, jobBudget.parse(row.budget)),
    },
    model,
  });
}

export type BundleAssembly = {
  sql: MemorySql;
  scope: MemoryScope;
  catalog: (bundle: AttemptBundle) => Promise<AttemptBundle['tools']>;
};

/** Complete the bundle after the lease commits, before any model request. */
export async function buildBundle(
  skeleton: AttemptBundle,
  options: BundleAssembly,
): Promise<{ bundle: AttemptBundle; recall: RecallResult }> {
  const { sql, scope } = options;
  const jobId = skeleton.attempt.job_id;
  const result = await recall(
    sql,
    scope,
    {
      job_id: jobId,
      query: skeleton.job.objective.slice(0, 2000),
      mode: 'current',
      max_tokens: CONTEXT_LIMITS.knowledge_tokens,
    },
    { includeProfile: true },
  );
  const tools = (await options.catalog(skeleton)).slice(0, CONTEXT_LIMITS.max_tools);
  const repairBriefs = await pendingRepairBriefs(sql, scope, jobId);
  // The delta was built once, in the lease transaction, from the job's own
  // rows. Memory sources are the one kind of evidence only readable here, under
  // the memory scope, so they complete that same brief rather than start another.
  // Handles reveal identity, not old claim text. Every join stays within the
  // job's space, and the current recall gate remains the authority on usable knowledge.
  const since = skeleton.since_last.ended_at;
  const sources = await sql`select s.id, s.source_version, s.stream, s.source_type, s.ingested_at
    from memory_sources s
    where s.space_id = ${scope.spaceId} and s.state = 'active'
      and s.audience = any(${scope.role === 'owner' ? ['private', 'space', 'public'] : ['space', 'public']})
      and ${skeleton.job.constraints.public_compartment !== true}
      and (${since}::timestamptz is null or s.ingested_at > ${since}::timestamptz)
    order by s.ingested_at, s.id limit 50`;
  return {
    recall: result,
    bundle: {
      ...skeleton,
      tools,
      knowledge: result.items.map(asKnowledge),
      inputs: { ...skeleton.inputs, repair_briefs: repairBriefs },
      since_last: {
        ...skeleton.since_last,
        evidence: [
          ...skeleton.since_last.evidence,
          ...sources.map((row) => ({
            kind: 'source' as const,
            handle: `source:${row.id}@${row.source_version}`,
            label: `${row.stream} ${row.source_type}`,
            at: new Date(row.ingested_at as string).toISOString(),
          })),
        ].slice(0, 50),
      },
    },
  };
}

type CompletedOutcome = Extract<AttemptOutcome, { kind: 'completed' }>;
type CompletionAction = Pick<
  typeof action.$inferSelect,
  'id' | 'jobId' | 'connectionId' | 'kind' | 'effectClass' | 'status' | 'receipt'
> & { spaceId: string | null };
type CompletionArtifact = Pick<
  typeof artifact.$inferSelect,
  'id' | 'jobId' | 'spaceId' | 'path' | 'contentHash' | 'size'
>;
type CompletionKnowledge = Pick<
  typeof knowledgeRecord.$inferSelect,
  'id' | 'spaceId' | 'status' | 'contentHash'
>;
export type CompletionRecords = {
  actions: readonly CompletionAction[];
  artifacts: readonly CompletionArtifact[];
  knowledge: readonly CompletionKnowledge[];
};
export type CompletionFacts = {
  all_actions_terminal: boolean;
  has_unknown_action: boolean;
  deliverable_declared: boolean;
  deliverable_satisfied: boolean;
  /** Every declared check on this job's latest artifacts holds. */
  artifact_validations_passed: boolean;
  /** Why not, in words a person can act on. Empty when it passed. */
  artifact_failures: string[];
};

function hasReceipt(row: CompletionAction): boolean {
  const parsed = receipt.safeParse(row.receipt);
  return (
    parsed.success &&
    parsed.data.action_id === row.id &&
    parsed.data.connection_id === row.connectionId
  );
}

function artifactMatches(
  deliverable: Extract<Deliverable, { kind: 'artifact' }>,
  path: string,
): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || normalized.split('/').includes('..')) return false;
  try {
    return new Bun.Glob(deliverable.path_glob.replaceAll('\\', '/')).match(normalized);
  } catch {
    return false;
  }
}

/** Evidence is useful only if a record in the current job or space supports it. */
export function evaluateCompletion(
  row: Pick<JobRow, 'id' | 'spaceId' | 'constraints'>,
  outcome: CompletedOutcome,
  records: CompletionRecords,
): CompletionFacts {
  const declared = jobConstraints.parse(row.constraints).deliverable;
  const actions = records.actions.filter((candidate) => candidate.jobId === row.id);
  const validActions = actions.filter(
    (candidate) =>
      candidate.spaceId === row.spaceId &&
      candidate.status === 'succeeded' &&
      hasReceipt(candidate),
  );
  const validArtifacts = records.artifacts.filter(
    (candidate) =>
      candidate.jobId === row.id &&
      candidate.spaceId === row.spaceId &&
      candidate.contentHash.trim() &&
      candidate.size >= 0,
  );
  const validKnowledge = records.knowledge.filter(
    (candidate) =>
      candidate.spaceId === row.spaceId &&
      candidate.status === 'active' &&
      candidate.contentHash.trim(),
  );
  const referencedActions = validActions.filter((candidate) =>
    outcome.evidence.some((ref) => ref.kind === 'action' && ref.action_id === candidate.id),
  );
  const referencedArtifacts = validArtifacts.filter((candidate) =>
    outcome.evidence.some((ref) => ref.kind === 'artifact' && ref.artifact_id === candidate.id),
  );
  const referencedKnowledge = validKnowledge.filter((candidate) =>
    outcome.evidence.some((ref) => ref.kind === 'knowledge' && ref.record_id === candidate.id),
  );
  let satisfied: boolean;
  switch (declared.kind) {
    case 'none':
      satisfied = true;
      break;
    case 'artifact':
      satisfied = referencedArtifacts.some((candidate) =>
        artifactMatches(declared, candidate.path),
      );
      break;
    case 'message_sent':
      satisfied = referencedActions.some(
        (candidate) =>
          candidate.connectionId === declared.connection_id &&
          candidate.effectClass === 'write_external' &&
          ['email.send', 'test.send'].includes(candidate.kind),
      );
      break;
    case 'answer':
      satisfied =
        Boolean(outcome.summary.trim()) &&
        referencedActions.length + referencedArtifacts.length + referencedKnowledge.length > 0;
      break;
  }
  return {
    all_actions_terminal: actions.every((candidate) =>
      (TERMINAL_ACTION_STATUSES as readonly string[]).includes(candidate.status),
    ),
    has_unknown_action: actions.some(
      (candidate) => candidate.status === 'unknown' || candidate.status === 'unresolved',
    ),
    deliverable_declared: declared.kind !== 'none',
    deliverable_satisfied: satisfied,
    // Nothing is known about artifacts from records alone; the caller that
    // reads the validation rows fills these in.
    artifact_validations_passed: true,
    artifact_failures: [],
  };
}

export async function completionFacts(
  tx: Transaction,
  row: JobRow,
  outcomeCompleted: CompletedOutcome,
  artifactRoots?: ArtifactRoots,
): Promise<CompletionFacts> {
  const actions = await tx
    .select({
      id: action.id,
      jobId: action.jobId,
      connectionId: action.connectionId,
      kind: action.kind,
      effectClass: action.effectClass,
      status: action.status,
      receipt: action.receipt,
      spaceId: connection.spaceId,
    })
    .from(action)
    .leftJoin(connection, eq(connection.id, action.connectionId))
    .where(eq(action.jobId, row.id));
  const artifactIds = outcomeCompleted.evidence.flatMap((ref) =>
    ref.kind === 'artifact' ? [ref.artifact_id] : [],
  );
  const knowledgeIds = outcomeCompleted.evidence.flatMap((ref) =>
    ref.kind === 'knowledge' ? [ref.record_id] : [],
  );
  const artifacts = artifactIds.length
    ? await tx
        .select()
        .from(artifact)
        .where(
          and(
            inArray(artifact.id, artifactIds),
            eq(artifact.jobId, row.id),
            eq(artifact.spaceId, row.spaceId),
          ),
        )
    : [];
  const knowledge = knowledgeIds.length
    ? await tx
        .select()
        .from(knowledgeRecord)
        .where(
          and(inArray(knowledgeRecord.id, knowledgeIds), eq(knowledgeRecord.spaceId, row.spaceId)),
        )
    : [];
  const facts = evaluateCompletion(row, outcomeCompleted, { actions, artifacts, knowledge });
  // A declared check that failed outranks a confident summary: the file is not
  // the thing it was promised to be, whatever the attempt said about it.
  const gate = await artifactGate(tx, row.id, artifactRoots);
  return {
    ...facts,
    artifact_validations_passed: gate.passed,
    artifact_failures: gate.failures,
  };
}

/**
 * A learned procedure is scoped to this job by the owner; trigger-selected
 * skills fill the rest. One entry per name, within the contract's cap.
 */
function mergeSkills(
  procedures: AttemptBundle['skills'],
  selected: AttemptBundle['skills'],
): AttemptBundle['skills'] {
  const seen = new Set<string>();
  const merged: AttemptBundle['skills'] = [];
  for (const skill of [...procedures, ...selected]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    merged.push(skill);
  }
  return merged.slice(0, CONTEXT_LIMITS.max_skills);
}
