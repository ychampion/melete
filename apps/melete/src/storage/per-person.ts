/**
 * How much each person keeps, and the most they may keep when the operator
 * sets one (`MELETE_STORAGE_PER_PERSON_MB`; unset, nobody is limited).
 *
 * What a person keeps is read from records, never from a walk of the disk:
 * the files they sent in chat (`attachment.size`), and one `stored_file` row
 * for each file their work saved, in their Files or in a chat's own folder,
 * with the bytes its receipt says it holds. The rows are kept as receipts land
 * (`recordStoredFiles`), in the transaction that lands them: a write sets its
 * place's bytes, a move takes them to the new place, a delete marks them with
 * the trash it went to, and a restore of that trash counts them again.
 *
 * A file is counted against the person whose work saved it last: in a shared
 * space, a member's request of the room's agent counts against that member,
 * not the space's owner. Work nobody asked for counts against the space's owner.
 */
import type { JsonValue } from '@melete/contracts';
import type { Query } from '../broker/records.ts';
import { filesPath } from '../connectors/shared-files.ts';
import type { Env } from '../env.ts';

const MB = 1024 * 1024;

/** The most one person may keep, in bytes, or null when the operator set no limit. */
export function storagePerPersonBytes(env: Pick<Env, 'MELETE_STORAGE_PER_PERSON_MB'>) {
  return env.MELETE_STORAGE_PER_PERSON_MB ? env.MELETE_STORAGE_PER_PERSON_MB * MB : null;
}

/** An amount of storage as a person reads it: "340 KB", "12.5 MB", "1.2 GB". */
export function storageAmount(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const one = (value: number) => value.toFixed(1).replace(/\.0$/, '');
  if (bytes < 1024 * MB) return `${one(bytes / MB)} MB`;
  return `${one(bytes / (1024 * MB))} GB`;
}

const FREE_SPACE =
  'deleting files they no longer need in Files, or chats with files they sent in them, frees space';

/** Why an upload was refused, said to the person who sent it. */
export function uploadRefused(input: {
  used: number;
  quota: number;
  name: string;
  bytes: number;
}): string {
  return `You are using ${storageAmount(input.used)} of the ${storageAmount(input.quota)} of storage you have here, and ${input.name} is ${storageAmount(input.bytes)}. Delete files you no longer need in Files, or chats with files you sent in them, to make room.`;
}

/** Why a step that would save a file was refused, said to the agent, which tells the person. */
export function saveRefused(input: { used: number; quota: number; bytes: number | null }): string {
  const adds = input.bytes === null ? '' : `, and this would add ${storageAmount(input.bytes)}`;
  return `the person's storage is full: they are using ${storageAmount(input.used)} of the ${storageAmount(input.quota)} each person has here${adds}, so nothing was saved. Tell them, and that ${FREE_SPACE}`;
}

/** What one person keeps now, in bytes. */
export async function storageUsed(query: Query, principalId: string): Promise<number> {
  const [row] = await query<{ used: number }[]>`select
      (select coalesce(sum(bytes), 0) from stored_file
        where principal_id = ${principalId} and trash_id is null)::float8
      + (select coalesce(sum(size), 0) from attachment where principal_id = ${principalId})::float8
      as used`;
  return Number(row?.used ?? 0);
}

/**
 * The person a job's files count against: who it works for, as the room's
 * approvals and the shared-files rule read it, or the space's owner when it
 * works for nobody in particular. Null in an installation with no people.
 */
export async function chargedPerson(query: Query, jobId: string): Promise<string | null> {
  const [row] = await query<{ person: string | null }[]>`select coalesce(
      case when r.audience = 'room' then r.requested_by_principal_id
        when j.audience = 'room' then j.requested_by_principal_id
        when p.kind = 'room' then null
        else j.principal_id end,
      s.owner_principal_id) as person
    from job j join space s on s.id = j.space_id
    left join principal p on p.id = j.principal_id
    left join job r on r.id = j.experience_parent_id and r.space_id = j.space_id
    where j.id = ${jobId}`;
  return row?.person ?? null;
}

/** Where a file is, as one key: the space's Files, or one chat's own folder. */
export function storedPlace(
  area: unknown,
  path: unknown,
  jobId: string,
): { place: string; jobId: string | null } | null {
  const relative = filesPath(path);
  if (!relative) return null;
  return area === 'artifacts'
    ? { place: `files:${relative}`, jobId: null }
    : { place: `chat:${jobId}:${relative}`, jobId };
}

/** One change a receipt makes to what is kept. */
export type StoredChange =
  | { op: 'set'; place: string; jobId: string | null; bytes: number }
  | { op: 'move'; from: string; place: string; jobId: string | null; bytes: number | null }
  | { op: 'trash'; place: string; trashId: string | null }
  | { op: 'restore'; trashId: string };

