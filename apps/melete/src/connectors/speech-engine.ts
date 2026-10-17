/**
 * ElevenLabs Speech Engine: voice for a call with Melete's own agent.
 *
 * ElevenLabs does the listening, the turn-taking, the interruptions and the
 * speaking; Melete stays the brain. When a call starts, ElevenLabs opens a
 * WebSocket to this service (the engine's `ws_url`) and sends what the person
 * said each time they finish a turn; the service answers with text, streamed,
 * which ElevenLabs speaks. The protocol is the documented "Speech Engine
 * upstream" one, read and written here directly because the service runs on
 * Bun's own WebSocket server rather than a Node HTTP server the SDK attaches to.
 *
 * Three calls with the operator's key, none of them made from the browser:
 *
 * - finding or making the engine this installation uses, pointed at its public
 *   address, and keeping its settings in step;
 * - a conversation token for one call, which is all the browser is given;
 * - checking that a WebSocket that claims to come from ElevenLabs does: it
 *   carries a short-lived JWT signed with the SHA-256 of the key.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { CALL_UPSTREAM_PATH } from '../call/upstream-path.ts';
import {
  client,
  ELEVENLABS_DEFAULT_STREAMING_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
  type ElevenLabsOptions,
  VoiceProviderError,
} from './elevenlabs.ts';

export { CALL_UPSTREAM_PATH, SPEECH_ENGINE_AUTH_HEADER } from '../call/upstream-path.ts';

const ISSUER = 'https://api.elevenlabs.io/convai/speech-engine';
const SUBJECT = 'convai_speech_engine_upstream';
/** The clock skew the provider allows its own tokens. */
const LEEWAY_SECONDS = 60;
/** A data-residency key signs with its base key. */
const RESIDENCY_SUFFIX = /_residency_[a-z0-9]+$/;

/**
 * How long a call's token may wait to be used. The browser starts the call as
 * soon as it has the token, so a few minutes is generous; after it, the call
 * the token was for is not taken.
 */
export const CALL_START_WINDOW_MS = 2 * 60 * 1000;

/** The longest call ElevenLabs serves (40 minutes). */
export const CALL_MAX_SECONDS = 2400;

/**
 * The text-to-speech models an English Speech Engine accepts. ElevenLabs
 * refuses the multilingual ones there (it fails creating the engine), so a
 * voice-mode model such as eleven_flash_v2_5 leaves the engine on its own
 * default instead.
 */
const ENGINE_TTS_MODELS = new Set([
  'eleven_turbo_v2',
  'eleven_flash_v2',
  'eleven_v3_conversational',
  'eleven_v4',
  'eleven_v4_turbo',
]);

const b64url = (value: string) =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Whether an upstream connection's JWT was signed by ElevenLabs for this key,
 * for the Speech Engine upstream, and is current. Nothing about a refusal is
 * returned: the connection is simply not accepted.
 */
export function verifyUpstreamToken(
  value: string | null | undefined,
  apiKey: string,
  now: number = Date.now(),
): boolean {
  if (!value) return false;
  let token = value.trim();
  if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header = '', payload = '', signature = ''] = parts;
  let claims: { iss?: unknown; sub?: unknown; exp?: unknown; iat?: unknown; alg?: unknown };
  let head: { alg?: unknown };
  try {
    head = JSON.parse(b64url(header).toString('utf8'));
    claims = JSON.parse(b64url(payload).toString('utf8'));
  } catch {
    return false;
  }
  if (head?.alg !== 'HS256') return false;
  const secret = createHash('sha256')
    .update(apiKey.trim().replace(RESIDENCY_SUFFIX, ''), 'utf8')
    .digest();
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = b64url(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  if (claims.iss !== ISSUER || claims.sub !== SUBJECT) return false;
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return false;
  const seconds = Math.floor(now / 1000);
  return claims.exp + LEEWAY_SECONDS >= seconds && claims.iat - LEEWAY_SECONDS <= seconds;
}

/* ---------- the upstream protocol ---------- */

const transcriptMessage = z.object({
  role: z.enum(['user', 'agent']),
  content: z.string(),
});

/** What ElevenLabs sends on the upstream WebSocket. Anything else is ignored. */
export const upstreamMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), conversation_id: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('user_transcript'),
    user_transcript: z.array(transcriptMessage).max(2000),
    event_id: z.number().int().optional(),
  }),
  z.object({ type: z.literal('ping') }).loose(),
  z.object({ type: z.literal('close') }).loose(),
  z.object({ type: z.literal('error'), message: z.string().optional() }).loose(),
]);
export type UpstreamMessage = z.infer<typeof upstreamMessage>;

