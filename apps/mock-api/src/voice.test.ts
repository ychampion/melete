import { describe, expect, test } from 'bun:test';
import {
  conversationResponse,
  errorResponse,
  voiceAside,
  voiceSession,
  voiceStatus,
  voiceTranscription,
} from '@melete/contracts';
import type { ServerWebSocket } from 'bun';
import { createMock } from './index.ts';
import { type RealtimeState, realtimeSocket, UTTERANCES } from './voice.ts';

async function conversation(app: ReturnType<typeof createMock>['app']) {
  const agents = (await (await app.request('/agents')).json()) as { agents: { id: string }[] };
  const created = await app.request('/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Voice', agent_id: agents.agents[0]?.id }),
  });
  return conversationResponse.parse(await created.json()).conversation.id;
}

describe('voice in the mock', () => {
  test('status, push-to-talk and its refusals answer with contract bodies', async () => {
    const { app } = createMock({ speed: 0 });
    expect(voiceStatus.parse(await (await app.request('/voice')).json())).toMatchObject({
      push_to_talk: true,
      voice_mode: true,
    });
    const heard = await app.request('/voice/transcriptions?duration_ms=2000', {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: new Uint8Array(100),
    });
    expect(voiceTranscription.parse(await heard.json()).text.length).toBeGreaterThan(0);
    const long = await app.request('/voice/transcriptions?duration_ms=130000', {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: new Uint8Array(100),
    });
    expect(long.status).toBe(413);
    expect(errorResponse.parse(await long.json()).error.code).toBe('recording_too_long');
  });

  test('turned off, voice is absent and its routes say it is not set up', async () => {
    const { app } = createMock({ speed: 0, voice: false });
    expect(voiceStatus.parse(await (await app.request('/voice')).json())).toMatchObject({
      push_to_talk: false,
      voice_mode: false,
    });
    const refused = await app.request('/voice/transcriptions?duration_ms=1000', {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: new Uint8Array(10),
    });
    expect(refused.status).toBe(404);
  });

  test('a session and speech need a conversation that exists', async () => {
    const { app } = createMock({ speed: 0 });
    expect(
      (await app.request('/conversations/nope/voice/session', { method: 'POST' })).status,
    ).toBe(404);
    const id = await conversation(app);
    const session = await app.request(`http://localhost:3210/conversations/${id}/voice/session`, {
      method: 'POST',
    });
    expect(session.status).toBe(201);
    expect(voiceSession.parse(await session.json()).url).toStartWith(
      'ws://localhost:3210/voice/realtime?token=mock-',
    );
    const speech = await app.request(`/conversations/${id}/voice/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Your afternoon is free.' }),
    });
    expect(speech.status).toBe(200);
    const bytes = new Uint8Array(await speech.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
  });

  test('the realtime socket commits an utterance after sound and then silence', () => {
    const sent: { message_type: string; text?: string }[] = [];
    const socket = {
      data: { spokenMs: 0, quietMs: 0, partials: 0, committed: 0 },
      send: (raw: string) => sent.push(JSON.parse(raw)),
    } as unknown as ServerWebSocket<RealtimeState>;
    realtimeSocket.open(socket);
    const chunk = (level: number) => {
      const pcm = new Int16Array(1600); // 100 ms at 16 kHz
      for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(level * 32767 * Math.sin(i / 3));
      realtimeSocket.message(
        socket,
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: Buffer.from(pcm.buffer).toString('base64'),
          commit: false,
          sample_rate: 16000,
        }),
      );
    };
    for (let i = 0; i < 12; i += 1) chunk(0.3);
    for (let i = 0; i < 8; i += 1) chunk(0);
    expect(sent[0]?.message_type).toBe('session_started');
    expect(sent.some((message) => message.message_type === 'partial_transcript')).toBe(true);
    expect(sent.at(-1)).toEqual({ message_type: 'committed_transcript', text: UTTERANCES[0] });
  });
});

describe('talking while the work runs, in the mock', () => {
  const activity = { now: 'Reading the third page', steps: ['Read page one', 'Read page two'] };

  test('asides answer with contract bodies: talk, steer, stop and progress', async () => {
    const { app } = createMock({ speed: 0 });
    const id = await conversation(app);
    const ask = async (body: unknown) => {
      const response = await app.request(`/conversations/${id}/voice/aside`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return voiceAside.parse(await response.json());
    };
    expect((await ask({ kind: 'heard', text: 'How is it going?', activity })).intent).toBe('talk');
    expect(
      (await ask({ kind: 'heard', text: 'Also check the second site.', activity })).intent,
    ).toBe('steer');
    expect((await ask({ kind: 'heard', text: 'Cancel it all.', activity })).intent).toBe('stop');
    expect(await ask({ kind: 'progress', activity })).toEqual({
      intent: 'talk',
      say: 'I have done 2 steps. Now: reading the third page.',
    });
    expect(await ask({ kind: 'progress', activity: { now: null, steps: [] } })).toEqual({
      intent: 'quiet',
      say: null,
    });
  });

  test('a private place refuses an aside as it refuses every voice route', async () => {
    const { app } = createMock({ speed: 0, voice: 'private' });
    const id = await conversation(app);
    const refused = await app.request(`/conversations/${id}/voice/aside`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'progress', activity }),
    });
    expect(refused.status).toBe(403);
    expect(errorResponse.parse(await refused.json()).error.code).toBe('voice_private');
  });
});
