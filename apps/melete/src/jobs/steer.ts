/**
 * Words the person sends while a conversation's turn is running.
 *
 * They are the person's message like any other, recorded at once as a
 * `user_message` notice marked `steer`, so the conversation shows them before
 * the agent has read them, and every later attempt reads them in order. What
 * differs is delivery, which happens exactly once, in one of three ways:
 *
 * - the running attempt takes them: the runtime hands them to the model at
 *   its next step's end, or as its next run's input, and reports
 *   `steer_delivered` on the attempt's own stream before its outcome;
 * - an attempt that has not started yet, or that starts after them (a retry,
 *   a resume after an approval), reads them as new messages, and its claim
 *   records them delivered;
 * - the turn ends before either: they are carried into a new turn of their
 *   own, which reads them as its message.
 *
 * Every step happens under the job's row lock, in the transaction that moves
 * the job, so a steer and the end of its turn are ordered: a steer recorded
 * before the turn settles is carried by it, and one that arrives after is an
 * ordinary next message.
 */
import { and, eq, sql } from 'drizzle-orm';
import { agent, event, experienceTurn, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import type { JobRow } from './service.ts';

export type PendingSteer = { id: string; text: string; seq: number };

/** Records the person's words for the running turn, once per id. */
export async function recordSteer(
  tx: Transaction,
  row: JobRow,
  input: {
    id: string;
    text: string;
    principalId: string | null;
    clientTimeZone?: string | null;
  },
): Promise<{ id: string; seq: number; at: Date }> {
  const written = await appendEvent(tx, {
    jobId: row.id,
    type: 'notice',
    payload: {
      kind: 'user_message',
      text: input.text,
      principal_id: input.principalId,
      steer: true,
      steer_id: input.id,
      ...(row.currentTurnId ? { turn_id: row.currentTurnId } : {}),
      ...(input.clientTimeZone ? { client_time_zone: input.clientTimeZone } : {}),
    },
    dedupKey: `${row.id}:steer:${input.id}`,
  });
  if (written) return { id: input.id, seq: written.seq, at: written.createdAt };
  // Sent twice with the same key: the first one stands.
  const [first] = await tx
    .select({ seq: event.seq, at: event.createdAt })
    .from(event)
    .where(eq(event.dedupKey, `${row.id}:steer:${input.id}`));
  if (!first) throw new Error('steer lost');
  return { id: input.id, seq: first.seq, at: first.at };
}

/** A steer already recorded on this job under this id, or null. */
export async function recordedSteer(
  tx: Pick<Transaction, 'select'>,
  jobId: string,
  id: string,
): Promise<{ id: string; seq: number; at: Date } | null> {
  const [first] = await tx
    .select({ seq: event.seq, at: event.createdAt })
    .from(event)
    .where(eq(event.dedupKey, `${jobId}:steer:${id}`));
  return first ? { id, seq: first.seq, at: first.at } : null;
}

/**
 * Whether a message names an agent the way a mention does: it opens with `@`,
 * with or without a space before the name. A mention is never steered into a
 * running turn; it waits and starts its own turn with the agent it names.
 */
export const opensWithMention = (text: string): boolean => text.trimStart().startsWith('@');

/** The job's steers no attempt has read and no turn has carried, oldest first. */
export async function pendingSteers(
  tx: Pick<Transaction, 'execute'>,
  jobId: string,
): Promise<PendingSteer[]> {
  const rows = (await tx.execute(sql`
    select e.seq, e.payload->>'steer_id' as id, e.payload->>'text' as text
    from event e
    where e.job_id = ${jobId} and e.type = 'notice'
      and e.payload->>'kind' = 'user_message' and e.payload->>'steer' = 'true'
      and not exists (select 1 from event d where d.job_id = e.job_id
        and d.type in ('steer_delivered', 'steer_carried')
        and d.payload->>'steer_id' = e.payload->>'steer_id')
    order by e.seq`)) as unknown as Array<{ seq: number | string; id: string; text: string }>;
  return rows.map((row) => ({ id: row.id, text: row.text, seq: Number(row.seq) }));
}

/**
 * Records that an attempt read these steers as new messages, because they
 * were written before it started.
 */
export async function steersRead(
  tx: Transaction,
  jobId: string,
  attemptId: string,
  upToSeq: number,
): Promise<void> {
  for (const steer of await pendingSteers(tx, jobId)) {
    if (steer.seq > upToSeq) continue;
    await appendEvent(tx, {
      jobId,
      attemptId,
      type: 'steer_delivered',
      payload: { steer_id: steer.id, read_as: 'message' },
      dedupKey: `steer-read:${steer.id}`,
    });
  }
}

/**
 * The turn ended before its steers were read: they become a turn of their
 * own, queued now, which reads them as its message. Returns the job as moved,
 * or null when nothing was waiting.
 */
export async function carrySteers(
  tx: Transaction,
  row: JobRow,
  move: (row: JobRow) => Promise<JobRow>,
): Promise<JobRow | null> {
  const waiting = await pendingSteers(tx, row.id);
  const [first] = waiting;
  if (!first) return null;
  const [fallback] = row.agentId
    ? []
    : await tx
        .select({ id: agent.id })
        .from(agent)
        .where(and(eq(agent.spaceId, row.spaceId), eq(agent.isDefault, true)));
  const agentId = row.agentId ?? fallback?.id;
  if (!agentId) return null;
  const turnId = newId('turn');
  await tx.insert(experienceTurn).values({
    id: turnId,
    jobId: row.id,
    agentId,
    submissionId: `steer:${row.id}:${first.id}`,
    authorPrincipalId: row.principalId,
    text: waiting.map((steer) => steer.text).join('\n\n'),
  });
  for (const steer of waiting)
    await appendEvent(tx, {
      jobId: row.id,
      type: 'steer_carried',
      payload: { steer_id: steer.id, turn_id: turnId },
      dedupKey: `steer-carried:${steer.id}`,
    });
  const moved = await move({ ...row, currentTurnId: null });
  await tx.update(job).set({ currentTurnId: turnId }).where(eq(job.id, row.id));
  return { ...moved, currentTurnId: turnId };
}
