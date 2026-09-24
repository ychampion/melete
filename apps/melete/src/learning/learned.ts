/**
 * What a person has taught, as they would describe it, and the few things they
 * can do about it: try it, pause it, resume it, remove it, and undo the last of
 * those. Also their answers to "keep doing this?".
 *
 * The list is assembled from sources: corrections, and the skills the engine
 * writes for itself (`learned-engine.ts`). Each implements `LearnedSourceProvider`
 * and registers, without changing the list, the change log or undo. Every change a person makes is logged with the fields it changed
 * before and after, and undo restores the "before" only while nothing else has
 * touched the item since, so an undo can never overwrite a revert, a newer
 * change or another source's work.
 */
import {
  type KeepAnswerRequest,
  keepAnswerRequest,
  type LearnedChange,
  type LearnedChangeAction,
  type LearnedItem,
  type LearnedSource,
  type LearnedState,
  learnedChange as learnedChangeView,
  learnedItem as learnedItemView,
  learningNotice as learningNoticeView,
  type ProcedurePromotion,
} from '@melete/contracts';
import { and, desc, eq, gt, isNull, like, or } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { space as spaceTable } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { visibleJob } from '../principals/authority.ts';
import { type EpisodeService, KEPT_UNTIL, requireLearningSpace } from './episodes.ts';
import {
  learnedName,
  learnedSteps,
  noticeReverted,
  noticeView,
  OWNER_DECLINED,
  reasonWords,
  withdrawQuestions,
} from './notices.ts';
import {
  type Candidate,
  hasSelectedFinalEvidence,
  type ProcedureService,
  requireNotRemoved,
  transitionProcedure,
  verifyDefinition,
  verifyEvidence,
} from './procedures.ts';
import { episode, learnedChange, learningNotice, procedureCandidate } from './schema.ts';

type ChangeRow = typeof learnedChange.$inferSelect;
export type PersonChange = 'pause' | 'resume' | 'remove';

/** One place taught behaviour comes from. */
export interface LearnedSourceProvider {
  readonly source: LearnedSource;
  /** Both sources keep their items as procedure candidates, so this reads the row. */
  owns(tx: Transaction, id: string): Promise<boolean>;
  list(tx: Transaction, principalId: string, spaceId: string): Promise<LearnedItem[]>;
  item(
    tx: Transaction,
    principalId: string,
    spaceId: string,
    id: string,
  ): Promise<LearnedItem | null>;
  /** Applies the change and returns the fields it changed, before and after. */
  change(
    tx: Transaction,
    principalId: string,
    spaceId: string,
    id: string,
    action: PersonChange,
  ): Promise<{ before: Record<string, unknown>; after: Record<string, unknown>; name: string }>;
  /** Restores `change.before`, refusing when the item moved on since `change.after`. */
  undo(tx: Transaction, principalId: string, spaceId: string, change: ChangeRow): Promise<void>;
}

/** The fields a person's change can move, and nothing else. */
type Snapshot = {
  state: Candidate['state'];
  promotion: ProcedurePromotion;
  rejection_reason: string | null;
  paused_at: string | null;
  removed_at: string | null;
  version: number;
  /** Recorded by "yes": when the correction behind it would have expired, for undo. */
  episode_expires_at?: string;
};
const snapshot = (candidate: Candidate): Snapshot => ({
  state: candidate.state,
  promotion: candidate.promotion,
  rejection_reason: candidate.rejectionReason,
  paused_at: candidate.pausedAt?.toISOString() ?? null,
  removed_at: candidate.removedAt?.toISOString() ?? null,
  version: candidate.version,
});

/**
 * Whether the item is still exactly as the change left it, in every field a change
 * moves. The version counter is not compared: undoing a later change moves it too,
 * and the change before that must still be undoable.
 */
function sameFields(current: Snapshot, recorded: Snapshot) {
  const canonical = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;
  const { version: _current, episode_expires_at: _kept, ...now } = current;
  const { version: _recorded, episode_expires_at: _keptThen, ...then } = recorded;
  return JSON.stringify(canonical(now)) === JSON.stringify(canonical(then));
}

