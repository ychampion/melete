/**
 * What learning tells a person, in words trusted code writes.
 *
 * Two things are said. After a job used something the person is trying, they
 * are asked once whether to keep doing it. When something they taught stops
 * being used, they are told what stopped and why. A notice row holds ids and a
 * reason code; the sentence is rendered when it is read, from the definition's
 * own admitted words, so nothing a model wrote and nothing from mail, pages or
 * tool results can reach it.
 */
import type { LearningNotice } from '@melete/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { JobRow } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { STEP_BODIES } from './procedure.ts';
import { learningNotice, procedureCandidate } from './schema.ts';

type Candidate = typeof procedureCandidate.$inferSelect;
export type NoticeRow = typeof learningNotice.$inferSelect;

export const OWNER_DECLINED = 'owner_declined';

/** Every reason code a notice can carry, in the words the person reads. */
const REASON_WORDS: Record<string, string> = {
  canary_intervention: 'You corrected a job that used it, so I stopped.',
  [OWNER_DECLINED]: 'You said not to keep doing it.',
};
export const reasonWords = (code: string | null) =>
  code ? (REASON_WORDS[code] ?? 'It was stopped.') : null;

const capitalised = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** A short name, from where it applies: the owner's own trigger words. */
export function learnedName(candidate: Pick<Candidate, 'triggers' | 'tests'>): string {
  const phrase = candidate.triggers[0]?.phrase.trim();
  if (phrase) return capitalised(phrase);
  return candidate.tests.includes('ordering-and-shape') ? 'Arranging records' : 'What you taught';
}

/**
 * What it does, step by step. A step kept verbatim is shown as the owner's quote
 * rather than inside the wrapper the delivered body puts around it.
 */
export function learnedSteps(candidate: Pick<Candidate, 'change'>): string[] {
  const steps = (candidate.change as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step): string[] => {
    if (typeof step === 'string')
      return step in STEP_BODIES ? [STEP_BODIES[step as keyof typeof STEP_BODIES]] : [];
    if (!step || typeof step !== 'object') return [];
    const { text, evidence } = step as {
      text?: unknown;
      evidence?: { fallback?: unknown; quote?: unknown };
    };
    if (evidence?.fallback === 'verbatim' && typeof evidence.quote === 'string')
      return [evidence.quote];
    return typeof text === 'string' ? [text] : [];
  });
}

const KEEP_OPTIONS = [
  { id: 'yes', label: 'Yes, keep doing this' },
  { id: 'no', label: 'No, stop' },
  { id: 'change', label: 'Change it' },
] as const;

export function noticeView(row: NoticeRow, candidate: Pick<Candidate, 'triggers' | 'tests'>) {
  const name = learnedName(candidate);
  const common = {
    id: row.id,
    item_id: row.candidateId,
    name,
    job_id: row.jobId,
    created_at: row.createdAt.toISOString(),
  };
  if (row.kind === 'keep_question')
    return {
      ...common,
      kind: 'keep_question',
      text: `I followed what you taught me about "${name}" on this job. Keep doing this?`,
      options: [...KEEP_OPTIONS],
      state: row.state === 'read' ? 'answered' : row.state,
      answer: row.answer ?? null,
    } satisfies LearningNotice;
  return {
    ...common,
    kind: 'reverted',
    text: `I stopped using "${name}". ${reasonWords(row.reasonCode) ?? ''}`.trim(),
    reason_code: row.reasonCode ?? 'stopped',
    state: row.state === 'read' ? 'read' : 'open',
  } satisfies LearningNotice;
}

/** A question about something that is no longer on trial has nothing left to ask. */
export async function withdrawQuestions(tx: Transaction, candidateId: string) {
  await tx
    .update(learningNotice)
    .set({ state: 'withdrawn', resolvedAt: new Date() })
    .where(
      and(
        eq(learningNotice.candidateId, candidateId),
        eq(learningNotice.kind, 'keep_question'),
        eq(learningNotice.state, 'open'),
      ),
    );
}

/** Also on the job's own stream, so a person watching that job sees it as it happens. */
async function announce(
  tx: Transaction,
  row: NoticeRow,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!row.jobId) return;
  await appendEvent(tx, {
    jobId: row.jobId,
    type: 'notice',
    payload: { ...payload, notice_id: row.id, procedure_id: row.candidateId },
    dedupKey: `learning-notice:${row.id}`,
  });
}

/**
 * Tells the person a procedure they were getting has stopped, and why. Called in
 * the transaction that stopped it, so the notice exists exactly when the revert does.
 */
