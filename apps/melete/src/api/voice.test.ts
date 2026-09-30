import { describe, expect, test } from 'bun:test';
import { VOICE_LIMITS, voiceStatus } from '@melete/contracts';
import { Hono } from 'hono';
import { VoiceProviderError } from '../connectors/elevenlabs.ts';
import { fakeTranscriptionAdapter, type TranscriptionAdapter } from '../connectors/transcribe.ts';
import { pcmWav, silentWav } from '../connectors/wav.ts';
import type { Database } from '../db/client.ts';
import { ServiceError } from './errors.ts';
import {
  mountVoice,
  type VoiceAllowance,
  type VoiceProviders,
  type VoiceUsageKind,
} from './voice.ts';

/** The allowance in memory, with what was taken and given back visible to the test. */
class CountingAllowance implements VoiceAllowance {
  rows = new Map<string, { principalId: string; kind: VoiceUsageKind; amount: number }>();
  async take(principalId: string, kind: VoiceUsageKind, amount: number, limit: number) {
    const used = [...this.rows.values()]
      .filter((row) => row.principalId === principalId && row.kind === kind)
      .reduce((sum, row) => sum + row.amount, 0);
    if (used + amount > limit) return null;
    const id = `r${this.rows.size + 1}`;
    this.rows.set(id, { principalId, kind, amount });
    return id;
  }
  async giveBack(id: string) {
    this.rows.delete(id);
  }
  used(kind: VoiceUsageKind) {
    return [...this.rows.values()]
      .filter((row) => row.kind === kind)
      .reduce((s, r) => s + r.amount, 0);
  }
}

const PERSON = 'prn_01J00000000000000000000000';

function app(
  providers: Partial<VoiceProviders> = {},
  options: { allowance?: CountingAllowance | null; seconds?: number } = {},
) {
  const allowance =
    options.allowance === null ? undefined : (options.allowance ?? new CountingAllowance());
  const built = new Hono();
  built.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ error: { code: error.code, message: error.message } }, error.status)
      : c.json({ error: { code: 'internal_error', message: String(error) } }, 500),
  );
  // What the session middleware sets for a signed-in person.
  built.use('*', async (c, next) => {
    c.set('owner', {
      id: PERSON,
      email: 'person@example.test',
      created_at: new Date().toISOString(),
    });
    c.set('experienceSpaceId', 'sp_01J00000000000000000000000');
    await next();
  });
  mountVoice(built, {
    // The two routes tested here never read a conversation.
    db: {} as Database,
    allowance,
    providers: { transcription: null, live: null, ...providers },
    limits: { seconds: options.seconds ?? 1800, characters: 20_000, sessions: 30 },
  });
  return { built, allowance };
}

const clip = (
  bytes: Uint8Array,
  durationMs: number,
  type = 'audio/wav',
  headers: Record<string, string> = {},
) =>
  new Request(`http://melete.test/voice/transcriptions?duration_ms=${durationMs}`, {
    method: 'POST',
    headers: { 'content-type': type, ...headers },
    body: bytes,
  });

describe('which voice features the service offers', () => {
  test('nothing configured: both absent, not broken', async () => {
    const { built } = app();
    const response = await built.request('/voice');
    expect(response.status).toBe(200);
    expect(voiceStatus.parse(await response.json())).toEqual({
      push_to_talk: false,
      voice_mode: false,
      max_recording_seconds: 120,
      max_recording_bytes: VOICE_LIMITS.recording_bytes,
    });
  });

  test('a transcription provider turns on push-to-talk; voice mode needs the live provider', async () => {
    const status = async (providers: Partial<VoiceProviders>, allowance?: null) =>
      (await (
        await app(providers, allowance === null ? { allowance } : {}).built.request('/voice')
      ).json()) as {
        push_to_talk: boolean;
        voice_mode: boolean;
      };
    expect(await status({ transcription: fakeTranscriptionAdapter })).toMatchObject({
      push_to_talk: true,
      voice_mode: false,
    });
    const live = {
      speak: async () => ({
        body: new Response('').body as ReadableStream<Uint8Array>,
        mime: 'audio/mpeg',
      }),
      session: async () => ({ url: 'wss://x', expires_at: new Date().toISOString() }),
    };
    expect(await status({ transcription: fakeTranscriptionAdapter, live })).toMatchObject({
      push_to_talk: true,
      voice_mode: true,
    });
    // Without somewhere to count the allowance, nothing is offered.
    expect(await status({ transcription: fakeTranscriptionAdapter, live }, null)).toMatchObject({
      push_to_talk: false,
      voice_mode: false,
    });
  });
});

