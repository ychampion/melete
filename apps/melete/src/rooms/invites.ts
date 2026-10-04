/**
 * Guests. An owner of a room invites someone by email; Melete makes a link that
 * works once, which the owner sends them. Opening it, the guest chooses a
 * password and lands in that room alone. A guest account uses only the rooms
 * it was invited to (see `guestMayUse` in api/auth.ts), never answers a
 * permission, has no people list and no work of its own, and its place in a
 * room ends when the invite's time is up.
 *
 * Only the SHA-256 of an invite's token is kept. The token travels in request
 * bodies, never in a path a proxy might log, and in the fragment of the link,
 * which no server sees.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  acceptInviteRequest,
  acceptInviteResponse,
  createRoomInviteRequest,
  inviteView,
  inviteViewRequest,
  type RoomInvite,
  roomInvite,
  roomInviteCreated,
  roomInviteList,
} from '@melete/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { activeSession, SESSION_COOKIE, startSession } from '../api/auth.ts';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { principal, space, spaceMembership } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { newId } from '../ids.ts';
import type { JobService } from '../jobs/service.ts';
import type { PrincipalService } from '../principals/service.ts';
import { roomInvite as roomInviteTable } from './schema.ts';
import { nameTaken, type RoomService } from './service.ts';
import { namesOf } from './transcript.ts';

/** How long a guest stays when the owner names no time. */
export const INVITE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const unavailable = () =>
  new ServiceError(
    'invite_unavailable',
    'This invite link is used, withdrawn or out of date. Ask for a new one.',
    404,
  );
const ownersOnly = () =>
  new ServiceError('scope_denied', 'Only an owner of this room can do that.', 403);

/** The page an invite link opens. The token rides in the fragment, which no server log sees. */
export function invitePath(token: string): string {
  return `/#/invite?${new URLSearchParams({ token })}`;
}
export function inviteUrl(publicUrl: string, token: string): string {
  const url = new URL('/', publicUrl);
  url.hash = `/invite?${new URLSearchParams({ token })}`;
  return url.href;
}

type InviteRow = typeof roomInviteTable.$inferSelect;

function stateOf(row: InviteRow, now: Date): RoomInvite['state'] {
  if (row.withdrawnAt) return 'withdrawn';
  if (row.redeemedAt) return 'accepted';
  return row.expiresAt <= now ? 'expired' : 'open';
}

export type InviteDeps = {
  db: Database;
  jobs: JobService;
  principals: PrincipalService;
  rooms: RoomService;
  publicUrl?: string;
};

export class InviteService {
  constructor(readonly deps: InviteDeps) {}

  private async view(rows: InviteRow[]): Promise<RoomInvite[]> {
    const now = new Date();
    const byRoom = new Map<string, Map<string, string>>();
    for (const row of rows)
      if (!byRoom.has(row.spaceId))
        byRoom.set(
          row.spaceId,
          await namesOf(
            this.deps.db,
            row.spaceId,
            rows.filter((other) => other.spaceId === row.spaceId).map((other) => other.createdBy),
          ),
        );
    return rows.map((row) =>
      roomInvite.parse({
        id: row.id,
        room_id: row.spaceId,
        email: row.email,
        state: stateOf(row, now),
        expires_at: row.expiresAt.toISOString(),
        created_by: {
          principal_id: row.createdBy,
          display_name: byRoom.get(row.spaceId)?.get(row.createdBy) ?? 'Someone',
        },
        created_at: row.createdAt.toISOString(),
        accepted_at: row.redeemedAt?.toISOString() ?? null,
      }),
    );
  }

  private async requireOwner(spaceId: string, actor: string) {
    const access = await this.deps.rooms.access(this.deps.db, spaceId, actor);
    if (access.role !== 'owner') throw ownersOnly();
    return access;
  }

