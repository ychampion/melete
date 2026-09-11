import { type ApiEvent, apiEvent, SSE_KEEPALIVE, sseFrame } from '@melete/contracts';
import { and, asc, eq, gt } from 'drizzle-orm';
import postgres from 'postgres';
import { ZodError } from 'zod';
import type { DatabaseHandle } from '../db/client.ts';
import { event } from '../db/schema.ts';

export const EVENT_CHANNEL = 'melete_events';
export type EventStreamOptions = {
  pageSize?: number;
  pollIntervalMs?: number;
  keepaliveMs?: number;
};
export type EventSubscription = { after: number; jobId?: string; signal?: AbortSignal };

type Client = { notify: () => void; close: () => void; buffered: () => number };

/** The frame still carries the real persisted notice and its real sequence ID. */
export function persistedFrame(value: ApiEvent): string {
  const frame = sseFrame(value);
  return value.type === 'notice' && value.payload.kind === 'gap'
    ? frame.replace('\nevent: notice\n', '\nevent: gap\n')
    : frame;
}

/**
 * One LISTEN connection signals all clients; Postgres remains their only event
 * queue. Polling repairs missed notifications, including LISTEN reconnect gaps.
 * Each consumer owns a cursor and at most one page, independent of other clients.
 */
export class EventStream {
  private listener: ReturnType<typeof postgres> | undefined;
  private listening: { unlisten: () => Promise<void> } | undefined;
  private starting: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly clients = new Set<Client>();
  private stopped = false;
  private readonly pageSize: number;
  private readonly pollIntervalMs: number;
  private readonly keepaliveMs: number;

  constructor(
    private readonly handle: DatabaseHandle,
    options: EventStreamOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 200;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.keepaliveMs = options.keepaliveMs ?? 20_000;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 1000) {
      throw new Error('event page size must be between 1 and 1000');
    }
    if (
      !Number.isFinite(this.pollIntervalMs) ||
      this.pollIntervalMs < 1 ||
      this.pollIntervalMs > 1000
    ) {
      throw new Error('event polling interval must be between 1 and 1000 ms');
    }
    if (!Number.isFinite(this.keepaliveMs) || this.keepaliveMs < 1) {
      throw new Error('event keepalive interval must be positive');
    }
  }

  get subscriberCount(): number {
    return this.clients.size;
  }
  get bufferedEventCount(): number {
    return [...this.clients].reduce((count, client) => count + client.buffered(), 0);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('event stream is closed');
    if (this.starting) return this.starting;
    if (this.listener) return;
    // postgres.js itself clones these parsed options for LISTEN. Keeping them
    // intact preserves authenticated multi-host configuration without exposing it.
    const listener = postgres({
      ...this.handle.sql.options,
      max: 1,
      connect_timeout: 2,
      idle_timeout: null,
      max_lifetime: null,
      connection: { ...this.handle.sql.options.connection, application_name: 'melete-events' },
    } as unknown as postgres.Options<Record<string, postgres.PostgresType>>);
    this.listener = listener;
    this.starting = (async () => {
      try {
        this.listening = await listener.listen(
          EVENT_CHANNEL,
          () => this.notify(),
          () => this.notify(),
        );
      } catch {
        // A healthy query pool can still replay while a separate LISTEN socket
        // is unavailable. The polling timer retries the subscription as well.
        await listener.end({ timeout: 0 });
        if (this.listener === listener) this.listener = undefined;
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private notify(): void {
    for (const client of this.clients) client.notify();
  }

  private add(client: Client): void {
    this.clients.add(client);
    if (this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => {
      this.notify();
      if (!this.listener && !this.starting && !this.stopped) void this.start().catch(() => {});
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  private remove(client: Client): void {
    this.clients.delete(client);
    if (this.clients.size === 0 && this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async page(after: number, jobId?: string): Promise<ApiEvent[]> {
    const rows = await this.handle.db
      .select()
      .from(event)
      .where(and(gt(event.seq, after), jobId === undefined ? undefined : eq(event.jobId, jobId)))
      .orderBy(asc(event.seq))
      .limit(this.pageSize);
    return rows.map((row) =>
      apiEvent.parse({
        seq: row.seq,
        job_id: row.jobId,
        attempt_id: row.attemptId,
        type: row.type,
        payload: row.payload,
        dedup_key: row.dedupKey,
        created_at: row.createdAt.toISOString(),
      }),
    );
  }

  async response(subscription: EventSubscription): Promise<Response> {
    if (!Number.isSafeInteger(subscription.after) || subscription.after < 0) {
      throw new Error('event cursor must be a nonnegative safe integer');
    }
    await this.start();
    if (this.stopped) throw new Error('event stream is closed');
    let cursor = subscription.after;
    let buffered: ApiEvent[] = [];
    let closed = false;
    let change = 0;
    let waiting: (() => void) | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let lastWrite = Date.now();
    const encoder = new TextEncoder();
    const notify = () => {
      change++;
      waiting?.();
      waiting = undefined;
    };
    const cleanup = (closeController: boolean) => {
      if (closed) return;
      closed = true;
      buffered = [];
      subscription.signal?.removeEventListener('abort', onAbort);
      this.remove(client);
      notify();
      if (closeController) controller?.close();
    };
    const onAbort = () => cleanup(true);
    const client: Client = { notify, close: () => cleanup(true), buffered: () => buffered.length };
    const waitForChange = (observed: number) =>
      new Promise<void>((resolve) => {
        if (closed || change !== observed) resolve();
        else waiting = resolve;
      });
    const body = new ReadableStream<Uint8Array>(
      {
        start: (value) => {
          controller = value;
          this.add(client);
          subscription.signal?.addEventListener('abort', onAbort, { once: true });
          if (subscription.signal?.aborted) onAbort();
        },
        pull: async (value) => {
          while (!closed) {
            const next = buffered.shift();
            if (next) {
              cursor = next.seq;
              value.enqueue(encoder.encode(persistedFrame(next)));
              lastWrite = Date.now();
              return;
            }
            const observed = change;
            try {
              buffered = await this.page(cursor, subscription.jobId);
            } catch (error) {
              if (closed) return;
              if (error instanceof ZodError) {
                cleanup(false);
                value.error(error);
                return;
              }
              await waitForChange(observed);
              continue;
            }
            if (closed) {
              buffered = [];
              return;
            }
            if (buffered.length) continue;
            if (Date.now() - lastWrite >= this.keepaliveMs) {
              value.enqueue(encoder.encode(SSE_KEEPALIVE));
              lastWrite = Date.now();
              return;
            }
            // Rechecking the notification generation closes the race between an
            // empty SELECT and registering the waiter for the next notification.
            await waitForChange(observed);
          }
        },
        cancel: () => cleanup(false),
      },
      { highWaterMark: 1 },
    );
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const client of [...this.clients]) client.close();
    await this.starting;
    try {
      await this.listening?.unlisten();
    } catch {
      /* The connection may already be gone. */
    }
    await this.listener?.end({ timeout: 1 });
    this.listening = undefined;
    this.listener = undefined;
  }
}
