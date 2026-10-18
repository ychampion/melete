/**
 * Reading a chat a page at a time: the newest turns and all their events in
 * one go, older turns put in front without repeating any, the whole history
 * read the old way from a service that does not page, and the copies kept for
 * going back, which never outlive a sign-out or a delete.
 */
import { afterEach, expect, test } from 'bun:test';
import { adapter } from './adapter.ts';
import {
  forgetConversation,
  forgetEveryConversation,
  keepConversation,
  keptConversation,
  openConversation,
  prefetchConversation,
  prependOlder,
  readOlder,
} from './history.ts';
import type { Conversation, ExperienceEvent, Turn, TurnPage } from './types.ts';

const AT = '2026-10-01T09:00:00.000Z';
const CHAT = { id: 'job_1', composer: 'send', status: 'done' } as unknown as Conversation;
const turnOf = (n: number): Turn => ({
  id: `turn_${n}`,
  conversation_id: 'job_1',
  agent_id: 'melete',
  text: `Step ${n}`,
  answer: `Answer ${n}`,
  status: 'done',
  delivery: null,
  created_at: new Date(Date.parse(AT) + n * 1000).toISOString(),
});
const delta = (seq: number, n: number, text: string): ExperienceEvent => ({
  seq,
  conversation_id: 'job_1',
  turn_id: `turn_${n}`,
  created_at: AT,
  item: { type: 'text_delta', text },
});
const ok = <T>(data: T) => ({ data, error: null, unavailable: null }) as const;

const real = { ...adapter };
afterEach(() => {
  Object.assign(adapter, real);
  forgetEveryConversation();
});

/** A paging service over `turns`, with `events` handed out `perRead` at a time. */
function serve(turns: Turn[], events: ExperienceEvent[], perRead = 1000) {
  const reads: Array<{ limit: number; before?: string; eventsAfter?: number }> = [];
  Object.assign(adapter, {
    conversation: async () => ok({ conversation: CHAT }),
    drafts: async () => ok({ drafts: [] }),
    turnsPage: async (
      _id: string,
      query: { limit: number; before?: string; events?: boolean; eventsAfter?: number },
    ) => {
      reads.push(query);
      const end = query.before ? Number(query.before) : turns.length;
      const start = Math.max(0, end - query.limit);
      const shown = turns.slice(start, end);
      const ids = new Set(shown.map((turn) => turn.id));
      const own = events.filter(
        (event) =>
          event.turn_id !== null && ids.has(event.turn_id) && event.seq > (query.eventsAfter ?? 0),
      );
      const sent = own.slice(0, perRead);
      const page: TurnPage = {
        turns: shown,
        next_cursor: start > 0 ? String(start) : null,
        total: turns.length,
        events: sent,
        events_cursor: own.length > perRead ? (sent.at(-1)?.seq ?? null) : null,
        last_seq: events.at(-1)?.seq ?? 0,
        messages_after: 40,
      };
      return ok(page);
    },
  });
  return reads;
}

test('a chat opens on its newest turns, with every one of their events however many reads it takes', async () => {
  const turns = Array.from({ length: 20 }, (_, n) => turnOf(n + 1));
  const events = turns.flatMap((_, n) => [
    delta(n * 2 + 1, n + 1, 'Answer '),
    delta(n * 2 + 2, n + 1, `${n + 1}`),
  ]);
  const reads = serve(turns, events, 5);
  const opened = (await openConversation('job_1'))?.data;
  if (!opened) throw new Error('expected the chat to open');
  expect(opened.transcript.turns.map((turn) => turn.id)).toEqual(
    turns.slice(-12).map((turn) => turn.id),
  );
  // 24 events five at a time: the first read and four more.
  expect(reads).toHaveLength(5);
  expect(opened.older).toBe('8');
  expect(opened.total).toBe(20);
  expect(opened.cursor).toBe(40);
  expect(opened.messagesAfter).toBe(40);
  // Saved answers are drawn quiet, never as text still streaming in.
  expect(opened.transcript.turns.every((turn) => !turn.streaming && turn.streamed === '')).toBe(
    true,
  );
});

