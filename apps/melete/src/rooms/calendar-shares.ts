/**
 * A room can reach a personal calendar only through its member's current
 * consent. This does not grant the room the connection itself: its tools use
 * this boundary again for every read and every approved event addition.
 */
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import type { Database } from '../db/client.ts';
import { connection, principal, space, spaceMembership } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { roomCalendarShare } from './schema.ts';

type Reader = Pick<Transaction, 'select'>;
type Share = typeof roomCalendarShare.$inferSelect;
type Connection = typeof connection.$inferSelect;
export type RoomCalendarShareMode = 'freebusy' | 'freebusy_add';

const unavailable = () =>
  new BrokerFault('scope_denied', 'That member has not shared a calendar for this action.');

/** Stored Google, Outlook and ICS calendars all use the caldav provider. */
export function calendarCanAdd(row: Connection): boolean {
  return (
    row.provider === 'caldav' &&
    row.configuration.kind !== 'ics' &&
    row.configuration.mode !== 'ics' &&
    row.scopes.includes('calendar.create')
  );
}

function isCalendar(row: Connection): boolean {
  return ['caldav', 'ics'].includes(row.provider) && row.scopes.includes('calendar.freebusy');
}

const shareView = (row: Share) => ({
  connection_id: row.connectionId,
  mode: row.mode,
  created_at: row.createdAt.toISOString(),
});

/** All authority is current, including the member's personal connection ownership. */
async function resolve(reader: Reader, roomId: string, memberId: string, write: boolean) {
  const [row] = await reader
    .select({ share: roomCalendarShare, connection })
    .from(roomCalendarShare)
    .innerJoin(
      spaceMembership,
      and(
        eq(spaceMembership.spaceId, roomCalendarShare.spaceId),
        eq(spaceMembership.principalId, roomCalendarShare.principalId),
        eq(spaceMembership.generation, roomCalendarShare.membershipGeneration),
      ),
    )
    .innerJoin(principal, eq(principal.id, roomCalendarShare.principalId))
    .innerJoin(connection, eq(connection.id, roomCalendarShare.connectionId))
    .innerJoin(space, eq(space.id, connection.spaceId))
    .where(
      and(
        eq(roomCalendarShare.spaceId, roomId),
        eq(roomCalendarShare.principalId, memberId),
        isNull(roomCalendarShare.revokedAt),
        isNull(spaceMembership.revokedAt),
        inArray(spaceMembership.role, ['owner', 'member']),
        or(isNull(spaceMembership.expiresAt), gt(spaceMembership.expiresAt, sql`now()`)),
        eq(principal.kind, 'person'),
        isNull(principal.disabledAt),
        eq(space.kind, 'personal'),
        isNull(space.removedAt),
        sql`coalesce(${space.ownerPrincipalId}, (select id from owner limit 1)) = ${memberId}`,
        eq(connection.status, 'active'),
        eq(connection.setupState, 'connected'),
        isNull(connection.keyChange),
        sql`exists (select 1 from space room where room.id = ${roomId}
        and room.kind = 'shared' and room.removed_at is null)`,
      ),
    );
  if (
    !row ||
    !isCalendar(row.connection) ||
    (write && (row.share.mode !== 'freebusy_add' || !calendarCanAdd(row.connection)))
  )
    throw unavailable();
  return row;
}

/** The raw-SQL broker uses exactly the same boundary as the settings service. */
export async function resolveRoomCalendarShare(
  query: Query,
  roomSpaceId: string,
  memberPrincipalId: string,
  write = false,
): Promise<{ share: Share; connection: Connection }> {
  // A broker transaction is a TransactionSql, which cannot initialize a
  // Drizzle database (it has no pool parser options). Keep this read on that
  // transaction's own connection instead of opening another pool connection.
  type Selected = Omit<Connection, 'createdAt' | 'lastCheckedAt'> & {
    createdAt: Date | string;
    lastCheckedAt: Date | string | null;
    shareMode: Share['mode'];
    shareCreatedAt: Date | string;
    shareMembershipGeneration: number;
  };
  const [row] = await query<Selected[]>`select c.id, c.space_id as "spaceId", c.provider, c.label,
      c.secret_ref as "secretRef", c.scopes, c.configuration, c.setup_state as "setupState",
      c.status, c.key_change as "keyChange", c.generation, c.health,
      c.last_checked_at as "lastCheckedAt", c.shared_use as "sharedUse",
      c.watch_changes as "watchChanges", c.created_at as "createdAt",
      r.mode as "shareMode", r.created_at as "shareCreatedAt",
      r.membership_generation as "shareMembershipGeneration"
    from room_calendar_share r
    join space_membership m on m.space_id = r.space_id and m.principal_id = r.principal_id
      and m.generation = r.membership_generation
    join principal p on p.id = r.principal_id
    join connection c on c.id = r.connection_id
    join space personal on personal.id = c.space_id
    join space room on room.id = r.space_id
    where r.space_id = ${roomSpaceId} and r.principal_id = ${memberPrincipalId}
      and r.revoked_at is null and m.revoked_at is null and m.role in ('owner', 'member')
      and (m.expires_at is null or m.expires_at > now())
      and p.kind = 'person' and p.disabled_at is null
      and personal.kind = 'personal' and personal.removed_at is null
      and coalesce(personal.owner_principal_id, (select id from owner limit 1)) = ${memberPrincipalId}
      and c.status = 'active' and c.setup_state = 'connected' and c.key_change is null
      and room.kind = 'shared' and room.removed_at is null`;
  if (!row) throw unavailable();
  const { shareMode, shareCreatedAt, shareMembershipGeneration, ...rawConnection } = row;
  const owned: Connection = {
    ...rawConnection,
    createdAt: new Date(rawConnection.createdAt),
    lastCheckedAt: rawConnection.lastCheckedAt ? new Date(rawConnection.lastCheckedAt) : null,
  };
  if (!isCalendar(owned) || (write && (shareMode !== 'freebusy_add' || !calendarCanAdd(owned))))
    throw unavailable();
  return {
    connection: owned,
    share: {
      spaceId: roomSpaceId,
      principalId: memberPrincipalId,
      connectionId: owned.id,
      mode: shareMode,
      membershipGeneration: shareMembershipGeneration,
      createdAt: new Date(shareCreatedAt),
      revokedAt: null,
    },
  };
}

