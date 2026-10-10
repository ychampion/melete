import { join } from 'node:path';
import {
  type ContextInvalidated,
  isTerminal,
  type JobState,
  spaceMembership as membershipContract,
} from '@melete/contracts';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import {
  attempt,
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
      return this.endMembership(tx, jobs, spaceId, memberId, access.space.policyGeneration);
    });
    settled(jobs, result);
    return { membership: result.membership, policy_generation: result.policy_generation };
  }

  /**
   * End one membership, already authorized by the caller, inside its
   * transaction, with the space row locked: the membership is revoked, the
   * roster is fenced, and the work the person started there, or asked of the
   * room, ends with their access.
   */
  private async endMembership(
    tx: Transaction,
    jobs: JobService,
    spaceId: string,
    memberId: string,
    policyGeneration: number,
  ) {
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
        policy_generation: policyGeneration,
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
    // A guest never holds an assistant grant; should one exist anywhere, it
    // goes with their place in the room.
    await tx.execute(
      sql`delete from mcp_authorization where principal_id = ${memberId}
        and exists (select 1 from principal p where p.id = ${memberId} and p.kind = 'guest')`,
    );
    await tx.execute(
      sql`delete from mcp_token where principal_id = ${memberId}
        and exists (select 1 from principal p where p.id = ${memberId} and p.kind = 'guest')`,
    );
    // What Melete kept for them in this space goes with their place in it:
    // the deadlines it was keeping, what it noticed, and anything still
    // waiting to be pushed about it.
    await tx.execute(sql`update push_intent set dropped_at = now()
      where principal_id = ${memberId} and sent_at is null and dropped_at is null
        and situation_id in (select id from situation
          where space_id = ${spaceId} and principal_id = ${memberId})`);
    await tx.execute(
      sql`delete from situation where space_id = ${spaceId} and principal_id = ${memberId}`,
    );
    await tx.execute(
      sql`delete from clock where space_id = ${spaceId} and principal_id = ${memberId}`,
    );
    // What they asked Melete to see through here ends with their place in it.
    await tx.execute(
      sql`delete from intent where space_id = ${spaceId} and principal_id = ${memberId}`,
    );
    const generation = policyGeneration + 1;
    // The copies of what memory handed the member's own actions, kept to say
    // why each was taken, go with the access.
    await tx.execute(
      sql`update memory_action_basis b set items = '[]'::jsonb from job j
        where b.space_id = ${spaceId} and j.id = b.job_id and j.principal_id = ${memberId}`,
    );
    // The fence is the service's own work, already authorized above: someone
    // leaving is no longer in the space whose work it fences.
    const controls = await principalContext.exit(() => fenceRoster(tx, spaceId, generation, jobs));
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
    for (const listed of affected) {
      // A turn under way ends as Stop ends it, so the chat does not go on
      // showing it as working; then the job is cancelled and its attempts end.
      if (listed.kind === 'chat') await jobs.stopTurn?.(tx, listed);
      const [row] = await tx.select().from(job).where(eq(job.id, listed.id));
      if (!row || isTerminal(row.state as JobState)) continue;
      await jobs.move(
        tx,
        row,
        { kind: 'cancelled' },
        { payload: { reason: 'membership_revoked' } },
      );
      await tx.update(trigger).set({ enabled: false }).where(eq(trigger.jobId, row.id));
      await tx
        .update(attempt)
        .set({
          outcome: 'fenced',
          outcomeDetail: { kind: 'cancelled', reason: 'membership_revoked' },
          endedAt: new Date(),
          leaseExpiresAt: null,
          leaseStatus: 'ended',
        })
        .where(and(eq(attempt.jobId, row.id), isNull(attempt.endedAt)));
      // A conversation's turn in flight ends with it, rather than reading as
      // still working once nobody can carry it on.
      if (row.currentTurnId)
        await tx
          .update(experienceTurn)
          .set({ status: 'stopped', finishedAt: new Date() })
          .where(
            and(
              eq(experienceTurn.id, row.currentTurnId),
              inArray(experienceTurn.status, ['queued', 'working', 'streaming', 'stalled']),
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
  }

  /**
   * Give a guest their place in a room, until `expiresAt`, inside the caller's
   * transaction. Adding a guest changes who reads the room, so the roster is
   * fenced as for any other change: work in flight starts again, and details
   * shared for members only leave the agent's next attempt. Someone already in
   * the room as a member or owner stays as they are.
   */
  async admitGuest(
    tx: Transaction,
    spaceId: string,
    guestId: string,
    expiresAt: Date,
  ): Promise<ContextInvalidated[]> {
    const [parent] = await tx.select().from(space).where(eq(space.id, spaceId)).for('update');
    if (parent?.kind !== 'shared' || parent.removedAt)
      throw new ServiceError('not_found', 'That room is not here.', 404);
    const [guest] = await tx.select().from(principal).where(eq(principal.id, guestId));
    if (guest?.kind !== 'guest') throw new ServiceError('not_found', 'Principal not found.', 404);
    const [existing] = await tx
      .select()
      .from(spaceMembership)
      .where(and(eq(spaceMembership.spaceId, spaceId), eq(spaceMembership.principalId, guestId)))
      .for('update');
    if (existing && !existing.revokedAt && existing.role !== 'guest')
      throw new ServiceError('already_in_room', 'They are already in this room.', 409);
    await tx
      .insert(spaceMembership)
      .values({ spaceId, principalId: guestId, role: 'guest', expiresAt })
      .onConflictDoUpdate({
        target: [spaceMembership.principalId, spaceMembership.spaceId],
        set: {
          role: 'guest',
          expiresAt,
          revokedAt: null,
          generation: sql`${spaceMembership.generation} + 1`,
        },
      });
    return fenceRoster(tx, spaceId, parent.policyGeneration + 1, this.jobs);
  }

  /**
   * End every guest's place whose time is up, through the same path as a
   * removal. Each one is read again under the room's lock, so a guest whose
   * place was renewed a moment ago stays. Returns how many ended.
   */
  async expireGuests(now = new Date()): Promise<number> {
    const jobs = this.jobs;
    if (!jobs) return 0;
    const due = await this.db
      .select({ spaceId: spaceMembership.spaceId, principalId: spaceMembership.principalId })
      .from(spaceMembership)
      .where(
        and(
          eq(spaceMembership.role, 'guest'),
          isNull(spaceMembership.revokedAt),
          lte(spaceMembership.expiresAt, now),
        ),
      )
      .orderBy(spaceMembership.expiresAt);
    let ended = 0;
    for (const entry of due) {
      const result = await jobs
        .transaction(async (tx) => {
          const [parent] = await tx
            .select()
            .from(space)
            .where(eq(space.id, entry.spaceId))
            .for('update');
          // A room being removed ends everyone's place with it.
          if (!parent || parent.removedAt) return null;
          const [still] = await tx
            .select({ principalId: spaceMembership.principalId })
            .from(spaceMembership)
            .where(
              and(
                eq(spaceMembership.spaceId, entry.spaceId),
                eq(spaceMembership.principalId, entry.principalId),
                eq(spaceMembership.role, 'guest'),
                isNull(spaceMembership.revokedAt),
                lte(spaceMembership.expiresAt, now),
              ),
            );
          if (!still) return null;
          return this.endMembership(
            tx,
            jobs,
            entry.spaceId,
            entry.principalId,
            parent.policyGeneration,
          );
        })
        // One place that cannot be ended now is said, and tried again on the
        // next sweep; it never holds up the guests after it.
        .catch((error: unknown) => {
          process.stderr.write(
            `guest expiry: ${entry.principalId} in ${entry.spaceId} failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          return null;
        });
      if (!result) continue;
      settled(jobs, result);
      ended += 1;
    }
    return ended;
  }
}

/** Database fencing is authoritative even when no local runner is attached. */
function settled(
  jobs: JobService,
  result: { cancelled: string[]; controls: ContextInvalidated[] },
) {
  for (const id of result.cancelled) jobs.onCancelled?.(id);
  for (const control of result.controls) jobs.onCancelled?.(control.job_id);
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