describe('push-to-talk transcription', () => {
  test('returns the words and counts the seconds against the day', async () => {
    const { built, allowance } = app({ transcription: fakeTranscriptionAdapter });
    const audio = silentWav({ script: 'Move my dentist to Friday.', durationMs: 2400 });
    const response = await built.request(clip(audio, 2400));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Move my dentist to Friday.', language: 'en' });
    expect(allowance?.used('transcribe')).toBe(3);
  });

  test('the provider is told the clip type and asked for no speaker labels', async () => {
    const seen: { filename: string; mime: string; diarize: boolean }[] = [];
    const adapter: TranscriptionAdapter = {
      model: 'm',
      async transcribe(request) {
        seen.push({ filename: request.filename, mime: request.mime, diarize: request.diarize });
        return { language: null, text: 'ok', words: [] };
      },
    };
    const { built } = app({ transcription: adapter });
    const response = await built.request(clip(new Uint8Array(10), 1000, 'audio/webm;codecs=opus'));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ filename: 'clip.webm', mime: 'audio/webm', diarize: false }]);
  });

  test('a clip longer than two minutes is refused before anything is spent', async () => {
    const { built, allowance } = app({ transcription: fakeTranscriptionAdapter });
    const response = await built.request(clip(new Uint8Array(100), 125_000, 'audio/webm'));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: 'recording_too_long',
        message: 'Voice messages can be up to 2 minutes. This recording is longer.',
      },
    });
    expect(allowance?.rows.size).toBe(0);
  });

  test('a WAV whose own header says it is longer than claimed is judged by the header', async () => {
    const { built } = app({ transcription: fakeTranscriptionAdapter });
    // 130 seconds of 8 kHz audio, claimed as one second.
    const audio = pcmWav(new Uint8Array(8000 * 2 * 130), 8000);
    expect(audio.length).toBeLessThan(VOICE_LIMITS.recording_bytes);
    const response = await built.request(clip(audio, 1000));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'recording_too_long',
    );
  });

  test('a clip larger than the limit is refused, by its stated length or by its bytes', async () => {
    const { built } = app({ transcription: fakeTranscriptionAdapter });
    const stated = await built.request(
      clip(new Uint8Array(10), 1000, 'audio/webm', {
        'content-length': String(VOICE_LIMITS.recording_bytes + 1),
      }),
    );
    expect(stated.status).toBe(413);
    const actual = await built.request(
      new Request('http://melete.test/voice/transcriptions?duration_ms=1000', {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: new Uint8Array(VOICE_LIMITS.recording_bytes + 1),
      }),
    );
    expect(actual.status).toBe(413);
    expect(((await actual.json()) as { error: { message: string } }).error.message).toBe(
      'Voice messages can be up to 5 MB. This recording is larger.',
    );
  });

  test('something that is not a recording, an empty one, or no length is refused plainly', async () => {
    const { built } = app({ transcription: fakeTranscriptionAdapter });
    expect((await built.request(clip(new Uint8Array(10), 1000, 'text/plain'))).status).toBe(400);
    expect((await built.request(clip(new Uint8Array(0), 1000, 'audio/webm'))).status).toBe(400);
    const unmeasured = await built.request(
      new Request('http://melete.test/voice/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: new Uint8Array(10),
      }),
    );
    expect(unmeasured.status).toBe(400);
  });

  test('past the daily allowance it says so, and nothing reaches the provider', async () => {
    let calls = 0;
    const adapter: TranscriptionAdapter = {
      model: 'm',
      async transcribe() {
        calls += 1;
        return { language: null, text: 'ok', words: [] };
      },
    };
    const { built } = app({ transcription: adapter }, { seconds: 10 });
    expect((await built.request(clip(new Uint8Array(10), 8000, 'audio/webm'))).status).toBe(200);
    const refused = await built.request(clip(new Uint8Array(10), 4000, 'audio/webm'));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: {
        code: 'voice_daily_limit',
        message:
          'You have used today’s allowance for voice messages. It frees up over the next day.',
      },
    });
    expect(calls).toBe(1);
  });

  test('a provider refusal is a plain sentence, and the seconds are given back', async () => {
    const adapter: TranscriptionAdapter = {
      model: 'm',
      async transcribe() {
        throw new VoiceProviderError(500);
      },
    };
    const { built, allowance } = app({ transcription: adapter });
    const response = await built.request(clip(new Uint8Array(10), 3000, 'audio/webm'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: 'voice_provider_failed',
        message: 'The speech service could not transcribe that just now. Try again in a moment.',
      },
    });
    expect(allowance?.rows.size).toBe(0);
  });

  test('a provider that never answered keeps the seconds counted: it may have done the work', async () => {
    const adapter: TranscriptionAdapter = {
      model: 'm',
      async transcribe() {
        throw new VoiceProviderError(null);
      },
    };
    const { built, allowance } = app({ transcription: adapter });
    expect((await built.request(clip(new Uint8Array(10), 3000, 'audio/webm'))).status).toBe(502);
    expect(allowance?.used('transcribe')).toBe(3);
  });

  test('unconfigured, the route answers that voice is not set up', async () => {
    const { built } = app();
    const response = await built.request(clip(new Uint8Array(10), 1000, 'audio/webm'));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'voice_unavailable',
    );
  });
});