export async function noticeReverted(
  tx: Transaction,
  candidate: Candidate,
  principalId: string | null,
  jobId: string | null,
  reasonCode: string,
) {
  await withdrawQuestions(tx, candidate.id);
  if (!principalId) return null;
  const [saved] = await tx
    .insert(learningNotice)
    .values({
      id: newId('ln'),
      spaceId: candidate.spaceId,
      principalId,
      candidateId: candidate.id,
      jobId,
      kind: 'reverted',
      definitionHash: candidate.bodyHash,
      reasonCode,
    })
    .returning();
  if (!saved) throw new Error('Notice insert returned no row');
  await announce(tx, saved, { kind: 'learning_reverted', reason_code: reasonCode });
  return saved;
}

/**
 * After a job the person runs has used something they are trying, and finished
 * without being corrected, ask once whether to keep it. Once per definition: an
 * answered question is not asked again for the same bytes, and while one is
 * open no second is added.
 */
export async function askToKeep(tx: Transaction, row: JobRow, attemptId: string) {
  if (!row.principalId) return [];
  const delivered = await tx.execute(sql`
    select distinct substr(skill->>'name', 11) as id
    from learning_attempt captured, jsonb_array_elements(captured.versions->'skills') skill
    where captured.attempt_id = ${attemptId} and skill->>'name' like 'procedure:%'`);
  const ids = delivered.map((entry) => String(entry.id));
  if (!ids.length) return [];
  const trials = await tx
    .select()
    .from(procedureCandidate)
    .where(
      and(
        inArray(procedureCandidate.id, ids),
        eq(procedureCandidate.state, 'enabled_canary'),
        eq(procedureCandidate.canarySpaceId, row.spaceId),
        isNull(procedureCandidate.rejectionReason),
        isNull(procedureCandidate.pausedAt),
        isNull(procedureCandidate.removedAt),
      ),
    )
    .for('update');
  const asked: NoticeRow[] = [];
  for (const candidate of trials) {
    const promotion = candidate.promotion;
    if (
      promotion.basis !== 'owner_trial' ||
      promotion.principal_id !== row.principalId ||
      promotion.definition_hash !== candidate.bodyHash
    )
      continue;
    const earlier = await tx
      .select()
      .from(learningNotice)
      .where(
        and(eq(learningNotice.candidateId, candidate.id), eq(learningNotice.kind, 'keep_question')),
      );
    if (
      earlier.some(
        (notice) =>
          notice.state === 'open' ||
          (notice.state === 'answered' && notice.definitionHash === candidate.bodyHash),
      )
    )
      continue;
    const [saved] = await tx
      .insert(learningNotice)
      .values({
        id: newId('ln'),
        spaceId: row.spaceId,
        principalId: row.principalId,
        candidateId: candidate.id,
        jobId: row.id,
        kind: 'keep_question',
        definitionHash: candidate.bodyHash,
      })
      .onConflictDoNothing()
      .returning();
    if (!saved) continue;
    await announce(tx, saved, { kind: 'learning_question' });
    asked.push(saved);
  }
  return asked;
}

/** The notice kind the conversation trail shows as a tool entry. */
export const TOOL_TRACE = 'tool_trace';
const TOOL_TITLE_LIMIT = 120;
const TOOL_SUMMARY_LIMIT = 160;
const TOOL_QUOTE_LIMIT = 200;
const clip = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/**
 * Each learned procedure an attempt was given is shown in the job's trail as a
 * tool entry, the way every other piece of work is: "Used what you taught me",
 * with its name, and the first step quoted as the person's own words. Nothing is
 * asked of the person; this only says what ran.
 */
export async function traceProcedureUse(
  tx: Transaction,
  jobId: string,
  attemptId: string,
  skills: readonly { name: string }[],
) {
  const ids = skills
    .filter((skill) => skill.name.startsWith('procedure:'))
    .map((skill) => skill.name.slice('procedure:'.length));
  if (!ids.length) return;
  const used = await tx
    .select()
    .from(procedureCandidate)
    .where(inArray(procedureCandidate.id, ids));
  const at = new Date().toISOString();
  for (const candidate of used) {
    const name = learnedName(candidate);
    const steps = learnedSteps(candidate);
    const first = steps[0]?.replace(/\s+/g, ' ').trim();
    const id = `procedure:${attemptId}:${candidate.id}`;
    await appendEvent(tx, {
      jobId,
      attemptId,
      type: 'notice',
      payload: {
        kind: TOOL_TRACE,
        call: {
          id,
          kind: 'skill',
          title: clip(`Used what you taught me: ${name}`, TOOL_TITLE_LIMIT),
          status: 'done',
          started_at: at,
          ended_at: at,
          input_summary: null,
          output_summary: {
            text: clip(
              `${steps.length} ${steps.length === 1 ? 'step' : 'steps'} you taught`,
              TOOL_SUMMARY_LIMIT,
            ),
            ...(first ? { quote: { text: clip(first, TOOL_QUOTE_LIMIT), from: 'message' } } : {}),
          },
          detail: null,
          parent: null,
        },
      },
      dedupKey: `tool:${id}:done`,
    });
  }
}
