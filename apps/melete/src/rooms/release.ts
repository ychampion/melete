/**
 * How a message that asks a room's agent becomes work. Each ask is a request
 * job of the room principal's, attributed to the person who asked. A thread
 * runs one request at a time: an ask made while another request in the thread
 * is queued or running waits as a pending message, and is released when that
 * request leaves `running` (settled, or parked on approval, input or a wait),
 * by the job transition hook, after an attempt ends, and on startup.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { agent, job, space, spaceMembership } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { type JobRow, type JobService, roomRequestInput } from '../jobs/service.ts';
import type { SubmissionService } from '../jobs/submissions.ts';
import { principalContext, spaceAuthority } from '../principals/authority.ts';
import { roomMessage, roomThread } from './schema.ts';

export type RoomWork = { jobs: JobService; submissions: SubmissionService };
type MessageRow = typeof roomMessage.$inferSelect;

/** A request in these states holds its thread: the next ask waits for it. */
export const HOLDS_THREAD = ['queued', 'running'];

/** The room's own principal: the identity its agent acts as. */
export async function roomPrincipalOf(tx: Pick<Transaction, 'select'>, spaceId: string) {
  const [row] = await tx
    .select({ id: spaceMembership.principalId, generation: spaceMembership.generation })
    .from(spaceMembership)
    .where(
      and(
        eq(spaceMembership.spaceId, spaceId),
        eq(spaceMembership.role, 'agent'),
        isNull(spaceMembership.revokedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ServiceError('not_found', 'That room is not here.', 404);
  return row;
}

/** The room's agent: the first one the room has, or Melete, made the first time it is asked. */
export async function roomAgentOf(tx: Transaction, spaceId: string) {
  const [existing] = await tx
    .select()
    .from(agent)
    .where(eq(agent.spaceId, spaceId))
    .orderBy(asc(agent.createdAt), asc(agent.id))
    .limit(1);
  if (existing) return existing;
  const [room] = await tx
    .select({ purpose: space.purpose })
    .from(space)
    .where(eq(space.id, spaceId));
  const [made] = await tx
    .insert(agent)
    .values({
      id: newId('agent'),
      spaceId,
      name: 'Melete',
      role: 'Room agent',
      colour: '#7D8CDB',
      surface: 'rounded',
      eyeColour: '#172044',
      tone: 'Clear and even-handed',
      standingInstruction: room?.purpose
        ? `This room is for: ${room.purpose}`
        : 'Help the people in this room with what they ask.',
    })
    .returning();
  if (!made) throw new Error('Agent insert returned no row');
  return made;
}

/**
 * Record that a message changed, in event order: a live thread stream sends it
 * again at this sequence number, and the commit wakes every stream.
 */
export async function touchMessage(tx: Transaction, message: MessageRow): Promise<MessageRow> {
  const written = await appendEvent(tx, {
    type: 'notice',
    payload: {
      kind: 'room_message',
      space_id: message.spaceId,
      thread_id: message.threadId,
      message_id: message.id,
    },
    dedupKey: `room_message:${message.id}:${randomBytes(8).toString('hex')}`,
  });
  if (!written) throw new Error('Room message event was not written');
  const [updated] = await tx
    .update(roomMessage)
    .set({ streamSeq: written.seq })
    .where(eq(roomMessage.id, message.id))
    .returning();
  if (!updated) throw new Error('Room message disappeared');
  return updated;
}

/** Whether a request of this thread is queued or running, or an ask is waiting ahead of `except`. */
export async function threadHeld(tx: Transaction, threadId: string, except?: string) {
  const [running] = await tx
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        eq(job.roomThreadId, threadId),
        eq(job.audience, 'room'),
        inArray(job.state, HOLDS_THREAD),
      ),
    )
    .limit(1);
  if (running) return true;
  const [waiting] = await tx
    .select({ id: roomMessage.id })
    .from(roomMessage)
    .where(
      and(
        eq(roomMessage.threadId, threadId),
        eq(roomMessage.requestState, 'pending'),
        except ? ne(roomMessage.id, except) : undefined,
      ),
    )
    .limit(1);
  return Boolean(waiting);
}

/** A submission id the job service accepts, unique to this one hand-over. */
const inputKey = (messageId: string) =>
  `room:${messageId.replace(/^rmg_/, '')}:${randomBytes(6).toString('hex')}`;

/** Give one input to a request, as the person who asked it. Throws when it is refused. */
async function speak(tx: Transaction, work: RoomWork, row: JobRow, message: MessageRow) {
  const result = await principalContext.run(message.authorPrincipalId, () =>
    roomRequestInput.run(row.id, () =>
      work.submissions.inputWithin(tx, row.id, { text: message.text }, inputKey(message.id)),
    ),
  );
  if (result.receipt.state !== 'accepted')
    throw new ServiceError(
      result.error?.code ?? 'message_not_accepted',
      result.error?.message ?? 'The request did not take this message.',
      409,
    );
}

/**
 * Hand an asking message to its request: the asker's own request in this
 * thread when they have one that still takes messages, or a new one. Done in
 * a savepoint, so a refusal leaves the message waiting and nothing half made.
 * Returns the request's id, or null when it could not start now.
 */
export async function startRequest(
  tx: Transaction,
  work: RoomWork,
  message: MessageRow,
): Promise<string | null> {
  if (!message.text) return null;
  const started = await tx
    .transaction(async (savepoint) => {
      const room = await roomPrincipalOf(savepoint, message.spaceId);
      const [own] = await savepoint
        .select()
        .from(job)
        .where(
          and(
            eq(job.roomThreadId, message.threadId),
            eq(job.spaceId, message.spaceId),
            eq(job.audience, 'room'),
            eq(job.requestedByPrincipalId, message.authorPrincipalId),
            ne(job.state, 'cancelled'),
          ),
        )
        .orderBy(desc(job.createdAt), desc(job.id))
        .limit(1);
      if (own) {
        // A follow-up the request cannot take now (paused, or still finishing
        // an attempt) starts a request of its own rather than waiting forever.
        try {
          await savepoint.transaction((inner) => speak(inner, work, own, message));
          return own.id;
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
        }
      }
      const persona = await roomAgentOf(savepoint, message.spaceId);
      const title = message.text.split('\n')[0]?.trim().slice(0, 200) || 'Request';
      const row = await work.jobs.createInTransaction(
        savepoint,
        { space_id: message.spaceId, title, objective: message.text },
        { kind: 'chat', agentId: persona.id },
        'room_member',
        {
          principalId: room.id,
          requestedBy: message.authorPrincipalId,
          threadId: message.threadId,
        },
      );
      await speak(savepoint, work, row, message);
      return row.id;
    })
    .catch((error: unknown) => {
      if (error instanceof ServiceError) return null;
      throw error;
    });
  if (!started) return null;
  const [updated] = await tx
    .update(roomMessage)
    .set({ requestState: 'started', requestJobId: started })
    .where(eq(roomMessage.id, message.id))
    .returning();
  if (updated) await touchMessage(tx, updated);
  return started;
}

/**
 * Start the thread's next waiting ask if nothing holds the thread. An ask whose
 * author has left the room since is dropped: it no longer asks anything.
 */
export async function releaseThread(tx: Transaction, work: RoomWork, threadId: string) {
  const [thread] = await tx
    .select({ id: roomThread.id })
    .from(roomThread)
    .where(eq(roomThread.id, threadId))
    .for('update');
  if (!thread) return;
  for (;;) {
    const [running] = await tx
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          eq(job.roomThreadId, threadId),
          eq(job.audience, 'room'),
          inArray(job.state, HOLDS_THREAD),
        ),
      )
      .limit(1);
    if (running) return;
    const [next] = await tx
      .select()
      .from(roomMessage)
      .where(and(eq(roomMessage.threadId, threadId), eq(roomMessage.requestState, 'pending')))
      .orderBy(asc(roomMessage.createdAt), asc(roomMessage.id))
      .limit(1);
    if (!next) return;
    const member = await spaceAuthority(tx, next.spaceId, next.authorPrincipalId)
      .then((access) => access.role !== 'agent')
      .catch((error: unknown) => {
        if (error instanceof ServiceError) return false;
        throw error;
      });
    if (member && (await startRequest(tx, work, next))) return;
    // Either its author left, or it could not start: it stops asking, so the
    // thread does not wait on it forever. Its words stay in the thread.
    const [dropped] = await tx
      .update(roomMessage)
      .set({ requestState: 'none' })
      .where(eq(roomMessage.id, next.id))
      .returning();
    if (dropped) await touchMessage(tx, dropped);
  }
}

/** Release every thread with a waiting ask, each in its own transaction. Run at startup. */
export async function releaseAll(db: Database, work: RoomWork) {
  const threads = await db
    .selectDistinct({ id: roomMessage.threadId })
    .from(roomMessage)
    .where(eq(roomMessage.requestState, 'pending'));
  for (const { id } of threads)
    await serviceTransaction(db, (tx) => releaseThread(tx, work, id)).catch(() => undefined);
}

/** The transition hook: a request that leaves `running` (or `queued`) lets the next ask go. */
export function releaseOnTransition(work: RoomWork) {
  return async (tx: Transaction, before: JobRow, after: JobRow) => {
    if (after.audience !== 'room' || !after.roomThreadId) return;
    if (!HOLDS_THREAD.includes(before.state) || HOLDS_THREAD.includes(after.state)) return;
    await releaseThread(tx, work, after.roomThreadId);
  };
}
