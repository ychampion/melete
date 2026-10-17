import { afterEach, describe, expect, test } from 'bun:test';
import { client, type StreamItem, subscribeConversation, waitToReconnect } from './adapter.ts';

const encoder = new TextEncoder();
const original = client.options.fetch;

/** A stream that sends these events, then stays open and silent. */
const silentAfter = (seqs: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const seq of seqs)
        controller.enqueue(
          encoder.encode(`id: ${seq}\ndata: ${JSON.stringify({ seq, item: { type: 'x' } })}\n\n`),
        );
    },
  });

afterEach(() => {
  (client.options as { fetch: typeof fetch }).fetch = original;
});

describe('following a conversation through a dropped connection', () => {
  test('a stream that goes silent is reopened from where it stopped', async () => {
    const asked: string[] = [];
    const replies = [silentAfter([1, 2]), silentAfter([3])];
    (client.options as { fetch: typeof fetch }).fetch = (async (url: string) => {
      asked.push(String(url));
      const body = replies.shift();
      return body ? new Response(body, { status: 200 }) : new Response(null, { status: 503 });
    }) as typeof fetch;
    const stop = new AbortController();
    const seen: string[] = [];
    for await (const item of subscribeConversation('cnv_1', { signal: stop.signal, idleMs: 60 })) {
      seen.push(describeItem(item));
      if (item.type === 'event' && item.event.seq === 3) stop.abort();
    }
    expect(seen).toEqual(['open', 'event 1', 'event 2', 'gap after 2', 'open', 'event 3']);
    expect(asked[0]).toContain('since=0');
    expect(asked[1]).toContain('since=2');
  });

  test('coming back online ends the wait before a retry', async () => {
    const target = new EventTarget();
    const started = Date.now();
    const waiting = waitToReconnect(10_000, undefined, target);
    setTimeout(() => target.dispatchEvent(new Event('online')), 20);
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('aborting ends the wait', async () => {
    const stop = new AbortController();
    const waiting = waitToReconnect(10_000, stop.signal, new EventTarget());
    stop.abort();
    await waiting;
  });
});

function describeItem(item: StreamItem): string {
  if (item.type === 'open') return 'open';
  if (item.type === 'gap') return `gap after ${item.gap.after}`;
  return `event ${item.event.seq}`;
}
