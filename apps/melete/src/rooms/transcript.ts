/**
 * What a room request's agent reads of its thread: every person's message with
 * their name, and the answers to the thread's other requests. Nothing from
 * anyone's personal space is here; a thread is all room material.
 */
import type { CanonicalMessage } from '@melete/contracts';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { experienceTurn, job, principal } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { answerText } from '../experience/answer-filter.ts';
import { roomMessage } from './schema.ts';

/**
 * The most of each source read for one attempt. The attempt's transcript,
 * thread and request together, is then held to the conversation bound.
 */
export const THREAD_MESSAGES = 100;

/** The name a person goes by in a room: the one they chose, or their email before the @. */
export function displayName(row: { displayName: string | null; email: string }): string {
  const chosen = row.displayName?.trim();
  return chosen || (row.email.split('@')[0] ?? row.email);
}

/** Display names for a set of principals. */
export async function namesOf(
  tx: Pick<Transaction, 'select'>,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await tx
    .select({ id: principal.id, displayName: principal.displayName, email: principal.email })
    .from(principal)
    .where(inArray(principal.id, unique));
  return new Map(rows.map((row) => [row.id, displayName(row)]));
}

export type RoomTranscript = {
  /** The thread around this request, oldest first. */
  thread: CanonicalMessage[];
  /** Every speaker this request's own messages may name. */
  names: Map<string, string>;
  /** Who asked this request. */
  requester: string;
};

/**
 * The thread a room request was asked in, for its attempt. The request's own
 * messages are left out: they reach the attempt as its own input, named by the
 * same map.
 */
export async function roomTranscript(
  tx: Transaction,
  row: {
    id: string;
    spaceId: string;
    roomThreadId: string | null;
    requestedByPrincipalId: string | null;
  },
): Promise<RoomTranscript> {
  const threadId = row.roomThreadId ?? '';
  const said = (
    await tx
      .select({
        author: roomMessage.authorPrincipalId,
        text: roomMessage.text,
        at: roomMessage.createdAt,
        viaAgent: roomMessage.viaAgent,
      })
      .from(roomMessage)
      .where(
        and(
          eq(roomMessage.threadId, threadId),
          eq(roomMessage.spaceId, row.spaceId),
          isNull(roomMessage.redactedAt),
          or(isNull(roomMessage.requestJobId), ne(roomMessage.requestJobId, row.id)),
        ),
      )
      .orderBy(desc(roomMessage.createdAt), desc(roomMessage.id))
      .limit(THREAD_MESSAGES)
  ).reverse();
  const answered = (
    await tx
      .select({
        answer: experienceTurn.answer,
        at: sql<Date>`coalesce(${experienceTurn.finishedAt}, ${experienceTurn.createdAt})`,
      })
      .from(experienceTurn)
      .innerJoin(job, eq(job.id, experienceTurn.jobId))
      .where(
        and(
          eq(job.roomThreadId, threadId),
          eq(job.spaceId, row.spaceId),
          eq(job.audience, 'room'),
          ne(job.id, row.id),
        ),
      )
      .orderBy(desc(experienceTurn.createdAt), desc(experienceTurn.id))
      .limit(THREAD_MESSAGES)
  ).reverse();
  const speakers = [
    ...said.map((entry) => entry.author),
    ...(row.requestedByPrincipalId ? [row.requestedByPrincipalId] : []),
  ];
  const names = await namesOf(tx, speakers);
  const thread: CanonicalMessage[] = [
    ...said.map((entry) => ({
      role: 'user' as const,
      name: `${names.get(entry.author) ?? 'Someone'}${entry.viaAgent ? ' (via Melete)' : ''}`,
      content: entry.text,
      at: entry.at.toISOString(),
    })),
    ...answered.flatMap((entry) => {
      const content = answerText(entry.answer).trim();
      return content
        ? [{ role: 'assistant' as const, content, at: new Date(entry.at).toISOString() }]
        : [];
    }),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const requester = names.get(row.requestedByPrincipalId ?? '') ?? 'Someone';
  return { thread, names, requester };
}