export class RoomCalendarShareService {
  constructor(readonly deps: { db: Database }) {}

  private async access(
    reader: Database | Transaction,
    roomId: string,
    actor: string,
    lock = false,
  ) {
    const access = await spaceAuthority(reader, roomId, actor, lock);
    if (access.space.kind !== 'shared' || access.role === 'agent')
      throw new ServiceError('scope_denied', 'You are not a member of that room.', 403);
    const [person] = await reader
      .select({ kind: principal.kind, disabledAt: principal.disabledAt })
      .from(principal)
      .where(eq(principal.id, actor));
    if (person?.kind !== 'person' || person.disabledAt)
      throw new ServiceError('scope_denied', 'Only a room member can share a calendar.', 403);
    return access;
  }

  async list(roomId: string, actor: string) {
    const access = await this.access(this.deps.db, roomId, actor);
    if (access.role === 'guest') return { share: null, connections: [] };
    const connections = await this.deps.db
      .select({ connection })
      .from(connection)
      .innerJoin(space, eq(space.id, connection.spaceId))
      .where(
        and(
          eq(space.kind, 'personal'),
          isNull(space.removedAt),
          sql`coalesce(${space.ownerPrincipalId}, (select id from owner limit 1)) = ${actor}`,
          eq(connection.status, 'active'),
          eq(connection.setupState, 'connected'),
          isNull(connection.keyChange),
        ),
      )
      .orderBy(asc(connection.label), asc(connection.id));
    const shared = await resolve(this.deps.db, roomId, actor, false).catch((error: unknown) => {
      if (error instanceof BrokerFault) return null;
      throw error;
    });
    return {
      share: shared ? shareView(shared.share) : null,
      connections: connections
        .map(({ connection: row }) => row)
        .filter(isCalendar)
        .map((row) => ({ id: row.id, label: row.label, can_add: calendarCanAdd(row) })),
    };
  }

  async put(roomId: string, actor: string, connectionId: string, mode: RoomCalendarShareMode) {
    return serviceTransaction(this.deps.db, async (tx) => {
      const access = await this.access(tx, roomId, actor, true);
      if (!['owner', 'member'].includes(access.role))
        throw new ServiceError('scope_denied', 'Only a room member can share a calendar.', 403);
      const [row] = await tx
        .select()
        .from(connection)
        .where(eq(connection.id, connectionId))
        .for('share');
      if (!row) throw new ServiceError('scope_denied', 'Choose a calendar in your own space.', 403);
      const own = await spaceAuthority(tx, row.spaceId, actor, true);
      if (
        own.space.kind !== 'personal' ||
        own.ownerId !== actor ||
        !isCalendar(row) ||
        row.status !== 'active' ||
        row.setupState !== 'connected' ||
        row.keyChange ||
        (mode === 'freebusy_add' && !calendarCanAdd(row))
      )
        throw new ServiceError(
          'scope_denied',
          'Choose an available calendar in your own space.',
          403,
        );
      const [previous] = await tx
        .select({ createdAt: roomCalendarShare.createdAt })
        .from(roomCalendarShare)
        .where(and(eq(roomCalendarShare.spaceId, roomId), eq(roomCalendarShare.principalId, actor)))
        .for('update');
      const values = {
        spaceId: roomId,
        principalId: actor,
        connectionId,
        mode,
        membershipGeneration: access.generation,
        // Every consent is distinct, even two changes within one millisecond.
        createdAt: new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1)),
        revokedAt: null,
      };
      const [share] = await tx
        .insert(roomCalendarShare)
        .values(values)
        .onConflictDoUpdate({
          target: [roomCalendarShare.spaceId, roomCalendarShare.principalId],
          set: values,
        })
        .returning();
      if (!share) throw new Error('Calendar share insert returned no row');
      return { share: shareView(share) };
    });
  }

  async revoke(roomId: string, actor: string) {
    return serviceTransaction(this.deps.db, async (tx) => {
      await this.access(tx, roomId, actor, true);
      await tx
        .update(roomCalendarShare)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(roomCalendarShare.spaceId, roomId), eq(roomCalendarShare.principalId, actor)),
        );
      return { revoked: true as const };
    });
  }
}
