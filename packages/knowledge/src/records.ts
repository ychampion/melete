/**
 * The two ways a record stops being true, which are not the same thing.
 *
 * Retraction keeps the text and adds the reason: the person can still read what
 * Melete believed and why it stopped believing it. Deletion removes the file,
 * commits the removal, and rebuilds the index in the same call, so the text is
 * gone from the working tree and from the only derived copy together.
 */
import { lintStatusTransition } from '@melete/contracts';
import { serializeRecord } from './frontmatter.ts';
import type { SpaceIndex } from './fts.ts';
import type { SpacePaths } from './layout.ts';
import { type CommitAttribution, commitRecord, commitRemoval, type SpaceCommit } from './space.ts';
import {
  type LoadedRecord,
  markIndexFresh,
  rebuild,
  type SpaceContents,
  toIndexed,
} from './store.ts';

export type RetractionRequest = {
  reason: string;
  /** Who asked. A person, or the agent that noticed the record was wrong. */
  by: string;
  now?: () => Date;
};

export type RetractionResult = {
  commit: SpaceCommit;
  /** The record as it now reads on disk. */
  content: string;
};

const isoDate = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Retract a record: mark it retracted, write the reason into the body, commit,
 * and drop it from the index. The drop is part of this call, so a job holding
 * an open handle stops seeing the record at once rather than at the next
 * restart.
 */
export async function retract(
  paths: SpacePaths,
  index: SpaceIndex,
  record: LoadedRecord,
  request: RetractionRequest,
): Promise<RetractionResult> {
  const now = request.now ?? (() => new Date());
  const at = now();

  // The contract treats a status that does not move as no transition at all, so
  // retracting twice would quietly rewrite the reason. Say so instead.
  if (record.frontmatter.status === 'retracted') {
    throw new Error(`${record.frontmatter.id} is already retracted`);
  }
  const illegal = lintStatusTransition(record.frontmatter.status, 'retracted');
  if (illegal.length > 0) {
    throw new Error(illegal.map((f) => f.message).join('; '));
  }

  const frontmatter = {
    ...record.frontmatter,
    status: 'retracted' as const,
    updated: isoDate(at),
    valid_until: record.frontmatter.valid_until ?? isoDate(at),
  };
  const body = `${record.body.trim()}\n\n**Retracted ${isoDate(at)}:** ${request.reason.trim()}`;
  const content = serializeRecord(frontmatter, body);

  const attribution: CommitAttribution = {
    proposedBy: request.by,
    subject: `Retract ${record.frontmatter.title}`,
    now,
  };
  const commit = await commitRecord(paths, record.path, content, attribution);
  index.remove(record.frontmatter.id);
  markIndexFresh(paths, index);
  return { commit, content };
}

export type DeletionResult = {
  commit: SpaceCommit;
  /** The space as it reads after the rebuild, so a caller can report the count. */
  contents: SpaceContents;
};

/**
 * Delete a record outright. The file goes, the removal is committed, and the
 * index is rebuilt from what is left before this call returns.
 */
export async function hardDelete(
  paths: SpacePaths,
  index: SpaceIndex,
  record: LoadedRecord,
  request: RetractionRequest,
): Promise<DeletionResult> {
  const now = request.now ?? (() => new Date());
  const commit = await commitRemoval(paths, record.path, {
    proposedBy: request.by,
    subject: `Delete ${record.frontmatter.title}: ${request.reason.trim()}`,
    now,
  });
  index.remove(record.frontmatter.id);
  const contents = rebuild(paths, index);
  return { commit, contents };
}

/** Put one record into the index without rebuilding the rest. */
export const indexRecord = (index: SpaceIndex, record: LoadedRecord): void =>
  index.upsert(toIndexed(record));
