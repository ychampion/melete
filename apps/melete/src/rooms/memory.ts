/**
 * A room's memory, as its people see and steer it. What anyone says in a room
 * becomes the room's memory under their name (`memory/capture.ts`); here they
 * read it, forget from it, delete their own messages, and share details from
 * their own memory into the room by reference (`shares.ts`). Every route
 * checks, as the other room routes do, that the person is in the room now.
 */
import {
  roomMemoryForgotten,
  roomMemoryView,
  roomMessageDeleted,
  roomShareResponse,
  roomShareWithdrawn,
  shareToRoomRequest,
} from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import { memoryKeyLabel } from '../experience/evidence.ts';
import { newId } from '../ids.ts';
import { roomSourceIdentity } from '../memory/capture.ts';
import { eligibleRevision } from '../memory/claims.ts';
import { MemoryError, type MemoryScope, newId as newMemoryId } from '../memory/db.ts';
import {
  forgetMemory,
  lockRestrictions,
  mayForgetRoomClaim,
  restrictWithin,
} from '../memory/forget.ts';
import { notifyInvalidated } from '../memory/invalidate.ts';
import type { RestrictionRecord } from '../memory/restore.ts';
import { applyRoomRecord } from '../memory/room-records.ts';
import type { MemoryRouteOptions } from '../memory/routes.ts';
import { messageView } from './projection.ts';
import { roomMessage } from './schema.ts';
import type { RoomService } from './service.ts';
import { roomShares, shareIntoRoom } from './shares.ts';
import { namesOf } from './transcript.ts';

type RoomMemory = Required<Pick<MemoryRouteOptions, 'sql' | 'journal' | 'storageScope'>>;

const notHere = () => new ServiceError('not_found', 'That is not in this room.', 404);

/** A memory refusal as the room routes answer it. */
function translate(error: unknown): never {
  if (error instanceof MemoryError) {
    if (error.code === 'claim_not_found' || error.code === 'scope_denied') throw notHere();
    if (error.code === 'private_detail')
      throw new ServiceError(
        'private_detail',
        'That detail came from a private conversation, so it stays yours.',
        409,
      );
    throw new ServiceError('memory_unavailable', 'Memory is not ready. Try again shortly.', 503);
  }
  throw error;
}

/** A room's removal, journaled so a restore from an older backup redoes it. */
function roomRecord(
  scope: MemoryScope,
  operation: 'redact_room_message' | 'withdraw_room_share',
  target: { room_message_id: string } | { grant_id: string },
): RestrictionRecord {
  return {
    id: newMemoryId('sup'),
    owner_id: scope.ownerId,
    space_id: scope.spaceId,
    operation,
    all: false,
    claim_ids: [],
    targets: [],
    eligibility_cutoff: 0,
    access_generation: 1,
    ...target,
    recorded_at: new Date().toISOString(),
  };
}

export class RoomMemoryService {
  constructor(
    readonly rooms: RoomService,
    readonly memory: RoomMemory,
  ) {}

  private get db() {
    return this.rooms.deps.db;
  }

  private async scope(spaceId: string): Promise<MemoryScope> {
    return { ...(await this.memory.storageScope(spaceId).catch(translate)), publisher: 'room' };
  }

