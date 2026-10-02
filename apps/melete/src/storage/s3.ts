/**
 * Blobs in an S3-compatible bucket, through Bun's own S3 client.
 *
 * The object key is the blob key under an optional prefix. Bytes given in
 * memory are hashed before anything is sent; a stream is spooled to a private
 * temporary file while it is hashed, because the object's name is its hash and
 * is not known until the last byte. The object is written on every put, even
 * when one is already there under that name: that marks it as freshly written,
 * which the collector's grace period counts from, and replaces one whose
 * bytes had changed.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from 'bun';
import {
  type BlobHead,
  type BlobKey,
  BlobMismatch,
  BlobNotFound,
  type BlobStore,
  BlobTooLarge,
  type ByteRange,
  blobKey,
  expectedSha256,
  isBlobKey,
  issueStored,
  type PutOptions,
  type StoredBlob,
  verifiedStream,
} from './blob.ts';

export type S3BlobOptions = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Left out, the AWS endpoint for the region. */
  endpoint?: string;
  prefix?: string;
};

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(options: S3BlobOptions) {
    this.client = new S3Client({
      bucket: options.bucket,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });
    const prefix = options.prefix?.replace(/\/+$/, '') ?? '';
    this.prefix = prefix ? `${prefix}/` : '';
  }

  private object(key: BlobKey): string {
    // Refused before any object name is built from it.
    if (!isBlobKey(key)) throw new Error('not a blob key');
    return `${this.prefix}${key}`;
  }

  async put(
    body: Uint8Array | ReadableStream<Uint8Array>,
    options?: PutOptions,
  ): Promise<StoredBlob> {
    const expected = expectedSha256(options);
    if (body instanceof Uint8Array) {
      if (options?.maxBytes !== undefined && body.byteLength > options.maxBytes)
        throw new BlobTooLarge(options.maxBytes);
      const sha256 = new Bun.CryptoHasher('sha256').update(body).digest('hex');
      if (expected !== undefined && sha256 !== expected) throw new BlobMismatch(expected, sha256);
      return this.send(blobKey(sha256), body.byteLength, body);
    }
    const directory = await mkdtemp(join(tmpdir(), 'melete-blob-'));
    try {
      const spool = join(directory, `${randomUUID()}.part`);
      const hasher = new Bun.CryptoHasher('sha256');
      let size = 0;
      const file = await open(
        spool,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        for await (const chunk of body) {
          size += chunk.byteLength;
          if (options?.maxBytes !== undefined && size > options.maxBytes)
            throw new BlobTooLarge(options.maxBytes);
          hasher.update(chunk);
          let written = 0;
          while (written < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, written);
            written += bytesWritten;
          }
        }
      } finally {
        await file.close();
      }
      const sha256 = hasher.digest('hex');
      if (expected !== undefined && sha256 !== expected) throw new BlobMismatch(expected, sha256);
      return await this.send(blobKey(sha256), size, Bun.file(spool));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async send(key: BlobKey, size: number, bytes: Uint8Array | Blob): Promise<StoredBlob> {
    await this.client.write(this.object(key), bytes, { type: 'application/octet-stream' });
    return issueStored({ key, size, sha256: key.slice('sha256/'.length) });
  }

  async get(key: BlobKey, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const file = this.client.file(this.object(key));
    if (!(await file.exists())) throw new BlobNotFound(key);
    if (range)
      return file.slice(range.start, range.end === undefined ? undefined : range.end + 1).stream();
    return verifiedStream(file.stream(), key);
  }

  async head(key: BlobKey): Promise<BlobHead | null> {
    const file = this.client.file(this.object(key));
    try {
      const found = await file.stat();
      return { key, size: found.size, modifiedAt: new Date(found.lastModified) };
    } catch (error) {
      // A HEAD has no body to carry an error code, so a miss is confirmed by asking.
      if (!(await file.exists())) return null;
      throw error;
    }
  }

  async delete(key: BlobKey): Promise<void> {
    // S3 answers a delete of a missing object with success.
    await this.client.delete(this.object(key));
  }

  async *list(): AsyncIterable<BlobHead> {
    let continuationToken: string | undefined;
    do {
      const page = await this.client.list({
        prefix: `${this.prefix}sha256/`,
        maxKeys: 1000,
        ...(continuationToken ? { continuationToken } : {}),
      });
      for (const entry of page.contents ?? []) {
        const key = entry.key.slice(this.prefix.length);
        if (!isBlobKey(key)) continue;
        yield {
          key,
          size: entry.size ?? 0,
          modifiedAt: entry.lastModified ? new Date(entry.lastModified) : new Date(0),
        };
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
  }
}
