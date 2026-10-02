/**
 * Referring to blobs, and letting go of them.
 *
 * A blob is deleted only while no row refers to it, and a row is added only
 * while the blob is there. Both sides hold the same per-key transaction lock
 * for that check, so a reference can never be added to a blob a collector or
 * a removal is deleting: whichever comes second sees what the first did. A
 * writer that loses the race finds the blob gone and stores it again.
 */
import type { Sql, TransactionSql } from 'postgres';
import {
  type BlobKey,
  BlobNotFound,
  type BlobStore,
  type PutOptions,
  type StoredBlob,
} from './blob.ts';

export type BlobOwner = { kind: string; id: string; spaceId: string };

/** Hold a blob's key for the rest of the transaction. */
export async function lockBlobKey(tx: TransactionSql, key: BlobKey): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`blob:${key}`}, 0))`;
}

/**
 * Record that `owner` needs the blob, inside the caller's transaction so the
 * reference lands with whatever row names the blob. Throws BlobNotFound when
 * the blob is not there; the caller stores it again and retries.
 */
export async function referenceBlob(
  tx: TransactionSql,
  store: BlobStore,
  key: BlobKey,
  owner: BlobOwner,
): Promise<void> {
  await lockBlobKey(tx, key);
  if (!(await store.head(key))) throw new BlobNotFound(key);
  await tx`insert into blob_ref (key, owner_kind, owner_id, space_id)
    values (${key}, ${owner.kind}, ${owner.id}, ${owner.spaceId})
    on conflict do nothing`;
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
      await sql.begin((tx) => referenceBlob(tx, store, stored.key, owner));
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
  owner: Pick<BlobOwner, 'kind' | 'id'>,
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
      await lockBlobKey(tx, key);
      if (await referencedElsewhere(tx, key, spaceId)) return;
      only.push(key);
      if (!(await store.head(key))) return;
      await store.delete(key);
      deleted++;
    });

  let left = 0;
  for (const key of only)
    await sql.begin(async (tx) => {
      await lockBlobKey(tx, key);
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
