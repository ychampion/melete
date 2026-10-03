/**
 * Who is looking at a room now: each open room view sends a heartbeat. This is
 * display only. What anyone may read is decided by membership, never by
 * presence, because a thread persists and is read later.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { spaceMembership } from '../db/schema.ts';
import { roomPresence } from './schema.ts';

/** A heartbeat older than this no longer shows a person as present. */
export const PRESENCE_MS = 45_000;

/** The current members whose last heartbeat in this room is recent. */
export async function presentIn(db: Database, spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: roomPresence.principalId })
    .from(roomPresence)
    .innerJoin(
      spaceMembership,
      and(
        eq(spaceMembership.spaceId, roomPresence.spaceId),
        eq(spaceMembership.principalId, roomPresence.principalId),
        isNull(spaceMembership.revokedAt),
      ),
    )
    .where(
      and(
        eq(roomPresence.spaceId, spaceId),
        gt(roomPresence.lastSeenAt, new Date(Date.now() - PRESENCE_MS)),
      ),
    );
  return rows.map((row) => row.id).sort();
}
