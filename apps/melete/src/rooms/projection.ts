/**
 * What a room's members see of its threads and requests. The rooms routes
 * have already checked the viewer is in the room; everything here reads the
 * room's own rows with the existing projectors, and nothing from a person's
 * own space.
 */
import {
  conversationTurn,
  type RoomMessage,
  type RoomRequest,
  type RoomThread,
  roomMessage as roomMessageContract,
  roomRequest,
  roomThread as roomThreadContract,
} from '@melete/contracts';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { action, artifact, connection, experienceTurn, job } from '../db/schema.ts';
import { answerStream } from '../experience/answer-filter.ts';
import {
  answerText,
  projectArtifact,
  projectCards,
  projectReceipt,
} from '../experience/projectors.ts';
import { conversationView } from '../experience/service.ts';
import type { JobRow } from '../jobs/service.ts';
import type { roomMessage, roomThread } from './schema.ts';

/** Turn statuses whose answer may still grow. */
const STILL_WRITING = new Set(['queued', 'working', 'streaming']);

const author = (names: ReadonlyMap<string, string>, id: string) => ({
  principal_id: id,
  display_name: names.get(id) ?? 'Someone',
});

export function threadView(
  row: typeof roomThread.$inferSelect,
  names: ReadonlyMap<string, string>,
): RoomThread {
  return roomThreadContract.parse({
    id: row.id,
    room_id: row.spaceId,
    title: row.title,
    created_by: author(names, row.createdBy),
    created_at: row.createdAt.toISOString(),
    last_activity_at: row.lastActivityAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
  });
}

export function messageView(
  row: typeof roomMessage.$inferSelect,
  names: ReadonlyMap<string, string>,
): RoomMessage {
  return roomMessageContract.parse({
    id: row.id,
    thread_id: row.threadId,
    author: author(names, row.authorPrincipalId),
    kind: row.kind,
    via_agent: row.viaAgent,
    text: row.redactedAt ? null : row.text,
    mentions: row.mentions,
    request_state: row.requestState,
    request_job_id: row.requestJobId,
    created_at: row.createdAt.toISOString(),
  });
}

/**
 * One request as the room sees it: its turns and answers, and the cards and
 * receipts of what it did, including the command jobs it started.
 */
export async function requestView(
  db: Database,
  row: JobRow,
  names: ReadonlyMap<string, string>,
): Promise<RoomRequest> {
  const turns = await db
    .select()
    .from(experienceTurn)
    .where(eq(experienceTurn.jobId, row.id))
    .orderBy(asc(experienceTurn.createdAt), asc(experienceTurn.id));
  const current = turns.find((turn) => turn.id === row.currentTurnId) ?? turns.at(-1) ?? null;
  const linked = await db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.experienceParentId, row.id), eq(job.spaceId, row.spaceId)));
  const jobIds = [row.id, ...linked.map((entry) => entry.id)];
  const effects = await db
    .select({ action, connection })
    .from(action)
    .innerJoin(connection, eq(connection.id, action.connectionId))
    .where(and(inArray(action.jobId, jobIds), eq(connection.spaceId, row.spaceId)))
    .orderBy(asc(action.createdAt), asc(action.id));
  const files = await db
    .select()
    .from(artifact)
    .where(
      and(eq(artifact.spaceId, row.spaceId), or(...jobIds.map((id) => eq(artifact.jobId, id)))),
    );
  const receipts = effects.flatMap(({ action: effect, connection: source }) => {
    const receipt = projectReceipt(effect, source);
    return receipt ? [receipt] : [];
  });
  return roomRequest.parse({
    job_id: row.id,
    requested_by: author(names, row.requestedByPrincipalId ?? ''),
    status: conversationView(row, current).status,
    turns: turns.map((turn) =>
      conversationTurn.parse({
        id: turn.id,
        conversation_id: turn.jobId,
        agent_id: turn.agentId,
        text: turn.text,
        answer: (STILL_WRITING.has(turn.status)
          ? answerStream(turn.answer)
          : answerText(turn.answer)
        ).trimStart(),
        status: turn.status,
        delivery: turn.status === 'queued' ? 'sending' : null,
        created_at: turn.createdAt.toISOString(),
      }),
    ),
    cards: [
      ...effects.flatMap(({ action: effect, connection: source }) => projectCards(effect, source)),
      ...files.map(projectArtifact),
    ],
    receipts,
  });
}
