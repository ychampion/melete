/**
 * The blob store's contract, run against every implementation: the local
 * directory always, and an S3-compatible service when MELETE_TEST_S3_ENDPOINT
 * names one (CI runs MinIO for this). Each S3 run writes under its own prefix,
 * so a listing sees only what this run stored.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from 'bun';
import {
  type BlobKey,
  BlobMismatch,
  BlobNotFound,
  type BlobStore,
  BlobTooLarge,
  blobKey,
  readBlob,
  storedHere,
} from './blob.ts';
import { LocalBlobStore } from './local.ts';
import { S3BlobStore } from './s3.ts';

type Subject = {
  name: string;
  make(): BlobStore;
  /** Replace a stored blob's bytes behind the store's back. */
  tamper(store: BlobStore, key: BlobKey, bytes: Uint8Array): Promise<void>;
};

const root = await mkdtemp(join(tmpdir(), 'melete-blobs-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const subjects: Subject[] = [
  {
    name: 'local directory',
    make: () => new LocalBlobStore(join(root, randomUUID())),
    async tamper(store, key, data) {
      const hex = key.slice('sha256/'.length);
      const { root: base } = store as LocalBlobStore;
      await writeFile(join(base, 'sha256', hex.slice(0, 2), hex.slice(2, 4), hex), data);
    },
  },
];

const s3 = s3Settings();
if (s3) subjects.push(s3Subject(s3));

function s3Settings() {
  const endpoint = process.env.MELETE_TEST_S3_ENDPOINT;
  if (!endpoint) return null;
  return {
    endpoint,
    bucket: process.env.MELETE_TEST_S3_BUCKET ?? 'melete-test',
    region: process.env.MELETE_TEST_S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.MELETE_TEST_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.MELETE_TEST_S3_SECRET_ACCESS_KEY ?? '',
  };
}

function s3Subject(settings: NonNullable<ReturnType<typeof s3Settings>>): Subject {
  const raw = new S3Client(settings);
  let prefix = '';
  return {
    name: 'S3-compatible bucket',
    make() {
      prefix = `test-${randomUUID()}`;
      return new S3BlobStore({ ...settings, prefix });
    },
    async tamper(_store, key, data) {
      await raw.write(`${prefix}/${key}`, data);
    },
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array) => new Bun.CryptoHasher('sha256').update(data).digest('hex');

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function listed(store: BlobStore): Promise<string[]> {
  const keys: string[] = [];
  for await (const head of store.list()) keys.push(head.key);
  return keys.sort();
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

for (const subject of subjects)
  describe(`blobs in a ${subject.name}`, () => {
    test('a blob is stored once by content and read back verified', async () => {
      const store = subject.make();
      const content = bytes('the quarterly figures, as of Tuesday');
      const first = await store.put(content);
      const again = await store.put(content);
      const streamed = await store.put(streamOf(content.slice(0, 7), content.slice(7)));

      expect(first).toEqual({
        key: `sha256/${sha256(content)}`,
        size: content.byteLength,
        sha256: sha256(content),
      });
      expect(again).toEqual(first);
      expect(streamed).toEqual(first);
      expect(await listed(store)).toEqual([first.key]);
      expect(await readBlob(store, first.key)).toEqual(content);
      expect(await store.head(first.key)).toMatchObject({
        key: first.key,
        size: content.byteLength,
      });
      // The expected hash is accepted in either case.
      expect(await store.put(content, { sha256: first.sha256.toUpperCase() })).toEqual(first);
    });

    test('a blob whose bytes do not match the expected hash is refused', async () => {
      const store = subject.make();
      const content = bytes('what was approved');
      const other = sha256(bytes('what was sent'));

      expect(await failure(() => store.put(content, { sha256: other }))).toBeInstanceOf(
        BlobMismatch,
      );
      expect(await failure(() => store.put(streamOf(content), { sha256: other }))).toBeInstanceOf(
        BlobMismatch,
      );
      // Nothing is kept under either name.
      expect(await listed(store)).toEqual([]);
      expect(await store.head(blobKey(other))).toBeNull();
    });

    test('a stored blob whose bytes changed is refused when it is read whole', async () => {
      const store = subject.make();
      const stored = await store.put(bytes('the original'));
      await subject.tamper(store, stored.key, bytes('the original, edited'));

      expect(await failure(() => readBlob(store, stored.key))).toBeInstanceOf(BlobMismatch);
    });

    test('storing the right bytes again repairs a blob whose bytes changed, even at the same size', async () => {
      const store = subject.make();
      const content = bytes('the original');
      const stored = await store.put(content);
      await subject.tamper(store, stored.key, bytes('THE ORIGINAL'));
      expect(await failure(() => readBlob(store, stored.key))).toBeInstanceOf(BlobMismatch);

      await store.put(content);
      expect(await readBlob(store, stored.key)).toEqual(content);
    });

    test('storing bytes again marks the blob as freshly written', async () => {
      const store = subject.make();
      const content = bytes('stored long ago, stored again today');
      const stored = await store.put(content);
      const before = await store.head(stored.key);
      // Some stores keep the time to the second.
      await Bun.sleep(1_100);
      await store.put(content);
      const after = await store.head(stored.key);
      expect(after?.modifiedAt.getTime() ?? 0).toBeGreaterThan(before?.modifiedAt.getTime() ?? 0);
    });

    test('only what a put returned can be used to refer to a blob', async () => {
      const store = subject.make();
      const stored = await store.put(bytes('mine to refer to'));
      expect(storedHere(stored)).toBe(true);
      expect(storedHere({ ...stored })).toBe(false);
      expect(Object.isFrozen(stored)).toBe(true);
    });

    test('bytes over the size limit are refused and nothing is kept', async () => {
      const store = subject.make();
      const content = bytes('eleven char');
      expect(await failure(() => store.put(content, { maxBytes: 10 }))).toBeInstanceOf(
        BlobTooLarge,
      );
      expect(
        await failure(() =>
          store.put(streamOf(content.slice(0, 6), content.slice(6)), { maxBytes: 10 }),
        ),
      ).toBeInstanceOf(BlobTooLarge);
      expect(await listed(store)).toEqual([]);
      expect(await store.put(content, { maxBytes: 11 })).toMatchObject({ size: 11 });
    });

    test('a ranged read returns just those bytes', async () => {
      const store = subject.make();
      const stored = await store.put(bytes('0123456789'));
      const part = await new Response(await store.get(stored.key, { start: 2, end: 5 })).text();
      expect(part).toBe('2345');
      const tail = await new Response(await store.get(stored.key, { start: 7 })).text();
      expect(tail).toBe('789');
    });

    test('a deleted blob is gone, and deleting it again succeeds', async () => {
      const store = subject.make();
      const stored = await store.put(bytes('short-lived'));
      await store.delete(stored.key);
      await store.delete(stored.key);
      expect(await store.head(stored.key)).toBeNull();
      expect(await failure(() => store.get(stored.key))).toBeInstanceOf(BlobNotFound);
      expect(await listed(store)).toEqual([]);
    });

    test('a key that is not a sha256 is refused before the store is touched', async () => {
      const store = subject.make();
      for (const key of [
        'sha256/../../../etc/passwd',
        `sha256/${'A'.repeat(64)}`,
        `sha256/${'a'.repeat(63)}`,
        `other/${'a'.repeat(64)}`,
      ] as BlobKey[]) {
        expect(await failure(() => store.get(key))).toBeInstanceOf(Error);
        expect(await failure(() => store.head(key))).toBeInstanceOf(Error);
        expect(await failure(() => store.delete(key))).toBeInstanceOf(Error);
      }
      expect(await failure(() => store.put(bytes('x'), { sha256: 'not-a-hash' }))).toBeInstanceOf(
        Error,
      );
    });
  });

describe('blobs in a local directory', () => {
  test('they are laid out by hash, and a stray file there is not a blob', async () => {
    const store = new LocalBlobStore(join(root, randomUUID()));
    const stored = await store.put(bytes('laid out'));
    const hex = stored.sha256;
    expect(
      (await stat(join(store.root, 'sha256', hex.slice(0, 2), hex.slice(2, 4), hex))).isFile(),
    ).toBe(true);
    // A file in the wrong place, and one whose name is not a hash.
    await mkdir(join(store.root, 'sha256', 'ff', 'ff'), { recursive: true });
    await writeFile(join(store.root, 'sha256', 'ff', 'ff', hex), 'misplaced');
    await writeFile(join(store.root, 'sha256', 'ff', 'ff', 'notes.txt'), 'stray');
    expect(await listed(store)).toEqual([stored.key]);
  });

  test('a partial upload left behind is cleared once it is older than the cutoff', async () => {
    const store = new LocalBlobStore(join(root, randomUUID()));
    await mkdir(join(store.root, 'tmp'), { recursive: true });
    const old = join(store.root, 'tmp', 'old.part');
    const fresh = join(store.root, 'tmp', 'fresh.part');
    await writeFile(old, 'half');
    await writeFile(fresh, 'half');
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(old, weekAgo, weekAgo);

    expect(await store.clearAbandonedUploads(new Date(Date.now() - 60_000))).toBe(1);
    expect(await failure(() => stat(old))).toBeDefined();
    expect((await stat(fresh)).isFile()).toBe(true);
  });
});
