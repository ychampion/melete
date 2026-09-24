/**
 * Skills the engine wrote for itself, as a source of "What I've learned".
 *
 * Each person sees the skills their own jobs wrote and that are promoted to them,
 * the same fence `EngineSkillService.list` keeps. Pausing, resuming and removing
 * go through the shared change log like any other source; approving the exact
 * text, rewriting it and "don't do this" are the engine skill's own controls, at
 * its own routes. A removal erases the skill's text, so it cannot be undone.
 */
import {
  type LearnedItem,
  type LearnedState,
  learnedItem as learnedItemView,
} from '@melete/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { ownJob } from '../principals/authority.ts';
import { ENGINE_ORIGIN } from './engine-scan.ts';
import { type EngineSkillService, isRefusal } from './engine-skills.ts';
import type { LearnedSourceProvider, PersonChange } from './learned.ts';
import { reasonWords } from './notices.ts';
import type { Candidate } from './procedures.ts';
import { type learnedChange, procedureCandidate } from './schema.ts';

type ChangeRow = typeof learnedChange.$inferSelect;

/** Gone at the person's word: deleted or declined, with nothing left to show. */
const ERASED = ['owner_deleted', 'owner_declined'];

function engineState(candidate: Candidate): LearnedState | null {
  const code = candidate.rejectionReason;
  // Refused at intake, or erased by the person: never learned, or no longer there.
  if (code && (isRefusal(code) || ERASED.includes(code))) return null;
  if (code) return 'reverted';
  if (candidate.holdReason) return 'proposed';
  if (candidate.state === 'enabled_canary') return candidate.pausedAt ? 'paused' : 'active';
  return null;
}

const ACTIONS: Record<LearnedState, LearnedItem['actions']> = {
  proposed: ['approve', 'edit', 'remove', 'stop'],
  trial: ['pause', 'edit', 'remove', 'stop'],
  active: ['pause', 'edit', 'remove', 'stop'],
  paused: ['resume', 'edit', 'remove', 'stop'],
  reverted: ['remove'],
};

function itemView(candidate: Candidate): LearnedItem | null {
  const state = engineState(candidate);
  if (!state) return null;
  const code = state === 'reverted' ? candidate.rejectionReason : null;
  return learnedItemView.parse({
    id: candidate.id,
    source: 'engine',
    name: candidate.skillName ?? '',
    does: candidate.description ? [candidate.description] : [],
    applies_when: [],
    space_id: candidate.spaceId,
    shared: false,
    state,
    reason: reasonWords(code),
    reason_code: code,
    definition_hash: candidate.bodyHash,
    learned_at: candidate.createdAt.toISOString(),
    expires_at: null,
    expiring_soon: false,
    actions: ACTIONS[state],
  });
}

type EngineSnapshot = {
  state: Candidate['state'];
  paused_at: string | null;
  hold_reason: string | null;
  rejection_reason: string | null;
};
const snapshot = (candidate: Candidate): EngineSnapshot => ({
  state: candidate.state,
  paused_at: candidate.pausedAt?.toISOString() ?? null,
  hold_reason: candidate.holdReason,
  rejection_reason: candidate.rejectionReason,
});
const same = (left: EngineSnapshot, right: EngineSnapshot) =>
  left.state === right.state &&
  left.paused_at === right.paused_at &&
  left.hold_reason === right.hold_reason &&
  left.rejection_reason === right.rejection_reason;

export class EngineSource implements LearnedSourceProvider {
  readonly source = 'engine' as const;
  constructor(readonly engine: EngineSkillService) {}

  async owns(tx: Transaction, id: string) {
    const [row] = await tx
      .select({ origin: procedureCandidate.origin })
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, id));
    return row?.origin === ENGINE_ORIGIN;
  }

  /** Written by this person's own jobs, and promoted to this person. */
  private async rows(tx: Transaction, principalId: string, spaceId: string, id?: string) {
    const rows = await tx
      .select({ candidate: procedureCandidate })
      .from(procedureCandidate)
      .innerJoin(job, eq(job.id, procedureCandidate.sourceJobId))
      .where(
        and(
          eq(procedureCandidate.spaceId, spaceId),
          eq(procedureCandidate.origin, ENGINE_ORIGIN),
          id ? eq(procedureCandidate.id, id) : undefined,
          ownJob(job.principalId, principalId),
          sql`${procedureCandidate.promotion}->>'principal_id' = ${principalId}`,
        ),
      )
      .orderBy(desc(procedureCandidate.createdAt))
      .limit(100);
    return rows.map((row) => row.candidate);
  }

  async list(tx: Transaction, principalId: string, spaceId: string) {
    return (await this.rows(tx, principalId, spaceId)).flatMap((candidate) => {
      const view = itemView(candidate);
      return view ? [view] : [];
    });
  }

  async item(tx: Transaction, principalId: string, spaceId: string, id: string) {
    const [candidate] = await this.rows(tx, principalId, spaceId, id);
    return candidate ? itemView(candidate) : null;
  }

  /** Locked, and this person's own on both counts; anything else reads as absent. */
  private async mine(tx: Transaction, principalId: string, spaceId: string, id: string) {
    const candidate = await this.engine.locked(tx, principalId, spaceId, id);
    if (candidate.promotion.principal_id !== principalId)
      throw new ServiceError('not_found', 'Skill not found.', 404);
    return candidate;
  }

  private async current(tx: Transaction, id: string) {
    const [row] = await tx.select().from(procedureCandidate).where(eq(procedureCandidate.id, id));
    if (!row) throw new ServiceError('not_found', 'Skill not found.', 404);
    return row;
  }

  async change(
    tx: Transaction,
    principalId: string,
    spaceId: string,
    id: string,
    action: PersonChange,
  ) {
    const candidate = await this.mine(tx, principalId, spaceId, id);
    const state = engineState(candidate);
    if (!state || !ACTIONS[state].includes(action))
      throw new ServiceError('invalid_procedure_state', `This cannot be ${action}d now.`, 409);
    if (action === 'remove')
      await this.engine.eraseIn(
        tx,
        principalId,
        spaceId,
        id,
        'owner_deleted',
        'The owner deleted this skill.',
      );
    else
      await this.engine.setPausedIn(
        tx,
        principalId,
        spaceId,
        id,
        action === 'pause' ? new Date() : null,
        action === 'pause' ? 'The owner paused this skill.' : 'The owner resumed this skill.',
      );
    const saved = await this.current(tx, id);
    return { before: snapshot(candidate), after: snapshot(saved), name: saved.skillName ?? '' };
  }

  async undo(tx: Transaction, principalId: string, spaceId: string, change: ChangeRow) {
    if (change.action === 'remove')
      throw new ServiceError(
        'undo_unavailable',
        'A removed skill cannot be brought back: its text was erased.',
        409,
      );
    const candidate = await this.mine(tx, principalId, spaceId, change.itemId);
    if (!same(snapshot(candidate), change.after as EngineSnapshot))
      throw new ServiceError(
        'undo_stale',
        'It has changed since, so that change can no longer be undone.',
        409,
      );
    const before = change.before as EngineSnapshot;
    await this.engine.setPausedIn(
      tx,
      principalId,
      spaceId,
      change.itemId,
      before.paused_at ? new Date(before.paused_at) : null,
      `The owner undid their last change (${change.action}).`,
    );
  }
}
