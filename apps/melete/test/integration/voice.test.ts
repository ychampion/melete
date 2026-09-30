/**
 * Voice through the real API: session cookies, the session space, the owner of
 * a conversation, and the daily allowance counted in Postgres. The providers
 * are fakes; nothing here reaches a speech service.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentResponse, conversationResponse, voiceSession, voiceStatus } from '@melete/contracts';
import type { LiveVoice } from '../../src/connectors/elevenlabs.ts';
import { fakeTranscriptionAdapter } from '../../src/connectors/transcribe.ts';
import { silentWav } from '../../src/connectors/wav.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-voice-'));
const password = 'a-long-enough-password';

/** What the fake live provider was asked to say, to show the text reached it and nothing else. */
const spoken: string[] = [];
let sessions = 0;
const live: LiveVoice = {
  async speak(text) {
    spoken.push(text);
    return {
      body: new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))
        .body as ReadableStream<Uint8Array>,
      mime: 'audio/mpeg',
    };
  },
  async session() {
    sessions += 1;
    return {
      url: `wss://voice.example.test/realtime?token=single-use-${sessions}`,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  },
};

const app =
  handle && jobs
    ? createApp({
        db: handle.db,
        sql: handle.sql,
        jobs,
        env: loadEnv({
          NODE_ENV: 'test',
          MELETE_SPACES_DIR: root,
          MELETE_VOICE_DAILY_CHARACTERS: '40',
          MELETE_VOICE_DAILY_SESSIONS: '1',
          MELETE_VOICE_DAILY_SECONDS: '5',
        }),
        voice: { transcription: fakeTranscriptionAdapter, live },
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;

function api() {
  if (!app) throw new Error('Postgres unavailable');
  return app;
}
function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}
const call = (cookie: string, path: string, method = 'GET', body?: unknown) =>
  api().request(path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function conversationOf(cookie: string, title: string): Promise<string> {
  const persona = agentResponse.parse(
    await (await call(cookie, '/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent)).json(),
  ).agent;
  const created = await call(cookie, '/conversations', 'POST', { title, agent_id: persona.id });
  expect(created.status).toBe(200);
  return conversationResponse.parse(await created.json()).conversation.id;
}

let owner = '';
let member = '';
let ownerConversation = '';
let memberConversation = '';

withDb('voice through the API', () => {
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  test('two people, each with a conversation of their own', async () => {
    const setup = await api().request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.test', password }),
    });
    expect(setup.status).toBe(201);
    owner = sessionCookie(setup);
    expect(
      (await call(owner, '/principals', 'POST', { email: 'second@example.test', password })).status,
    ).toBe(201);
    member = sessionCookie(
      await api().request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'second@example.test', password }),
      }),
    );
    ownerConversation = await conversationOf(owner, 'Plans for Friday');
    memberConversation = await conversationOf(member, 'Groceries');
  }, 60_000);

  test('without a session nothing answers', async () => {
    expect((await api().request('/voice')).status).toBe(401);
    expect(
      (await api().request(`/conversations/${ownerConversation}/voice/session`, { method: 'POST' }))
        .status,
    ).toBe(401);
  });

  test('the status says both features are here', async () => {
    const status = voiceStatus.parse(await (await call(owner, '/voice')).json());
    expect(status).toMatchObject({ push_to_talk: true, voice_mode: true });
  });

  test('another person’s conversation is not there: no session, no speech', async () => {
    const session = await call(member, `/conversations/${ownerConversation}/voice/session`, 'POST');
    expect(session.status).toBe(404);
    const speech = await call(member, `/conversations/${ownerConversation}/voice/speech`, 'POST', {
      text: 'Read this',
    });
    expect(speech.status).toBe(404);
    expect(sessions).toBe(0);
    expect(spoken).toEqual([]);
    // Refused before the allowance: nothing was counted for the member.
    const [row] = await (handle?.sql ?? (() => []))`select count(*)::int as n from voice_usage`;
    expect(Number(row?.n)).toBe(0);
  });

  test('the owner opens a session and hears a reply; the token is the only credential', async () => {
    const session = await call(owner, `/conversations/${ownerConversation}/voice/session`, 'POST');
    expect(session.status).toBe(201);
    const opened = voiceSession.parse(await session.json());
    expect(opened.url).toBe('wss://voice.example.test/realtime?token=single-use-1');
    expect(opened.sample_rate).toBe(16_000);
    const speech = await call(owner, `/conversations/${ownerConversation}/voice/speech`, 'POST', {
      text: 'Friday is clear after two.',
    });
    expect(speech.status).toBe(200);
    expect(speech.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xfb, 0x90, 0x00]),
    );
    expect(spoken).toEqual(['Friday is clear after two.']);
  });

  test('each daily allowance holds per person, and only amounts are kept', async () => {
    // One session a day: the owner's second is refused, the member's first is not.
    const again = await call(owner, `/conversations/${ownerConversation}/voice/session`, 'POST');
    expect(again.status).toBe(429);
    expect(
      (await call(member, `/conversations/${memberConversation}/voice/session`, 'POST')).status,
    ).toBe(201);
    // Forty characters a day: 26 were used, so 20 more is past it.
    const past = await call(owner, `/conversations/${ownerConversation}/voice/speech`, 'POST', {
      text: 'Twenty characters!!!',
    });
    expect(past.status).toBe(429);
    expect(((await past.json()) as { error: { message: string } }).error.message).toBe(
      'You have used today’s allowance for replies read aloud. It frees up over the next day.',
    );
    const rows = await (handle?.sql ?? (() => []))`select * from voice_usage order by created_at`;
    expect(rows.map((row) => [row.kind, row.amount])).toEqual([
      ['session', 1],
      ['speech', 26],
      ['session', 1],
    ]);
    expect(JSON.stringify(rows)).not.toContain('Friday');
  });

  test('push-to-talk transcribes through the real session, then the seconds run out', async () => {
    const clip = silentWav({ script: 'Book a table for two.', durationMs: 3000 });
    const send = () =>
      api().request('/voice/transcriptions?duration_ms=3000', {
        method: 'POST',
        headers: { Cookie: owner, 'Content-Type': 'audio/wav' },
        body: clip,
      });
    const first = await send();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ text: 'Book a table for two.', language: 'en' });
    // Five seconds a day: three used, three more is past it.
    expect((await send()).status).toBe(429);
  });

  test('an invalid speech request is refused as invalid', async () => {
    const empty = await call(owner, `/conversations/${ownerConversation}/voice/speech`, 'POST', {
      text: '   ',
    });
    expect(empty.status).toBe(400);
  });
});
