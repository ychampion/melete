import { join } from 'node:path';
import { ID_PREFIXES } from '@melete/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { principal, space } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { spaceAuthority } from './authority.ts';

/** The one space a request speaks for, already authorized for its principal. */
export type SessionSpace = {
  spaceId: string;
  kind: 'personal' | 'shared';
  role: 'owner' | 'member';
  generation: number;
  /** True when this very request is what brought the space into being. */
  created: boolean;
};

/**
 * Whether the session owns the space it speaks for. Only `owner` does: a
 * member, a guest, any role added later, and a request with no selected space
 * at all are each refused an owner's surface. Ask this rather than whether
 * the role is `member`, so a new role is never taken for an owner.
 */
export function ownsSessionSpace(session: Pick<SessionSpace, 'role'> | undefined): boolean {
  return session?.role === 'owner';
}

/** A space the session named earlier, with the membership generation it was chosen under. */
export type SpaceSelection = { spaceId: string; generation: number | null };

async function ownPersonalSpace(
  db: Pick<Database, 'select'>,
  principalId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: space.id })
    .from(space)
    .where(
      and(
        eq(space.kind, 'personal'),
        // A personal space that names no owner predates accounts and is the setup owner's.
        sql`coalesce(${space.ownerPrincipalId}, (select id from owner limit 1)) = ${principalId}`,
      ),
    )
    .orderBy(space.createdAt, space.id)
    .limit(1);
  return row?.id;
}

/**
 * Every account has exactly one place of its own. An account created before
 * personal spaces were provisioned gets one on first use; the account row is
 * locked while it is made, so concurrent first requests agree on one space.
 */
export async function ensurePersonalSpace(
  db: Database,
  principalId: string,
  spacesRoot: string,
): Promise<{ spaceId: string; created: boolean }> {
  // Only a person has a place of their own. A guest uses only the rooms they
  // were invited to, and a room's own principal owns nothing. An account's
  // kind never changes, so it is read once, before anything is locked.
  const [account] = await db
    .select({ kind: principal.kind })
    .from(principal)
    .where(eq(principal.id, principalId));
  if (!account) throw new ServiceError('unauthorized', 'A session is required.', 401);
  if (account.kind !== 'person')
    throw new ServiceError(
      'guests_use_rooms',
      'A guest account uses only the rooms it was invited to.',
      403,
    );
  const existing = await ownPersonalSpace(db, principalId);
  if (existing) return { spaceId: existing, created: false };
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.id, principalId))
      .for('update');
    if (!locked) throw new ServiceError('unauthorized', 'A session is required.', 401);
    const raced = await ownPersonalSpace(tx, principalId);
    if (raced) return { spaceId: raced, created: false };
    const id = newId(ID_PREFIXES.space);
    await tx.insert(space).values({
      id,
      name: 'Personal',
      kind: 'personal',
      audience: 'owner',
      ownerPrincipalId: principalId,
      gitPath: join(spacesRoot, id),
    });
    return { spaceId: id, created: true };
  });
}

/**
 * The selected space itself, while the principal may still use it (for a
 * shared space, under the membership generation it was chosen with), or
 * undefined. Nothing falls back: a grant made for one space is never answered
 * in another.
 */
export async function selectedSpace(
  db: Database,
  principalId: string,
  selection: SpaceSelection,
): Promise<SessionSpace | undefined> {
  try {
    const access = await spaceAuthority(db, selection.spaceId, principalId);
    const kind = access.space.kind === 'shared' ? 'shared' : 'personal';
    if (kind === 'shared' && access.generation !== selection.generation) return undefined;
    // Only an owner or a member works in a selected space; any other role
    // (a room's own principal) is treated as no selection.
    if (access.role !== 'owner' && access.role !== 'member') return undefined;
    return {
      spaceId: selection.spaceId,
      kind,
      role: access.role,
      generation: access.generation,
      created: false,
    };
  } catch (error) {
    if (error instanceof ServiceError) return undefined;
    throw error;
  }
}

/**
 * The space comes from the authenticated principal and from nothing else. A
 * stored selection holds only while the principal may still use that space, and
 * for a shared space only under the membership generation it was chosen with:
 * a revocation ends it and a later regrant does not revive it. Whatever fails
 * falls back to the principal's own personal space, never to another account's.
 */
export async function resolveSessionSpace(
  db: Database,
  spacesRoot: string,
  principalId: string,
  selection: SpaceSelection | null,
): Promise<SessionSpace> {
  const selected = selection ? await selectedSpace(db, principalId, selection) : undefined;
  if (selected) return selected;
  const personal = await ensurePersonalSpace(db, principalId, spacesRoot);
  return {
    spaceId: personal.spaceId,
    kind: 'personal',
    role: 'owner',
    generation: 0,
    created: personal.created,
  };
}
