/**
 * Handoffs: a room's agent asks one person to run something with their own
 * setup. The room's agent never reaches anyone's mailbox, files or memory. It
 * proposes a task, stored whole, and the person it names sees that exact text
 * in their own Melete and runs it, or declines it. Running it starts work in
 * their own space, under their own connections and their own approvals. When
 * that work finishes they see the exact answer and choose to share it with the
 * room or keep it; the room hears which, and only a shared answer's words.
 *
 * Two hashes bind what the person read to what happens: the task's, checked
 * when they accept, and the result's, checked when they share.
 */
import { createHash } from 'node:crypto';
import { type AttemptOutcome, type RoomHandoff, roomHandoff, waitSpec } from '@melete/contracts';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import {
  attempt,
  connection,
  experienceTurn,
  job,
  principal,
  space,
  spaceMembership,
  trigger,
} from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { answerText } from '../experience/answer-filter.ts';
import { newId } from '../ids.ts';
import type { JobRow, JobService } from '../jobs/service.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { ENDED_STATES } from '../jobs/withdraw.ts';
import { principalContext } from '../principals/authority.ts';
import { touchMessage } from './release.ts';
import { roomHandoff as handoffTable, roomMessage, roomThread } from './schema.ts';
import { namesOf, personLabel } from './transcript.ts';

type HandoffRow = typeof handoffTable.$inferSelect;
type Reader = Pick<Transaction, 'select'>;

/** How long a handoff waits for its person before the room is told it went unanswered. */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60_000;
/** How many handoffs waiting on one person one room may hold, and one request may make. */
export const HANDOFF_OPEN_PER_PERSON = 3;
export const HANDOFF_PER_REQUEST = 3;
/** The most of a task a handoff carries. The person reads all of it. */
export const HANDOFF_TASK_LIMIT = 8000;

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The event a room's request waits on to hear how one handoff ended. */
export const handoffEventName = (handoffId: string) => `room.handoff_settled.${handoffId}`;

/**
 * The person's own space: the personal space they own. A space being removed
 * is nobody's to run work in.
 */
