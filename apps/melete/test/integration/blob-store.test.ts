/**
 * References and the collector, against a real database: a blob nothing
 * refers to is deleted only once the grace period has passed, a referenced
 * one never is, and a reference landing while the collector decides keeps its
 * blob. Referencers do not wait for each other, a reference comes only from
 * bytes actually stored, and its space is its owner's. Run against the local
 * store, and against an S3-compatible service when MELETE_TEST_S3_ENDPOINT
 * names one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { BlobNotFound, type BlobStore, type StoredBlob } from '../../src/storage/blob.ts';
import { BLOB_GRACE_MS, BlobCollector } from '../../src/storage/gc.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import {
  BlobOwnerUnknown,
  referenceBlob,
  referenceBlobs,
  releaseBlob,
  storeReferenced,
} from '../../src/storage/refs.ts';
import { S3BlobStore } from '../../src/storage/s3.ts';
import { testOwner } from '../helpers/blob-owner.ts';
import { testDatabase } from '../helpers/database.ts';
import { installationOwner } from './space-removal-fixture.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-blob-refs-'));
if (handle)
  afterAll(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

const stores: { name: string; make: () => BlobStore }[] = [
  { name: 'local directory', make: () => new LocalBlobStore(join(root, randomUUID())) },
];
if (process.env.MELETE_TEST_S3_ENDPOINT)
  stores.push({
    name: 'S3-compatible bucket',
    make: () =>
      new S3BlobStore({
        endpoint: process.env.MELETE_TEST_S3_ENDPOINT,
        bucket: process.env.MELETE_TEST_S3_BUCKET ?? 'melete-test',
        region: process.env.MELETE_TEST_S3_REGION ?? 'us-east-1',
        accessKeyId: process.env.MELETE_TEST_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.MELETE_TEST_S3_SECRET_ACCESS_KEY ?? '',
        prefix: `test-${randomUUID()}`,
      }),
  });

const bytes = (text: string) => new TextEncoder().encode(text);
const DAY = 24 * 60 * 60 * 1000;

async function newSpace(sql: Sql): Promise<string> {
  const ownerId = await installationOwner(sql);
  const spaceId = `sp_${randomUUID().replaceAll('-', '')}`;
  await sql`insert into space (id, name, kind, audience, owner_principal_id, git_path)
    values (${spaceId}, 'Blobs', 'shared', 'space', ${ownerId}, ${join(root, spaceId)})`;
  return spaceId;
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function refsFor(sql: Sql, key: string): Promise<{ space_id: string; owner_id: string }[]> {
  return sql<{ space_id: string; owner_id: string }[]>`select space_id, owner_id from blob_ref
    where key = ${key} order by owner_id`;
}

describe.if(handle !== null)('blob references and the collector', () => {
  if (!handle) return;
  const { sql } = handle;

  for (const { name, make } of stores)
    describe(`in a ${name}`, () => {
      test('the collector deletes unreferenced blobs only after the grace period', async () => {
        const store = make();
        const spaceId = await newSpace(sql);
        const owner = testOwner(spaceId, 'one');
        const kept = await storeReferenced(sql, store, bytes('kept: an app page'), owner);
        const loose = await store.put(bytes('loose: nothing names this'));

        // Within the grace period nothing goes, referenced or not.
        const early = new BlobCollector({ sql, store });
        expect(await early.collect()).toMatchObject({ examined: 2, deleted: 0 });
        expect(await store.head(loose.key)).not.toBeNull();

        // Past it, the unreferenced blob goes and the referenced one stays.
        const late = new BlobCollector({
          sql,
          store,
          now: () => new Date(Date.now() + BLOB_GRACE_MS + DAY),
        });
        expect(await late.collect()).toMatchObject({ examined: 2, deleted: 1 });
        expect(await store.head(loose.key)).toBeNull();
        expect(await store.head(kept.key)).not.toBeNull();

        // Once its last owner lets go, it is collected like any other.
        await releaseBlob(sql, kept.key, owner);
        expect(await late.collect()).toMatchObject({ deleted: 1 });
        expect(await store.head(kept.key)).toBeNull();
      });

      test('a reference landing while the collector decides keeps its blob', async () => {
        const store = make();
        const spaceId = await newSpace(sql);
        const stored = await store.put(bytes('referenced mid-collection'));
        const collector = new BlobCollector({
          sql,
          store,
          now: () => new Date(Date.now() + BLOB_GRACE_MS + DAY),
        });

        // The reference's transaction holds the key until it commits; the
        // collector, which saw no reference when it listed, waits for it and
        // then sees one.
        let collecting: Promise<unknown> | undefined;
        await sql.begin(async (tx) => {
          await referenceBlob(tx, store, stored, testOwner(spaceId, 'late'));
          collecting = collector.collect();
          await Bun.sleep(300);
        });
        expect(await collecting).toMatchObject({ deleted: 0 });
        expect(await store.head(stored.key)).not.toBeNull();
      });

      test('two owners referring to the same blobs in opposite orders both go ahead', async () => {
        const store = make();
        const spaceId = await newSpace(sql);
        const a = await store.put(bytes(`a shared library ${spaceId}`));
        const b = await store.put(bytes(`a shared page ${spaceId}`));

        // Each holds its first key while it reaches for the other's.
        const refer = (first: StoredBlob, second: StoredBlob, owner: string) =>
          sql
            .begin(async (tx) => {
              await referenceBlob(tx, store, first, testOwner(spaceId, owner));
              await Bun.sleep(300);
              await referenceBlob(tx, store, second, testOwner(spaceId, owner));
            })
            .then(
              () => 'ok',
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            );
        expect(await Promise.all([refer(a, b, 'one'), refer(b, a, 'two')])).toEqual(['ok', 'ok']);
        expect((await refsFor(sql, a.key)).length).toBe(2);
        expect((await refsFor(sql, b.key)).length).toBe(2);
      });

      test('a reference to a blob that is no longer stored is refused', async () => {
        const store = make();
        const spaceId = await newSpace(sql);
        const stored = await store.put(bytes('stored, then deleted'));
        await store.delete(stored.key);
        const refused = await failure(() =>
          sql.begin((tx) => referenceBlob(tx, store, stored, testOwner(spaceId, 'gone'))),
        );
        expect(refused).toBeInstanceOf(BlobNotFound);
        expect(await refsFor(sql, stored.key)).toEqual([]);
      });

      test('a hash alone is not enough to refer to a blob', async () => {
        const store = make();
        const spaceId = await newSpace(sql);
        const stored = await store.put(bytes('a filled-in template from another space'));
        // The same key, size and hash, named rather than stored by this caller.
        const named: StoredBlob = { key: stored.key, size: stored.size, sha256: stored.sha256 };
        const refused = await failure(() =>
          sql.begin((tx) => referenceBlobs(tx, store, [named], testOwner(spaceId, 'guess'))),
        );
        expect(refused).toBeInstanceOf(Error);
        expect(await refsFor(sql, stored.key)).toEqual([]);
      });

      test('a reference belongs to the space of its owner, and an owner that is not there refers to nothing', async () => {
        const store = make();
        const spaceId = await newSpace(sql);
        const stored = await store.put(bytes(`owned ${spaceId}`));
        await sql.begin((tx) => referenceBlob(tx, store, stored, testOwner(spaceId, 'mine')));
        expect(await refsFor(sql, stored.key)).toEqual([
          { space_id: spaceId, owner_id: `${spaceId}/mine` },
        ]);

        const nowhere = await failure(() =>
          sql.begin((tx) => referenceBlob(tx, store, stored, testOwner('sp_missing', 'x'))),
        );
        expect(nowhere).toBeInstanceOf(BlobOwnerUnknown);
        const undefinedKind = await failure(() =>
          sql.begin((tx) => referenceBlob(tx, store, stored, { kind: 'no_such_kind', id: 'x' })),
        );
        expect(undefinedKind).toBeInstanceOf(Error);
        expect((await refsFor(sql, stored.key)).length).toBe(1);
      });
    });

  test('a reference names a blob key and nothing else', async () => {
    const spaceId = await newSpace(sql);
    let refused = '';
    try {
      await sql`insert into blob_ref (key, owner_kind, owner_id, space_id)
        values ('sha256/../../etc/passwd', 'test_owner', 'x', ${spaceId})`;
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused).toContain('blob_ref_key_shape');
  });
});
