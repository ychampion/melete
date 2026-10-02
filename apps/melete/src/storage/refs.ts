/**
 * Referring to blobs, and letting go of them.
 *
 * A blob is deleted only while no row refers to it, and a row is added only
 * while the blob is there. Both checks run under a per-key transaction lock:
 * referencers take it shared, so any number of them proceed together, and
 * whatever deletes (the collector, a space removal) takes it exclusive. A
 * reference can therefore never be added to a blob that is being deleted:
 * whichever comes second sees what the first did, and a writer that loses the
 * race finds the blob gone and stores it again. Several keys are always locked
 * in sorted order.
 *
 * A reference is made only from what this process's own `put` returned, never
 * from a hash alone: knowing a blob's hash is not having its bytes, and a
 * reference is how bytes become readable to whoever owns it.
 *
 * Every reference belongs to the space its owner belongs to, and the space is
 * read from the owner row, never taken from the caller. Each kind of owner is
 * defined once with how its space is found. Moving an owner to another space
 * must move its references with it, in the same transaction.
 */
import type { Sql, TransactionSql } from 'postgres';
import {
  type BlobKey,
  BlobNotFound,
  type BlobStore,
  type PutOptions,
  type StoredBlob,
  storedHere,
} from './blob.ts';

export type BlobOwner = { kind: string; id: string };

/** The space an owner row belongs to, or null when there is no such row. */
export type OwnerSpace = (tx: TransactionSql, ownerId: string) => Promise<string | null>;

const owners = new Map<string, OwnerSpace>();

/** Define a kind of owner, with how to find the space one belongs to. */
export function defineBlobOwner(kind: string, space: OwnerSpace): void {
  owners.set(kind, space);
}

export class BlobOwnerUnknown extends Error {
  readonly code = 'blob_owner_unknown';
  constructor(owner: BlobOwner) {
    super(`no ${owner.kind} ${owner.id} to refer to a blob`);
  }
}

/** Shared for a referencer, exclusive for whatever deletes. Held to the end of the transaction. */
export async function lockBlobKey(
  tx: TransactionSql,
  key: BlobKey,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const id = `blob:${key}`;
  if (mode === 'shared') await tx`select pg_advisory_xact_lock_shared(hashtextextended(${id}, 0))`;
  else await tx`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
}

/**
 * Record that `owner` needs each of these blobs, inside the caller's
 * transaction so the references land with whatever row names them. Throws
 * BlobNotFound when one is no longer there; the caller stores it again and
 * retries.
 */
export async function referenceBlobs(
  tx: TransactionSql,
  store: BlobStore,
  blobs: readonly StoredBlob[],
  owner: BlobOwner,
): Promise<void> {
  for (const blob of blobs)
    if (!storedHere(blob)) throw new Error('a blob is referenced only from what put returned');
  const resolve = owners.get(owner.kind);
  if (!resolve) throw new Error(`blob owner kind ${owner.kind} is not defined`);
  const spaceId = await resolve(tx, owner.id);
  if (!spaceId) throw new BlobOwnerUnknown(owner);
  const keys = [...new Set(blobs.map((blob) => blob.key))].sort();
  for (const key of keys) {
    await lockBlobKey(tx, key, 'shared');
    if (!(await store.head(key))) throw new BlobNotFound(key);
    await tx`insert into blob_ref (key, owner_kind, owner_id, space_id)
      values (${key}, ${owner.kind}, ${owner.id}, ${spaceId})
      on conflict do nothing`;
  }
}

/** One blob; see referenceBlobs. */
export function referenceBlob(
  tx: TransactionSql,
  store: BlobStore,
  blob: StoredBlob,
  owner: BlobOwner,
): Promise<void> {
  return referenceBlobs(tx, store, [blob], owner);
}

/** Store bytes and record the owner's reference to them, storing again if they went in between. */
export async function storeReferenced(
  sql: Sql,
  store: BlobStore,
  bytes: Uint8Array,
  owner: BlobOwner,
  options?: PutOptions,
): Promise<StoredBlob> {
  for (let attempt = 0; ; attempt++) {
    const stored = await store.put(bytes, options);
    try {
      await sql.begin((tx) => referenceBlob(tx, store, stored, owner));
      return stored;
    } catch (error) {
      if (!(error instanceof BlobNotFound) || attempt > 0) throw error;
    }
  }
}

/** The owner no longer needs the blob. The collector deletes it once nothing else does. */
export async function releaseBlob(
  tx: Sql | TransactionSql,
  key: BlobKey,
  owner: BlobOwner,
): Promise<void> {
  await tx`delete from blob_ref
    where key = ${key} and owner_kind = ${owner.kind} and owner_id = ${owner.id}`;
}

export type SpaceBlobRelease = {
  /** Blobs deleted because only this space referred to them. */
  deleted: number;
  /** Blobs only this space referred to that the store still holds, asked again after deleting. */
  left: number;
};

/**
 * Delete every blob only this space refers to, and then the space's
 * references. The blobs go first and are asked for again before a reference
 * is touched: a reference is the only record of which blobs were the space's,
 * so it stays until the store says they are gone, and a pass that finds one
 * still held leaves everything for the next pass. `hold` is taken in each
 * transaction, so a run that has lost its claim deletes nothing more.
 */
export async function releaseSpaceBlobs(
  sql: Sql,
  store: BlobStore,
  spaceId: string,
  hold?: (tx: TransactionSql) => Promise<void>,
): Promise<SpaceBlobRelease> {
  const rows = await sql<{ key: BlobKey }[]>`select distinct key from blob_ref
    where space_id = ${spaceId} order by key`;
  const only: BlobKey[] = [];
  let deleted = 0;
  for (const { key } of rows)
    await sql.begin(async (tx) => {
      await hold?.(tx);
      await lockBlobKey(tx, key, 'exclusive');
      if (await referencedElsewhere(tx, key, spaceId)) return;
      only.push(key);
      if (!(await store.head(key))) return;
      await store.delete(key);
      deleted++;
    });

  let left = 0;
  for (const key of only)
    await sql.begin(async (tx) => {
      await lockBlobKey(tx, key, 'exclusive');
      // Another space may have stored the same bytes again since; then they are its.
      if (await referencedElsewhere(tx, key, spaceId)) return;
      if (await store.head(key)) left++;
    });
  if (left > 0) return { deleted, left };

  await sql.begin(async (tx) => {
    await hold?.(tx);
    await tx`delete from blob_ref where space_id = ${spaceId}`;
  });
  return { deleted, left };
}

async function referencedElsewhere(
  tx: TransactionSql,
  key: BlobKey,
  spaceId: string,
): Promise<boolean> {
  const [row] = await tx<{ present: boolean }[]>`select exists (
      select 1 from blob_ref where key = ${key} and space_id <> ${spaceId}
    ) as present`;
  return row?.present === true;
}