export async function personalSpaceOf(tx: Pick<Transaction, 'execute'>, principalId: string) {
  const rows = (await tx.execute(sql`select s.id from space s
    where s.kind = 'personal' and s.removed_at is null
      and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId}
    order by s.created_at, s.id limit 1`)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/**
 * A person's place in a room, now: `owner` or `member` while they are a
 * current, not revoked, person member of a shared space that is not being
 * removed. A guest, the room's own principal and anyone else get null: none of
 * them runs or sends anything of their own to a room.
 */
export async function roomMemberRole(
  tx: Reader,
  spaceId: string,
  principalId: string,
): Promise<'owner' | 'member' | null> {
  const [row] = await tx
    .select({ role: spaceMembership.role })
    .from(spaceMembership)
    .innerJoin(space, eq(space.id, spaceMembership.spaceId))
    .innerJoin(principal, eq(principal.id, spaceMembership.principalId))
    .where(
      and(
        eq(spaceMembership.spaceId, spaceId),
        eq(spaceMembership.principalId, principalId),
        isNull(spaceMembership.revokedAt),
        inArray(spaceMembership.role, ['owner', 'member']),
        eq(space.kind, 'shared'),
        isNull(space.removedAt),
        eq(principal.kind, 'person'),
      ),
    );
  return (row?.role as 'owner' | 'member' | undefined) ?? null;
}

/**
 * Put a message in a room's thread, once per key, and wake its live streams.
 * Used for what a person sends through their own agent and for the room's
 * notes about a handoff; never for an ask, so it starts no request.
 */
export async function postToThread(
  tx: Transaction,
  value: {
    spaceId: string;
    threadId: string;
    author: string;
    kind: 'person' | 'handoff_result' | 'system';
    viaAgent: boolean;
    text: string;
    key: string;
  },
) {
  const submissionId = sha256(`room-post:${value.key}`);
  const [existing] = await tx
    .select()
    .from(roomMessage)
    .where(eq(roomMessage.submissionId, submissionId));
  if (existing) return existing;
  const [inserted] = await tx
    .insert(roomMessage)
    .values({
      id: newId('rmg'),
      spaceId: value.spaceId,
      threadId: value.threadId,
      authorPrincipalId: value.author,
      kind: value.kind,
      viaAgent: value.viaAgent,
      text: value.text,
      mentions: [],
      requestState: 'none',
      submissionId,
    })
    .returning();
  if (!inserted) throw new Error('Message insert returned no row');
  await tx
    .update(roomThread)
    .set({ lastActivityAt: new Date() })
    .where(eq(roomThread.id, value.threadId));
  return touchMessage(tx, inserted);
}

export type HandoffDeps = {
  db: Database;
  jobs: JobService;
  /** Wakes the room's request waiting on a handoff. Without it the room hears at its next turn. */
  triggers?: TriggerService;
};

export class HandoffService {
  constructor(readonly deps: HandoffDeps) {}

  private async view(reader: Reader, row: HandoffRow): Promise<RoomHandoff> {
    const [room] = await reader
      .select({ id: space.id, name: space.name })
      .from(space)
      .where(eq(space.id, row.spaceId));
    const [request] = row.roomJobId
      ? await reader
          .select({ asker: job.requestedByPrincipalId })
          .from(job)
          .where(eq(job.id, row.roomJobId))
      : [];
    const names = await namesOf(reader, row.spaceId, request?.asker ? [request.asker] : []);
    const asker = request?.asker ? names.get(request.asker) : undefined;
    return roomHandoff.parse({
      id: row.id,
      room: { id: row.spaceId, name: room?.name ?? 'A room' },
      thread_id: row.threadId,
      asked_by:
        request?.asker && asker ? { principal_id: request.asker, display_name: asker } : null,
      task: row.taskText,
      task_hash: row.taskHash,
      state: row.state,
      job_id: row.personalJobId,
      result: row.resultHash ? row.resultText : null,
      result_hash: row.resultHash,
      created_at: row.createdAt.toISOString(),
      decided_at: row.decidedAt?.toISOString() ?? null,
      expires_at: row.expiresAt.toISOString(),
    });
  }

  /** Every handoff addressed to the person, newest first. */
  async list(actor: string) {
    await this.expireDue();
    const rows = await this.deps.db
      .select()
      .from(handoffTable)
      .where(eq(handoffTable.targetPrincipalId, actor))
      .orderBy(desc(handoffTable.createdAt), desc(handoffTable.id))
      .limit(100);
    const handoffs = [];
    for (const row of rows) handoffs.push(await this.view(this.deps.db, row));
    return { handoffs };
  }

  /**
   * What waits for the person on Home and in Approvals: a task to run or
   * decline, or a result to share or keep. Shown only in their own space.
   */
  async waiting(actor: string, spaceId: string): Promise<RoomHandoff[]> {
    if ((await personalSpaceOf(this.deps.db, actor)) !== spaceId) return [];
    const { handoffs } = await this.list(actor);
    return handoffs.filter(
      (item) => item.state === 'pending' || (item.state === 'settled' && item.result_hash),
    );
  }

  private async locked(tx: Transaction, id: string, actor: string) {
    const [row] = await tx
      .select()
      .from(handoffTable)
      .where(and(eq(handoffTable.id, id), eq(handoffTable.targetPrincipalId, actor)))
      .for('update');
    if (!row) throw new ServiceError('not_found', 'That request is not here.', 404);
    return row;
  }

  /** How the room names a person: its own handle for them, never their email. */
  private async labelOf(reader: Reader, spaceId: string, principalId: string) {
    const [row] = await reader
      .select({ displayName: principal.displayName, email: principal.email })
      .from(principal)
      .where(eq(principal.id, principalId));
    return row ? personLabel({ id: principalId, ...row }, spaceId) : 'Someone';
  }

  /**
   * Run it with my setup, or decline. Accepting checks the person read this
   * exact task, and starts work in their own space whose objective is that
   * text, verbatim, recorded as coming from a room rather than typed by them.
   */
  async decide(
    id: string,
    actor: string,
    input: { decision: 'accept'; task_hash: string } | { decision: 'decline' },
  ) {
    await this.expireDue();
    const outcome = await this.deps.jobs.transaction(async (tx) => {
      const row = await this.locked(tx, id, actor);
      if (row.state !== 'pending') return { row, refusal: stateRefusal(row) };
      // Past its time, or its request has ended: it is withdrawn, not run.
      const ended = await this.withdrawIfOver(tx, row);
      if (ended) return { row: ended, refusal: stateRefusal(ended) };
      const label = await this.labelOf(tx, row.spaceId, actor);
      if (input.decision === 'decline') {
        const updated = await this.move(tx, row, { state: 'declined', decidedAt: new Date() });
        await this.note(tx, updated, `${label} declined to run this with their own setup.`);
        await this.tell(tx, updated, 'declined', { by: label });
        return { row: updated };
      }
      if (input.task_hash !== row.taskHash)
        return {
          row,
          refusal: new ServiceError(
            'task_changed',
            'This is not the task you were shown. Read it again before running it.',
            409,
          ),
        };
      // Someone who has left the room no longer runs its work.
      if (!(await roomMemberRole(tx, row.spaceId, actor))) {
        const updated = await this.move(tx, row, { state: 'expired', decidedAt: new Date() });
        await this.tell(tx, updated, 'expired', { by: label });
        return {
          row: updated,
          refusal: new ServiceError('not_in_room', 'You are no longer in that room.', 409),
        };
      }
      const personal = await personalSpaceOf(tx, actor);
      if (!personal)
        return {
          row,
          refusal: new ServiceError('no_personal_space', 'You have no space of your own.', 409),
        };
      const [room] = await tx
        .select({ name: space.name })
        .from(space)
        .where(eq(space.id, row.spaceId));
      const first = row.taskText.split('\n')[0]?.trim() ?? '';
      const title = `For ${room?.name ?? 'a room'}: ${first}`.slice(0, 200);
      const started = await principalContext.run(actor, () =>
        this.deps.jobs.createInTransaction(
          tx,
          { space_id: personal, title, objective: row.taskText },
          undefined,
          'room_handoff',
        ),
      );
      const updated = await this.move(tx, row, {
        state: 'running',
        personalJobId: started.id,
        decidedAt: new Date(),
      });
      await this.note(tx, updated, `${label} is running this with their own setup.`);
      return { row: updated };
    });
    if (outcome.refusal) throw outcome.refusal;
    return { handoff: await this.view(this.deps.db, outcome.row) };
  }

  /**
   * Share the finished result with the room, or keep it. Sharing posts the
   * exact text the person read, as theirs through their agent; keeping posts
   * only that they kept it.
   */
  async result(
    id: string,
    actor: string,
    input: { decision: 'share'; result_hash: string } | { decision: 'keep' },
  ) {
    const outcome = await this.deps.jobs.transaction(async (tx) => {
      const row = await this.locked(tx, id, actor);
      if (row.state !== 'settled' || !row.resultHash || row.resultText === null)
        return {
          row,
          refusal:
            row.state === 'settled' || row.state === 'running' || row.state === 'pending'
              ? new ServiceError('no_result', 'There is no result to share yet.', 409)
              : stateRefusal(row),
        };
      const label = await this.labelOf(tx, row.spaceId, actor);
      if (input.decision === 'keep') {
        // Kept means kept: no copy of it stays with the room's records.
        const updated = await this.move(tx, row, {
          state: 'kept',
          resultText: null,
          resultHash: null,
        });
        await this.note(tx, updated, `${label} kept the result private.`);
        await this.tell(tx, updated, 'kept', { by: label });
        return { row: updated };
      }
      if (input.result_hash !== row.resultHash)
        return {
          row,
          refusal: new ServiceError(
            'result_changed',
            'This is not the result you were shown. Read it again before sharing it.',
            409,
          ),
        };
      if (!(await roomMemberRole(tx, row.spaceId, actor)))
        return {
          row,
          refusal: new ServiceError('not_in_room', 'You are no longer in that room.', 409),
        };
      await postToThread(tx, {
        spaceId: row.spaceId,
        threadId: row.threadId,
        author: actor,
        kind: 'handoff_result',
        viaAgent: true,
        text: row.resultText,
        key: `handoff:${row.id}:result`,
      });
      // The thread holds the shared copy now; the handoff keeps none.
      const updated = await this.move(tx, row, {
        state: 'shared',
        resultText: null,
        resultHash: null,
      });
      await this.tell(tx, updated, 'shared', { by: label, result: row.resultText });
      return { row: updated };
    });
    if (outcome.refusal) throw outcome.refusal;
    return { handoff: await this.view(this.deps.db, outcome.row) };
  }

  private async move(tx: Transaction, row: HandoffRow, change: Partial<HandoffRow>) {
    const [updated] = await tx
      .update(handoffTable)
      .set(change)
      .where(eq(handoffTable.id, row.id))
      .returning();
    if (!updated) throw new Error('Handoff disappeared');
    return updated;
  }

  /** A line in the room's thread about where the handoff got to, in the person's name. */
  private async note(tx: Transaction, row: HandoffRow, text: string) {
    await postToThread(tx, {
      spaceId: row.spaceId,
      threadId: row.threadId,
      author: row.targetPrincipalId,
      kind: 'system',
      viaAgent: false,
      text,
      key: `handoff:${row.id}:${row.state}`,
    });
  }

  /**
   * Tell the room's request how the handoff ended, through the room's own
   * connection, in this transaction: a request waiting on it wakes now, and
   * one that waits later finds it already there.
   */
  private async tell(
    tx: Transaction,
    row: HandoffRow,
    outcome: 'declined' | 'expired' | 'shared' | 'kept' | 'failed' | 'withdrawn',
    detail: { by: string; result?: string },
  ) {
    if (!row.connectionId) return;
    const dedup = `${row.id}:${outcome}`;
    const [source] = await tx.select().from(connection).where(eq(connection.id, row.connectionId));
    if (source?.status !== 'active') return;
    const [parent] = await tx
      .select({ policyGeneration: space.policyGeneration })
      .from(space)
      .where(eq(space.id, source.spaceId));
    await appendEvent(tx, {
      type: 'notice',
      payload: {
        kind: 'connector_event',
        connection_id: row.connectionId,
        event_name: handoffEventName(row.id),
        cursor: row.id,
        dedup_key: dedup,
        payload: {
          handoff_id: row.id,
          outcome,
          person: detail.by,
          ...(detail.result !== undefined ? { result: detail.result } : {}),
        },
        connection_generation: source.generation,
        policy_generation: parent?.policyGeneration ?? 0,
      },
      dedupKey: `connector:${row.connectionId}:${dedup}`,
    });
    if (!row.roomJobId || !row.triggerId || !this.deps.triggers) return;
    // Only a request waiting on this very handoff is woken here. One waiting on
    // something else hears it when it next waits; the person's answer never
    // depends on what the request happens to be waiting for.
    const waiting = await this.deps.jobs.lock(tx, row.roomJobId);
    const wait = waitSpec.safeParse(waiting?.wait);
    if (
      waiting?.spaceId !== source.spaceId ||
      waiting.state !== 'waiting_for_event_or_time' ||
      !wait.success ||
      wait.data.kind !== 'event' ||
      wait.data.trigger_id !== row.triggerId
    )
      return;
    const [registration] = await tx
      .select({ enabled: trigger.enabled })
      .from(trigger)
      .where(eq(trigger.id, row.triggerId));
    if (registration?.enabled) await this.deps.triggers.registerWait(tx, waiting);
  }

  /**
   * Withdraw a pending handoff that is past its time, or whose request has
   * ended or was stopped. Returns the withdrawn row, or null when it stands.
   */
  private async withdrawIfOver(tx: Transaction, row: HandoffRow, now = new Date()) {
    if (row.state !== 'pending') return null;
    const label = await this.labelOf(tx, row.spaceId, row.targetPrincipalId);
    if (row.expiresAt.getTime() <= now.getTime()) {
      const updated = await this.move(tx, row, { state: 'expired', decidedAt: now });
      await this.note(tx, updated, `${label} did not answer in time, so this was not run.`);
      await this.tell(tx, updated, 'expired', { by: label });
      return updated;
    }
    if (!(await this.requestEnded(tx, row))) return null;
    const updated = await this.move(tx, row, { state: 'expired', decidedAt: now });
    await this.note(
      tx,
      updated,
      `The request this came from ended, so ${label} was not asked to run it.`,
    );
    return updated;
  }

  /** Whether the room's request that asked has ended, or the turn that asked was stopped. */
  private async requestEnded(reader: Reader, row: HandoffRow) {
    if (!row.roomJobId) return true;
    const [request] = await reader
      .select({ state: job.state })
      .from(job)
      .where(eq(job.id, row.roomJobId));
    if (!request || ENDED_STATES.includes(request.state)) return true;
    if (!row.roomTurnId) return false;
    const [turn] = await reader
      .select({ status: experienceTurn.status })
      .from(experienceTurn)
      .where(eq(experienceTurn.id, row.roomTurnId));
    return turn?.status === 'stopped';
  }

  /**
   * The person's work ended. With an answer, the handoff waits for them to
   * share or keep it. Without one, the room is told it did not finish.
   */
  async settle(tx: Transaction, row: JobRow, outcome?: AttemptOutcome) {
    if (!ENDED_STATES.includes(row.state)) return;
    const [handoff] = await tx
      .select()
      .from(handoffTable)
      .where(and(eq(handoffTable.personalJobId, row.id), eq(handoffTable.state, 'running')))
      .for('update');
    if (!handoff) return;
    const answer =
      row.state === 'completed' && outcome?.kind === 'completed'
        ? answerText(outcome.summary).trim()
        : '';
    if (answer) {
      // The person has as long again to share or keep it; after that it is cleared.
      await this.move(tx, handoff, {
        state: 'settled',
        resultText: answer,
        resultHash: sha256(answer),
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
      });
      return;
    }
    const updated = await this.move(tx, handoff, { state: 'expired' });
    const label = await this.labelOf(tx, handoff.spaceId, handoff.targetPrincipalId);
    await this.note(tx, updated, `The work ${label} ran with their own setup did not finish.`);
    await this.tell(tx, updated, 'failed', { by: label });
  }

  /** The transition hook: work cancelled or failed outside an attempt settles its handoff too. */
  afterMove() {
    return async (tx: Transaction, before: JobRow, after: JobRow) => {
      if (after.audience !== 'principal' || ENDED_STATES.includes(before.state)) return;
      if (after.state === 'cancelled' || after.state === 'failed') await this.settle(tx, after);
    };
  }

  /**
   * Withdraw handoffs that are past their time or whose request ended, clear
   * results nobody shared or kept in time or whose words the person has since
   * forgotten, and settle any whose work ended while no hook was listening.
   * Each row is its own transaction, and one that fails leaves the others to
   * go ahead. Run on reads and with the recovery scan.
   */
  async expireDue(now = new Date()) {
    const each = async (ids: string[], work: (tx: Transaction, id: string) => Promise<void>) => {
      for (const id of ids)
        await serviceTransaction(this.deps.db, (tx) => work(tx, id)).catch(() => {
          process.stderr.write(`handoff ${id} could not be brought up to date\n`);
        });
    };
    const lockedRow = async (tx: Transaction, id: string, state: string) => {
      const [row] = await tx
        .select()
        .from(handoffTable)
        .where(and(eq(handoffTable.id, id), eq(handoffTable.state, state)))
        .for('update');
      return row;
    };
    const pending = (await this.deps.db.execute(sql`select h.id from room_handoff h
        left join job j on j.id = h.room_job_id
        left join experience_turn t on t.id = h.room_turn_id
      where h.state = 'pending' and (h.expires_at <= ${now.toISOString()}::timestamptz or j.id is null
        or j.state in ('cancelled', 'failed', 'completed') or t.status = 'stopped')
      limit 100`)) as unknown as { id: string }[];
    await each(
      pending.map((row) => row.id),
      async (tx, id) => {
        const row = await lockedRow(tx, id, 'pending');
        if (row) await this.withdrawIfOver(tx, row, now);
      },
    );
    // A result nobody shared or kept in time, or one cleared because the
    // person forgot what it was built from or removed their space.
    const results = await this.deps.db
      .select({ id: handoffTable.id })
      .from(handoffTable)
      .where(
        and(
          eq(handoffTable.state, 'settled'),
          or(isNull(handoffTable.resultHash), lte(handoffTable.expiresAt, now)),
        ),
      )
      .limit(100);
    await each(
      results.map((row) => row.id),
      async (tx, id) => {
        const row = await lockedRow(tx, id, 'settled');
        if (!row) return;
        const lapsed = row.resultHash !== null;
        const updated = await this.move(tx, row, {
          state: 'expired',
          resultText: null,
          resultHash: null,
          decidedAt: now,
        });
        const label = await this.labelOf(tx, row.spaceId, row.targetPrincipalId);
        await this.note(
          tx,
          updated,
          lapsed
            ? `${label} did not share or keep the result in time, so it was not shared.`
            : `The result of the work ${label} ran is no longer kept, so it was not shared.`,
        );
        await this.tell(tx, updated, lapsed ? 'expired' : 'withdrawn', { by: label });
      },
    );
    const ended = await this.deps.db
      .select({ jobId: handoffTable.personalJobId })
      .from(handoffTable)
      .innerJoin(job, eq(job.id, handoffTable.personalJobId))
      .where(and(eq(handoffTable.state, 'running'), inArray(job.state, [...ENDED_STATES])))
      .limit(100);
    await each(
      ended.flatMap((row) => (row.jobId ? [row.jobId] : [])),
      async (tx, jobId) => {
        const row = await this.deps.jobs.lock(tx, jobId);
        if (!row) return;
        const [last] = await tx
          .select({ detail: attempt.outcomeDetail })
          .from(attempt)
          .where(and(eq(attempt.jobId, row.id), eq(attempt.outcome, 'completed')))
          .orderBy(desc(attempt.startedAt), desc(attempt.id))
          .limit(1);
        await this.settle(tx, row, (last?.detail ?? undefined) as AttemptOutcome | undefined);
      },
    );
  }
}

function stateRefusal(row: HandoffRow) {
  const said: Record<string, string> = {
    declined: 'You already declined this.',
    expired: 'This request expired before it was answered.',
    running: 'This is already running with your setup.',
    settled: 'This has already run.',
    shared: 'You already shared the result.',
    kept: 'You already kept the result private.',
    accepted: 'This is already running with your setup.',
  };
  return new ServiceError(
    'handoff_answered',
    said[row.state] ?? 'This request was already answered.',
    409,
  );
}
