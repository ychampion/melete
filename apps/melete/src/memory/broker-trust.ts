/**
 * The seam between the broker's admission rule and memory's record of where a
 * value came from.
 *
 * The broker holds an interface and asks a question about a payload it is about
 * to send; memory holds the answer and never learns what an effect is. This
 * file is the only place the two meet, and it lives in memory because memory is
 * the side that knows claims. It does three things and nothing else: find the
 * handles the job declared, ask memory about them inside the transaction the
 * broker already opened, and return the answer in the shape the broker gates on.
 *
 * Silence is not consent. A field memory cannot account for is simply left out
 * of the answer, and the broker's own rule turns anything it did not hear about
 * into `unknown`, which never satisfies admission on its own.
 */
import type { OriginResolution, TrustResolution } from '@melete/contracts';
import { originResolution } from '@melete/contracts';
import type { Query } from '../broker/records.ts';
import { describeOrigin, type TrustResolutionInput, type TrustResolver } from '../broker/trust.ts';
import type { MemoryScope, MemoryTx } from './db.ts';
import { resolveTrustIn } from './trust.ts';

/**
 * Every handle the job declared it used, across all of its recorded outputs. A
 * value that traces to none of them is a value the job cannot account for.
 */
export async function handlesForJob(tx: Query, spaceId: string, jobId: string): Promise<string[]> {
  const rows = await tx`select distinct u.handle
    from memory_outputs o join memory_output_uses u on u.output_row_id = o.id
    where o.space_id = ${spaceId} and o.job_id = ${jobId}`;
  return rows.map((row) => row.handle as string);
}

/**
 * The owner of the space, read rather than asserted. A space memory has no row
 * for yields no scope, and the resolver answers for nothing.
 */
export async function memoryScopeForSpace(
  tx: Query,
  spaceId: string,
  principalId?: string | null,
): Promise<MemoryScope | null> {
  const [row] = await tx`select owner_id from memory_spaces where space_id = ${spaceId}`;
  if (!row) return null;
  if (principalId) {
    const [parent] =
      await tx`select kind, owner_principal_id from space where id = ${spaceId} for share`;
    if (!parent) return null;
    const [membership] =
      parent.kind === 'shared'
        ? await tx`select role, generation from space_membership where space_id = ${spaceId} and principal_id = ${principalId} and revoked_at is null for share`
        : [];
    const isOwner = parent.owner_principal_id === principalId;
    if (parent.kind === 'shared' ? !membership : !isOwner) return null;
    return {
      ownerId: row.owner_id as string,
      principalId,
      membershipGeneration: Number(membership?.generation ?? 0),
      spaceId,
      publisher: 'broker',
      audience: isOwner ? 'private' : 'space',
      role: isOwner ? 'owner' : 'reader',
    };
  }
  return {
    ownerId: row.owner_id as string,
    spaceId,
    publisher: 'broker',
    audience: 'private',
    role: 'owner',
  };
}

/** Memory's answer, keyed the way the broker asked. Both walk the same payload. */
function align(input: TrustResolutionInput, resolution: TrustResolution): OriginResolution[] {
  const byPath = new Map(resolution.fields.map((field) => [field.field, field]));
  const byValue = new Map(resolution.fields.map((field) => [field.value, field]));
  const answers: OriginResolution[] = [];
  for (const field of input.fields) {
    const match = byPath.get(field.path) ?? byValue.get(field.value);
    if (!match) continue;
    answers.push(
      originResolution.parse({
        ...field,
        origin_trust: match.origin_trust,
        handle: match.handle,
        description: match.description || describeOrigin(match.origin_trust, match.handle),
      }),
    );
  }
  return answers;
}

/**
 * The resolver the effect boundary is started with. It runs on the broker's own
 * transaction, so an admission and the question it asks about memory are one
 * unit of work rather than two that can wait on each other.
 */
export function createMemoryTrustResolver(): TrustResolver {
  return {
    async resolve(tx, input) {
      const [job] =
        await tx`select * from job where id = ${input.job_id} and space_id = ${input.space_id}`;
      if (!job) return [];
      const scope = await memoryScopeForSpace(
        tx,
        input.space_id,
        job.principal_id as string | null | undefined,
      );
      if (!scope) return [];
      const handles = await handlesForJob(tx, input.space_id, input.job_id);
      const resolution = await resolveTrustIn(tx as MemoryTx, scope, {
        payload: input.canonical_payload,
        handles,
      });
      return align(input, resolution);
    },
  };
}
