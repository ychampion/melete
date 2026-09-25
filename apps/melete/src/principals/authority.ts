import { AsyncLocalStorage } from 'node:async_hooks';
import type { CapabilityClaims } from '@melete/contracts';
import { and, eq, isNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { Sql, TransactionSql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { job, owner, space, spaceMembership } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

/** Request identity is server-owned and never populated from a request body or header. */
export const principalContext = new AsyncLocalStorage<string>();
export const requestPrincipal = () => principalContext.getStore();
type Reader = Database | Transaction;

export function visibleSpace(
  spaceId: SQLWrapper,
  principalId = requestPrincipal(),
): SQL | undefined {
  if (!principalId) return undefined; // Trusted internal service calls have their own capability fence.
  return sql`exists (select 1 from space authority_space where authority_space.id = ${spaceId} and
    ((authority_space.kind = 'personal' and coalesce(authority_space.owner_principal_id, (select id from owner limit 1)) = ${principalId})
    or (authority_space.kind = 'shared' and exists (select 1 from space_membership membership
      where membership.space_id = authority_space.id and membership.principal_id = ${principalId} and membership.revoked_at is null))))`;
}
export function visibleJob(jobId: SQLWrapper, principalId = requestPrincipal()): SQL | undefined {
  if (!principalId) return undefined;
  return sql`exists (select 1 from job authority_job where authority_job.id = ${jobId}
    and coalesce(authority_job.principal_id, (select id from owner limit 1)) = ${principalId}
    and ${visibleSpace(sql`authority_job.space_id`, principalId)})`;
}

/**
 * A job belongs to the principal it names; an unnamed job predates principals
 * and belongs to the setup owner. Membership of the job's space never widens
 * this: the caller has already been authorized for the space it selects.
 */
export function ownJob(
  principalColumn: SQLWrapper = job.principalId,
  principalId = requestPrincipal(),
): SQL | undefined {
  if (!principalId) return undefined;
  return sql`coalesce(${principalColumn}, (select id from owner limit 1)) = ${principalId}`;
}

/** The same ownership rule for hand-written queries that alias the job table. */
export function ownJobClause(
  query: Sql | TransactionSql,
  alias: string,
  principalId = requestPrincipal(),
) {
  return principalId
    ? query`and coalesce(${query(alias)}.principal_id, (select id from owner limit 1)) = ${principalId}`
    : query``;
}

/**
 * `visibleJob` for a hand-written transaction: the job is the principal's own,
 * in a space they can see. Read inside the transaction that acts on the job, so
 * a revoked membership cannot slip between the check and the change.
 */
export async function jobVisibleTo(
  query: Sql | TransactionSql,
  jobId: string,
  principalId: string,
): Promise<boolean> {
  const [row] = await query`select 1 from job j join space s on s.id = j.space_id
    where j.id = ${jobId}
      and coalesce(j.principal_id, (select id from owner limit 1)) = ${principalId}
      and ((s.kind = 'personal' and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId})
        or (s.kind = 'shared' and exists (select 1 from space_membership m
          where m.space_id = s.id and m.principal_id = ${principalId} and m.revoked_at is null)))`;
  return Boolean(row);
}

/** Private memory questions remain an owner surface inside a shared space. */
export function ownedSpace(spaceId: SQLWrapper, principalId = requestPrincipal()): SQL | undefined {
  if (!principalId) return undefined;
  return sql`exists (select 1 from space authority_space where authority_space.id = ${spaceId}
    and coalesce(authority_space.owner_principal_id, (select id from owner limit 1)) = ${principalId})`;
}

/**
 * The role `spaceAuthority` gives a principal, for code that holds a raw SQL
 * connection rather than the typed one: the owner of a personal space (the
 * installation's owner when the space predates principals), the membership role
 * in a shared space, and nothing for a space under removal or a principal it
 * does not admit. The two must agree; the broker's skill reads rely on it.
 */
export async function spaceRole(
  query: Sql | TransactionSql,
  spaceId: string,
  principalId: string | null,
): Promise<'owner' | 'member' | null> {
  const [parent] = await query`select kind, removed_at,
    coalesce(owner_principal_id, (select id from owner limit 1)) as owner_id
    from space where id = ${spaceId}`;
  if (!parent || parent.removed_at) return null;
  const actor = principalId ?? parent.owner_id ?? null;
  if (parent.kind === 'personal') return actor === parent.owner_id ? 'owner' : null;
  if (!actor) return null;
  const [membership] = await query`select role from space_membership
    where space_id = ${spaceId} and principal_id = ${actor} and revoked_at is null`;
  return membership ? (membership.role as 'owner' | 'member') : null;
}

/** What anyone asking a space under removal for anything is told. */
export const SPACE_BEING_CLEARED = 'This space is being cleared.';

/**
 * The same refusal when it comes from the database: every insert of new work,
 * a connection or a mailbox scan is refused there for a space under removal,
 * including the ones written as raw SQL that never pass through this module.
 */
export function refusedForRemoval(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause)
    if ((current as { code?: unknown }).code === 'P0001' && current.message === 'space_removed')
      return true;
  return false;
}

export async function spaceAuthority(
  db: Reader,
  spaceId: string,
  principalId?: string | null,
  lock = false,
) {
  const query = db.select().from(space).where(eq(space.id, spaceId));
  const [parent] = lock ? await query.for('share') : await query;
  if (!parent) throw new ServiceError('scope_denied', 'Space is not accessible.', 403);
  // A space under removal admits nothing, from anyone: not its owner, and not
  // the owner of a personal space whose emptying is waiting on something. The
  // removal's own routes answer from its record rather than from here.
  if (parent.removedAt) throw new ServiceError('scope_denied', SPACE_BEING_CLEARED, 403);
  const [installation] = parent.ownerPrincipalId
    ? []
    : await db.select({ id: owner.id }).from(owner).limit(1);
  const ownerId = parent.ownerPrincipalId ?? installation?.id ?? null;
  const actor = principalId ?? ownerId;
  if (parent.kind === 'personal') {
    if (actor !== ownerId) throw new ServiceError('scope_denied', 'Space is not accessible.', 403);
    return { space: parent, principalId: actor, ownerId, role: 'owner' as const, generation: 0 };
  }
  if (!actor) throw new ServiceError('scope_denied', 'Shared work requires a principal.', 403);
  const memberships = db
    .select()
    .from(spaceMembership)
    .where(
      and(
        eq(spaceMembership.spaceId, spaceId),
        eq(spaceMembership.principalId, actor),
        isNull(spaceMembership.revokedAt),
      ),
    );
  const [membership] = lock ? await memberships.for('share') : await memberships;
  if (!membership) throw new ServiceError('scope_denied', 'Space is not accessible.', 403);
  return {
    space: parent,
    principalId: actor,
    ownerId,
    role: membership.role as 'owner' | 'member',
    generation: membership.generation,
  };
}

export async function requireJobAccess(db: Reader, id: string, actor = requestPrincipal()) {
  const [row] = await db.select().from(job).where(eq(job.id, id));
  if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
  if (actor) {
    const access = await spaceAuthority(db, row.spaceId, actor);
    if ((row.principalId ?? access.ownerId) !== actor)
      throw new ServiceError('scope_denied', 'Job is not accessible.', 403);
  }
  return row;
}

export async function requirePrincipalCapability(
  tx: Transaction,
  row: typeof job.$inferSelect,
  claims: CapabilityClaims,
  legacyPersonal = false,
) {
  const access = await spaceAuthority(tx, row.spaceId, row.principalId, true);
  if (
    (row.principalId !== null &&
      claims.principal_id !== row.principalId &&
      !(legacyPersonal && access.space.kind === 'personal' && claims.principal_id === undefined)) ||
    (claims.principal_id !== undefined && claims.principal_id !== access.principalId) ||
    (access.space.kind === 'shared' &&
      (!claims.principal_id || claims.membership_generation !== access.generation))
  )
    throw new ServiceError(
      'scope_denied',
      'The capability no longer names current membership.',
      403,
    );
  return access;
}
