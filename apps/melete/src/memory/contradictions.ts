/**
 * E2. One active head per key, and a contradiction as a state rather than an
 * accident.
 *
 * Precedence is a table, not a judgement: an owner correction beats an owner
 * statement, which beats a verified connector observation, which beats a document
 * assertion, which beats an inference. Ties break by event time - when the thing
 * was true - and never by import time, so an old email that arrives late cannot
 * overwrite what the owner said last week.
 *
 * When two candidates are genuinely equal and neither carried an explicit
 * supersede, nothing is merged and nothing is dropped. Both revisions are
 * committed, the key enters `memory_contradictions`, and exactly one owner
 * question is queued with `because` naming the two revision handles that
 * disagree. Recall keeps serving the winning head and flags the key, and the
 * bundle tells the runtime not to act externally on it without approval.
 */
import {
  type Contradiction,
  claimHandleOf,
  contradiction as contradictionContract,
  type MemoryOwnerQuestion,
  memoryOwnerQuestion,
  type OriginTrust,
} from '@melete/contracts';
import { enqueue, iso, type MemoryScope, type MemoryTx, stableId } from './db.ts';
import { describeDay } from './trust.ts';

/** owner correction 4 > owner statement 3 > connector 2 > document 1 > inference 0. */
export const PRECEDENCE = {
  owner_correction: 4,
  owner_statement: 3,
  verified_connector: 2,
  document_assertion: 1,
  inference: 0,
} as const;

export function keyPrecedence(input: {
  origin_trust: OriginTrust;
  protected: boolean;
  kind: string;
}): number {
  if (input.kind === 'inferred') return PRECEDENCE.inference;
  if (input.origin_trust === 'owner')
    return input.protected ? PRECEDENCE.owner_correction : PRECEDENCE.owner_statement;
  if (input.origin_trust === 'verified_connector') return PRECEDENCE.verified_connector;
  if (input.origin_trust === 'external_content') return PRECEDENCE.document_assertion;
  return PRECEDENCE.inference;
}

export type KeyCandidate = {
  precedence: number;
  event_at: string;
  content: string;
  /** True when the proposal named the revision it replaces, so the owner meant to replace it. */
  explicit_supersede: boolean;
};
export type KeyDecision = {
  decision: 'publish' | 'historical' | 'dispute' | 'dispute_keep_head' | 'no-op';
  reason: string;
};

/**
 * Which of two candidates for one key holds the active slot. The model does not
 * participate: everything here is the precedence table and event time.
 */
export function resolveKeyedHead(
  proposal: KeyCandidate,
  head: Omit<KeyCandidate, 'explicit_supersede'>,
): KeyDecision {
  if (proposal.content.trim() === head.content.trim())
    return { decision: 'no-op', reason: 'already_the_head' };
  if (proposal.precedence > head.precedence)
    return { decision: 'publish', reason: 'higher_precedence' };
  if (proposal.precedence < head.precedence)
    return { decision: 'historical', reason: 'lower_precedence' };
  if (proposal.explicit_supersede) return { decision: 'publish', reason: 'explicit_supersede' };
  if (proposal.event_at > head.event_at)
    return { decision: 'dispute', reason: 'later_statement_without_an_explicit_supersede' };
  if (proposal.event_at < head.event_at)
    return { decision: 'historical', reason: 'earlier_by_event_time' };
  // Equal event time. Import order is not an authority, so the slot does not move.
  return { decision: 'dispute_keep_head', reason: 'simultaneous_disagreement' };
}

const subjectOf = (key: string) => key.split('.').slice(0, 2).join(' ').replace(/-/g, ' ');
const leafOf = (key: string) => key.slice(key.lastIndexOf('.') + 1);

export function questionFor(
  key: string,
  head: { content: string; event_at: string },
  alternative: { content: string; event_at: string },
) {
  return {
    question: `Which is right for the ${subjectOf(key)}: ${head.content}, from ${describeDay(head.event_at)}, or ${alternative.content}, from ${describeDay(alternative.event_at)}?`,
    if_ignored: `Melete will not act externally on the ${leafOf(key)} for ${subjectOf(key)} until you answer, and will keep serving ${head.content}.`,
  };
}

