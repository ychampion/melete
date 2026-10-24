/**
 * A live conversation stream reads new events when a commit says one may have
 * landed, rather than on its next poll, and still polls when nothing says so.
 */
import { expect, test } from 'bun:test';
import type { ExperienceEvent } from '@melete/contracts';
import type { Database } from '../db/client.ts';
import { EXPERIENCE_POLL_MS, EXPERIENCE_READ_GAP_MS, ExperienceEvents } from './events.ts';

const AT = '2026-09-30T09:00:00.000Z';
const event = (seq: number): ExperienceEvent => ({
  seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item: { type: 'text_delta', text: `piece ${seq}` },
});

/**
 * The stream over an in-memory page, with commit notifications the test sends.
 * Committed events are already projected, so the projector only tells the
 * conversation's streams; `raw` commits need projecting, which the stream does.
 */
function harness(options: { notify: boolean; afterRead?: (reads: number) => void }) {
  const store: (ExperienceEvent & { raw?: boolean })[] = [];
  const listeners = new Set<() => void>();
  let reads = 0;
  let syncs = 0;
  const changes = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const after = (from: number, limit = 100) => {
    const events = store.filter((item) => item.seq > from && !item.raw).slice(0, limit);
    return { events, next_cursor: events.at(-1)?.seq ?? from, has_more: false };
  };
  class Events extends ExperienceEvents {
    protected override async newest() {
      return store.at(-1)?.seq ?? 0;
    }
    protected override async changedBetween(from: number, through: number) {
      const range = store.filter((item) => item.seq > from && item.seq <= through);
      if (!range.length) return [];
      const raw = range.some((item) => item.raw);
      // The projector leaves raw events to the stream, as for a conversation it does not project.
      return [{ id: 'job_1', spaceId: 'space_1', principalId: 'own_1', raw, projectable: false }];
    }
    override async sync() {
      syncs++;
      for (const item of store) item.raw = false;
    }
    protected override async read(_spaceId: string, from: number, _jobId?: string, limit = 100) {
      reads++;
      const page = after(from, limit);
      // Something lands after the read looked and before it returns.
      options.afterRead?.(reads);
      return page;
    }
  }
  const events = new Events(
    undefined as unknown as Database,
    undefined,
    options.notify ? changes : undefined,
  );
  const commit = (seq: number, raw = false) => {
    store.push({ ...event(seq), raw });
    for (const listener of listeners) listener();
  };
  return { events, commit, listeners, reads: () => reads, syncs: () => syncs };
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
  // Only the projector still listens; a closed stream reads nothing more.
  expect(listeners.size).toBe(1);
});

test('a closed stream is told of nothing more', async () => {
  const { events, commit, reads } = harness({ notify: true });
  const controller = new AbortController();
  drain(await events.response('space_1', 0, controller.signal, 'job_1', 'own_1'));
  controller.abort();
  const before = reads();
  commit(1);
  await Bun.sleep(EXPERIENCE_READ_GAP_MS * 4);
  expect(reads()).toBe(before);
});

test('a change the projector leaves unprojected is projected by the stream', async () => {
  const { events, commit, syncs } = harness({ notify: true });
  const controller = new AbortController();
  const response = await events.response('space_1', 0, controller.signal, 'job_1', 'own_1');
  const opened = syncs();
  const reading = firstEvent(response);
  await Bun.sleep(100);
  const started = performance.now();
  commit(1, true);
  expect(await reading).toBe(1);
  expect(performance.now() - started).toBeLessThan(EXPERIENCE_POLL_MS / 2);
  expect(syncs()).toBe(opened + 1);
  controller.abort();
});

test('a change told while the opening page is read is not lost', async () => {
  let commit!: (seq: number) => void;
  const made = harness({ notify: true, afterRead: (reads) => reads === 1 && commit(1) });
  commit = made.commit;
  const controller = new AbortController();
  const started = performance.now();
  const opening = await made.events.response('space_1', 0, controller.signal, 'job_1', 'own_1');
  expect(await firstEvent(opening)).toBe(1);
  expect(performance.now() - started).toBeLessThan(EXPERIENCE_POLL_MS / 2);
  controller.abort();
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

/** Reads the stream until it is cancelled, so the stream keeps being asked for more. */
function drain(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('no body');
  void (async () => {
    while (!(await reader.read()).done);
  })().catch(() => {});
}

test('an idle stream with notifications does not read again until one comes', async () => {
  const { events, commit, reads } = harness({ notify: true });
  const controller = new AbortController();
  drain(await events.response('space_1', 0, controller.signal, 'job_1', 'own_1'));
  await Bun.sleep(EXPERIENCE_POLL_MS * 2.5);
  // The opening page only: nothing said there was anything to read.
  expect(reads()).toBe(1);
  commit(1);
  await Bun.sleep(EXPERIENCE_READ_GAP_MS * 4);
  expect(reads()).toBe(2);
  controller.abort();
}, 10_000);

test('an idle stream without notifications reads on every poll', async () => {
  const { events, reads } = harness({ notify: false });
  const controller = new AbortController();
  drain(await events.response('space_1', 0, controller.signal, 'job_1', 'own_1'));
  await Bun.sleep(EXPERIENCE_POLL_MS * 2.5);
  expect(reads()).toBeGreaterThanOrEqual(3);
  controller.abort();
}, 10_000);
