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
import { labelsIn, type RoomAuthority, roomAuthorityOf } from '../rooms/approvals.ts';
import type { MemoryScope, MemoryTx } from './db.ts';
import { resolveTrustIn } from './trust.ts';

/**
 * Every handle the job declared it used, across all of its recorded outputs. A
 * value that traces to none of them is a value the job cannot account for.
 */
export async function handlesForJob(tx: Query, spaceId: string, jobId: string): Promise<string[]> {
  const rows = await tx`select distinct u.handle
    from memory_outputs o join memory_output_uses u on u.output_row_id = o.id
    where o.space_id = ${spaceId} and (o.job_id = ${jobId} or o.job_id =
      (select experience_parent_id from job where id = ${jobId} and space_id = ${spaceId}))`;
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
      const room = await roomAuthorityOf(tx, input.job_id);
      const said = room ? await roomOrigins(tx, room, input) : [];
      const scope = await memoryScopeForSpace(
        tx,
        input.space_id,
        job.principal_id as string | null | undefined,
      );
      if (!scope) return said;
      const handles = await handlesForJob(tx, input.space_id, input.job_id);
      const resolution = await resolveTrustIn(tx as MemoryTx, scope, {
        payload: input.canonical_payload,
        handles,
      });
      const remembered = align(input, resolution);
      if (!room) return remembered;
      // In a room, what was said in this request answers first. Room memory
      // keeps the trust it was captured with, and never vouches for a value as
      // if the person who asked had given it.
      const answered = new Set(said.map((entry) => entry.path));
      return [
        ...said,
        ...remembered
          .filter((entry) => !answered.has(entry.path))
          .map((entry) =>
            entry.origin_trust === 'owner'
              ? originResolution.parse({
                  ...entry,
                  origin_trust: 'external_content',
                  description: describeOrigin('external_content', entry.handle),
                })
              : entry,
          ),
      ];
    },
  };
}

/** Characters that continue a value: a match next to one is part of something longer. */
const CONTINUES = /[\p{L}\p{N}_@/-]/u;

/**
 * Whether `value` appears in `text` as itself: not inside a longer word,
 * address or path. A full stop after it counts as the end of a sentence only
 * when nothing follows it but space.
 */
export function saysVerbatim(text: string, value: string): boolean {
  const haystack = text.toLowerCase();
  const needle = value.trim().toLowerCase();
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const next = haystack[at + needle.length + 1];
    if (before !== undefined && (CONTINUES.test(before) || before === '.')) continue;
    if (after !== undefined && CONTINUES.test(after)) continue;
    if (after === '.' && next !== undefined && !/\s/u.test(next)) continue;
    return true;
  }
  return false;
}

/**
 * Where the gated values of a room request's effect came from, as far as the
 * room can say. A value the person who asked typed in this request is theirs:
 * `owner` trust, for this request only. A value someone else in the thread
 * typed is `external_content`, named as theirs, so it carries a warning on the
 * asker's card and no standing rule admits it. A value both typed is the
 * asker's: they said it themselves.
 */
export async function roomOrigins(
  tx: Query,
  room: RoomAuthority,
  input: TrustResolutionInput,
): Promise<OriginResolution[]> {
  if (input.fields.length === 0) return [];
  const asker = room.requestedBy ?? '';
  const own = asker
    ? await tx`select payload->>'text' as text from event
        where job_id = ${room.requestJobId} and type = 'notice'
          and payload->>'kind' = 'user_message' and payload->>'principal_id' = ${asker}`
    : [];
  const others = room.threadId
    ? await tx`select author_principal_id, text from room_message
        where thread_id = ${room.threadId} and space_id = ${room.spaceId}
          and redacted_at is null and author_principal_id <> ${asker}
        order by created_at, id`
    : [];
  const names = await labelsIn(
    tx,
    others.map((entry) => String(entry.author_principal_id)),
  );
  const answers: OriginResolution[] = [];
  for (const field of input.fields) {
    if (own.some((entry) => saysVerbatim(String(entry.text ?? ''), field.value))) {
      answers.push(
        originResolution.parse({
          ...field,
          origin_trust: 'owner',
          handle: null,
          description: 'The person who asked typed this value in their request.',
        }),
      );
      continue;
    }
    const typed = others.find((entry) => saysVerbatim(String(entry.text ?? ''), field.value));
    if (typed)
      answers.push(
        originResolution.parse({
          ...field,
          origin_trust: 'external_content',
          handle: null,
          description: `${names.get(String(typed.author_principal_id)) ?? 'Someone else in the room'} typed this value in the room, not the person who asked.`,
        }),
      );
  }
  return answers;
}
