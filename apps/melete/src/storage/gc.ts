/**
 * The blob collector.
 *
 * Once a day it deletes every blob that nothing refers to and that has not
 * been written for the grace period. The grace period covers the gap between
 * a blob being stored and the row that names it being committed. Each delete
 * re-checks under the blob's key lock (`refs.ts`), so a reference added while
 * the collector runs keeps its blob, and the blob's age is read again then,
 * so bytes stored again since the listing are kept too.
 *
 * Several service instances may run it at once: the key lock makes every
 * delete safe however many are deciding. The first pass waits a random part
 * of an hour after start, so restarts and several instances do not each list
 * the whole store at once.
 */
import type { Sql } from 'postgres';
import type { BlobHead, BlobKey, BlobStore } from './blob.ts';
import { lockBlobKey } from './refs.ts';

export const BLOB_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

export type CollectorOptions = {
  sql: Sql;
  store: BlobStore;
  graceMs?: number;
  intervalMs?: number;
  now?: () => Date;
  /** Left out, a random time within the first hour. */
  firstPassDelayMs?: number;
  /** Whether this instance leads collection; another instance's passes are skipped here. */
  leads?: () => boolean | Promise<boolean>;
};

export type Collection = { examined: number; deleted: number; abandonedUploads: number };

export class BlobCollector {
  private readonly graceMs: number;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private running?: Promise<unknown>;

  constructor(private readonly options: CollectorOptions) {
    this.graceMs = options.graceMs ?? BLOB_GRACE_MS;
    this.intervalMs = options.intervalMs ?? DAY_MS;
    this.now = options.now ?? (() => new Date());
  }

  async collect(): Promise<Collection> {
    const cutoff = new Date(this.now().getTime() - this.graceMs);
    const result: Collection = { examined: 0, deleted: 0, abandonedUploads: 0 };
    let batch: BlobHead[] = [];
    for await (const head of this.options.store.list()) {
      result.examined++;
      if (head.modifiedAt >= cutoff) continue;
      batch.push(head);
      if (batch.length >= BATCH) {
        result.deleted += await this.sweep(batch, cutoff);
        batch = [];
      }
    }
    if (batch.length) result.deleted += await this.sweep(batch, cutoff);
    result.abandonedUploads = (await this.options.store.clearAbandonedUploads?.(cutoff)) ?? 0;
    return result;
  }

  private async sweep(candidates: BlobHead[], cutoff: Date): Promise<number> {
    const { sql, store } = this.options;
    const keys = candidates.map((head) => head.key);
    const referenced = new Set(
      (
        await sql<{ key: BlobKey }[]>`select distinct key from blob_ref where key = any(${keys})`
      ).map((row) => row.key),
    );
    let deleted = 0;
    for (const key of keys) {
      if (referenced.has(key)) continue;
      await sql.begin(async (tx) => {
        await lockBlobKey(tx, key, 'exclusive');
        const [row] = await tx<{ present: boolean }[]>`select exists (
            select 1 from blob_ref where key = ${key}
          ) as present`;
        if (row?.present) return;
        const head = await store.head(key);
        if (!head || head.modifiedAt >= cutoff) return;
        await store.delete(key);
        deleted++;
      });
    }
    return deleted;
  }

  /** Collect soon and once a day after, without holding up whoever started it. */
  start(): void {
    if (this.timer || this.first) return;
    const pass = () => {
      if (this.running) return;
      this.running = Promise.resolve(this.options.leads?.() ?? true)
        .then((leading) => (leading ? this.collect() : undefined))
        .catch((error) =>
          process.stderr.write(
            `blob collection failed: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
        )
        .finally(() => {
          this.running = undefined;
        });
    };
    const delay = this.options.firstPassDelayMs ?? Math.floor(Math.random() * 60 * 60 * 1000);
    this.first = setTimeout(() => {
      this.first = undefined;
      pass();
      this.timer = setInterval(pass, this.intervalMs);
      this.timer.unref?.();
    }, delay);
    this.first.unref?.();
  }

  /** Stop the timer and wait for a pass already running. */
  async stop(): Promise<void> {
    clearTimeout(this.first);
    this.first = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
