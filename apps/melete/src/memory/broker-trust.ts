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
import { leaves } from '../intents/values.ts';
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
      // Work a room handed the person: the task is the room's words, not theirs.
      // Work carrying out something the person asked for: the details they
      // said are theirs. Melete's own reading of the rest vouches for nothing.
      const said = room
        ? await roomOrigins(tx, room, input)
        : job.objective_origin === 'room_handoff'
          ? await handoffOrigins(tx, String(job.space_id), String(job.id), input)
          : await intentOrigins(tx, String(job.space_id), String(job.id), input);
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
      if (!room && said.length === 0) return remembered;
      // In a room, what was said in this request answers first. Room memory
      // keeps the trust it was captured with, and never vouches for a value as
      // if the person who asked had given it. In handed work, what the room's
      // task names answers first; the person's own memory answers the rest.
      const answered = new Set(said.map((entry) => entry.path));
      return [
        ...said,
        ...remembered
          .filter((entry) => !answered.has(entry.path))
          .map((entry) =>
            room && entry.origin_trust === 'owner'
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
    room.spaceId,
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

/**
 * Where the gated values of a person's work came from, when a room handed
 * them that work. The task is the room's text, which the person accepted to
 * run, not text they typed: a value it names is `external_content`, so it
 * carries a warning on the person's own card, and no standing rule they made
 * for their own requests admits it.
 */
export async function handoffOrigins(
  tx: Query,
  spaceId: string,
  jobId: string,
  input: TrustResolutionInput,
): Promise<OriginResolution[]> {
  if (input.fields.length === 0) return [];
  const [row] = await tx`select h.task_text, s.name from room_handoff h
    join space s on s.id = h.space_id
    join job j on j.id = h.personal_job_id
    where h.personal_job_id = ${jobId} and j.space_id = ${spaceId}`;
  if (!row) return [];
  const task = String(row.task_text ?? '');
  return input.fields
    .filter((field) => saysVerbatim(task, field.value))
    .map((field) =>
      originResolution.parse({
        ...field,
        origin_trust: 'external_content',
        handle: null,
        description: `This value came from a request in the room ${JSON.stringify(String(row.name ?? ''))}, not from something you typed.`,
      }),
    );
}

const sameValue = (said: string, value: string) => {
  const a = said.trim().toLowerCase();
  const b = value.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const numbers = [Number(a), Number(b)];
  if (numbers.every((n) => a !== '' && b !== '' && Number.isFinite(n)))
    return numbers[0] === numbers[1];
  const times = [Date.parse(said), Date.parse(value)];
  return (
    /\d{4}-\d{2}-\d{2}T/.test(said) &&
    /\d{4}-\d{2}-\d{2}T/.test(value) &&
    times.every(Number.isFinite) &&
    times[0] === times[1]
  );
};

/**
 * Where the gated values of an intent's work came from. A value equal to a
 * detail the person said when they asked for it is theirs: `owner` trust, for
 * this work only. A detail Melete inferred answers nothing here, so it never
 * counts as the person's instruction: it is left to memory, and to the
 * approval card, like any value the work cannot account for.
 */
export async function intentOrigins(
  tx: Query,
  spaceId: string,
  jobId: string,
  input: TrustResolutionInput,
): Promise<OriginResolution[]> {
  if (input.fields.length === 0) return [];
  const kept = await tx`select i.constraints, i.origins, i.deadline_at, i.deadline_day
    from intent i
    where i.space_id = ${spaceId} and i.state in ('active', 'waiting', 'at_risk')
      and i.source = 'chat'
      and (i.run_id = ${jobId}
        or i.run_id = (select parent_run_id from run_state where job_id = ${jobId}))`;
  const theirs: string[] = [];
  for (const row of kept) {
    const origins = (row.origins ?? {}) as Record<string, string>;
    const deadline =
      (row.deadline_day as string | null) ??
      (row.deadline_at ? new Date(row.deadline_at as Date).toISOString() : null);
    for (const leaf of leaves((row.constraints ?? {}) as never, deadline))
      if (origins[leaf.path] === 'person') theirs.push(String(leaf.value));
  }
  if (!theirs.length) return [];
  return input.fields
    .filter((field) => theirs.some((value) => sameValue(value, field.value)))
    .map((field) =>
      originResolution.parse({
        ...field,
        origin_trust: 'owner',
        handle: null,
        description: 'You said this when you asked Melete to do it.',
      }),
    );
}
