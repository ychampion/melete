/**
 * Whose a room's files are. Each route names the room in its path, and the
 * person is checked against the room's roster now, on every request: someone
 * removed from the room, or never in it, is told the room is not there. A
 * guest uploads only in a room that lets guests ask its agent.
 */
import type { Context } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { readRoomPolicy } from '../rooms/policy.ts';
import type { AttachmentScope } from './store.ts';

export type RoomAttachmentScope = (
  c: Context,
  roomId: string,
  use: 'upload' | 'read',
) => Promise<AttachmentScope>;

const notHere = () => new ServiceError('not_found', 'That room is not here.', 404);

export const GUESTS_MAY_NOT_ATTACH =
  'Guests can attach files only in rooms where guests may ask the agent.';

export function roomAttachmentScope(db: Database): RoomAttachmentScope {
  return async (c, roomId, use) => {
    const actor = c.get('owner')?.id as string | undefined;
    if (!actor) throw notHere();
    const access = await spaceAuthority(db, roomId, actor).catch((error: unknown) => {
      if (error instanceof ServiceError) throw notHere();
      throw error;
    });
    if (access.space.kind !== 'shared' || access.role === 'agent') throw notHere();
    if (
      use === 'upload' &&
      access.role === 'guest' &&
      !(await readRoomPolicy(db, roomId)).guests_may_ask
    )
      throw new ServiceError('guests_may_not_attach', GUESTS_MAY_NOT_ATTACH, 403);
    return { spaceId: roomId, principalId: actor };
  };
}