  /**
   * Invite a guest. Someone with a full account here is added from People
   * instead, and someone already in the room needs no invite. The link is
   * shown once and works once.
   */
  async create(spaceId: string, actor: string, input: { email: string; days?: number }) {
    await this.requireOwner(spaceId, actor);
    const email = input.email.toLowerCase();
    const [account] = await this.deps.db
      .select({ id: principal.id, kind: principal.kind })
      .from(principal)
      .where(eq(principal.email, email));
    if (account && account.kind !== 'guest')
      throw new ServiceError(
        'person_account',
        account.kind === 'person'
          ? 'That email has a full account here. Add them from People instead.'
          : 'That email cannot be invited.',
        409,
      );
    if (account) {
      const [inRoom] = await this.deps.db
        .select({ role: spaceMembership.role })
        .from(spaceMembership)
        .where(
          and(
            eq(spaceMembership.spaceId, spaceId),
            eq(spaceMembership.principalId, account.id),
            isNull(spaceMembership.revokedAt),
          ),
        );
      if (inRoom) throw new ServiceError('already_in_room', 'They are already in this room.', 409);
    }
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.deps.db
      .insert(roomInviteTable)
      .values({
        id: newId('rin'),
        spaceId,
        email,
        tokenHash: digest(token),
        expiresAt: new Date(Date.now() + (input.days ?? INVITE_DAYS) * DAY_MS),
        createdBy: actor,
      })
      .returning();
    if (!row) throw new Error('Invite insert returned no row');
    const [invite] = await this.view([row]);
    return roomInviteCreated.parse({
      invite,
      link: this.deps.publicUrl ? inviteUrl(this.deps.publicUrl, token) : null,
      path: invitePath(token),
    });
  }

  async list(spaceId: string, actor: string) {
    await this.requireOwner(spaceId, actor);
    const rows = await this.deps.db
      .select()
      .from(roomInviteTable)
      .where(eq(roomInviteTable.spaceId, spaceId))
      .orderBy(desc(roomInviteTable.createdAt), desc(roomInviteTable.id))
      .limit(200);
    return roomInviteList.parse({ invites: await this.view(rows) });
  }

  /** Take back an invite nobody has used. A guest already in is removed from People instead. */
  async withdraw(spaceId: string, actor: string, inviteId: string) {
    await this.requireOwner(spaceId, actor);
    const row = await this.deps.db.transaction(async (tx) => {
      const [found] = await tx
        .select()
        .from(roomInviteTable)
        .where(and(eq(roomInviteTable.id, inviteId), eq(roomInviteTable.spaceId, spaceId)))
        .for('update');
      if (!found) throw new ServiceError('not_found', 'That invite is not in this room.', 404);
      if (found.redeemedAt)
        throw new ServiceError(
          'invite_used',
          'That invite was already accepted. Remove the guest from People instead.',
          409,
        );
      if (found.withdrawnAt) return found;
      const [updated] = await tx
        .update(roomInviteTable)
        .set({ withdrawnAt: new Date() })
        .where(eq(roomInviteTable.id, inviteId))
        .returning();
      return updated ?? found;
    });
    const [invite] = await this.view([row]);
    return { invite };
  }

  /** The invite a token names, while it can still be accepted, and its room. */
  private async open(token: string) {
    const [row] = await this.deps.db
      .select({ invite: roomInviteTable, room: space })
      .from(roomInviteTable)
      .innerJoin(space, eq(space.id, roomInviteTable.spaceId))
      .where(eq(roomInviteTable.tokenHash, digest(token)));
    if (
      !row ||
      stateOf(row.invite, new Date()) !== 'open' ||
      row.room.removedAt ||
      row.room.kind !== 'shared'
    )
      throw unavailable();
    return row;
  }

