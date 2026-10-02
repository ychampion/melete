import { join } from 'node:path';
import {
  type ContextInvalidated,
  isTerminal,
  type JobState,
  spaceMembership as membershipContract,
} from '@melete/contracts';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import {
  experienceTurn,
  job,
  owner,
  principal,
  space,
  spaceMembership,
  trigger,
} from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { PolicyService } from '../jobs/policy.ts';
import type { JobService } from '../jobs/service.ts';
import { principalContext, spaceAuthority } from './authority.ts';

export const membershipView = (row: typeof spaceMembership.$inferSelect) =>
  membershipContract.parse({
    principal_id: row.principalId,
    space_id: row.spaceId,
    role: row.role,
    generation: row.generation,
    revoked_at: row.revokedAt?.toISOString() ?? null,
  });

export class PrincipalService {
  constructor(
    readonly db: Database,
    readonly spacesRoot: string,
    readonly jobs?: JobService,
  ) {}

  async create(actor: string, email: string, password: string) {
    const [installation] = await this.db.select().from(owner).limit(1);
    if (installation?.id !== actor)
      throw new ServiceError('scope_denied', 'Only the setup owner can provision an account.', 403);
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    return serviceTransaction(this.db, async (tx) => {
      const [created] = await tx
        .insert(principal)
        .values({ id: newId('own'), email: email.toLowerCase(), passwordHash })
        .onConflictDoNothing()
        .returning();
      if (!created)
        throw new ServiceError('principal_exists', 'An account already uses that email.', 409);
      const spaceId = newId('sp');
      await tx.insert(space).values({
        id: spaceId,
        name: 'Personal',
        ownerPrincipalId: created.id,
        gitPath: join(this.spacesRoot, spaceId),
      });
      return {
        principal: {
          id: created.id,
          email: created.email,
          created_at: created.createdAt.toISOString(),
        },
        /** The account's own place, so a caller can furnish exactly it. */
        spaceId,
      };
    });
  }

  /**
   * A shared space is a room. Its creator owns it, and it gets its own
   * principal, which its agent acts as: no password, never listed, and a
   * membership whose generation is the room's roster generation.
   */
  async createShared(actor: string, name: string, purpose?: string | null) {
    return serviceTransaction(this.db, async (tx) => {
      const [creator] = await tx
        .select({ kind: principal.kind })
        .from(principal)
        .where(eq(principal.id, actor));
      if (creator?.kind !== 'person')
        throw new ServiceError('scope_denied', 'Only a person can make a room.', 403);
      const id = newId('sp');
      const [created] = await tx
        .insert(space)
        .values({
          id,
          name,
          kind: 'shared',
          audience: 'space',
          ownerPrincipalId: actor,
          gitPath: join(this.spacesRoot, id),
          purpose: purpose?.trim() || null,
        })
        .returning();
      await tx.insert(spaceMembership).values({ principalId: actor, spaceId: id, role: 'owner' });
      const roomPrincipal = newId('own');
      await tx.insert(principal).values({
        id: roomPrincipal,
        email: roomPrincipalEmail(id),
        kind: 'room',
        displayName: name,
      });
      await tx
        .insert(spaceMembership)
        .values({ principalId: roomPrincipal, spaceId: id, role: 'agent' });
      return created;
    });
  }

  async grant(actor: string, spaceId: string, memberId: string) {
    const jobs = this.jobs;
    const result = await serviceTransaction(this.db, async (tx) => {
      await tx.select({ id: space.id }).from(space).where(eq(space.id, spaceId)).for('update');
      const access = await spaceAuthority(tx, spaceId, actor, true);
      if (access.space.kind !== 'shared' || access.role !== 'owner')
        throw new ServiceError(
          'scope_denied',
          'Only a shared-space owner manages membership.',
          403,
        );
      const [target] = await tx.select().from(principal).where(eq(principal.id, memberId));
      // A room's own principal, or any account that is not a person, is never added.
      if (target?.kind !== 'person')
        throw new ServiceError('not_found', 'Principal not found.', 404);
      const [existing] = await tx
        .select()
        .from(spaceMembership)
        .where(
          and(eq(spaceMembership.spaceId, spaceId), eq(spaceMembership.principalId, memberId)),
        );
      if (existing && !existing.revokedAt)
        return { membership: membershipView(existing), controls: [] as ContextInvalidated[] };
      const [row] = await tx
        .insert(spaceMembership)
        .values({ spaceId, principalId: memberId, role: 'member' })
        .onConflictDoUpdate({
          target: [spaceMembership.principalId, spaceMembership.spaceId],
          set: { generation: sql`${spaceMembership.generation} + 1`, revokedAt: null },
        })
        .returning();
      if (!row) throw new Error('Membership insert returned no row');
      // Who can read the room changed, so work in flight starts again with the new roster.
      const controls = await fenceRoster(tx, spaceId, access.space.policyGeneration + 1, jobs);
      return { membership: membershipView(row), controls };
    });
    for (const control of result.controls) jobs?.onCancelled?.(control.job_id);
    return result.membership;
  }