const object = (value: unknown): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * What a succeeded step's receipt changes in what is kept, read from the step
 * and its receipt alone. Steps that keep nothing change nothing.
 */
export function storedChanges(input: {
  kind: string;
  jobId: string;
  payload: Record<string, JsonValue>;
  detail: Record<string, JsonValue>;
}): StoredChange[] {
  const { kind, jobId, payload, detail } = input;
  if (kind === 'files.write' || kind === 'files.save_attachment') {
    const at = storedPlace(detail.area ?? payload.area, detail.path ?? payload.path, jobId);
    const bytes = count(detail.bytes);
    return at && bytes !== null ? [{ op: 'set', ...at, bytes }] : [];
  }
  if (kind === 'files.move') {
    const area = detail.area ?? payload.area;
    const from = storedPlace(area, detail.from ?? payload.from, jobId);
    const to = storedPlace(
      detail.to_area ?? payload.to_area ?? area,
      detail.to ?? payload.to,
      jobId,
    );
    if (!from || !to) return [];
    return [{ op: 'move', from: from.place, ...to, bytes: count(detail.bytes) }];
  }
  if (kind === 'files.delete') {
    const at = storedPlace(detail.area ?? payload.area, detail.path ?? payload.path, jobId);
    if (!at) return [];
    return [
      {
        op: 'trash',
        place: at.place,
        trashId: typeof detail.trash_id === 'string' ? detail.trash_id : null,
      },
    ];
  }
  if (kind === 'files.restore') {
    const trashId = detail.trash_id ?? payload.trash_id;
    return typeof trashId === 'string' ? [{ op: 'restore', trashId }] : [];
  }
  if (kind === 'audio.synthesize' || kind === 'audio.transcribe') {
    // Saved into the space's Files under `artifacts/<name>` (broker/artifacts.ts).
    const name = typeof detail.path === 'string' ? detail.path.replace(/^artifacts\//, '') : null;
    const at = storedPlace('artifacts', name, jobId);
    const bytes = count(detail.bytes);
    return at && bytes !== null ? [{ op: 'set', ...at, bytes }] : [];
  }
  if (kind === 'artifact.publish' && detail.destination === 'space_artifacts') {
    const at = storedPlace('artifacts', detail.path, jobId);
    const bytes = count(detail.bytes);
    return at && bytes !== null ? [{ op: 'set', ...at, bytes }] : [];
  }
  return [];
}

/**
 * Apply what a succeeded step kept, inside the transaction that records its
 * receipt. Each change sets where things are now, so applying one twice
 * leaves the same rows.
 */
export async function recordStoredFiles(
  tx: Query,
  job: { id: string; space_id: string },
  action: { kind: string; canonical_payload: Record<string, JsonValue> },
  receipt: { detail: unknown },
): Promise<void> {
  const changes = storedChanges({
    kind: action.kind,
    jobId: job.id,
    payload: object(action.canonical_payload),
    detail: object(receipt.detail),
  });
  if (!changes.length) return;
  const person = changes.some((change) => change.op === 'set' || change.op === 'move')
    ? await chargedPerson(tx, job.id)
    : null;
  for (const change of changes) await applyChange(tx, job.space_id, person, change);
}

async function applyChange(
  tx: Query,
  spaceId: string,
  person: string | null,
  change: StoredChange,
): Promise<void> {
  if (change.op === 'set') {
    await tx`insert into stored_file (space_id, place, job_id, principal_id, bytes)
      values (${spaceId}, ${change.place}, ${change.jobId}, ${person}, ${change.bytes})
      on conflict (space_id, place) do update set job_id = excluded.job_id,
        principal_id = excluded.principal_id, bytes = excluded.bytes, trash_id = null,
        updated_at = now()`;
    return;
  }
  if (change.op === 'move') {
    // The bytes the receipt names, or else what the old place held; a file
    // nothing recorded before (one the agent's computer made) and a receipt
    // that names no size leave nothing to count.
    await tx`with moved as (
        delete from stored_file where space_id = ${spaceId} and place = ${change.from}
          and trash_id is null
        returning bytes)
      insert into stored_file (space_id, place, job_id, principal_id, bytes)
      select ${spaceId}, ${change.place}, ${change.jobId}, ${person}, b.bytes
      from (select coalesce(${change.bytes}::bigint, (select bytes from moved)) as bytes) b
      where b.bytes is not null
      on conflict (space_id, place) do update set job_id = excluded.job_id,
        principal_id = excluded.principal_id, bytes = excluded.bytes, trash_id = null,
        updated_at = now()`;
    return;
  }
  if (change.op === 'trash') {
    const beneath = `${change.place}/`;
    if (change.trashId === null) {
      await tx`delete from stored_file where space_id = ${spaceId}
        and (place = ${change.place} or starts_with(place, ${beneath}))`;
      return;
    }
    await tx`update stored_file set trash_id = ${change.trashId}, updated_at = now()
      where space_id = ${spaceId} and trash_id is null
        and (place = ${change.place} or starts_with(place, ${beneath}))`;
    return;
  }
  await tx`update stored_file set trash_id = null, updated_at = now()
    where space_id = ${spaceId} and trash_id = ${change.trashId}`;
}

/** Mark a file deleted from the Files page as in the trash, or count it again once restored. */
export async function trashStoredFile(
  query: Query,
  spaceId: string,
  at: { place: string },
  trashId: string,
): Promise<void> {
  await applyChange(query, spaceId, null, { op: 'trash', place: at.place, trashId });
}

export async function restoreStoredFiles(
  query: Query,
  spaceId: string,
  trashId: string,
): Promise<void> {
  await applyChange(query, spaceId, null, { op: 'restore', trashId });
}

/**
 * The bytes a step would add for the person it counts against, read before it
 * is decided: a write's content less what that person already keeps at its
 * place, a saved attachment's size, a restore's trashed files, a published
 * file's record. Null when it cannot be known before the step runs, as for a
 * generated recording or a move of a file nothing recorded.
 */
export async function incomingBytes(
  query: Query,
  input: {
    kind: string;
    jobId: string;
    spaceId: string;
    person: string;
    payload: Record<string, JsonValue>;
  },
): Promise<number | null | 'none'> {
  const { kind, jobId, spaceId, person, payload } = input;
  const keptThere = async (place: string) => {
    const [row] = await query<{ bytes: number }[]>`select bytes::float8 as bytes from stored_file
      where space_id = ${spaceId} and place = ${place} and trash_id is null
        and principal_id = ${person}`;
    return row ? Number(row.bytes) : 0;
  };
  if (kind === 'files.write') {
    if (typeof payload.content !== 'string') return 'none';
    const bytes = Buffer.byteLength(payload.content);
    const at = storedPlace(payload.area, payload.path, jobId);
    return Math.max(0, bytes - (at ? await keptThere(at.place) : 0));
  }
  if (kind === 'files.save_attachment') {
    if (typeof payload.attachment_id !== 'string') return 'none';
    const [row] = await query<{ size: number }[]>`select size from attachment
      where id = ${payload.attachment_id} and space_id = ${spaceId}`;
    return row ? Number(row.size) : null;
  }
  if (kind === 'files.move') {
    const from = storedPlace(payload.area, payload.from, jobId);
    if (!from) return 'none';
    const [row] = await query`select 1 from stored_file
      where space_id = ${spaceId} and place = ${from.place} and trash_id is null`;
    return row ? 0 : null;
  }
  if (kind === 'files.restore') {
    if (typeof payload.trash_id !== 'string') return null;
    const [row] = await query<{ bytes: number }[]>`select coalesce(sum(bytes), 0)::float8 as bytes
      from stored_file where space_id = ${spaceId} and trash_id = ${payload.trash_id}`;
    return Number(row?.bytes ?? 0);
  }
  if (kind === 'audio.synthesize' || kind === 'audio.transcribe') return null;
  if (kind === 'artifact.publish') {
    if (object(payload.destination).kind !== 'space_artifacts') return 'none';
    if (typeof payload.artifact_id !== 'string') return null;
    const [row] = await query<{ size: number }[]>`select size from artifact
      where id = ${payload.artifact_id} and space_id = ${spaceId}`;
    return row ? Number(row.size) : null;
  }
  return 'none';
}

/** The steps that can add to what a person keeps; every other step goes ahead unread. */
const STORING = new Set([
  'files.write',
  'files.save_attachment',
  'files.move',
  'files.restore',
  'audio.synthesize',
  'audio.transcribe',
  'artifact.publish',
]);

/**
 * Null when the step may go ahead; otherwise why not, said to the agent. With
 * no limit set, every step goes ahead and nothing is read.
 */
export async function storageRefusal(
  query: Query,
  quota: number | null | undefined,
  input: { kind: string; jobId: string; spaceId: string; payload: Record<string, JsonValue> },
): Promise<string | null> {
  if (!quota || !STORING.has(input.kind)) return null;
  const person = await chargedPerson(query, input.jobId);
  if (!person) return null;
  const bytes = await incomingBytes(query, { ...input, person });
  if (bytes === 'none' || bytes === 0) return null;
  const used = await storageUsed(query, person);
  if (bytes === null ? used < quota : used + bytes <= quota) return null;
  return saveRefused({ used, quota, bytes });
}