  /** What the link shows before it is accepted: the room's name, and nothing about its people. */
  async preview(token: string) {
    const { invite, room } = await this.open(token);
    const [account] = await this.deps.db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.email, invite.email));
    return inviteView.parse({
      room_name: room.name,
      expires_at: invite.expiresAt.toISOString(),
      existing_account: Boolean(account),
    });
  }

  /**
   * Accept an invite. Without a session it makes the guest account; when the
   * email already has a guest account, that account must be the one signed in,
   * so a link can never take over an account or set its password. A full
   * account is added from People by an owner instead. The invite is used up in
   * the same transaction that gives the guest their place, and the room's
   * roster is fenced there too.
   */
  async accept(
    input: { token: string; password?: string; display_name?: string },
    signedIn: { id: string; kind: string } | null,
  ): Promise<{ roomId: string; guestId: string; created: boolean }> {
    // Checked before any password is hashed; checked again under the lock.
    const { invite } = await this.open(input.token);
    const [existing] = await this.deps.db
      .select()
      .from(principal)
      .where(eq(principal.email, invite.email));
    if (existing) ensureSignedInAs(existing, signedIn);
    else {
      if (signedIn)
        throw new ServiceError(
          'signed_in_as_other',
          'This invite is for another email. Sign out, then open the link again.',
          409,
        );
      if (!input.password)
        throw new ServiceError('password_required', 'Choose a password for your account.', 400);
    }
    const name = input.display_name?.trim() || null;
    if (!existing && name && (await nameTaken(this.deps.db, name)))
      throw new ServiceError(
        'name_taken',
        'Someone here already goes by that name. Choose another.',
        409,
      );
    const passwordHash =
      !existing && input.password
        ? await Bun.password.hash(input.password, { algorithm: 'argon2id' })
        : null;
    const jobs = this.deps.jobs;
    const result = await jobs.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(roomInviteTable)
        .where(eq(roomInviteTable.tokenHash, digest(input.token)))
        .for('update');
      if (!locked || stateOf(locked, new Date()) !== 'open') throw unavailable();
      let guestId: string;
      let created = false;
      const [account] = await tx.select().from(principal).where(eq(principal.email, locked.email));
      if (account) {
        ensureSignedInAs(account, signedIn);
        guestId = account.id;
      } else {
        if (!passwordHash) throw unavailable();
        const [made] = await tx
          .insert(principal)
          .values({
            id: newId('own'),
            email: locked.email,
            passwordHash,
            kind: 'guest',
            displayName: name,
          })
          .onConflictDoNothing()
          .returning();
        // Someone made an account with this email a moment ago: they sign in first.
        if (!made) throw signInFirst();
        guestId = made.id;
        created = true;
      }
      const controls = await this.deps.principals.admitGuest(
        tx,
        locked.spaceId,
        guestId,
        locked.expiresAt,
      );
      await tx
        .update(roomInviteTable)
        .set({ redeemedAt: new Date(), principalId: guestId })
        .where(eq(roomInviteTable.id, locked.id));
      return { roomId: locked.spaceId, guestId, created, controls };
    });
    for (const control of result.controls) jobs.onCancelled?.(control.job_id);
    return { roomId: result.roomId, guestId: result.guestId, created: result.created };
  }
}

const signInFirst = () =>
  new ServiceError(
    'sign_in_first',
    'This email already has an account. Sign in, then open the link again.',
    409,
  );

/** An invite reaches an account that exists only when that very guest account is signed in. */
function ensureSignedInAs(
  account: { id: string; kind: string },
  signedIn: { id: string; kind: string } | null,
) {
  if (account.kind !== 'guest')
    throw new ServiceError(
      'person_account',
      'This email has a full account here. Ask an owner of the room to add you.',
      409,
    );
  if (signedIn?.id !== account.id) throw signInFirst();
}

export function mountInvites(app: Hono, invites: InviteService, env: Env) {
  const actor = (c: Context) => c.get('owner').id;
  const param = (c: Context, name: string) => c.req.param(name) ?? '';
  app.get('/rooms/:id/invites', async (c) => c.json(await invites.list(param(c, 'id'), actor(c))));
  app.post('/rooms/:id/invites', async (c) => {
    const input = createRoomInviteRequest.parse(await c.req.json());
    return c.json(
      await invites.create(param(c, 'id'), actor(c), {
        email: input.email,
        days: input.expires_in_days,
      }),
      201,
    );
  });
  app.delete('/rooms/:id/invites/:inviteId', async (c) =>
    c.json(await invites.withdraw(param(c, 'id'), actor(c), param(c, 'inviteId'))),
  );
  app.post('/invites/view', async (c) => {
    const input = inviteViewRequest.parse(await c.req.json());
    return c.json(await invites.preview(input.token));
  });
  app.post('/invites/accept', async (c) => {
    const input = acceptInviteRequest.parse(await c.req.json());
    // A public route: the session, when there is one, is read here.
    const cookie = getCookie(c, SESSION_COOKIE);
    const session = cookie ? await activeSession(invites.deps.db, cookie) : undefined;
    const signedIn = session ? { id: session.owner.id, kind: session.owner.kind } : null;
    const accepted = await invites.accept(input, signedIn);
    if (accepted.created) await startSession(c, invites.deps.db, env, accepted.guestId);
    return c.json(acceptInviteResponse.parse({ room_id: accepted.roomId }));
  });
}
