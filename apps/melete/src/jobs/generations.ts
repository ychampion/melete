import { type ContextGenerations, contextGenerations } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { connection, space } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

export async function readGenerations(
  tx: Transaction,
  spaceId: string,
  lockedPolicyGeneration?: number,
): Promise<ContextGenerations> {
  // A caller holding the space row's share lock can reuse its policy version.
  const [parent] =
    lockedPolicyGeneration === undefined
      ? await tx.select().from(space).where(eq(space.id, spaceId))
      : [{ policyGeneration: lockedPolicyGeneration }];
  if (!parent) throw new ServiceError('not_found', 'Space not found.', 404);
  const connections = await tx
    .select({ id: connection.id, generation: connection.generation })
    .from(connection)
    .where(and(eq(connection.spaceId, spaceId), eq(connection.status, 'active')));
  return {
    policy_generation: parent.policyGeneration,
    connection_generations: Object.fromEntries(connections.map((row) => [row.id, row.generation])),
  };
}

export async function requireGenerations(
  tx: Transaction,
  spaceId: string,
  expected: ContextGenerations,
  lockedPolicyGeneration?: number,
) {
  const current = await readGenerations(tx, spaceId, lockedPolicyGeneration);
  assertGenerations(expected, current);
  return current;
}

/** Compare every attempt's own snapshot, even when its current policy was already read. */
export function assertGenerations(expected: ContextGenerations, current: ContextGenerations) {
  const parsed = contextGenerations.safeParse(expected);
  if (
    !parsed.success ||
    current.policy_generation !== parsed.data.policy_generation ||
    Object.entries(parsed.data.connection_generations).some(
      ([id, generation]) => current.connection_generations[id] !== generation,
    )
  )
    throw new ServiceError(
      'context_invalidated',
      'Account or policy context changed; start a fresh attempt.',
    );
}

/**
 * A locked authority row supplies current policy. Empty connection snapshots
 * constrain no connections: newly active rows were already ignored by the
 * subset comparison. Nonempty snapshots still read current connections on
 * every call, including changes made outside event-order transactions.
 */
export async function assertCurrentGenerations(
  tx: Transaction,
  spaceId: string,
  expected: ContextGenerations,
  lockedPolicyGeneration: number,
): Promise<void> {
  const parsed = contextGenerations.safeParse(expected);
  if (!parsed.success || parsed.data.policy_generation !== lockedPolicyGeneration)
    throw new ServiceError(
      'context_invalidated',
      'Account or policy context changed; start a fresh attempt.',
    );
  if (!Object.keys(parsed.data.connection_generations).length) return;
  assertGenerations(parsed.data, await readGenerations(tx, spaceId, lockedPolicyGeneration));
}
