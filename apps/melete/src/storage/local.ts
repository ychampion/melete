/**
 * Blobs in a directory: `<root>/sha256/ab/cd/<hex>`.
 *
 * A write goes to a fresh file under `<root>/tmp`, is hashed as it is written,
 * fsynced, and renamed into place only once its hash is known and checked. A
 * reader therefore sees a whole blob or none, and a process that dies mid-write
 * leaves only a partial file in `tmp`, which the collector clears.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
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
  issueStored,
  type PutOptions,
  type StoredBlob,
  verifiedStream,
} from './blob.ts';

const HEX = /^[0-9a-f]{64}$/;
const PAIR = /^[0-9a-f]{2}$/;

export class LocalBlobStore implements BlobStore {
  readonly kind = 'local' as const;

  constructor(readonly root: string) {}

  private path(key: BlobKey): string {
    const hex = key.slice('sha256/'.length);
    // Refused before any path is built from it.
    if (!HEX.test(hex)) throw new Error('not a blob key');
    return join(this.root, 'sha256', hex.slice(0, 2), hex.slice(2, 4), hex);
  }

  async put(
    body: Uint8Array | ReadableStream<Uint8Array>,
    options?: PutOptions,
  ): Promise<StoredBlob> {
    const expected = expectedSha256(options);
    const uploads = join(this.root, 'tmp');
    try {
      await mkdir(uploads, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error(
        `the blob store cannot write under MELETE_ARTIFACTS_DIR (${this.root}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const partial = join(uploads, `${randomUUID()}.part`);
    const hasher = new Bun.CryptoHasher('sha256');
    let size = 0;
    const file = await open(
      partial,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    let kept = false;
    try {
      try {
        const chunks = body instanceof Uint8Array ? [body] : body;
        for await (const chunk of chunks) {
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
        await file.sync();
      } finally {
        await file.close();
      }
      const sha256 = hasher.digest('hex');
      if (expected !== undefined && sha256 !== expected) throw new BlobMismatch(expected, sha256);
      const key = blobKey(sha256);
      const target = this.path(key);
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      try {
        // Replacing a file already there marks the blob as freshly written,
        // which the collector's grace period counts from, and repairs one
        // whose bytes had changed.
        await rename(partial, target);
        kept = true;
        await syncDirectory(join(target, '..'));
      } catch (error) {
        // Windows will not replace a file another reader holds open. What is
        // there is kept, and marked as freshly written.
        if (!(await exists(target))) throw error;
        const now = new Date();
        await utimes(target, now, now);
      }
      return issueStored({ key, size, sha256 });
    } finally {
      if (!kept) await unlink(partial).catch(() => {});
    }
  }

  async get(key: BlobKey, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const file = Bun.file(this.path(key));
    if (!(await file.exists())) throw new BlobNotFound(key);
    if (range)
      return file.slice(range.start, range.end === undefined ? undefined : range.end + 1).stream();
    return verifiedStream(file.stream(), key);
  }

  async head(key: BlobKey): Promise<BlobHead | null> {
    try {
      const found = await stat(this.path(key));
      return { key, size: found.size, modifiedAt: found.mtime };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: BlobKey): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async *list(): AsyncIterable<BlobHead> {
    const base = join(this.root, 'sha256');
    for (const first of await entries(base)) {
      if (!PAIR.test(first)) continue;
      for (const second of await entries(join(base, first))) {
        if (!PAIR.test(second)) continue;
        for (const name of await entries(join(base, first, second))) {
          // Only a file in the place its own name puts it is a blob.
          if (!HEX.test(name) || name.slice(0, 2) !== first || name.slice(2, 4) !== second)
            continue;
          const head = await this.head(blobKey(name));
          if (head) yield head;
        }
      }
    }
  }

  async clearAbandonedUploads(before: Date): Promise<number> {
    const uploads = join(this.root, 'tmp');
    let cleared = 0;
    for (const name of await entries(uploads)) {
      if (!name.endsWith('.part')) continue;
      const path = join(uploads, name);
      try {
        if ((await stat(path)).mtime >= before) continue;
        await unlink(path);
        cleared++;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return cleared;
  }
}

async function entries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** So a rename survives a crash; directories cannot be opened for this on Windows. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
