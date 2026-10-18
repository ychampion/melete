/**
 * A long chat read a page at a time, and a turn that goes on with nobody
 * watching. Pages walk back through every turn once, in order, while new
 * turns arrive and after the chat is deleted; a page's events are the ones
 * its turns made; and a stream dropped in the middle of a turn picks up from
 * the last event it had, with nothing missed and nothing twice.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  conversationResponse,
  dedupKey,
  type ExperienceEvent,
  experienceEvent,
  type Turn,
  turnList,
} from '@melete/contracts';
import { session } from '../../src/db/auth-schema.ts';
import { owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'chat-pages-signing-key-32-bytes!!' })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'pages@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
}
const withDb = handle ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
async function request(path: string, init: RequestInit = {}) {
  return required(app).request(path, {
    ...init,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}
async function newChat() {
  const persona = agentResponse.parse(
    await (await request('/agents', { method: 'POST', body: JSON.stringify(freshAgent()) })).json(),
  ).agent;
  return conversationResponse.parse(
    await (
      await request('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'Build log', agent_id: persona.id }),
      })
    ).json(),
  ).conversation;
}

/** The person's message and the attempt that takes it, left running. */
async function begin(chatId: string, text: string) {
  const sent = await request(`/conversations/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: { 'Idempotency-Key': `pages-${randomBytes(6).toString('hex')}` },
  });
  expect(sent.status).toBe(200);
  const row = await required(jobs).get(chatId);
  const claimed = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
  let local = 0;
  const say = (words: string) =>
    required(runner).emit(claimed.claims, {
      type: 'text_delta',
      attempt_id: claimed.claims.attempt_id,
      local_seq: ++local,
      dedup_key: dedupKey(claimed.claims.attempt_id, local),
      at: new Date().toISOString(),
      text: words,
    });
  const finish = (summary: string) =>
    required(runner).commitOutcome(claimed.claims, { kind: 'completed', summary, evidence: [] });
  return { say, finish };
}
async function turn(chatId: string, n: number) {
  const running = await begin(chatId, `Step ${n}`);
  await running.say(`Answer ${n}`);
  await running.finish(`Answer ${n}`);
}
const page = async (chatId: string, query: string) => {
  const response = await request(`/conversations/${chatId}/messages?${query}`);
  expect(response.status).toBe(200);
  return turnList.parse(await response.json());
};
/** Every turn from the newest page back, the way the chat screen reads them. */
async function walk(chatId: string, limit: number) {
  const pages: Turn[][] = [];
  let before: string | null | undefined;
  do {
    const read = await page(
      chatId,
      `limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    );
    pages.push(read.turns);
    before = read.next_cursor;
  } while (before);
  return pages.reverse().flat();
}

