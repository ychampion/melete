import { describe, expect, test } from 'bun:test';
import { createMeleteClient } from './client.ts';
import { type MeleteStreamItem, subscribeEvents } from './events.ts';

type Opened = { url: string; headers: Record<string, string> };

const frame = (seq: number, type: string, payload: Record<string, unknown> = {}): string =>
  `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({
    seq,
    job_id: 'job_01J000000000000000000000',
    attempt_id: null,
    type,
    payload,
    created_at: '2026-09-11T12:00:00.000Z',
  })}\n\n`;

const body = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

/** Serves one scripted response per connection, recording how each was opened. */
function streamingFetch(responses: string[]) {
  const opened: Opened[] = [];
  let index = 0;
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    opened.push({ url: String(input), headers });
    const text = responses[index] ?? '';
    index += 1;
    return new Response(body(text), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, opened };
}

const collect = async (
  iterator: AsyncGenerator<MeleteStreamItem, void, void>,
): Promise<MeleteStreamItem[]> => {
  const items: MeleteStreamItem[] = [];
  for await (const item of iterator) items.push(item);
  return items;
};

const noSleep = async () => {};

describe('subscribeEvents', () => {
  test('yields events in order and opens the job stream', async () => {
    const { fetch, opened } = streamingFetch([
      frame(1, 'job_created') + frame(2, 'attempt_started'),
    ]);
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const items = await collect(
      subscribeEvents(client, {
        jobId: 'job_01J000000000000000000000',
        retryAttempts: 1,
        sleep: noSleep,
      }),
    );

    expect(items[0]).toEqual({ type: 'open', after: 0, attempt: 1 });
    expect(items.slice(1).map((i) => (i.type === 'event' ? i.event.type : i.type))).toEqual([
      'job_created',
      'attempt_started',
    ]);
    const url = new URL(opened[0]?.url ?? '');
    expect(url.pathname).toBe('/jobs/job_01J000000000000000000000/events');
    expect(url.searchParams.get('after')).toBe('0');
    expect(opened[0]?.headers.accept).toBe('text/event-stream');
    expect(opened[0]?.headers['last-event-id']).toBeUndefined();
  });

  test('follows the global feed when no job is named', async () => {
    const { fetch, opened } = streamingFetch([frame(1, 'notice')]);
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    await collect(subscribeEvents(client, { retryAttempts: 1, sleep: noSleep }));

    expect(new URL(opened[0]?.url ?? '').pathname).toBe('/events');
  });

  test('marks a reconnect as a gap and resumes with Last-Event-ID', async () => {
    const { fetch, opened } = streamingFetch([
      frame(1, 'text_delta', { text: 'Reading' }),
      frame(2, 'text_delta', { text: 'Drafting' }),
    ]);
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const items = await collect(
      subscribeEvents(client, {
        jobId: 'job_01J000000000000000000000',
        retryAttempts: 2,
        sleep: noSleep,
      }),
    );

    const gaps = items.filter((i) => i.type === 'gap');
    expect(gaps).toEqual([{ type: 'gap', after: 1, next: null, reason: 'reconnect' }]);
    expect(opened[1]?.headers['last-event-id']).toBe('1');
    expect(new URL(opened[1]?.url ?? '').searchParams.get('after')).toBe('1');
    expect(items.filter((i) => i.type === 'event')).toHaveLength(2);
  });

  test('drops events the caller already has when the server replays them', async () => {
    const { fetch } = streamingFetch([
      frame(1, 'job_created'),
      frame(1, 'job_created') + frame(2, 'notice'),
    ]);
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const items = await collect(subscribeEvents(client, { retryAttempts: 2, sleep: noSleep }));

    const seqs = items.flatMap((i) => (i.type === 'event' ? [i.event.seq] : []));
    expect(seqs).toEqual([1, 2]);
  });

  test('reports a skipped sequence as a gap with both ends', async () => {
    const { fetch } = streamingFetch([frame(1, 'job_created') + frame(5, 'notice')]);
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const items = await collect(subscribeEvents(client, { retryAttempts: 1, sleep: noSleep }));

    expect(items.filter((i) => i.type === 'gap')).toEqual([
      { type: 'gap', after: 1, next: 5, reason: 'sequence_skip' },
    ]);
  });

  test('starts after the cursor the caller already holds', async () => {
    const { fetch, opened } = streamingFetch([frame(9, 'notice')]);
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const items = await collect(
      subscribeEvents(client, { after: 8, retryAttempts: 1, sleep: noSleep }),
    );

    expect(opened[0]?.headers['last-event-id']).toBe('8');
    expect(items[0]).toEqual({ type: 'open', after: 8, attempt: 1 });
    expect(items.filter((i) => i.type === 'event')).toHaveLength(1);
  });

  test('ignores keepalives and unparsable frames', async () => {
    const { fetch } = streamingFetch([`: keepalive\n\ndata: not json\n\n${frame(1, 'notice')}`]);
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const items = await collect(subscribeEvents(client, { retryAttempts: 1, sleep: noSleep }));

    expect(items.filter((i) => i.type === 'event')).toHaveLength(1);
  });

  test('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const { fetch, opened } = streamingFetch([frame(1, 'notice'), frame(2, 'notice')]);
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const items: MeleteStreamItem[] = [];
    for await (const item of subscribeEvents(client, {
      retryAttempts: 5,
      sleep: noSleep,
      signal: controller.signal,
    })) {
      items.push(item);
      if (item.type === 'event') controller.abort();
    }

    expect(opened).toHaveLength(1);
    expect(items.filter((i) => i.type === 'event')).toHaveLength(1);
  });

  test('retries a failed open without inventing events', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection refused');
      return new Response(body(frame(1, 'notice')), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const items = await collect(subscribeEvents(client, { retryAttempts: 2, sleep: noSleep }));

    expect(calls).toBe(2);
    expect(items.filter((i) => i.type === 'event')).toHaveLength(1);
  });
});
