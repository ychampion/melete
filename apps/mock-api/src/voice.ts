/**
 * Voice, without a speech service. The routes answer as the service does, in
 * shape and in refusals, so push-to-talk and voice mode can be built and shown
 * with no key:
 *
 * - a push-to-talk clip is "heard" as one of a few fixed sentences;
 * - a voice session is a WebSocket on this server that speaks the realtime
 *   transcription protocol: it listens to the PCM it is sent, and when a burst
 *   of sound is followed by silence it commits the next fixed sentence;
 * - speech is silence, as long as the text would take to read.
 *
 * `MELETE_MOCK_VOICE=off` starts with voice not set up, so the interface can be
 * seen without it.
 */
import { randomUUID } from 'node:crypto';
import {
  VOICE_LIMITS,
  type VoiceAside,
  type VoiceAsideRequest,
  voiceAside,
  voiceAsideRequest,
  voiceSession,
  voiceSpeechRequest,
  voiceStatus,
  voiceTranscription,
  voiceTranscriptionQuery,
} from '@melete/contracts';
import type { ServerWebSocket } from 'bun';
import type { Context, Hono } from 'hono';
import type { ExperienceMock } from './experience.ts';

/** What push-to-talk "hears", in turn. */
const HEARD = [
  'Remind me to call Sam about the invoice tomorrow morning.',
  'What is on my calendar this afternoon?',
  'Draft a short thank-you note to the landlord.',
];

/** What voice mode "hears", one per utterance, in turn. */
export const UTTERANCES = [
  'What is on my calendar tomorrow?',
  'How is it going?',
  'Also check the second site.',
  'Thanks, that is all for now.',
];

/**
 * What the companion makes of an aside, without a model: a stop, an
 * instruction for the work, a question about it, or a progress word built from
 * the activity. The service asks a model; the shapes are the same.
 */
