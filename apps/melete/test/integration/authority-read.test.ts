import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { TransactionSql } from 'postgres';
import { ServiceError } from '../../src/api/errors.ts';
import { owner, principal, schema, space, spaceMembership } from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { newId } from '../../src/ids.ts';
import { SPACE_BEING_CLEARED, spaceAuthority } from '../../src/principals/authority.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const suite = handle ? describe : describe.skip;

suite('space authority reads', () => {
  const { db, sql: query } = handle ?? ({} as NonNullable<typeof handle>);
  const installationId = newId('own');
  const personalOwnerId = newId('own');
  const memberId = newId('own');
  beforeAll(async () => {
    await db.insert(principal).values(
      [installationId, personalOwnerId, memberId].map((id) => ({
        id,
        email: `authority-${id}@example.test`,
      })),
    );
    await db
      .insert(owner)
      .values({ id: installationId, email: `authority-${installationId}@example.test` });
  });
  afterAll(() => handle?.close());

  async function parent(kind = 'personal', ownerPrincipalId: string | null = null) {
    const id = newId('sp');
    await db.insert(space).values({
      id,
      kind,
      ownerPrincipalId,
      name: 'Authority',
      gitPath: `/spaces/${id}`,
    });
    return id;
  }

  async function denied(operation: Promise<unknown>, message?: string) {
    const error = await operation.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('scope_denied');
    if (message) expect((error as ServiceError).message).toBe(message);
  }

  async function blockedBy(pid: number, blocker: number) {
    const until = Date.now() + 5000;
    do {
      const [row] =
        await query`select ${blocker}::int = any(pg_blocking_pids(${pid}::int)) as blocked`;
      if (row?.blocked) return;
      await Bun.sleep(10);
    } while (Date.now() < until);
    throw new Error('The authority share lock did not block the change.');
  }

  async function behindAuthority(
    spaceId: string,
    actor: string,
    change: (tx: TransactionSql) => Promise<unknown>,
  ) {
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<number>();
    const holder = serviceTransaction(db, async (tx) => {
      await spaceAuthority(tx, spaceId, actor, true);
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      held.resolve(Number(row?.pid));
      await release.promise;
    });
    let mutation: Promise<unknown> | undefined;
    try {
      const blocker = await held.promise;
      mutation = query.begin(async (tx) => {
        const [row] = await tx`select pg_backend_pid() as pid`;
        started.resolve(Number(row?.pid));
        await change(tx);
      });
      await blockedBy(await started.promise, blocker);
    } finally {
      release.resolve();
      await holder;
      await mutation;
    }
  }

  test('legacy personal authority reads the space and fallback owner in one statement', async () => {
    const id = await parent();
    const statements: string[] = [];
    const logged = drizzle(query, {
      schema,
      logger: { logQuery: (statement) => statements.push(statement) },
    });
    const access = await serviceTransaction(logged, (tx) =>
      spaceAuthority(tx, id, installationId, true),
    );
    expect(access.space.id).toBe(id);
    expect(access.ownerId).toBe(installationId);
    expect(access.principalId).toBe(installationId);
    expect(access.role).toBe('owner');
    const authorityReads = statements.filter(
      (statement) =>
        /^\s*select\b/i.test(statement) && !statement.includes('pg_advisory_xact_lock'),
    );
    expect(authorityReads).toHaveLength(1);
    expect(authorityReads[0]).toContain('for share');
  });

  test('the space share lock fences removal until the authorized transaction commits', async () => {
    const id = await parent();
    await behindAuthority(id, installationId, async (tx) => {
      await tx`update space set removed_at = now() where id = ${id}`;
    });
    await denied(
      serviceTransaction(db, (tx) => spaceAuthority(tx, id, installationId, true)),
      SPACE_BEING_CLEARED,
    );
  });

  test('explicit personal ownership takes precedence over the installation owner', async () => {
    const id = await parent('personal', personalOwnerId);
    const access = await spaceAuthority(db, id, personalOwnerId);
    expect(access.ownerId).toBe(personalOwnerId);
    expect(access.principalId).toBe(personalOwnerId);
    expect((await spaceAuthority(db, id)).principalId).toBe(personalOwnerId);
    await denied(spaceAuthority(db, id, installationId));
    await denied(spaceAuthority(db, id, memberId));
    await denied(spaceAuthority(db, await parent(), personalOwnerId));
    await denied(spaceAuthority(db, newId('sp'), installationId));
  });

  test('shared membership keeps its share lock, generation, revocation and expiry fences', async () => {
    const id = await parent('shared', personalOwnerId);
    await db.insert(spaceMembership).values({
      spaceId: id,
      principalId: memberId,
      role: 'member',
      generation: 4,
    });
    const access = await spaceAuthority(db, id, memberId);
    expect(access.ownerId).toBe(personalOwnerId);
    expect(access.principalId).toBe(memberId);
    expect(access.role).toBe('member');
    expect(access.generation).toBe(4);
    await denied(spaceAuthority(db, id, personalOwnerId));
    await denied(spaceAuthority(db, id, installationId));
    await behindAuthority(id, memberId, async (tx) => {
      await tx`update space_membership set revoked_at = now(), generation = 5
        where space_id = ${id} and principal_id = ${memberId}`;
    });
    await denied(spaceAuthority(db, id, memberId));
    const membership = and(
      eq(spaceMembership.spaceId, id),
      eq(spaceMembership.principalId, memberId),
    );
    await db
      .update(spaceMembership)
      .set({ revokedAt: null, expiresAt: new Date(Date.now() - 60_000), generation: 6 })
      .where(membership);
    await denied(spaceAuthority(db, id, memberId));
    await db.update(spaceMembership).set({ expiresAt: null, generation: 7 }).where(membership);
    expect(
      (await serviceTransaction(db, (tx) => spaceAuthority(tx, id, memberId, true))).generation,
    ).toBe(7);
  });
});
