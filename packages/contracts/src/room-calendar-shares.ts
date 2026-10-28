/** Explicit, revocable access to one member's personal calendar from a room. */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

const connectionId = prefixedId(ID_PREFIXES.connection);

export const roomCalendarShareMode = z.enum(['freebusy', 'freebusy_add']);
export type RoomCalendarShareMode = z.infer<typeof roomCalendarShareMode>;

/** Only the calendar's member sees these settings and connection labels. */
export const roomCalendarShare = z.strictObject({
  connection_id: connectionId,
  mode: roomCalendarShareMode,
  created_at: timestamp,
});

export const roomCalendarShareUpdate = z.strictObject({
  connection_id: connectionId,
  mode: roomCalendarShareMode,
});

export const roomCalendarShareSettings = z.strictObject({
  share: roomCalendarShare.nullable(),
  connections: z.array(
    z.strictObject({
      id: connectionId,
      label: z.string(),
      can_add: z.boolean(),
    }),
  ),
});

export const roomCalendarShareResult = z.strictObject({ share: roomCalendarShare });
export const roomCalendarShareRevoked = z.strictObject({ revoked: z.literal(true) });