export function mockAside(request: VoiceAsideRequest): VoiceAside {
  const { now, steps } = request.activity;
  if (request.kind === 'progress') {
    if (!steps.length && !now) return { intent: 'quiet', say: null };
    const done = steps.length === 1 ? 'one step' : `${steps.length} steps`;
    return {
      intent: 'talk',
      say: now ? `I have done ${done}. Now: ${now.toLowerCase()}.` : `I have done ${done}.`,
    };
  }
  const heard = request.text.toLowerCase();
  if (/\b(stop|cancel|never mind)\b/.test(heard)) return { intent: 'stop', say: 'Stopping now.' };
  if (/\b(also|instead|make it|change|add|check|don't|do not|shorter|longer)\b/.test(heard))
    return { intent: 'steer', say: 'Got it. I will pass that on.' };
  return {
    intent: 'talk',
    say: now ? `Still working. Right now: ${now.toLowerCase()}.` : 'Still working on it.',
  };
}

const SAMPLE_RATE = 16_000;
export const REALTIME_PATH = '/voice/realtime';

/** A playable WAV of silence, about as long as the text takes to read. */
export function silence(text: string, sampleRate = 8000): Uint8Array {
  const seconds = Math.min(8, Math.max(0.6, text.length * 0.055));
  const samples = Math.round(sampleRate * seconds);
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const ascii = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) out[at + i] = value.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  return out;
}

/** What the service says where the space or agent is marked private. */
const PRIVATE_HERE =
  'Voice is off here because this space or its agent is marked private. Voice sends what you say, and the replies it reads aloud, to ElevenLabs, a cloud speech service.';

export function mountVoiceMock(
  app: Hono,
  deps: {
    experience: ExperienceMock;
    enabled: boolean;
    /** Behave as a private space: voice is offered but off, with the reason. */
    private?: boolean;
  },
): void {
  let heard = 0;
  const fail = (c: Context, status: 400 | 401 | 403 | 404 | 413, code: string, message: string) =>
    c.json({ error: { code, message } }, status);
  const kept = (c: Context) => fail(c, 403, 'voice_private', PRIVATE_HERE);
  // Signed out after POST /signout, as every experience route is.
  const signedIn = (_c: Context) => !deps.experience.signedOut;
  const unset = (c: Context) =>
    fail(c, 404, 'voice_unavailable', 'Voice is not set up on this installation.');

  app.get('/voice', (c) => {
    if (!signedIn(c)) return fail(c, 401, 'unauthorized', 'A session is required.');
    return c.json(
      voiceStatus.parse({
        push_to_talk: deps.enabled,
        voice_mode: deps.enabled,
        max_recording_seconds: VOICE_LIMITS.recording_seconds,
        max_recording_bytes: VOICE_LIMITS.recording_bytes,
        off_reason: deps.enabled && deps.private ? PRIVATE_HERE : null,
      }),
    );
  });

  app.post('/voice/transcriptions', async (c) => {
    if (!signedIn(c)) return fail(c, 401, 'unauthorized', 'A session is required.');
    if (!deps.enabled) return unset(c);
    const query = voiceTranscriptionQuery.safeParse(c.req.query());
    if (!query.success) return fail(c, 400, 'invalid_request', 'Say how long the recording is.');
    if (deps.private) return kept(c);
    if (query.data.duration_ms > VOICE_LIMITS.recording_seconds * 1000 + 1000)
      return fail(
        c,
        413,
        'recording_too_long',
        'Voice messages can be up to 2 minutes. This recording is longer.',
      );
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!type.startsWith('audio/'))
      return fail(
        c,
        400,
        'recording_unreadable',
        'That recording is not in a format Melete can read.',
      );
    const bytes = (await c.req.arrayBuffer()).byteLength;
    if (bytes > VOICE_LIMITS.recording_bytes)
      return fail(
        c,
        413,
        'recording_too_large',
        'Voice messages can be up to 5 MB. This recording is larger.',
      );
    if (bytes === 0) return fail(c, 400, 'recording_unreadable', 'That recording is empty.');
    const text = HEARD[heard % HEARD.length] ?? '';
    heard += 1;
    return c.json(voiceTranscription.parse({ text, language: 'en' }));
  });

  const conversation = (c: Context) =>
    signedIn(c) && deps.experience.chats.has(c.req.param('id') ?? '');

  app.post('/conversations/:id/voice/session', (c) => {
    if (!conversation(c)) return fail(c, 404, 'not_found', 'That item is not here.');
    if (!deps.enabled) return unset(c);
    if (deps.private) return kept(c);
    const url = new URL(c.req.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = REALTIME_PATH;
    url.search = `?token=mock-${randomUUID()}&audio_format=pcm_16000&commit_strategy=vad`;
    return c.json(
      voiceSession.parse({
        url: url.toString(),
        sample_rate: SAMPLE_RATE,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
      201,
    );
  });

  app.post('/conversations/:id/voice/aside', async (c) => {
    if (!conversation(c)) return fail(c, 404, 'not_found', 'That item is not here.');
    if (!deps.enabled) return unset(c);
    if (deps.private) return kept(c);
    const parsed = voiceAsideRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid_request', 'Check the request and try again.');
    return c.json(voiceAside.parse(mockAside(parsed.data)));
  });

  app.post('/conversations/:id/voice/speech', async (c) => {
    if (!conversation(c)) return fail(c, 404, 'not_found', 'That item is not here.');
    if (!deps.enabled) return unset(c);
    if (deps.private) return kept(c);
    const parsed = voiceSpeechRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid_request', 'Check the request and try again.');
    // The service streams MP3 from the provider; silence as WAV plays the same way here.
    return new Response(Uint8Array.from(silence(parsed.data.text)), {
      headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' },
    });
  });
}

/** How loud a chunk is, from its 16-bit samples: 0 is silence, 1 is full scale. */
const loudness = (pcm: Uint8Array): number => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  const count = Math.floor(pcm.length / 2);
  for (let i = 0; i < count; i += 1) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sum += sample * sample;
  }
  return count ? Math.sqrt(sum / count) : 0;
};

export type RealtimeState = {
  spokenMs: number;
  quietMs: number;
  partials: number;
  committed: number;
};

/**
 * One realtime session: sound followed by silence is one utterance. Partial
 * transcripts arrive while the sound lasts, the commit once the silence does.
 */
export const realtimeSocket = {
  open(socket: ServerWebSocket<RealtimeState>) {
    socket.send(
      JSON.stringify({
        message_type: 'session_started',
        session_id: `mock-${Date.now()}`,
        config: { sample_rate: SAMPLE_RATE, audio_format: 'pcm_16000' },
      }),
    );
  },
  message(socket: ServerWebSocket<RealtimeState>, raw: string | Buffer) {
    let message: { message_type?: string; audio_base_64?: string };
    try {
      message = JSON.parse(String(raw));
    } catch {
      socket.send(JSON.stringify({ message_type: 'invalid_request', error: 'Not JSON.' }));
      return;
    }
    if (message.message_type !== 'input_audio_chunk' || !message.audio_base_64) return;
    const pcm = Uint8Array.from(Buffer.from(message.audio_base_64, 'base64'));
    const ms = (pcm.length / 2 / SAMPLE_RATE) * 1000;
    const state = socket.data;
    const utterance = UTTERANCES[state.committed % UTTERANCES.length] ?? '';
    if (loudness(pcm) > 0.02) {
      state.spokenMs += ms;
      state.quietMs = 0;
      const words = utterance.split(' ');
      const shown = Math.min(words.length, Math.floor(state.spokenMs / 250));
      if (shown > state.partials) {
        state.partials = shown;
        socket.send(
          JSON.stringify({
            message_type: 'partial_transcript',
            text: words.slice(0, shown).join(' '),
          }),
        );
      }
      return;
    }
    if (state.spokenMs < 300) return;
    state.quietMs += ms;
    if (state.quietMs < 700) return;
    socket.send(JSON.stringify({ message_type: 'committed_transcript', text: utterance }));
    state.committed += 1;
    state.spokenMs = 0;
    state.quietMs = 0;
    state.partials = 0;
  },
};