function learnedState(candidate: Candidate): LearnedState | null {
  if (candidate.state === 'reverted') return 'reverted';
  if (candidate.state === 'superseded') return null;
  if (candidate.state === 'enabled_canary' || candidate.state === 'active')
    return candidate.pausedAt ? 'paused' : candidate.state === 'active' ? 'active' : 'trial';
  // A candidate the owner rejected, or one refused before it was ever tried, was never learned.
  return candidate.rejectionReason ? null : 'proposed';
}

const ACTIONS: Record<LearnedState, LearnedItem['actions']> = {
  proposed: ['try', 'remove'],
  trial: ['pause', 'remove'],
  active: ['pause', 'remove'],
  paused: ['resume', 'remove'],
  reverted: ['remove'],
};

/** An item this close to expiring is shown as expiring. */
const EXPIRING_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

function itemView(
  candidate: Candidate,
  source: { actor: string; expiresAt: Date },
  principalId: string,
  shareable = false,
) {
  const state = learnedState(candidate);
  if (!state || candidate.removedAt) return null;
  const code = state === 'reverted' ? candidate.rejectionReason : null;
  // Kept by the person's "yes": it lasts. Anything else goes with the correction it came from.
  const expires = source.expiresAt.getTime() >= KEPT_UNTIL.getTime() ? null : source.expiresAt;
  return learnedItemView.parse({
    id: candidate.id,
    source: 'correction',
    name: learnedName(candidate),
    does: learnedSteps(candidate),
    applies_when: candidate.triggers.map((trigger) => trigger.phrase),
    space_id: candidate.spaceId,
    shared: candidate.promotion.scope === 'space',
    state,
    reason: reasonWords(code),
    reason_code: code,
    definition_hash: candidate.bodyHash,
    learned_at: candidate.createdAt.toISOString(),
    expires_at: expires?.toISOString() ?? null,
    expiring_soon: !!expires && expires.getTime() - Date.now() <= EXPIRING_WITHIN_MS,
    // Only the person who made the correction may try what it taught.
    actions: [
      ...ACTIONS[state].filter((action) => action !== 'try' || source.actor === principalId),
      ...(state === 'active' && shareable ? (['share'] as const) : []),
    ],
  });
}

/** Procedures learned from the person's own corrections. */
export class CorrectionSource implements LearnedSourceProvider {
  readonly source = 'correction' as const;
  constructor(readonly procedures: ProcedureService) {}

