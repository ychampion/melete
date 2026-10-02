/**
 * Write-once bytes, kept by what they are.
 *
 * A blob's key is the sha256 of its bytes, so the same bytes are stored once
 * however many things refer to them, and a reader can tell whether what came
 * back is what was stored. Keys have exactly one shape, `sha256/<64 hex>`, and
 * every implementation refuses any other before it touches storage, which is
 * what keeps a key from naming a path or an object outside the store.
 *
 * Who still needs a blob is recorded beside it in Postgres (`refs.ts`), and
 * the collector (`gc.ts`) deletes what nothing has needed for a while.
 */
import type { Env } from '../env.ts';
import { LocalBlobStore } from './local.ts';
import { S3BlobStore } from './s3.ts';

export type BlobKey = `sha256/${string}`;

export type StoredBlob = { key: BlobKey; size: number; sha256: string };

export type BlobHead = { key: BlobKey; size: number; modifiedAt: Date };

export type PutOptions = {
  /** The bytes are refused, and nothing is kept, unless they hash to this. */
  sha256?: string;
  /** The bytes are refused once they pass this many. */
  maxBytes?: number;
};

/** An inclusive byte range, as in an HTTP Range header. */
export type ByteRange = { start: number; end?: number };

export interface BlobStore {
  readonly kind: 'local' | 's3';
  /** Store the bytes, or find them already stored. Either way they are there when this returns. */
  put(body: Uint8Array | ReadableStream<Uint8Array>, options?: PutOptions): Promise<StoredBlob>;
  /**
   * The bytes, as a stream. A whole read is hashed as it goes and errors at
   * the end if the bytes are not the ones the key names. A ranged read cannot
   * be checked that way, so its caller checks what it needs to.
   */
  get(key: BlobKey, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  /** Null when there is no such blob. */
  head(key: BlobKey): Promise<BlobHead | null>;
  /** Deleting a blob that is not there succeeds. */
  delete(key: BlobKey): Promise<void>;
  /** Every blob in the store, in no particular order. */
  list(): AsyncIterable<BlobHead>;
  /** Partial uploads left by a process that died mid-write, older than `before`. */
  clearAbandonedUploads?(before: Date): Promise<number>;
}

export class BlobMismatch extends Error {
  readonly code = 'blob_mismatch';
  constructor(expected: string, actual: string) {
    super(`the bytes hash to ${actual}, not the expected ${expected}`);
  }
}

export class BlobNotFound extends Error {
  readonly code = 'blob_not_found';
  constructor(readonly key: string) {
    super(`no blob ${key}`);
  }
}

export class BlobTooLarge extends Error {
  readonly code = 'blob_too_large';
  constructor(readonly maxBytes: number) {
    super(`the bytes are larger than ${maxBytes}`);
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const KEY = /^sha256\/([0-9a-f]{64})$/;

export function isBlobKey(value: string): value is BlobKey {
  return KEY.test(value);
}

/** The key for a sha256, refusing anything that is not one. */
export function blobKey(sha256: string): BlobKey {
  if (!SHA256.test(sha256)) throw new Error('a blob key needs a lowercase hex sha256');
  return `sha256/${sha256}`;
}

/** The sha256 a key names, refusing anything that is not a key. */
export function keySha256(key: string): string {
  const match = KEY.exec(key);
  if (!match?.[1]) throw new Error('not a blob key');
  return match[1];
}

/** Checks an expected hash before any bytes are read, so a malformed one fails at once. */
export function expectedSha256(options: PutOptions | undefined): string | undefined {
  if (options?.sha256 === undefined) return undefined;
  const expected = options.sha256.toLowerCase();
  if (!SHA256.test(expected)) throw new Error('an expected sha256 is 64 hex characters');
  return expected;
}

/**
 * Pass the bytes through while hashing them, and error the stream at its end
 * if they are not the bytes the key names. The reader sees every chunk before
 * the verdict, so whoever serves them must not treat the response as finished
 * until the stream has closed without an error.
 */
export function verifiedStream(
  source: ReadableStream<Uint8Array>,
  key: BlobKey,
): ReadableStream<Uint8Array> {
  const expected = keySha256(key);
  const hasher = new Bun.CryptoHasher('sha256');
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hasher.update(chunk);
        controller.enqueue(chunk);
      },
      flush(controller) {
        const actual = hasher.digest('hex');
        if (actual !== expected) controller.error(new BlobMismatch(expected, actual));
      },
    }),
  );
}

/** A whole blob in memory, checked against its key. */
export async function readBlob(store: BlobStore, key: BlobKey): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await store.get(key)).arrayBuffer());
}

/** The store this installation is configured for. Nothing is created until the first write. */
export function configuredBlobStore(env: Env): BlobStore {
  if (env.MELETE_BLOB_STORE === 'local') return new LocalBlobStore(env.MELETE_ARTIFACTS_DIR);
  const bucket = env.MELETE_BLOB_S3_BUCKET;
  const accessKeyId = env.MELETE_BLOB_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.MELETE_BLOB_S3_SECRET_ACCESS_KEY;
  // The environment schema already refuses s3 without these; this keeps the types honest.
  if (!bucket || !accessKeyId || !secretAccessKey)
    throw new Error('MELETE_BLOB_STORE=s3 needs a bucket and its access keys');
  return new S3BlobStore({
    bucket,
    region: env.MELETE_BLOB_S3_REGION,
    accessKeyId,
    secretAccessKey,
    ...(env.MELETE_BLOB_S3_ENDPOINT ? { endpoint: env.MELETE_BLOB_S3_ENDPOINT } : {}),
    ...(env.MELETE_BLOB_S3_PREFIX ? { prefix: env.MELETE_BLOB_S3_PREFIX } : {}),
  });
}
