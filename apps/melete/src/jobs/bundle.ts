import { join } from 'node:path';
import {
  type AttemptBundle,
  type AttemptOutcome,
  attemptBundle,
  attemptOutcome,
  type CanonicalMessage,
  CONTEXT_LIMITS,
  type ContextGenerations,
  type Deliverable,
  jobBudget,
  jobConstraints,
  jsonObject,
  QUESTION_GUIDANCE,
  type RecallResult,
  type ResponsibilityAttemptBundle,
  receipt,
  responsibilityAttemptBundle,
  TERMINAL_ACTION_STATUSES,
  waitSpec,
} from '@melete/contracts';
import { chooseSkills, loadSkills } from '@melete/skills';
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
  space,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { MemoryScope, MemorySql } from '../memory/db.ts';
import { pendingRepairBriefs } from '../memory/outputs.ts';
import { asKnowledge, recall } from '../memory/recall.ts';
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

/** Reserve the durable attempt first; its capability is usable only after commit. */
export async function buildAttemptSkeleton(
  tx: Transaction,
  row: JobRow,
  attemptIdentity: { id: string; epoch: number; revision: number; token: string },
  model: AttemptBundle['model'],
  afterSeq: number,
  expected?: ContextGenerations,
): Promise<ResponsibilityAttemptBundle> {
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
  const wait = waitSpec.parse(row.wait);
  const [open] = await tx
    .select()
    .from(question)
    .where(and(eq(question.jobId, row.id), eq(question.state, 'open')))
    .limit(1);
  const [jobSpace] = await tx
    .select({ path: space.gitPath })
    .from(space)
    .where(eq(space.id, row.spaceId));
  // This schema has one owner and no memberships. Only this space's skills can
  // override the built-ins; no directory supplied by the model is consulted.
  const selected = chooseSkills(
    row.objective,
    [...history.transcript].reverse().find((message) => message.role === 'user')?.content ?? '',
    loadSkills({ spaceSkillsDirectory: jobSpace ? join(jobSpace.path, 'skills') : undefined })
      .skills,
    CONTEXT_LIMITS.max_skills,
  );
  return responsibilityAttemptBundle.parse({
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
    skills: selected.map(({ skill }) => ({ name: skill.frontmatter.name, body: skill.body })),
    knowledge: [],
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
  const [previous] = await sql`select id, started_at from attempt
    where job_id = ${jobId} and epoch < ${skeleton.attempt.epoch} order by epoch desc limit 1`;
  // Handles reveal identity, not old claim text. Every join stays within the job's
  // space, and the current recall gate remains the authority on usable knowledge.
  const evidence = await sql`select s.id, s.source_version from memory_sources s
    where s.space_id = ${scope.spaceId} and s.state = 'active'
      and s.audience = any(${scope.role === 'owner' ? ['private', 'space', 'public'] : ['space', 'public']})
      and ${skeleton.job.constraints.public_compartment !== true}
      and (${previous?.started_at ?? null}::timestamptz is null
      or s.ingested_at > ${previous?.started_at ?? null}::timestamptz) order by s.ingested_at, s.id limit 50`;
  const actions =
    await sql`select a.id, a.status, a.receipt->>'action_id' as receipt_id from action a
    join job j on j.id = a.job_id where j.id = ${jobId} and j.space_id = ${scope.spaceId}
    order by a.created_at desc, a.id limit 50`;
  const questions =
    await sql`select q.id, q.text as prompt from question q join job j on j.id = q.job_id
    where j.id = ${jobId} and j.space_id = ${scope.spaceId} and q.state = 'open' order by q.created_at, q.id limit 20`;
  const approvals =
    await sql`select p.id, p.action_id from approval p join action a on a.id = p.action_id
    join job j on j.id = a.job_id where j.id = ${jobId} and j.space_id = ${scope.spaceId}
    and p.decision is null and a.status = 'needs_approval' and p.job_revision = j.revision
    and (p.expires_at is null or p.expires_at > now()) order by p.requested_at, p.id limit 20`;
  return {
    recall: result,
    bundle: {
      ...skeleton,
      tools,
      knowledge: result.items.map(asKnowledge),
      inputs: {
        ...skeleton.inputs,
        repair_briefs: repairBriefs,
        since_last: {
          previous_attempt_id: (previous?.id as string) ?? null,
          evidence_handles: evidence.map((entry) => `${entry.id}@${entry.source_version}`),
          actions: actions.map((entry) => ({
            action_id: entry.id as string,
            status: entry.status as string,
            receipt_id: (entry.receipt_id as string) ?? null,
          })),
          pending_questions: questions.map((entry) => ({
            id: entry.id as string,
            prompt: entry.prompt as string,
          })),
          pending_approvals: approvals.map((entry) => ({
            approval_id: entry.id as string,
            action_id: entry.action_id as string,
          })),
        },
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
