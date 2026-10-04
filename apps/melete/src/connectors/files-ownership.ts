/**
 * Who a file in a conversation's reach belongs to, read from that
 * conversation's own file records.
 *
 * Deleting is the one file change that cannot be put back, so it follows the
 * rule for risky actions: what Melete itself made in this conversation goes
 * at once, with a receipt, and anything of the person's asks them first. The
 * job's workspace is Melete's own, except the files the person gave it there:
 * one saved from their upload (`files.save_attachment`) or taken out of their
 * Files (`files.move` to `work`). The person's Files are theirs, except a file
 * this conversation saved there as a new file and nobody has changed since.
 *
 * A path is followed through this conversation's moves and deletes in the
 * order they settled, so a file the person gave and the agent renamed is
 * still theirs. A command that renames one on the agent's computer leaves no
 * such record; its new name counts as the agent's.
 */
import type { Query } from '../broker/records.ts';
import { segmentsFor } from '../paths.ts';

export type FileRecords = {
  /** Files in the job's workspace the person gave it. */
  personInWork: Set<string>;
  /** Files this conversation made new in the person's Files, with the content hash it saved. */
  madeInFiles: Map<string, string>;
};

type RecordRow = { kind: string; canonical_payload: unknown; receipt: unknown };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A recorded path as its names joined by `/`, or null when it names no file. */
function normal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const segments = segmentsFor(value);
    return segments.length ? segments.join('/') : null;
  } catch {
    return null;
  }
}

/** The paths in `paths` that are `target` or lie beneath it. */
export function beneath(paths: Iterable<string>, target: string): string[] {
  return [...paths].filter((path) => path === target || path.startsWith(`${target}/`));
}

/** The records' answer, folded in the order the actions settled. */
export function fileRecords(rows: readonly RecordRow[]): FileRecords {
  const personInWork = new Set<string>();
  const madeInFiles = new Map<string, string>();
  for (const row of rows) {
    const payload = object(row.canonical_payload);
    const detail = object(object(row.receipt).detail);
    const hash = typeof detail.content_hash === 'string' ? detail.content_hash : null;
    const area = payload.area === 'artifacts' ? 'artifacts' : 'work';
    if (row.kind === 'files.save_attachment') {
      const saved = normal(detail.path ?? payload.path);
      if (saved) personInWork.add(saved);
    } else if (row.kind === 'files.move') {
      const from = normal(payload.from);
      const to = normal(payload.to);
      if (!from || !to) continue;
      const toArea = (payload.to_area ?? payload.area) === 'artifacts' ? 'artifacts' : 'work';
      // A file in the person's Files that this conversation did not make is theirs.
      const theirs = area === 'work' ? personInWork.has(from) : !madeInFiles.has(from);
      if (area === 'work') personInWork.delete(from);
      else madeInFiles.delete(from);
      if (toArea === 'work') {
        if (theirs) personInWork.add(to);
      } else if (!theirs && hash) madeInFiles.set(to, hash);
      else madeInFiles.delete(to);
    } else if (row.kind === 'files.write') {
      const written = normal(payload.path);
      if (!written || area !== 'artifacts') continue;
      // Only a write that made a new file makes it Melete's; one that saved
      // over a file there leaves it the person's.
      if (detail.created === true && hash) madeInFiles.set(written, hash);
      else madeInFiles.delete(written);
    } else if (row.kind === 'files.delete') {
      const gone = normal(payload.path);
      if (!gone) continue;
      if (area === 'work')
        for (const path of beneath(personInWork, gone)) personInWork.delete(path);
      else for (const path of beneath(madeInFiles.keys(), gone)) madeInFiles.delete(path);
    }
  }
  return { personInWork, madeInFiles };
}

/** This conversation's file records, in the order they settled. */
export async function loadFileRecords(tx: Query, jobId: string): Promise<FileRecords> {
  const rows = await tx`select kind, canonical_payload, receipt from action
    where job_id = ${jobId} and status = 'succeeded'
      and kind in ('files.write', 'files.move', 'files.save_attachment', 'files.delete')
    order by resolved_at nulls last, created_at, id`;
  return fileRecords(rows as unknown as RecordRow[]);
}

/**
 * Why a file in the job's workspace may not be deleted without the person,
 * or null when it is Melete's own. Said to the agent as it is.
 */
export function personGivenReason(records: FileRecords, relative: string): string | null {
  const given = beneath(records.personInWork, relative);
  if (!given.length) return null;
  return given.length === 1 && given[0] === relative
    ? `${JSON.stringify(relative)} is a file the person gave you`
    : `${JSON.stringify(relative)} holds ${given.length === 1 ? 'a file' : `${given.length} files`} the person gave you (${given
        .slice(0, 3)
        .map((path) => JSON.stringify(path))
        .join(', ')}${given.length > 3 ? ', ...' : ''})`;
}
