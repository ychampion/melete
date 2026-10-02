/**
 * How a room works: who decides its permissions, when its agent answers,
 * whether guests may ask it, and how many asks an hour it takes. Everyone in
 * the room may read it; only its owners change it.
 */
import { type RoomPolicy, roomPolicy as roomPolicyContract } from '@melete/contracts';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import type { Transaction } from '../db/transaction.ts';
import { ROOM_POLICY_DEFAULTS } from './approvals.ts';
import { roomMessage, roomPolicy } from './schema.ts';

/** A room's settings, or the defaults for a room that never changed them. */
export async function readRoomPolicy(
  reader: Database | Transaction,
  spaceId: string,
): Promise<RoomPolicy> {
  const [row] = await reader.select().from(roomPolicy).where(eq(roomPolicy.spaceId, spaceId));
  return roomPolicyContract.parse(
    row
      ? {
          approvers: row.approvers,
          agent_turns: row.agentTurns,
          guests_may_ask: row.guestsMayAsk,
          requests_per_hour: row.requestsPerHour,
          requests_per_person_hour: row.requestsPerPersonHour,
        }
      : ROOM_POLICY_DEFAULTS,
  );
}

/** Change some of a room's settings. The caller has checked the actor owns the room. */
export async function writeRoomPolicy(
  tx: Transaction,
  spaceId: string,
  actor: string,
  patch: Partial<RoomPolicy>,
): Promise<RoomPolicy> {
  const next = { ...(await readRoomPolicy(tx, spaceId)), ...patch };
  if (next.requests_per_person_hour > next.requests_per_hour)
    throw new ServiceError(
      'invalid_request',
      'One person cannot ask more often than the whole room.',
      400,
    );
  const values = {
    approvers: next.approvers,
    agentTurns: next.agent_turns,
    guestsMayAsk: next.guests_may_ask,
    requestsPerHour: next.requests_per_hour,
    requestsPerPersonHour: next.requests_per_person_hour,
    updatedAt: new Date(),
    updatedBy: actor,
  };
  await tx
    .insert(roomPolicy)
    .values({ spaceId, ...values })
    .onConflictDoUpdate({ target: roomPolicy.spaceId, set: values });
  return roomPolicyContract.parse(next);
}

/**
 * Which limit one more ask would pass, if any: the room's hour, or the asker's. An ask is
 * a message that reached the agent or waits its turn; a message that asked
 * nothing, or whose ask was dropped, is not counted.
 */
export async function askLimitReached(
  tx: Transaction,
  spaceId: string,
  actor: string,
  policy: RoomPolicy,
): Promise<'room' | 'person' | null> {
  const since = sql`now() - interval '1 hour'`;
  const [counts] = await tx
    .select({
      room: sql<number>`count(*)::int`,
      person: sql<number>`count(*) filter (where ${roomMessage.authorPrincipalId} = ${actor})::int`,
    })
    .from(roomMessage)
    .where(
      and(
        eq(roomMessage.spaceId, spaceId),
        ne(roomMessage.requestState, 'none'),
        gt(roomMessage.createdAt, since),
      ),
    );
  if (Number(counts?.room ?? 0) >= policy.requests_per_hour) return 'room';
  if (Number(counts?.person ?? 0) >= policy.requests_per_person_hour) return 'person';
  return null;
}
