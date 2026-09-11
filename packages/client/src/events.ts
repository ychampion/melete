/**
 * The resumable event stream.
 *
 * Two facts shape this file. Durable events are persisted before they are
 * streamed, so a reconnect with `Last-Event-ID` replays them from the database
 * and no history is lost. Text deltas are transient, so whatever was streamed
 * while the connection was down is gone for good. The caller is told the
 * difference: a `gap` item means "something you cannot see happened here", and
 * the UI shows an ellipsis rather than pretending the transcript is complete.
 */
import { type MeleteClient, meleteUrl } from './client.ts';
import { readSse } from './sse.ts';
import type { EventType, StoredEvent } from './types.ts';

/** One event as the SSE frame carries it; `dedup_key` is a storage concern. */
export type MeleteEvent = Omit<StoredEvent, 'dedup_key'>;

export type GapReason =
  /** The connection dropped and was reopened. Transient text may be missing. */
  | 'reconnect'
  /** The next event's seq skipped ahead. Durable history is missing. */
  | 'sequence_skip';

export type MeleteStreamItem =
  | { type: 'open'; after: number; attempt: number }
  | { type: 'event'; event: MeleteEvent }
  | { type: 'gap'; after: number; next: number | null; reason: GapReason };

export type SubscribeOptions = {
  /** Follow one job. Omit for the global feed that drives the inbox. */
  jobId?: string;
  /** The last seq already held. Zero, the default, means from the beginning. */
  after?: number;
  /** Server-side filter; the stream still advances the cursor past the rest. */
  types?: EventType[];
  signal?: AbortSignal;
  /** How many times to reopen a dropped stream. Infinite by default. */
  retryAttempts?: number;
  /** Backoff before attempt n (1-based). Injected so tests do not sleep. */
  retryDelayMs?: (attempt: number) => number;
  /** Injected for tests; the default is a cancellable `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const defaultDelay = (attempt: number): number => Math.min(500 * 2 ** (attempt - 1), 15_000);

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

/** Narrow an SSE payload to an event without trusting the server's shape. */
export function parseEventData(data: string): MeleteEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.seq !== 'number' || !Number.isFinite(candidate.seq)) return null;
  if (typeof candidate.type !== 'string') return null;
  return parsed as MeleteEvent;
}

/**
 * Follow the event stream, reopening it as needed, and yield everything the
 * caller needs to render an honest timeline.
 *
 * ```ts
 * for await (const item of subscribeEvents(client, { jobId, after: 0 })) {
 *   if (item.type === 'gap') showEllipsis();
 * }
 * ```
 */
export async function* subscribeEvents(
  client: MeleteClient,
  options: SubscribeOptions = {},
): AsyncGenerator<MeleteStreamItem, void, void> {
  const path = options.jobId ? `/jobs/${encodeURIComponent(options.jobId)}/events` : '/events';
  const maxAttempts = options.retryAttempts ?? Number.POSITIVE_INFINITY;
  const delayMs = options.retryDelayMs ?? defaultDelay;
  const sleep = options.sleep ?? defaultSleep;

  let cursor = options.after ?? 0;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    if (options.signal?.aborted) return;

    if (attempt > 1) {
      // Said before the reopen, so the UI can mark the break at the right place
      // in the transcript rather than after the replayed events land.
      yield { type: 'gap', after: cursor, next: null, reason: 'reconnect' };
      await sleep(delayMs(attempt - 1), options.signal);
      if (options.signal?.aborted) return;
    }

    const headers: Record<string, string> = {
      ...client.options.headers,
      Accept: 'text/event-stream',
    };
    // Both, deliberately: `after` is what a script would use and `Last-Event-ID`
    // is what a browser sends on its own. The server honours either.
    if (cursor > 0) headers['Last-Event-ID'] = String(cursor);

    const url = meleteUrl(client, path, {
      after: cursor,
      ...(options.types?.length ? { types: options.types } : {}),
    });

    let body: ReadableStream<Uint8Array> | null = null;
    try {
      const response = await client.options.fetch(url, {
        method: 'GET',
        headers,
        credentials: client.options.credentials,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) throw new Error(`event stream returned ${response.status}`);
      body = response.body;
      if (!body) throw new Error('event stream returned no body');
    } catch (error) {
      if (isAbort(error) || options.signal?.aborted) return;
      continue;
    }

    yield { type: 'open', after: cursor, attempt };

    try {
      for await (const frame of readSse(body)) {
        if (frame.comment) continue;
        const event = parseEventData(frame.data);
        if (!event) continue;
        // A replayed event the caller already has. Dropping it here keeps the
        // resume rule in one place instead of in every screen.
        if (event.seq <= cursor) continue;
        if (cursor > 0 && event.seq > cursor + 1) {
          yield { type: 'gap', after: cursor, next: event.seq, reason: 'sequence_skip' };
        }
        cursor = event.seq;
        yield { type: 'event', event };
      }
    } catch (error) {
      if (isAbort(error) || options.signal?.aborted) return;
    }

    if (options.signal?.aborted) return;
  }
}

/** Page through the same events without holding a connection open. */
export async function fetchEventPage(
  client: MeleteClient,
  options: { jobId?: string; after?: number; limit?: number } = {},
) {
  const query = { after: options.after ?? 0, limit: options.limit ?? 200 };
  if (options.jobId) {
    return client.api.GET('/jobs/{jobId}/events', {
      params: { path: { jobId: options.jobId }, query },
    });
  }
  return client.api.GET('/events', { params: { query } });
}