/** SSE frames until `count` events arrived or the stream ends, then hang up. */
async function stream(chatId: string, count: number, lastEventId?: number) {
  const controller = new AbortController();
  const response = await request(`/conversations/${chatId}/events`, {
    headers: {
      Accept: 'text/event-stream',
      ...(lastEventId === undefined ? {} : { 'Last-Event-ID': String(lastEventId) }),
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = required(response.body).getReader();
  const decoder = new TextDecoder();
  const events: ExperienceEvent[] = [];
  let buffer = '';
  const deadline = Date.now() + 10_000;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
      buffer = buffer.slice(end + 2);
      if (data) events.push(experienceEvent.parse(JSON.parse(data)));
      end = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel();
  controller.abort();
  return events;
}
/** The conversation's whole stream, read as plain pages. */
async function everything(chatId: string) {
  const all: ExperienceEvent[] = [];
  let since = 0;
  for (;;) {
    const read = (await (
      await request(`/conversations/${chatId}/events?since=${since}`)
    ).json()) as { events: ExperienceEvent[]; next_cursor: number; has_more: boolean };
    all.push(...read.events);
    if (!read.has_more || read.next_cursor <= since) return all;
    since = read.next_cursor;
  }
}

withDb('a chat read a page at a time', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('pages walk back through every turn once, in order, and say how many there are', async () => {
    const chat = await newChat();
    for (let n = 1; n <= 7; n++) await turn(chat.id, n);
    const whole = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    // Without a limit the service answers as it always did: every turn, no paging fields.
    expect(whole.turns.map((entry) => entry.text)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((n) => `Step ${n}`),
    );
    expect(whole.next_cursor).toBeUndefined();

    const newest = await page(chat.id, 'limit=3');
    expect(newest.turns.map((entry) => entry.text)).toEqual(['Step 5', 'Step 6', 'Step 7']);
    expect(newest.total).toBe(7);
    expect(newest.next_cursor).toEqual(expect.any(String));
    expect((await walk(chat.id, 3)).map((entry) => entry.id)).toEqual(
      whole.turns.map((entry) => entry.id),
    );
    // A page that reaches the first turn says there is nothing before it.
    const all = await page(chat.id, 'limit=7');
    expect(all.next_cursor).toBeNull();
    for (const bad of ['nonsense', 'dA', encodeURIComponent('t|not-a-date|turn_x')])
      expect(
        (await request(`/conversations/${chat.id}/messages?limit=3&before=${bad}`)).status,
      ).toBe(400);
  }, 120_000);

  test('turns that arrive while reading back neither shift nor repeat the older pages', async () => {
    const chat = await newChat();
    for (let n = 1; n <= 5; n++) await turn(chat.id, n);
    const first = await page(chat.id, 'limit=2');
    expect(first.turns.map((entry) => entry.text)).toEqual(['Step 4', 'Step 5']);
    // Two new turns go in while the person is scrolled back.
    await turn(chat.id, 6);
    await turn(chat.id, 7);
    const seen = [...first.turns];
    let before = first.next_cursor;
    while (before) {
      const older = await page(chat.id, `limit=2&before=${encodeURIComponent(before)}`);
      seen.unshift(...older.turns);
      before = older.next_cursor;
    }
    expect(seen.map((entry) => entry.text)).toEqual([1, 2, 3, 4, 5].map((n) => `Step ${n}`));
    expect(new Set(seen.map((entry) => entry.id)).size).toBe(5);
    // The newest page now ends on the new turns.
    expect((await page(chat.id, 'limit=2')).turns.map((entry) => entry.text)).toEqual([
      'Step 6',
      'Step 7',
    ]);
  }, 120_000);

  test('a deleted chat reads as gone through any cursor it handed out', async () => {
    const chat = await newChat();
    for (let n = 1; n <= 3; n++) await turn(chat.id, n);
    const first = await page(chat.id, 'limit=1');
    const deleted = await request(`/conversations/${chat.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const after = await request(
      `/conversations/${chat.id}/messages?limit=1&before=${encodeURIComponent(required(first.next_cursor))}`,
    );
    expect(after.status).toBe(404);
  }, 120_000);

  test("a page's events are its own turns', and continue from where they stopped", async () => {
    const chat = await newChat();
    for (let n = 1; n <= 4; n++) await turn(chat.id, n);
    const all = await everything(chat.id);
    const newest = await page(chat.id, 'limit=2&events=true');
    const ids = new Set(newest.turns.map((entry) => entry.id));
    const events = required(newest.events);
    expect(events.length).toBeGreaterThan(0);
    for (const entry of events)
      if (entry.turn_id !== null) expect(ids.has(entry.turn_id)).toBe(true);
    // Every event of those turns is there, in order, and the stream carries on after the newest.
    expect(events.map((entry) => entry.seq)).toEqual(
      all
        .filter((entry) => entry.seq >= (events[0]?.seq ?? 0))
        .filter((entry) => entry.turn_id === null || ids.has(entry.turn_id))
        .map((entry) => entry.seq),
    );
    expect(newest.last_seq).toBe(all.at(-1)?.seq);
    // The older page holds only its own turns' events, none of the newer ones.
    const older = await page(
      chat.id,
      `limit=2&events=true&before=${encodeURIComponent(required(newest.next_cursor))}`,
    );
    const olderIds = new Set(older.turns.map((entry) => entry.id));
    expect(required(older.events).every((entry) => olderIds.has(entry.turn_id ?? ''))).toBe(true);
    expect(required(older.events).map((entry) => entry.seq)).toEqual(
      all.filter((entry) => olderIds.has(entry.turn_id ?? '')).map((entry) => entry.seq),
    );
    // Read from part way, a page's events start after that point.
    const cut = required(events[Math.floor(events.length / 2)]).seq;
    const rest = await page(chat.id, `limit=2&events=true&events_after=${cut}`);
    expect(required(rest.events).map((entry) => entry.seq)).toEqual(
      events.filter((entry) => entry.seq > cut).map((entry) => entry.seq),
    );
  }, 120_000);

  test('a turn nobody is watching goes on after the stream drops, and the stream resumes with nothing lost or twice', async () => {
    const chat = await newChat();
    const running = await begin(chat.id, 'Run the long build');
    await running.say('Starting. ');
    await running.say('Compiling. ');
    // The tab watches the start, then goes away.
    const before = await stream(chat.id, 3);
    expect(before.length).toBeGreaterThan(0);
    const last = required(before.at(-1)).seq;
    // With nobody connected, the turn carries on and finishes.
    for (let n = 0; n < 20; n++) await running.say(`Step ${n} done. `);
    await running.finish('Built.');
    const saved = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(saved.turns.at(-1)?.status).toBe('done');
    // Coming back, the stream starts after the last event the tab had.
    const all = await everything(chat.id);
    const missed = all.filter((entry) => entry.seq > last);
    expect(missed.length).toBeGreaterThan(20);
    const resumed = await stream(chat.id, missed.length, last);
    expect(resumed.map((entry) => entry.seq)).toEqual(missed.map((entry) => entry.seq));
    // Together, what the tab saw before and after is the whole stream once.
    const seen = [...before, ...resumed].map((entry) => entry.seq);
    expect(seen).toEqual(
      all.filter((entry) => entry.seq <= required(seen.at(-1))).map((entry) => entry.seq),
    );
    expect(new Set(seen).size).toBe(seen.length);
    // And the words streamed while away add up to what was saved.
    const words = [...before, ...resumed]
      .flatMap((entry) => (entry.item.type === 'text_delta' ? [entry.item.text] : []))
      .join('');
    expect(words).toContain('Step 19 done.');
  }, 120_000);
});