  /** What the room remembers, whose words each detail rests on, and what people shared into it. */
  async view(spaceId: string, actor: string) {
    const access = await this.rooms.access(this.db, spaceId, actor);
    const scope = await this.scope(spaceId);
    const { sql } = this.memory;
    const reader: MemoryScope = { ...scope, role: 'reader' };
    const rows =
      await sql`select c.id, c.key, c.domain_key, c.head_revision, b.content, r.recorded_at
      from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
      join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
      where c.space_id = ${spaceId} and not c.hidden and c.audience in ('space', 'public')
        and r.status in ('active', 'disputed')
      order by r.recorded_at desc, c.id limit 200`;
    const said = new Map<string, string[]>();
    const kept: Record<string, unknown>[] = [];
    for (const row of rows) {
      const visible = await sql.begin((tx) =>
        eligibleRevision(tx, reader, String(row.id), Number(row.head_revision)),
      );
      if (!visible) continue;
      kept.push(row);
      const authors = await sql`select distinct s.author_principal_id from memory_references ref
        join memory_sources s on s.id = ref.source_id
        where ref.claim_id = ${row.id} and ref.revision = ${row.head_revision}
          and s.author_principal_id is not null order by s.author_principal_id`;
      said.set(
        String(row.id),
        authors.map((author) => String(author.author_principal_id)),
      );
    }
    const shares = await roomShares(sql, spaceId, access.role === 'guest');
    const names = await namesOf(this.db, [
      ...[...said.values()].flat(),
      ...shares.map((share) => share.granted_by),
    ]);
    const author = (id: string) => ({ principal_id: id, display_name: names.get(id) ?? 'Someone' });
    const items = [];
    for (const row of kept) {
      const id = String(row.id);
      items.push({
        claim_id: id,
        key: (row.key as string | null) ?? null,
        label: memoryKeyLabel((row.key as string | null) ?? (row.domain_key as string)),
        content: String(row.content),
        said_by: (said.get(id) ?? []).map(author),
        can_forget: access.role === 'owner' || (await mayForgetRoomClaim(sql, spaceId, id, actor)),
        recorded_at: new Date(row.recorded_at as string).toISOString(),
      });
    }
    return roomMemoryView.parse({
      items,
      shares: shares.map((share) => ({
        id: share.id,
        claim_id: share.claim_id,
        shared_by: author(share.granted_by),
        members_only: share.members_only,
        label: share.content === null ? null : memoryKeyLabel(share.key),
        content: share.content,
        created_at: share.created_at.toISOString(),
        can_withdraw: access.role === 'owner' || share.granted_by === actor,
      })),
    });
  }

  /** Forget one detail: an owner any, anyone else only one from their own words. */
  async forget(spaceId: string, claimId: string, actor: string) {
    const access = await this.rooms.access(this.db, spaceId, actor);
    const scope = await this.scope(spaceId);
    const { sql } = this.memory;
    const [claim] =
      await sql`select id from memory_claims where id = ${claimId} and space_id = ${spaceId} and not hidden`;
    if (!claim) throw notHere();
    if (access.role !== 'owner' && !(await mayForgetRoomClaim(sql, spaceId, claimId, actor)))
      throw new ServiceError(
        'scope_denied',
        'You can forget what came from your own words here; an owner of the room can forget anything.',
        403,
      );
    await forgetMemory(sql, scope, { claim_id: claimId }, this.memory.journal).catch(translate);
    return roomMemoryForgotten.parse({ forgotten: claimId });
  }

  /** Share one of the person's own details into the room. Guests share nothing. */
  async share(spaceId: string, actor: string, raw: unknown) {
    const access = await this.rooms.access(this.db, spaceId, actor);
    if (access.role === 'guest')
      throw new ServiceError('scope_denied', 'Guests share nothing into a room.', 403);
    const input = shareToRoomRequest.parse(raw);
    const { sql } = this.memory;
    const shared = await shareIntoRoom(sql, {
      roomSpaceId: spaceId,
      principalId: actor,
      claimId: input.claim_id,
      membersOnly: input.members_only ?? true,
      grantId: newId('rsh'),
    }).catch(translate);
    const view = await this.view(spaceId, actor);
    const share = view.shares.find((entry) => entry.id === shared.id);
    if (!share) throw notHere();
    return { created: shared.created, body: roomShareResponse.parse({ share }) };
  }

