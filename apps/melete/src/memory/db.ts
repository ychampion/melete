import { createHash } from 'node:crypto';
import { type SpaceGeneration, spaceGeneration } from '@melete/contracts';
import type postgres from 'postgres';
import { ulid } from 'ulid';

export type MemorySql = ReturnType<typeof postgres>;
export type MemoryTx = postgres.TransactionSql;
/** Constructed by server authentication, never by parsing a model/request body. */
export type MemoryScope = {
  principalId?: string;
  membershipGeneration?: number;
  ownerId: string;
  spaceId: string;
  publisher: string;
  audience: 'private' | 'space' | 'public';
  role: 'owner' | 'reader';
};
export class MemoryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const newId = (prefix: string) => `${prefix}_${ulid()}`;
export const stableId = (...parts: (string | number)[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** A proposal and its eventual publication share one stable, contract-shaped identity. */
export function stableEntityId(prefix: string, ...parts: (string | number)[]) {
  let number = BigInt(`0x${stableId(...parts).slice(0, 32)}`);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let encoded = '';
  for (let i = 0; i < 26; i++) {
    encoded = alphabet[Number(number & 31n)] + encoded;
    number >>= 5n;
  }
  return `${prefix}_${encoded}`;
}
export const iso = (value: string | Date) => new Date(value).toISOString();
export const generation = (row: Record<string, unknown>): SpaceGeneration =>
  spaceGeneration.parse({
    space_id: row.space_id,
    policy_generation: row.policy_generation,
    data_revision: row.data_revision,
    access_generation: row.access_generation,
    eligibility_generation: row.eligibility_generation,
    restore_ready: row.restore_ready,
  });

export async function lockSpace(tx: MemoryTx, scope: MemoryScope, write = true) {
  if (scope.principalId) {
    const [parent] =
      await tx`select kind, owner_principal_id from space where id = ${scope.spaceId} for share`;
    const [membership] =
      await tx`select role, generation from space_membership where space_id = ${scope.spaceId} and principal_id = ${scope.principalId} and revoked_at is null for share`;
    const access = parent ? { ...parent, ...membership } : undefined;
    const isOwner = access?.owner_principal_id === scope.principalId;
    if (
      !access ||
      (access.kind === 'personal'
        ? !isOwner
        : !access.role || access.generation !== scope.membershipGeneration) ||
      (scope.role === 'owner' && !isOwner)
    )
      throw new MemoryError('scope_denied');
  }
  const [row] =
    await tx`select * from memory_spaces where space_id = ${scope.spaceId} and owner_id = ${scope.ownerId} for update`;
  if (!row || row.revoked || (write && scope.role !== 'owner'))
    throw new MemoryError('scope_denied');
  if (!row.restore_ready) throw new MemoryError('restore_pending');
  return row;
}
export async function bumpRevision(tx: MemoryTx, spaceId: string): Promise<number> {
  const [row] =
    await tx`update memory_spaces set data_revision = data_revision + 1 where space_id = ${spaceId} returning data_revision`;
  return row?.data_revision as number;
}
export async function enqueue(tx: MemoryTx, spaceId: string, kind: string, targetId: string) {
  const id = stableId(spaceId, kind, targetId);
  await tx`insert into memory_outbox (id, space_id, kind, target_id) values (${id}, ${spaceId}, ${kind}, ${targetId}) on conflict do nothing`;
}
/** Provisioning is a server operation, independent of any ingest payload. */
export async function provisionMemorySpace(sql: MemorySql, ownerId: string, spaceId: string) {
  await sql`insert into memory_spaces (space_id, owner_id) values (${spaceId}, ${ownerId}) on conflict do nothing`;
  const [row] = await sql`select owner_id from memory_spaces where space_id = ${spaceId}`;
  if (row?.owner_id !== ownerId) throw new MemoryError('scope_denied');
  await sql`insert into memory_index_manifest (space_id) values (${spaceId}) on conflict do nothing`;
}