  /**
   * End a membership: an owner removes a member, or a member leaves. The space's
   * owner cannot be removed, and a room's own principal is not a member to remove.
   */
  async revoke(actor: string, spaceId: string, memberId: string) {
    const jobs = this.jobs;
    if (!jobs) throw new ServiceError('service_unavailable', 'Configure the job service.', 503);
    const result = await jobs.transaction(async (tx) => {
      await tx.select({ id: space.id }).from(space).where(eq(space.id, spaceId)).for('update');
      const access = await spaceAuthority(tx, spaceId, actor, true);
      const leaving = actor === memberId && access.role !== 'agent';
      if (
        access.space.kind !== 'shared' ||
        (access.role !== 'owner' && !leaving) ||
        access.ownerId === memberId
      )
        throw new ServiceError('scope_denied', 'A shared-space owner may revoke a member.', 403);
      const [existing] = await tx
        .select()
        .from(spaceMembership)
        .where(and(eq(spaceMembership.spaceId, spaceId), eq(spaceMembership.principalId, memberId)))
        .for('update');
      if (!existing || existing.role === 'agent')
        throw new ServiceError('not_found', 'Membership not found.', 404);
      if (existing.revokedAt)
        return {
          membership: membershipView(existing),
          controls: [] as ContextInvalidated[],
          cancelled: [] as string[],
          policy_generation: access.space.policyGeneration,
        };
      const [updated] = await tx
        .update(spaceMembership)
        .set({ revokedAt: new Date(), generation: existing.generation + 1 })
        .where(and(eq(spaceMembership.spaceId, spaceId), eq(spaceMembership.principalId, memberId)))
        .returning();
      // An assistant the member connected from this space loses it with them.
      await tx.execute(
        sql`delete from mcp_authorization where space_id = ${spaceId} and principal_id = ${memberId}`,
      );
      await tx.execute(
        sql`delete from mcp_token where space_id = ${spaceId} and principal_id = ${memberId}`,
      );
      const generation = access.space.policyGeneration + 1;
      // The copies of what memory handed the member's own actions, kept to say
      // why each was taken, go with the access.
      await tx.execute(
        sql`update memory_action_basis b set items = '[]'::jsonb from job j
          where b.space_id = ${spaceId} and j.id = b.job_id and j.principal_id = ${memberId}`,
      );
      // The fence is the service's own work, already authorized above: someone
      // leaving is no longer in the space whose work it fences.
      const controls = await principalContext.exit(() =>
        fenceRoster(tx, spaceId, generation, jobs),
      );
      // The member's own jobs end with their access, and so do the requests
      // they asked of the room: only the person who asked a request answers it,
      // so one whose asker has gone would wait for ever.
      const affected = await tx
        .select()
        .from(job)
        .where(
          and(
            eq(job.spaceId, spaceId),
            or(
              eq(job.principalId, memberId),
              and(eq(job.audience, 'room'), eq(job.requestedByPrincipalId, memberId)),
            ),
          ),
        )
        .orderBy(job.id);
      const cancelled: string[] = [];
      for (const row of affected) {
        if (isTerminal(row.state as JobState)) continue;
        await jobs.move(
          tx,
          row,
          { kind: 'cancelled' },
          { payload: { reason: 'membership_revoked' } },
        );
        await tx.update(trigger).set({ enabled: false }).where(eq(trigger.jobId, row.id));
        // A conversation's turn in flight ends with it, rather than reading as
        // still working once nobody can carry it on.
        if (row.currentTurnId)
          await tx
            .update(experienceTurn)
            .set({ status: 'stopped', finishedAt: new Date() })
            .where(
              and(
                eq(experienceTurn.id, row.currentTurnId),
                inArray(experienceTurn.status, ['queued', 'working', 'streaming']),
              ),
            );
        cancelled.push(row.id);
      }
      if (!updated) throw new Error('Locked membership disappeared');
      return {
        membership: membershipView(updated),
        controls,
        cancelled,
        policy_generation: generation,
      };
    });
    // Database fencing is authoritative even when no local runner is attached.
    for (const id of result.cancelled) jobs.onCancelled?.(id);
    for (const control of result.controls) jobs.onCancelled?.(control.job_id);
    return { membership: result.membership, policy_generation: result.policy_generation };
  }
}

/** The address a room principal is created with: `.invalid` is never routable (RFC 2606). */
export const roomPrincipalEmail = (spaceId: string) => `${spaceId.toLowerCase()}@room.invalid`;

/**
 * A shared space's roster changed. Everything read or prepared under the old
 * roster is fenced: the space's policy generation and memory caches move on,
 * work in flight starts again with fresh context, and the room principal's
 * generation (the room's roster generation) moves, so a capability minted for
 * the old roster is refused at the broker.
 */
async function fenceRoster(
  tx: Transaction,
  spaceId: string,
  generation: number,
  jobs?: JobService,
): Promise<ContextInvalidated[]> {
  await tx.update(space).set({ policyGeneration: generation }).where(eq(space.id, spaceId));
  await tx
    .update(spaceMembership)
    .set({ generation: sql`${spaceMembership.generation} + 1` })
    .where(and(eq(spaceMembership.spaceId, spaceId), eq(spaceMembership.role, 'agent')));
  // Memory caches and prepared outputs carry the same access fence.
  await tx.execute(
    sql`update memory_spaces set policy_generation = policy_generation + 1, access_generation = access_generation + 1 where space_id = ${spaceId}`,
  );
  await tx.execute(
    sql`update memory_contexts set invalidated_at = now(), items = '[]'::jsonb where space_id = ${spaceId} and invalidated_at is null`,
  );
  await tx.execute(
    sql`update memory_prepared set stale = true, content = null where space_id = ${spaceId}`,
  );
  return jobs
    ? new PolicyService(jobs).invalidateInTransaction(
        tx,
        spaceId,
        generation,
        null,
        'policy_changed',
      )
    : [];
}
