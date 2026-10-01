/**
 * A live conversation stream reads new events when a commit says one may have
 * landed, rather than on its next poll, and still polls when nothing says so.
 */
import { expect, test } from 'bun:test';
import type { ExperienceEvent } from '@melete/contracts';
import type { Database } from '../db/client.ts';
import { EXPERIENCE_POLL_MS, ExperienceEvents } from './events.ts';

const AT = '2026-09-30T09:00:00.000Z';
const event = (seq: number): ExperienceEvent => ({
  seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item: { type: 'text_delta', text: `piece ${seq}` },
});

/** The stream over an in-memory page, with commit notifications the test sends. */
function harness(options: { notify: boolean }) {
  const store: ExperienceEvent[] = [];
  const listeners = new Set<() => void>();
  const changes = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  class Events extends ExperienceEvents {
    override async page(_spaceId: string, after: number) {
      const events = store.filter((item) => item.seq > after);
      return { events, next_cursor: events.at(-1)?.seq ?? after, has_more: false };
    }
  }
  const events = new Events(
    undefined as unknown as Database,
    undefined,
    options.notify ? changes : undefined,
  );
  const commit = (seq: number) => {
    store.push(event(seq));
    for (const listener of listeners) listener();
  };
  return { events, commit, listeners };
}

async function firstEvent(response: Response): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('stream ended');
    buffer += decoder.decode(chunk.value);
    const match = /^id: (\d+)$/m.exec(buffer);
    if (match) {
      await reader.cancel();
      return Number(match[1]);
    }
  }
}

test('a committed event reaches a waiting stream well before the next poll', async () => {
  const { events, commit, listeners } = harness({ notify: true });
  const controller = new AbortController();
  const response = await events.response('space_1', 0, controller.signal, 'job_1', 'own_1');
  const reading = firstEvent(response);
  await Bun.sleep(100);
  const started = performance.now();
  commit(1);
  expect(await reading).toBe(1);
  expect(performance.now() - started).toBeLessThan(EXPERIENCE_POLL_MS / 2);
  controller.abort();
  // A closed stream stops listening.
  expect(listeners.size).toBe(0);
});

test('without notifications the stream still finds the event on its poll', async () => {
  const { events, commit } = harness({ notify: false });
  const controller = new AbortController();
  const response = await events.response('space_1', 0, controller.signal, 'job_1', 'own_1');
  const reading = firstEvent(response);
  await Bun.sleep(100);
  commit(1);
  expect(await reading).toBe(1);
  controller.abort();
}, 5_000);