  async owns(tx: Transaction, id: string) {
    const [row] = await tx
      .select({ origin: procedureCandidate.origin })
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, id));
    return row?.origin === 'owner_correction';
  }

  /** The person's own: delivered to them, from a correction on a job they can see. */
  private async rows(tx: Transaction, principalId: string, spaceId: string, id?: string) {
    const rows = await tx
      .select({ candidate: procedureCandidate, source: episode })
      .from(procedureCandidate)
      .innerJoin(episode, eq(episode.id, procedureCandidate.episodeId))
      .where(
        and(
          eq(procedureCandidate.spaceId, spaceId),
          id ? eq(procedureCandidate.id, id) : undefined,
          visibleJob(episode.jobId, principalId),
          eq(episode.restricted, false),
          gt(episode.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(procedureCandidate.createdAt))
      .limit(100);
    return rows.filter(
      ({ candidate, source }) => (candidate.promotion.principal_id ?? source.actor) === principalId,
    );
  }

  /**
   * Whether the person may share what they kept with their space: a shared space,
   * and sealed evaluation evidence for the exact definition they kept.
   */
  private async shareable(tx: Transaction, spaceId: string, candidate: Candidate) {
    if (
      candidate.state !== 'active' ||
      candidate.pausedAt ||
      candidate.promotion.basis !== 'owner_confirmed' ||
      candidate.promotion.definition_hash !== candidate.bodyHash
    )
      return false;
    const [space] = await tx
      .select({ kind: spaceTable.kind })
      .from(spaceTable)
      .where(eq(spaceTable.id, spaceId));
    return space?.kind === 'shared' && (await hasSelectedFinalEvidence(tx, candidate));
  }

  async list(tx: Transaction, principalId: string, spaceId: string) {
    const items: LearnedItem[] = [];
    for (const { candidate, source } of await this.rows(tx, principalId, spaceId)) {
      const view = itemView(
        candidate,
        source,
        principalId,
        await this.shareable(tx, spaceId, candidate),
      );
      if (view) items.push(view);
    }
    return items;
  }

  async item(tx: Transaction, principalId: string, spaceId: string, id: string) {
    const [row] = await this.rows(tx, principalId, spaceId, id);
    return row
      ? itemView(
          row.candidate,
          row.source,
          principalId,
          await this.shareable(tx, spaceId, row.candidate),
        )
      : null;
  }

  /** Locked, and the person's own; anything else reads as absent. */
  private async mine(tx: Transaction, principalId: string, spaceId: string, id: string) {
    const locked = await this.procedures.lockedCorrection(tx, principalId, spaceId, id);
    if ((locked.candidate.promotion.principal_id ?? locked.source.actor) !== principalId)
      throw new ServiceError('not_found', 'Procedure not found.', 404);
    return locked;
  }

  async change(
    tx: Transaction,
    principalId: string,
    spaceId: string,
    id: string,
    action: PersonChange,
  ) {
    const { candidate } = await this.mine(tx, principalId, spaceId, id);
    requireNotRemoved(candidate);
    const state = learnedState(candidate);
    if (!state || !ACTIONS[state].includes(action))
      throw new ServiceError('invalid_procedure_state', `This cannot be ${action}d now.`, 409);
    if (action === 'resume') verifyDefinition(candidate);
    const now = new Date();
    const [saved] = await tx
      .update(procedureCandidate)
      .set({
        ...(action === 'pause' ? { pausedAt: now } : {}),
        ...(action === 'resume' ? { pausedAt: null } : {}),
        ...(action === 'remove' ? { removedAt: now } : {}),
        version: candidate.version + 1,
      })
      .where(and(eq(procedureCandidate.id, id), eq(procedureCandidate.version, candidate.version)))
      .returning();
    if (!saved)
      throw new ServiceError('procedure_changed', 'This changed while you were changing it.');
    // Asking whether to keep something that is paused or gone asks nothing.
    if (action !== 'resume') await withdrawQuestions(tx, id);
    return { before: snapshot(candidate), after: snapshot(saved), name: learnedName(saved) };
  }

  async undo(tx: Transaction, principalId: string, spaceId: string, change: ChangeRow) {
    if (!change.candidateId) throw new ServiceError('not_found', 'Nothing to undo.', 404);
    const { candidate, source, objective } = await this.mine(
      tx,
      principalId,
      spaceId,
      change.candidateId,
    );
    const after = change.after as Snapshot;
    const before = change.before as Snapshot;
    if (!sameFields(snapshot(candidate), after))
      throw new ServiceError(
        'undo_stale',
        'It has changed since, so that change can no longer be undone.',
        409,
      );
    // Back to being delivered: the definition and its evidence must still hold.
    if (
      !before.removed_at &&
      !before.paused_at &&
      ['enabled_canary', 'active'].includes(before.state)
    ) {
      verifyDefinition(candidate);
      verifyEvidence(candidate, source, objective);
    }
    const [saved] = await tx
      .update(procedureCandidate)
      .set({
        promotion: before.promotion,
        rejectionReason: before.rejection_reason,
        pausedAt: before.paused_at ? new Date(before.paused_at) : null,
        removedAt: before.removed_at ? new Date(before.removed_at) : null,
      })
      .where(eq(procedureCandidate.id, candidate.id))
      .returning();
    if (!saved) throw new ServiceError('procedure_changed', 'The procedure changed during undo.');
    // Undoing a "yes" gives the correction back the expiry it had.
    if (before.episode_expires_at)
      await tx
        .update(episode)
        .set({ expiresAt: new Date(before.episode_expires_at) })
        .where(eq(episode.id, candidate.episodeId));
    await transitionProcedure(
      tx,
      saved,
      before.state,
      principalId,
      `The owner undid their last change (${change.action}).`,
    );
  }
}

/** A correction is named from its trigger words; an engine skill by the name it was given. */
const nameOf = (candidate: Candidate) =>
  candidate.origin === 'engine_staged' ? (candidate.skillName ?? '') : learnedName(candidate);

const changeView = (row: ChangeRow, name: string): LearnedChange =>
  learnedChangeView.parse({
    id: row.id,
    item_id: row.itemId,
    source: row.source,
    action: row.action,
    name,
    created_at: row.createdAt.toISOString(),
  });

export class LearnedService {
  readonly sources: LearnedSourceProvider[];
  constructor(
    readonly jobs: JobService,
    readonly procedures: ProcedureService,
    readonly episodes: EpisodeService,
    extra: LearnedSourceProvider[] = [],
  ) {
    this.sources = [new CorrectionSource(procedures), ...extra];
  }

  private async sourceFor(tx: Transaction, id: string) {
    for (const source of this.sources) if (await source.owns(tx, id)) return source;
    throw new ServiceError('not_found', 'Not found.', 404);
  }

  private async record(
    tx: Transaction,
    principalId: string,
    spaceId: string,
    source: LearnedSource,
    itemId: string,
    action: LearnedChangeAction,
    change: { before: Record<string, unknown>; after: Record<string, unknown>; name: string },
  ) {
    const [row] = await tx
      .insert(learnedChange)
      .values({
        id: newId('lc'),
        spaceId,
        principalId,
        source,
        itemId,
        candidateId: itemId,
        action,
        before: change.before,
        after: change.after,
      })
      .returning();
    if (!row) throw new Error('Change insert returned no row');
    return changeView(row, change.name);
  }

  /** The person's latest change here that has not been undone, if any. */
  private async latest(tx: Transaction, principalId: string, spaceId: string) {
    const [row] = await tx
      .select({ change: learnedChange, candidate: procedureCandidate })
      .from(learnedChange)
      .leftJoin(procedureCandidate, eq(procedureCandidate.id, learnedChange.candidateId))
      .where(
        and(
          eq(learnedChange.spaceId, spaceId),
          eq(learnedChange.principalId, principalId),
          isNull(learnedChange.undoneAt),
        ),
      )
      .orderBy(desc(learnedChange.createdAt), desc(learnedChange.id))
      .limit(1);
    return row;
  }

  async list(principalId: string, spaceId: string) {
    return this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, principalId, spaceId);
      const items = (
        await Promise.all(this.sources.map((source) => source.list(tx, principalId, spaceId)))
      ).flat();
      const latest = await this.latest(tx, principalId, spaceId);
      return {
        items,
        last_change: latest
          ? changeView(latest.change, latest.candidate ? nameOf(latest.candidate) : '')
          : null,
      };
    });
  }

  async change(principalId: string, spaceId: string, id: string, action: PersonChange) {
    return this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, principalId, spaceId);
      const source = await this.sourceFor(tx, id);
      const applied = await source.change(tx, principalId, spaceId, id, action);
      const change = await this.record(
        tx,
        principalId,
        spaceId,
        source.source,
        id,
        action,
        applied,
      );
      return { item: await source.item(tx, principalId, spaceId, id), change };
    });
  }

  /** Sharing what the person kept, on the same sealed evidence any sharing needs. */
  async share(principalId: string, spaceId: string, id: string) {
    await this.requireCorrection(id);
    await this.procedures.activate(principalId, spaceId, id, 'space');
    return this.jobs.transaction(async (tx) => ({
      item: await (await this.sourceFor(tx, id)).item(tx, principalId, spaceId, id),
      change: null,
    }));
  }

  /** Sharing and trying are the correction road; an engine skill has its own controls. */
  private async requireCorrection(id: string) {
    const source = await this.jobs.transaction((tx) => this.sourceFor(tx, id));
    if (source.source !== 'correction')
      throw new ServiceError(
        'invalid_procedure_state',
        'A skill the engine wrote is managed through its own surface.',
        409,
      );
  }

  /** Trying approves the definition the person was shown, by its hash. */
  async try(principalId: string, spaceId: string, id: string, definitionHash: string) {
    await this.requireCorrection(id);
    await this.procedures.startTrial(principalId, spaceId, id, definitionHash);
    return this.jobs.transaction(async (tx) => ({
      item: await (await this.sourceFor(tx, id)).item(tx, principalId, spaceId, id),
      change: null,
    }));
  }

  async undo(principalId: string, spaceId: string, changeId: string) {
    return this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, principalId, spaceId);
      const latest = await this.latest(tx, principalId, spaceId);
      // Only the change the person was shown as their latest; never an older one.
      if (!latest || latest.change.id !== changeId)
        throw new ServiceError('undo_stale', 'That is no longer your latest change.', 409);
      const source = await this.sourceFor(tx, latest.change.itemId);
      await source.undo(tx, principalId, spaceId, latest.change);
      await tx
        .update(learnedChange)
        .set({ undoneAt: new Date() })
        .where(eq(learnedChange.id, latest.change.id));
      return {
        item: await source.item(tx, principalId, spaceId, latest.change.itemId),
        change: null,
      };
    });
  }

  /** Open questions and unread notices, newest first. */
  async notices(principalId: string, spaceId: string) {
    return this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, principalId, spaceId);
      const rows = await tx
        .select({ notice: learningNotice, candidate: procedureCandidate })
        .from(learningNotice)
        .innerJoin(procedureCandidate, eq(procedureCandidate.id, learningNotice.candidateId))
        .where(
          and(
            eq(learningNotice.spaceId, spaceId),
            eq(learningNotice.principalId, principalId),
            eq(learningNotice.state, 'open'),
          ),
        )
        .orderBy(desc(learningNotice.createdAt))
        .limit(50);
      return rows.map(({ notice, candidate }) =>
        learningNoticeView.parse(noticeView(notice, candidate)),
      );
    });
  }

  private async notice(tx: Transaction, principalId: string, spaceId: string, id: string) {
    const [row] = await tx
      .select()
      .from(learningNotice)
      .where(
        and(
          eq(learningNotice.id, id),
          eq(learningNotice.spaceId, spaceId),
          eq(learningNotice.principalId, principalId),
        ),
      )
      .for('update');
    if (!row) throw new ServiceError('not_found', 'Notice not found.', 404);
    return row;
  }

  async read(principalId: string, spaceId: string, id: string) {
    return this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, principalId, spaceId);
      const row = await this.notice(tx, principalId, spaceId, id);
      if (row.kind !== 'reverted')
        throw new ServiceError(
          'invalid_notice',
          'Answer a question instead of dismissing it.',
          409,
        );
      const [saved] = await tx
        .update(learningNotice)
        .set({ state: 'read', resolvedAt: row.resolvedAt ?? new Date() })
        .where(eq(learningNotice.id, id))
        .returning();
      const [candidate] = await tx
        .select()
        .from(procedureCandidate)
        .where(eq(procedureCandidate.id, row.candidateId));
      if (!saved || !candidate) throw new ServiceError('not_found', 'Notice not found.', 404);
      return learningNoticeView.parse(noticeView(saved, candidate));
    });
  }

  /**
   * Yes keeps it for this person: it becomes active on the strength of their own
   * approval, still private to them in this space; sharing it still needs sealed
   * evaluation evidence. No stops it, with their reason recorded. Change turns
   * their words into a correction of the job that used it, which also stops it.
   */
  async answer(principalId: string, spaceId: string, id: string, raw: unknown) {
    const request: KeepAnswerRequest = keepAnswerRequest.parse(raw);
    type Answered = {
      row: typeof learningNotice.$inferSelect;
      episodeId: string | null;
      candidateId: string;
      /** The job a "change" corrected, which may have an attempt to fence. */
      corrected?: string;
    };
    const result = await this.jobs.transaction(async (tx): Promise<Answered> => {
      await requireLearningSpace(tx, principalId, spaceId);
      const row = await this.notice(tx, principalId, spaceId, id);
      if (row.kind !== 'keep_question')
        throw new ServiceError('invalid_notice', 'This notice asks nothing.', 409);
      if (row.state !== 'open') {
        // Answering the same way again is the same answer; anything else is too late.
        if (row.state === 'answered' && row.answer === request.answer)
          return { row, episodeId: row.episodeId, candidateId: row.candidateId };
        throw new ServiceError('question_closed', 'This question is no longer open.', 409);
      }
      const { candidate, source, objective } = await this.procedures.lockedCorrection(
        tx,
        principalId,
        spaceId,
        row.candidateId,
      );
      const promotion = candidate.promotion;
      if (
        candidate.state !== 'enabled_canary' ||
        promotion.basis !== 'owner_trial' ||
        promotion.principal_id !== principalId ||
        candidate.bodyHash !== row.definitionHash ||
        candidate.pausedAt ||
        candidate.removedAt ||
        candidate.rejectionReason
      )
        throw new ServiceError('question_closed', 'This is no longer being tried.', 409);
      const answered = async (episodeId: string | null = null) => {
        const [saved] = await tx
          .update(learningNotice)
          .set({ state: 'answered', answer: request.answer, episodeId, resolvedAt: new Date() })
          .where(eq(learningNotice.id, id))
          .returning();
        if (!saved) throw new Error('Notice update returned no row');
        return saved;
      };
      if (request.answer === 'change') {
        if (!row.jobId)
          throw new ServiceError('question_closed', 'The job it asked about is gone.', 409);
        // Answered first: the correction ends the trial, and ending it withdraws open questions.
        await answered();
        const correction = await this.episodes.interveneInTransaction(tx, principalId, row.jobId, {
          idempotency_key: `keep:${row.id}`,
          kind: 'correction',
          text: request.text,
        });
        const saved = await answered(correction.id);
        return {
          row: saved,
          episodeId: correction.id,
          candidateId: row.candidateId,
          corrected: row.jobId,
        };
      }
      verifyDefinition(candidate);
      verifyEvidence(candidate, source, objective);
      // The job asked about still has to be one the person did not correct.
      if (row.jobId) {
        const [intervened] = await tx
          .select({ id: episode.id })
          .from(episode)
          .where(
            and(
              or(eq(episode.jobId, row.jobId), eq(episode.correctiveJobId, row.jobId)),
              like(episode.segmentKey, 'intervention:%'),
            ),
          )
          .limit(1);
        if (intervened)
          throw new ServiceError('question_closed', 'You corrected that job since.', 409);
      }
      const saved = await answered();
      if (request.answer === 'yes') {
        const [kept] = await tx
          .update(procedureCandidate)
          .set({
            promotion: {
              scope: 'private',
              principal_id: principalId,
              basis: 'owner_confirmed',
              definition_hash: candidate.bodyHash,
              approved_at: new Date().toISOString(),
            },
          })
          .where(eq(procedureCandidate.id, candidate.id))
          .returning();
        if (!kept) throw new Error('Procedure update returned no row');
        // What the person said to keep lasts: the correction it quotes stops expiring with it.
        // Forgetting still reaches it; retention no longer does. Only what the steps quote
        // is kept: the answers before and after the correction are no longer needed.
        await tx
          .update(episode)
          .set({ expiresAt: KEPT_UNTIL, priorOutput: null, correctedOutput: null })
          .where(eq(episode.id, candidate.episodeId));
        const active = await transitionProcedure(
          tx,
          kept,
          'active',
          principalId,
          'The owner said to keep doing this after a job used it.',
        );
        await this.record(tx, principalId, spaceId, 'correction', candidate.id, 'keep', {
          before: { ...snapshot(candidate), episode_expires_at: source.expiresAt.toISOString() },
          after: snapshot(active),
          name: learnedName(candidate),
        });
        return { row: saved, episodeId: null, candidateId: candidate.id };
      }
      await tx
        .update(procedureCandidate)
        .set({ rejectionReason: OWNER_DECLINED })
        .where(eq(procedureCandidate.id, candidate.id));
      const reverted = await transitionProcedure(
        tx,
        { ...candidate, rejectionReason: OWNER_DECLINED },
        'reverted',
        principalId,
        request.reason
          ? `The owner said not to keep it: ${request.reason}`
          : 'The owner said not to keep it.',
      );
      await noticeReverted(tx, reverted, principalId, row.jobId, OWNER_DECLINED);
      await this.record(tx, principalId, spaceId, 'correction', candidate.id, 'decline', {
        before: snapshot(candidate),
        after: snapshot(reverted),
        name: learnedName(candidate),
      });
      return { row: saved, episodeId: null, candidateId: candidate.id };
    });
    // A correction on a job that is running fences its attempt; the runner hears of it here.
    if (result.corrected) this.episodes.interrupt?.(result.corrected);
    return this.jobs.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(procedureCandidate)
        .where(eq(procedureCandidate.id, result.candidateId));
      if (!candidate) throw new ServiceError('not_found', 'Notice not found.', 404);
      return {
        notice: learningNoticeView.parse(noticeView(result.row, candidate)),
        item: await (await this.sourceFor(tx, candidate.id)).item(
          tx,
          principalId,
          spaceId,
          candidate.id,
        ),
        episode_id: result.episodeId,
      };
    });
  }
}