/** What the service sends back: a piece of the answer, the end of it, or a pong. */
export type UpstreamReply =
  | { type: 'agent_response'; content: string; event_id: number | undefined; is_final: boolean }
  | { type: 'pong' };

/* ---------- the engine and the call token ---------- */

/** Starting a call: what the browser is given, and the call it is for. */
export type CallStart = {
  /** The conversation token for the browser. Good for this call only. */
  token: string;
  /** The provider's id for the call, which its upstream connection names in `init`. */
  conversationId: string;
  /** When the token stops being accepted for starting this call. */
  expiresAt: Date;
};

/** Voice for calls: a token per call, and the check on the upstream connection. */
export type CallVoice = {
  start(signal?: AbortSignal): Promise<CallStart>;
  verify(header: string | null | undefined): boolean;
};

export type SpeechEngineOptions = ElevenLabsOptions & {
  /** An engine the operator set up; used as it is, never changed. */
  engineId?: string;
  /** The WebSocket address ElevenLabs connects to, `wss://…/api/voice/call/upstream`. */
  wsUrl: string;
  /** The engine's name in ElevenLabs, which is how this installation finds its own again. */
  name: string;
};

const engineList = z.object({
  speech_engines: z.array(z.object({ speech_engine_id: z.string(), name: z.string() })),
});
const engineReply = z.object({ speech_engine_id: z.string().min(1) });
const tokenReply = z.object({
  token: z.string().min(1).max(8192),
  conversation_id: z.string().min(1).max(200),
});

/** The `exp` of a JWT, read without trusting it, or null when it is not one. */
function jwtExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(b64url(payload).toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The address ElevenLabs reaches this service's upstream route at, or null
 * when the service has no public https:// address: ElevenLabs connects from the
 * internet, so a private address cannot take calls.
 */
export function callUpstreamUrl(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:') return null;
    return `wss://${url.host}${url.pathname.replace(/\/+$/, '')}/api${CALL_UPSTREAM_PATH}`;
  } catch {
    return null;
  }
}

export function elevenLabsSpeechEngine(options: SpeechEngineOptions): CallVoice {
  const request = client(options);
  const model = options.streamingModel ?? ELEVENLABS_DEFAULT_STREAMING_MODEL;
  const settings = {
    name: options.name,
    tags: ['melete'],
    speech_engine: { ws_url: options.wsUrl },
    tts: {
      voice_id: options.voiceId ?? ELEVENLABS_DEFAULT_VOICE,
      ...(ENGINE_TTS_MODELS.has(model) ? { model_id: model } : {}),
    },
    conversation: {
      max_duration_seconds: CALL_MAX_SECONDS,
      client_events: [
        'conversation_initiation_metadata',
        'audio',
        'interruption',
        'user_transcript',
        'tentative_user_transcript',
        'agent_response',
        'agent_response_correction',
        'ping',
      ],
    },
    // The words are kept in the chat; ElevenLabs keeps no recording of the call.
    privacy: { record_voice: false },
    // The agent may start a turn, call a tool and only then speak; the filler
    // words come within a couple of seconds, well inside this.
    cascade_timeout_seconds: 15,
  };
  let engine: Promise<string> | null = null;

  const ensure = async (): Promise<string> => {
    if (options.engineId) return options.engineId;
    const search = new URLSearchParams({ search: options.name, page_size: '100' });
    const listed = engineList.safeParse(
      await (await request(`v1/speech-engine?${search}`, { method: 'GET' }))
        .json()
        .catch(() => null),
    );
    if (!listed.success) throw new VoiceProviderError(200);
    const found = listed.data.speech_engines.find((entry) => entry.name === options.name);
    const response = await request(
      found ? `v1/speech-engine/${encodeURIComponent(found.speech_engine_id)}` : 'v1/speech-engine',
      {
        method: found ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      },
    );
    const made = engineReply.safeParse(await response.json().catch(() => null));
    if (!made.success) throw new VoiceProviderError(response.status);
    return made.data.speech_engine_id;
  };

  return {
    async start(signal) {
      engine ??= ensure().catch((error: unknown) => {
        // A failure is not remembered: the next call tries again.
        engine = null;
        throw error;
      });
      const id = await engine;
      const response = await request(
        `v1/convai/conversation/token?${new URLSearchParams({ agent_id: id })}`,
        { method: 'GET', ...(signal ? { signal } : {}) },
      );
      const parsed = tokenReply.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new VoiceProviderError(response.status);
      const window = Date.now() + CALL_START_WINDOW_MS;
      const stated = jwtExpiry(parsed.data.token);
      return {
        token: parsed.data.token,
        conversationId: parsed.data.conversation_id,
        expiresAt: new Date(stated === null ? window : Math.min(stated, window)),
      };
    },
    verify: (header) => verifyUpstreamToken(header, options.apiKey),
  };
}
