import { join } from 'node:path';
import {
  type ContextInvalidated,
  isTerminal,
  type JobState,
  spaceMembership as membershipContract,
} from '@melete/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { job, owner, principal, space, spaceMembership, trigger } from '../db/schema.ts';
import { serviceTransaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { PolicyService } from '../jobs/policy.ts';
import type { JobService } from '../jobs/service.ts';
import { spaceAuthority } from './authority.ts';

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
      return { id: created.id, email: created.email, created_at: created.createdAt.toISOString() };
    });
  }

  async createShared(actor: string, name: string) {
    return serviceTransaction(this.db, async (tx) => {
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
        })
        .returning();
      await tx.insert(spaceMembership).values({ principalId: actor, spaceId: id, role: 'owner' });
      return created;
    });
  }

  async grant(actor: string, spaceId: string, memberId: string) {
    return serviceTransaction(this.db, async (tx) => {
      await tx.select({ id: space.id }).from(space).where(eq(space.id, spaceId)).for('update');
      const access = await spaceAuthority(tx, spaceId, actor, true);
      if (access.space.kind !== 'shared' || access.role !== 'owner')
        throw new ServiceError(
          'scope_denied',
          'Only a shared-space owner manages membership.',
          403,
        );
      const [target] = await tx.select().from(principal).where(eq(principal.id, memberId));
      if (!target) throw new ServiceError('not_found', 'Principal not found.', 404);
      const [existing] = await tx
        .select()
        .from(spaceMembership)
        .where(
          and(eq(spaceMembership.spaceId, spaceId), eq(spaceMembership.principalId, memberId)),
        );
      if (existing && !existing.revokedAt) return membershipView(existing);
      const [row] = await tx
        .insert(spaceMembership)
        .values({ spaceId, principalId: memberId, role: 'member' })
        .onConflictDoUpdate({
          target: [spaceMembership.principalId, spaceMembership.spaceId],
          set: { generation: sql`${spaceMembership.generation} + 1`, revokedAt: null },
        })
        .returning();
      if (!row) throw new Error('Membership insert returned no row');
      return membershipView(row);
    });
  }

  async revoke(actor: string, spaceId: string, memberId: string) {
    const jobs = this.jobs;
    if (!jobs) throw new ServiceError('service_unavailable', 'Configure the job service.', 503);
    const result = await jobs.transaction(async (tx) => {
      await tx.select({ id: space.id }).from(space).where(eq(space.id, spaceId)).for('update');
      const access = await spaceAuthority(tx, spaceId, actor, true);
      if (access.space.kind !== 'shared' || access.role !== 'owner' || access.ownerId === memberId)
        throw new ServiceError('scope_denied', 'A shared-space owner may revoke a member.', 403);
      const [existing] = await tx
        .select()
        .from(spaceMembership)
        .where(and(eq(spaceMembership.spaceId, spaceId), eq(spaceMembership.principalId, memberId)))
        .for('update');
      if (!existing) throw new ServiceError('not_found', 'Membership not found.', 404);
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
      const generation = access.space.policyGeneration + 1;
      await tx.update(space).set({ policyGeneration: generation }).where(eq(space.id, spaceId));
      // Memory caches and prepared outputs carry the same revoked access fence.
      await tx.execute(
        sql`update memory_spaces set policy_generation = policy_generation + 1, access_generation = access_generation + 1 where space_id = ${spaceId}`,
      );
      await tx.execute(
        sql`update memory_contexts set invalidated_at = now(), items = '[]'::jsonb where space_id = ${spaceId} and invalidated_at is null`,
      );
      await tx.execute(
        sql`update memory_prepared set stale = true, content = null where space_id = ${spaceId}`,
      );
      const controls = await new PolicyService(jobs).invalidateInTransaction(
        tx,
        spaceId,
        generation,
        null,
        'policy_changed',
      );
      const affected = await tx
        .select()
        .from(job)
        .where(and(eq(job.spaceId, spaceId), eq(job.principalId, memberId)))
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
