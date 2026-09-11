import { type ContextGenerations, contextGenerations } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { connection, space } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

export async function readGenerations(
  tx: Transaction,
  spaceId: string,
): Promise<ContextGenerations> {
  const [parent] = await tx.select().from(space).where(eq(space.id, spaceId));
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
) {
  const parsed = contextGenerations.safeParse(expected);
  const current = await readGenerations(tx, spaceId);
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
  return current;
}