test('older turns go in front once each, drawn from their own events', async () => {
  const turns = Array.from({ length: 20 }, (_, n) => turnOf(n + 1));
  const events = turns.map((_, n) => delta(n + 1, n + 1, `Answer ${n + 1}`));
  serve(turns, events);
  const opened = (await openConversation('job_1'))?.data;
  if (!opened) throw new Error('expected the chat to open');
  let transcript = opened.transcript;
  let before = opened.older;
  while (before) {
    const older = (await readOlder('job_1', before, transcript)).data;
    if (!older) throw new Error('expected older turns');
    transcript = prependOlder(transcript, older);
    // Putting the same page in again changes nothing.
    expect(prependOlder(transcript, older).turns).toHaveLength(transcript.turns.length);
    before = older.older;
  }
  expect(transcript.turns.map((turn) => turn.id)).toEqual(turns.map((turn) => turn.id));
  expect(transcript.turns[0]?.turn.answer).toBe('Answer 1');
});

test('a failed read of older turns says so', async () => {
  Object.assign(adapter, {
    turnsPage: async () => ({ data: null, error: 'Offline', unavailable: null }),
  });
  const older = await readOlder('job_1', '5', { composer: 'send', status: 'done' });
  expect(older.data).toBeNull();
  expect(older.error).toBe('Offline');
});

test('a service that does not page is read the old way, from the first event', async () => {
  const turns = [turnOf(1), turnOf(2)];
  const events = [delta(1, 1, 'Answer 1'), delta(2, 2, 'Answer 2')];
  const since: number[] = [];
  Object.assign(adapter, {
    conversation: async () => ok({ conversation: CHAT }),
    drafts: async () => ok({ drafts: [] }),
    turnsPage: async () => ok({ turns } as TurnPage),
    eventsSince: async (_id: string, after: number) => {
      since.push(after);
      return ok({
        events: events.filter((event) => event.seq > after),
        next_cursor: 2,
        has_more: false,
      });
    },
  });
  const opened = (await openConversation('job_1'))?.data;
  expect(since).toEqual([0]);
  expect(opened?.older).toBeNull();
  expect(opened?.cursor).toBe(2);
  expect(opened?.transcript.turns).toHaveLength(2);
});

test('copies are kept for the chats gone between, the oldest let go, none past a sign-out or delete', async () => {
  const copy = (n: number) => ({
    conversation: CHAT,
    transcript: { turns: [] } as never,
    older: null,
    total: n,
    at: Date.now(),
  });
  for (let n = 0; n < 13; n++) keepConversation(`job_${n}`, copy(n));
  // Twelve are kept: the first chat kept is the one let go.
  expect(keptConversation('job_0')).toBeUndefined();
  expect(keptConversation('job_12')?.total).toBe(12);
  forgetConversation('job_12');
  expect(keptConversation('job_12')).toBeUndefined();
  forgetEveryConversation();
  expect(keptConversation('job_5')).toBeUndefined();

  // Read ahead once, however often the pointer passes; a fresh copy is not read again.
  const reads = serve([turnOf(1)], []);
  prefetchConversation('job_1');
  prefetchConversation('job_1');
  await Bun.sleep(10);
  expect(reads).toHaveLength(1);
  expect(keptConversation('job_1')?.transcript.turns).toHaveLength(1);
  prefetchConversation('job_1');
  await Bun.sleep(10);
  expect(reads).toHaveLength(1);

  // A read begun before signing out is never kept after it.
  forgetEveryConversation();
  serve([turnOf(1)], []);
  prefetchConversation('job_2');
  forgetEveryConversation();
  await Bun.sleep(10);
  expect(keptConversation('job_2')).toBeUndefined();
});