export type ContradictionInput = {
  key: string;
  audience: string;
  claimId: string;
  head: { revision: number; content: string; event_at: string };
  alternative: { revision: number; content: string; event_at: string };
};

/**
 * Record the contradiction and queue exactly one question for the key. The unique
 * partial indexes do the enforcing: one open contradiction and one queued
 * question per key, however many times a conflicting proposal arrives.
 */
export async function recordContradiction(
  tx: MemoryTx,
  scope: MemoryScope,
  input: ContradictionInput,
): Promise<{ contradiction_id: string; question_id: string }> {
  const head = claimHandleOf(input.claimId, input.head.revision);
  const alternative = claimHandleOf(input.claimId, input.alternative.revision);
  const questionId = `mq_${stableId(scope.spaceId, input.key)}`;
  const contradictionId = `mc_${stableId(scope.spaceId, input.key, head, alternative)}`;
  const { question, if_ignored } = questionFor(input.key, input.head, input.alternative);
  // `because` is the two handles that disagree. The table refuses an empty one.
  await tx`insert into memory_questions (id, space_id, key, question, because, if_ignored)
    values (${questionId}, ${scope.spaceId}, ${input.key}, ${question}, ${JSON.stringify([head, alternative])}::text::jsonb, ${if_ignored})
    on conflict do nothing`;
  await tx`insert into memory_contradictions (id, space_id, key, audience, claim_id, head, alternative, question_id)
    values (${contradictionId}, ${scope.spaceId}, ${input.key}, ${input.audience}, ${input.claimId}, ${head}, ${alternative}, ${questionId})
    on conflict do nothing`;
  await enqueue(tx, scope.spaceId, 'question', questionId);
  return { contradiction_id: contradictionId, question_id: questionId };
}

/** An owner correction on the key settles it: the contradiction closes and the question is answered. */
export async function resolveContradictions(tx: MemoryTx, scope: MemoryScope, key: string) {
  await tx`update memory_contradictions set state = 'resolved'
    where space_id = ${scope.spaceId} and key = ${key} and state = 'open'`;
  await tx`update memory_questions set state = 'answered'
    where space_id = ${scope.spaceId} and key = ${key} and state = 'queued'`;
  await tx`update memory_outbox set completed_at = clock_timestamp()
    where space_id = ${scope.spaceId} and kind = 'question' and target_id = ${`mq_${stableId(scope.spaceId, key)}`} and completed_at is null`;
}

/** The keys a reader must not act externally on without approval. */
export async function disputedKeys(
  tx: MemoryTx,
  spaceId: string,
  audiences: readonly string[],
): Promise<string[]> {
  if (!audiences.length) return [];
  const rows = await tx`select distinct key from memory_contradictions
    where space_id = ${spaceId} and state = 'open' and audience = any(${[...audiences]}) order by key`;
  return rows.map((row) => row.key as string);
}

export async function listContradictions(
  tx: MemoryTx,
  scope: MemoryScope,
): Promise<Contradiction[]> {
  const rows = await tx`select * from memory_contradictions where space_id = ${scope.spaceId}
    and (${scope.role === 'owner'} or audience in ('space','public')) order by recorded_at, id`;
  return rows.map((row) =>
    contradictionContract.parse({
      id: row.id,
      space_id: row.space_id,
      key: row.key,
      audience: row.audience,
      claim_id: row.claim_id,
      head: row.head,
      alternative: row.alternative,
      state: row.state,
      question_id: row.question_id ?? null,
      recorded_at: iso(row.recorded_at as Date),
    }),
  );
}

export async function listQuestions(
  tx: MemoryTx,
  scope: MemoryScope,
): Promise<MemoryOwnerQuestion[]> {
  const rows = await tx`select * from memory_questions where space_id = ${scope.spaceId}
    and state = 'queued' order by created_at, id`;
  return rows.map((row) =>
    memoryOwnerQuestion.parse({
      id: row.id,
      space_id: row.space_id,
      key: row.key,
      question: row.question,
      because: row.because,
      if_ignored: row.if_ignored,
      state: row.state,
      created_at: iso(row.created_at as Date),
    }),
  );
}
