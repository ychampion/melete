import {
  type ApiEvent,
  type ResponsibilityEvent,
  responsibilityEvent,
  SSE_KEEPALIVE,
} from '@melete/contracts';
import { and, asc, eq, gt } from 'drizzle-orm';
import postgres from 'postgres';
import { ZodError } from 'zod';
import { ServiceError } from '../api/errors.ts';
import type { DatabaseHandle } from '../db/client.ts';
import { event } from '../db/schema.ts';
import { visibleJob } from '../principals/authority.ts';
import { EventProtocol } from './protocol.ts';

export const EVENT_CHANNEL = 'melete_events';
export type EventStreamOptions = {
  pageSize?: number;
  pollIntervalMs?: number;
  keepaliveMs?: number;
};
export type EventSubscription = {
  principalId?: string;
  after: number;
  jobId?: string;
  signal?: AbortSignal;
  epoch?: number;
  resync?: boolean;
};

type Client = { notify: () => void; close: () => void; buffered: () => number };

/** The frame still carries the real persisted notice and its real sequence ID. */
export function persistedFrame(value: ApiEvent | ResponsibilityEvent): string {
  const { dedup_key: _dedupKey, ...data } = value;
  const name = value.type === 'notice' && value.payload.kind === 'gap' ? 'gap' : value.type;
  return `id: ${value.seq}\nevent: ${name}\ndata: ${JSON.stringify({ ...data, cursor: value.seq, epoch: 'epoch' in value ? value.epoch : null })}\n\n`;
}

/**
 * One LISTEN connection signals all clients; Postgres remains their only event
 * queue. Polling repairs missed notifications, including LISTEN reconnect gaps.
 * Each consumer owns a cursor and at most one page, independent of other clients.
 */
export class EventStream {
  readonly protocol: EventProtocol;
  private listener: ReturnType<typeof postgres> | undefined;
  private listening: { unlisten: () => Promise<void> } | undefined;
  private starting: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly clients = new Set<Client>();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly pageSize: number;
  private readonly pollIntervalMs: number;
  private readonly keepaliveMs: number;

  constructor(
    private readonly handle: DatabaseHandle,
    options: EventStreamOptions = {},
  ) {
    this.protocol = new EventProtocol(handle.db);
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

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
    }
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

  private async page(
    after: number,
    jobId?: string,
    principalId?: string,
  ): Promise<ResponsibilityEvent[]> {
    const rows = await this.handle.db
      .select()
      .from(event)
      .where(
        and(
          gt(event.seq, after),
          jobId === undefined ? undefined : eq(event.jobId, jobId),
          visibleJob(event.jobId, principalId),
        ),
      )
      .orderBy(asc(event.seq))
      .limit(this.pageSize);
    return rows.map((row) =>
      responsibilityEvent.parse({
        seq: row.seq,
        cursor: row.seq,
        epoch: row.epoch,
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
    const initial = await this.query(() =>
      this.protocol.handshake(
        subscription.after,
        subscription.jobId,
        subscription.epoch,
        subscription.resync,
        subscription.principalId,
      ),
    );
    if (this.stopped) throw new Error('event stream is closed');
    let cursor = subscription.after;
    let epoch = initial.epoch;
    let controls = initial.frames;
    if (controls.length) cursor = initial.cursor;
    let buffered: ResponsibilityEvent[] = [];
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
      controls = [];
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
            const control = controls.shift();
            if (control) {
              // Refresh snapshots just before delivery; buffered controls cannot preserve revoked bytes.
              let frame = control;
              if (subscription.principalId && control.includes('event: reset\n')) {
                const fresh = await this.query(() =>
                  this.protocol.handshake(
                    cursor,
                    subscription.jobId,
                    epoch,
                    true,
                    subscription.principalId,
                  ),
                ).catch(() => null);
                if (!fresh) {
                  cleanup(true);
                  return;
                }
                frame = fresh.frames.at(-1) ?? control;
                cursor = fresh.cursor;
              }
              value.enqueue(encoder.encode(frame));
              lastWrite = Date.now();
              return;
            }
            const next = buffered.shift();
            if (next) {
              cursor = next.seq;
              if (subscription.principalId) {
                const [allowed] = await this.query(() =>
                  this.handle.db
                    .select({ seq: event.seq })
                    .from(event)
                    .where(
                      and(
                        eq(event.seq, next.seq),
                        visibleJob(event.jobId, subscription.principalId),
                      ),
                    ),
                );
                if (!allowed) continue;
              }
              value.enqueue(encoder.encode(persistedFrame(next)));
              lastWrite = Date.now();
              return;
            }
            const observed = change;
            try {
              const position = await this.query(() =>
                this.protocol.handshake(
                  cursor,
                  subscription.jobId,
                  epoch,
                  false,
                  subscription.principalId,
                ),
              );
              if (closed) return;
              epoch = position.epoch;
              if (position.frames.length) {
                cursor = position.cursor;
                controls = position.frames;
                continue;
              }
              buffered = await this.query(() =>
                this.page(cursor, subscription.jobId, subscription.principalId),
              );
            } catch (error) {
              if (closed) return;
              if (error instanceof ServiceError && error.code === 'scope_denied') {
                cleanup(true);
                return;
              }
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
    // Cancelling a reader does not cancel its SQL; drain it before releasing shared resources.
    await Promise.allSettled([...this.pending]);
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
