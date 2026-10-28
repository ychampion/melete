/**
 * Whose a room's files are. Each route names the room in its path, and the
 * person is checked against the room's roster now, on every request: someone
 * removed from the room, or never in it, is told the room is not there. A
 * guest uploads only in a room that lets guests ask its agent.
 *
 * In a room set to "Show me only what needs me" (`spaces/summaries.ts`), a
 * posted file is read as it is only by the person who posted it and the room's
 * maker. Everyone else opens the original on purpose, and each such open is
 * noted in the room's activity before a byte of it is sent. The room's request
 * still reads the file: only what people are shown changes.
 */
import { originalKind, SUMMARIES_ONLY_CODE } from '@melete/contracts';
import type { Context } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { readRoomPolicy } from '../rooms/policy.ts';
import { noteInActivity, SUMMARIES_ONLY_REFUSAL, summariesOnlyIn } from '../spaces/summaries.ts';
import type { AttachmentScope } from './store.ts';

export type RoomAttachments = {
  /** The room's scope for this person, or the room is not there for them. */
  scope: (c: Context, roomId: string, use: 'upload' | 'read') => Promise<AttachmentScope>;
  /**
   * Whether this person may read this file as it is (`content`), or open it on
   * purpose (`original`), which in a summaries-only room is noted first.
   */
  admit: (input: {
    roomId: string;
    viewer: string;
    uploader: string | null;
    mediaType: string;
    read: 'content' | 'original';
  }) => Promise<void>;
};

const notHere = () => new ServiceError('not_found', 'That room is not here.', 404);

export const GUESTS_MAY_NOT_ATTACH =
  'Guests can attach files only in rooms where guests may ask the agent.';

export function roomAttachments(db: Database): RoomAttachments {
  return {
    async scope(c, roomId, use) {
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
    },

    async admit({ roomId, viewer, uploader, mediaType, read }) {
      if (!(await summariesOnlyIn(db, roomId))) return;
      if (read === 'content') {
        if (viewer === uploader) return;
        const { ownerId } = await spaceAuthority(db, roomId, viewer);
        if (ownerId !== null && ownerId === viewer) return;
        throw new ServiceError(SUMMARIES_ONLY_CODE, SUMMARIES_ONLY_REFUSAL, 403);
      }
      // An open nobody can see is what the setting is there to prevent: when
      // the note cannot be written, the file is not sent either.
      await noteInActivity(db, {
        spaceId: roomId,
        principalId: viewer,
        note: 'original_opened',
        where: 'Room',
        destination: originalKind(mediaType),
      });
    },
  };
}
