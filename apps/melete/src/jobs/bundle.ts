import {
  type AttemptBundle,
  type AttemptOutcome,
  attemptBundle,
  attemptOutcome,
  type CanonicalMessage,
  type ContextGenerations,
  type Deliverable,
  jobBudget,
  jobConstraints,
  jsonObject,
  QUESTION_GUIDANCE,
  type ResponsibilityAttemptBundle,
  receipt,
  responsibilityAttemptBundle,
  TERMINAL_ACTION_STATUSES,
  waitSpec,
} from '@melete/contracts';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  action,
  artifact,
  attempt,
  connection,
  event,
  knowledgeRecord,
  question,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
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

export async function buildBundle(
  tx: Transaction,
  row: JobRow,
  attemptIdentity: { id: string; epoch: number; revision: number; token: string },
  model: AttemptBundle['model'],
  afterSeq: number,
  expected?: ContextGenerations,
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
  const constraints = jobConstraints.parse(row.constraints);
  const context = await selectedContext(
    tx,
    row.spaceId,
    access.principalId,
    row.objective,
    history.inputs.new_user_messages.at(-1)?.content ?? '',
    constraints.public_compartment,
  );
  const wait = waitSpec.parse(row.wait);
  const [open] = await tx
    .select()
    .from(question)
    .where(and(eq(question.jobId, row.id), eq(question.state, 'open')))
    .limit(1);
  return responsibilityAttemptBundle.parse({
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
    },
    inputs: history.inputs,
    transcript: history.transcript,
    tools: [],
    skills: context.skills,
    knowledge: context.knowledge,
    workspace: { mount: '/work', files: [] },
    // The budget is one question per wake, stated rather than implied.
    attention: {
      questions_allowed: open ? 0 : 1,
      guidance: QUESTION_GUIDANCE,
      open_question: open ? questionView(open, row.title) : null,
      deferred_questions: readDeferred(row),
    },
    budget: jobBudget.parse(row.budget),
    model,
  });
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
  };
}

export async function completionFacts(
  tx: Transaction,
  row: JobRow,
  outcomeCompleted: CompletedOutcome,
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
  return evaluateCompletion(row, outcomeCompleted, { actions, artifacts, knowledge });
}
