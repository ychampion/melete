/**
 * What a room request's agent reads of its thread: every person's message with
 * their name, and the answers to the thread's other requests. Nothing from
 * anyone's personal space is here; a thread is all room material.
 */
import { createHash } from 'node:crypto';
import type { CanonicalMessage, RoomApprovers } from '@melete/contracts';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { experienceTurn, job, principal } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { answerText } from '../experience/answer-filter.ts';
import { roomMessage, roomPolicy } from './schema.ts';

/**
 * The most of each source read for one attempt. The attempt's transcript,
 * thread and request together, is then held to the conversation bound.
 */
export const THREAD_MESSAGES = 100;

/**
 * The name a person goes by in a room: the one they chose, or the part of
 * their email before the @. The rest of an email, how to reach them, is never
 * part of a room's labels.
 */
export function displayName(row: { displayName: string | null; email: string }): string {
  const chosen = row.displayName?.trim();
  return chosen || (row.email.split('@')[0] ?? row.email);
}

/** Letters a handle is made of: no two that read alike. */
const HANDLE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const HANDLE_LENGTH = 6;

/**
 * The code a room gives a person. It comes from the room and the person's
 * account, both made by the service, so nobody chooses it or can take someone
 * else's; it differs from room to room, so a guest in two rooms is not
 * followed between them by it.
 */
export function roomHandle(spaceId: string, principalId: string): string {
  const digest = createHash('sha256').update(`room-handle:${spaceId}:${principalId}`).digest();
  let handle = '';
  for (let index = 0; index < HANDLE_LENGTH; index++)
    handle += HANDLE_ALPHABET[(digest[index] ?? 0) % HANDLE_ALPHABET.length];
  return handle;
}

/**
 * How a room names a person: the name they chose, then the room's handle for
 * them in angle brackets. The handle is theirs alone in the room and nobody
 * chooses it, so it is what tells people apart; the name before it is only
 * what they call themselves. A chosen name cannot hold `<`, `>` or `@`, so it
 * never reads as a handle. No label carries an email: guests read the room too.
 */
export function personLabel(
  row: { id: string; displayName: string | null; email: string },
  spaceId: string,
): string {
  return `${displayName(row)} <${roomHandle(spaceId, row.id)}>`;
}

/** The label of each of a set of principals in one room; see `personLabel`. */
export async function namesOf(
  tx: Pick<Transaction, 'select'>,
  spaceId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await tx
    .select({ id: principal.id, displayName: principal.displayName, email: principal.email })
    .from(principal)
    .where(inArray(principal.id, unique));
  return new Map(rows.map((row) => [row.id, personLabel(row, spaceId)]));
}

export type RoomTranscript = {
  /** The thread around this request, oldest first. */
  thread: CanonicalMessage[];
  /** Every speaker this request's own messages may name. */
  names: Map<string, string>;
  /** Who asked this request. */
  requester: string;
  /** Who answers this request's permissions, as one sentence for the agent. */
  approvers: string;
};

/** Who answers a room request's permissions, under each of the room's rules. */
export const APPROVERS_LINE: Record<RoomApprovers, string> = {
  requester: 'Only they can answer the permissions it asks for.',
  any_member: 'Anyone in the room who is not a guest can answer the permissions it asks for.',
  owners: "Only the room's owners can answer the permissions it asks for.",
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
  const names = await namesOf(tx, row.spaceId, speakers);
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
  const [policy] = await tx
    .select({ approvers: roomPolicy.approvers })
    .from(roomPolicy)
    .where(eq(roomPolicy.spaceId, row.spaceId));
  // A guest never answers a permission: their request is answered by the owners.
  const [asker] = row.requestedByPrincipalId
    ? await tx
        .select({ kind: principal.kind })
        .from(principal)
        .where(eq(principal.id, row.requestedByPrincipalId))
    : [];
  const rule = (policy?.approvers ?? 'requester') as RoomApprovers;
  const approvers =
    APPROVERS_LINE[rule === 'requester' && asker?.kind === 'guest' ? 'owners' : rule] ??
    APPROVERS_LINE.requester;
  return { thread, names, requester, approvers };
}