  /** Withdraw a share: the person who shared it, or an owner of the room. */
  async withdraw(spaceId: string, shareId: string, actor: string) {
    const access = await this.rooms.access(this.db, spaceId, actor);
    const { sql, journal } = this.memory;
    const [grant] = await sql`select granted_by from memory_room_grant
      where id = ${shareId} and room_space_id = ${spaceId} and revoked_at is null`;
    if (!grant) throw notHere();
    if (access.role !== 'owner' && grant.granted_by !== actor)
      throw new ServiceError(
        'scope_denied',
        'Only the person who shared it, or an owner of the room, can withdraw it.',
        403,
      );
    const scope = await this.scope(spaceId);
    await sql.begin(async (tx) => {
      await lockRestrictions(tx);
      const record = roomRecord(scope, 'withdraw_room_share', { grant_id: shareId });
      await journal.append(record);
      await applyRoomRecord(tx, record);
    });
    await notifyInvalidated(sql, spaceId);
    return roomShareWithdrawn.parse({ withdrawn: shareId });
  }

  /**
   * Delete one's own message. Its words leave the thread, the request it
   * reached and the room's memory in one transaction, and the journal keeps
   * the deletion so a restore from an older backup redoes it.
   */
  async deleteMessage(spaceId: string, messageId: string, actor: string) {
    await this.rooms.access(this.db, spaceId, actor);
    const [message] = await this.db
      .select()
      .from(roomMessage)
      .where(and(eq(roomMessage.id, messageId), eq(roomMessage.spaceId, spaceId)));
    if (!message) throw notHere();
    if (message.authorPrincipalId !== actor)
      throw new ServiceError('scope_denied', 'Only the person who wrote it can delete it.', 403);
    const scope = await this.scope(spaceId);
    const { sql, journal } = this.memory;
    await sql
      .begin(async (tx) => {
        await lockRestrictions(tx);
        await tx`select id from room_message where id = ${messageId} for update`;
        // What memory kept of the message goes the way any deleted source does.
        const sources = await tx`select id from memory_sources
          where space_id = ${spaceId} and source_identity = ${roomSourceIdentity(messageId)}
            and state <> 'deleted' order by id`;
        for (const source of sources)
          await restrictWithin(
            tx,
            scope,
            { operation: 'delete', sourceId: String(source.id), all: false },
            journal,
          );
        const record = roomRecord(scope, 'redact_room_message', { room_message_id: messageId });
        await journal.append(record);
        await applyRoomRecord(tx, record);
      })
      .catch(translate);
    await notifyInvalidated(sql, spaceId);
    const [after] = await this.db.select().from(roomMessage).where(eq(roomMessage.id, messageId));
    if (!after) throw notHere();
    const names = await namesOf(this.db, [after.authorPrincipalId]);
    return roomMessageDeleted.parse({ message: messageView(after, names) });
  }
}

/** The room memory routes. Without memory on this installation they answer 503. */
export function mountRoomMemory(app: Hono, rooms: RoomService, memory?: MemoryRouteOptions) {
  const service =
    memory?.storageScope && memory.journal
      ? new RoomMemoryService(rooms, {
          sql: memory.sql,
          journal: memory.journal,
          storageScope: memory.storageScope,
        })
      : null;
  const ready = () => {
    if (!service)
      throw new ServiceError(
        'memory_unavailable',
        'Memory is not running on this installation.',
        503,
      );
    return service;
  };
  const actor = (c: Context) => c.get('owner').id as string;
  const param = (c: Context, name: string) => c.req.param(name) ?? '';
  app.get('/rooms/:id/memory', async (c) => c.json(await ready().view(param(c, 'id'), actor(c))));
  app.post('/rooms/:id/memory/:claimId/forget', async (c) =>
    c.json(await ready().forget(param(c, 'id'), param(c, 'claimId'), actor(c))),
  );
  app.post('/rooms/:id/shares', async (c) => {
    const result = await ready().share(param(c, 'id'), actor(c), await c.req.json());
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.delete('/rooms/:id/shares/:shareId', async (c) =>
    c.json(await ready().withdraw(param(c, 'id'), param(c, 'shareId'), actor(c))),
  );
  app.delete('/rooms/:id/messages/:messageId', async (c) =>
    c.json(await ready().deleteMessage(param(c, 'id'), param(c, 'messageId'), actor(c))),
  );
  return service;
}
