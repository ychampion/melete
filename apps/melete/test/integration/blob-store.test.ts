/**
 * References and the collector, against a real database: a blob nothing
 * refers to is deleted only once the grace period has passed, a referenced
 * one never is, and a reference landing while the collector decides keeps its
 * blob. Run against the local store, and against an S3-compatible service
 * when MELETE_TEST_S3_ENDPOINT names one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { BlobNotFound, type BlobStore, blobKey } from '../../src/storage/blob.ts';
import { BLOB_GRACE_MS, BlobCollector } from '../../src/storage/gc.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { referenceBlob, releaseBlob, storeReferenced } from '../../src/storage/refs.ts';
import { S3BlobStore } from '../../src/storage/s3.ts';
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

describe.if(handle !== null)('blob references and the collector', () => {
  if (!handle) return;
  const { sql } = handle;

  for (const { name, make } of stores)
    describe(`in a ${name}`, () => {
      test('the collector deletes unreferenced blobs only after the grace period', async () => {
        const store = make();
        const spaceId = await newSpace(sql);
        const kept = await storeReferenced(sql, store, bytes('kept: an app page'), {
          kind: 'test_owner',
          id: 'one',
          spaceId,
        });
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
        await releaseBlob(sql, kept.key, { kind: 'test_owner', id: 'one' });
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
          await referenceBlob(tx, store, stored.key, { kind: 'test_owner', id: 'late', spaceId });
          collecting = collector.collect();
          await Bun.sleep(300);
        });
        expect(await collecting).toMatchObject({ deleted: 0 });
        expect(await store.head(stored.key)).not.toBeNull();
      });

      test('a reference to a blob that is not stored is refused', async () => {
        const store = make();
        const spaceId = await newSpace(sql);
        const missing = blobKey(
          new Bun.CryptoHasher('sha256').update('never stored').digest('hex'),
        );
        let refused: unknown;
        try {
          await sql.begin((tx) =>
            referenceBlob(tx, store, missing, { kind: 'test_owner', id: 'gone', spaceId }),
          );
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeInstanceOf(BlobNotFound);
        const [row] = await sql<{ count: number }[]>`select count(*)::int as count
          from blob_ref where key = ${missing}`;
        expect(row?.count).toBe(0);
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
