/**
 * ElevenLabs, as the one provider behind every voice feature.
 *
 * Four calls, all authenticated with the operator's key in the `xi-api-key`
 * header, and none of them ever made from the browser with that key:
 *
 * - text to speech for the `audio.synthesize` capability, asked for as raw
 *   PCM and wrapped in a WAV header here, so the artifact is the same kind of
 *   file the other adapters write;
 * - Scribe batch transcription, for `audio.transcribe` and for push-to-talk;
 * - streaming text to speech, for reading a reply aloud in voice mode;
 * - a single-use token for Scribe realtime, which the browser presents
 *   instead of the key. It expires after fifteen minutes and is consumed on use.
 *
 * A failure is reported by status, and by the provider's error code when it is
 * one of a known few. What the provider wrote is never passed on: it can quote
 * the request, and it is not written for the person anyway.
 */
import { z } from 'zod';
import type { Transcript, TranscriptionAdapter } from './transcribe.ts';
import type { SpeechAdapter } from './tts.ts';
import { pcmWav } from './wav.ts';

export const ELEVENLABS_API = 'https://api.elevenlabs.io/';
/** A premade voice every account has, used when no voice is configured. */
export const ELEVENLABS_DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
export const ELEVENLABS_DEFAULT_SPEECH_MODEL = 'eleven_multilingual_v2';
export const ELEVENLABS_DEFAULT_STREAMING_MODEL = 'eleven_flash_v2_5';
export const ELEVENLABS_DEFAULT_TRANSCRIPTION_MODEL = 'scribe_v2';
/** The only model Scribe realtime serves. */
export const ELEVENLABS_REALTIME_MODEL = 'scribe_v2_realtime';
/** What the browser sends realtime Scribe: 16 kHz, 16-bit mono PCM. */
export const REALTIME_SAMPLE_RATE = 16_000;
/** How long a single-use token is good for, as the provider documents it. */
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;
/** The sample rate the artifact adapter asks for; plain PCM at this rate is on every plan. */
const SPEECH_SAMPLE_RATE = 24_000;

export type ElevenLabsOptions = {
  apiKey: string;
  voiceId?: string;
  /** The second voice in a two-person script; the first voice when unset. */
  secondVoiceId?: string;
  speechModel?: string;
  streamingModel?: string;
  transcriptionModel?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

/**
 * Error codes ElevenLabs puts in `detail.status`. Only a code on this list is
 * kept from a refusal, so a log line can say why without repeating anything
 * the provider wrote.
 */
const KNOWN_CODES = [
  'invalid_api_key',
  'missing_permissions',
  'quota_exceeded',
  'payment_required',
  'detected_unusual_activity',
  'voice_not_found',
  'model_not_found',
  'too_many_concurrent_requests',
  'system_busy',
] as const;
export type VoiceProviderCode = (typeof KNOWN_CODES)[number];

/** What a status means, in words an operator can act on. */
function meaning(status: number | null, code: VoiceProviderCode | null): string {
  if (status === null) return 'the service could not be reached';
  if (code === 'invalid_api_key') return 'key rejected';
  if (code === 'missing_permissions') return 'the key lacks a permission this call needs';
  if (code === 'quota_exceeded') return 'the account is out of credits';
  if (code === 'payment_required') return 'the plan does not cover this call';
  if (code === 'detected_unusual_activity') return 'the account is held for unusual activity';
  if (code === 'voice_not_found') return 'the configured voice does not exist';
  if (code === 'model_not_found') return 'the configured model does not exist';
  if (code === 'too_many_concurrent_requests' || status === 429)
    return 'rate or concurrency limit reached';
  if (status === 401) return 'key rejected';
  if (status === 402) return 'the plan or credits do not cover this call';
  if (status === 403) return 'the key is not allowed to make this call';
  if (status === 404) return 'the voice or model was not found';
  if (status >= 500) return 'the service had an error';
  return 'the request was refused';
}

/**
 * The provider answered with an error, or not at all. Carries the status and,
 * when the provider gave one of the known codes, that code; never the body.
 * The message is fit for a log line: it names no key and quotes nothing.
 */
export class VoiceProviderError extends Error {
  readonly code: VoiceProviderCode | null;
  constructor(
    readonly status: number | null,
    code: string | null = null,
  ) {
    const known = KNOWN_CODES.find((candidate) => candidate === code) ?? null;
    super(
      status === null
        ? `ElevenLabs did not answer: ${meaning(null, null)}`
        : `${status} from ElevenLabs: ${meaning(status, known)}${known ? ` (${known})` : ''}`,
    );
    this.code = known;
  }

  /** The key itself was refused, rather than one call. */
  get keyRefused(): boolean {
    if (this.code === 'missing_permissions') return false;
    return this.status === 401 || this.code === 'invalid_api_key';
  }
}

/** The `detail.status` of an error body, read only to match it against the known codes. */
async function refusalCode(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text.slice(0, 4096)) as { detail?: { status?: unknown } } | null;
    const status = parsed?.detail?.status;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}

/** Whether the key is accepted, as a connector's health check reads it. */
export type ProviderCheck = { ok: true } | { ok: false; keyRefused: boolean; detail: string };

/** How long one answer about the key is reused, so checks do not call the provider each time. */
const CHECK_REUSE_MS = 5 * 60 * 1000;

/** Reading a reply aloud, and opening a realtime transcription session, for voice mode. */
export type LiveVoice = {
  /** Streams speech for one piece of text. The bytes are passed through, never kept. */
  speak(
    text: string,
    signal?: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; mime: string }>;
  /** A realtime transcription address the browser can open with no key of its own. */
  session(): Promise<{ url: string; expires_at: string }>;
};

const scribeReply = z.object({
  language_code: z.string().nullish(),
  text: z.string(),
  words: z
    .array(
      z.object({
        text: z.string(),
        start: z.number().nullish(),
        end: z.number().nullish(),
        type: z.string().nullish(),
        speaker_id: z.string().nullish(),
      }),
    )
    .nullish(),
});

const tokenReply = z.object({ token: z.string().min(1).max(4096) });

function client(options: ElevenLabsOptions) {
  const base = (options.baseUrl ?? ELEVENLABS_API).replace(/\/*$/, '/');
  const call = options.fetch ?? fetch;
  return async (path: string, init: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await call(new URL(path, base), {
        ...init,
        headers: { 'xi-api-key': options.apiKey, ...init.headers },
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new VoiceProviderError(null);
    }
    if (!response.ok) {
      // The body is read for its error code alone: nothing the provider wrote is passed on.
      throw new VoiceProviderError(response.status, await refusalCode(response));
    }
    return response;
  };
}

/**
 * A cheap call that tells whether the key is accepted: the account's own
 * record, which costs no characters. A key scoped without that read is still
 * a working key, so a missing permission here counts as accepted. One answer
 * is reused for a few minutes.
 */
function keyCheck(options: ElevenLabsOptions): () => Promise<ProviderCheck> {
  const request = client(options);
  let last: { at: number; result: ProviderCheck } | null = null;
  return async () => {
    if (last && Date.now() - last.at < CHECK_REUSE_MS) return last.result;
    let result: ProviderCheck;
    try {
      await request('v1/user', { method: 'GET' });
      result = { ok: true };
    } catch (error) {
      if (!(error instanceof VoiceProviderError)) throw error;
      result =
        error.code === 'missing_permissions'
          ? { ok: true }
          : { ok: false, keyRefused: error.keyRefused, detail: error.message };
    }
    last = { at: Date.now(), result };
    return result;
  };
}

const voicePath = (voiceId: string) => encodeURIComponent(voiceId);

export function elevenLabsSpeechAdapter(options: ElevenLabsOptions): SpeechAdapter {
  const request = client(options);
  const model = options.speechModel ?? ELEVENLABS_DEFAULT_SPEECH_MODEL;
  const first = options.voiceId ?? ELEVENLABS_DEFAULT_VOICE;
  const second = options.secondVoiceId ?? first;
  return {
    model,
    verify: keyCheck(options),
    async synthesize({ script, voice }) {
      const response = await request(
        `v1/text-to-speech/${voicePath(voice === 'tenor' ? second : first)}?output_format=pcm_${SPEECH_SAMPLE_RATE}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: script, model_id: model }),
        },
      );
      return pcmWav(new Uint8Array(await response.arrayBuffer()), SPEECH_SAMPLE_RATE);
    },
  };
}

export function elevenLabsTranscriptionAdapter(options: ElevenLabsOptions): TranscriptionAdapter {
  const request = client(options);
  const model = options.transcriptionModel ?? ELEVENLABS_DEFAULT_TRANSCRIPTION_MODEL;
  return {
    model,
    verify: keyCheck(options),
    async transcribe(input, signal): Promise<Transcript> {
      const form = new FormData();
      form.set('model_id', model);
      form.set(
        'file',
        new Blob([Uint8Array.from(input.audio)], { type: input.mime }),
        input.filename,
      );
      form.set('diarize', input.diarize ? 'true' : 'false');
      form.set('timestamps_granularity', 'word');
      form.set('tag_audio_events', 'false');
      if (input.language) form.set('language_code', input.language);
      if (input.diarize && input.speakers) form.set('num_speakers', String(input.speakers));
      const response = await request('v1/speech-to-text', {
        method: 'POST',
        body: form,
        ...(signal ? { signal } : {}),
      });
      const parsed = scribeReply.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new VoiceProviderError(response.status);
      return {
        language: parsed.data.language_code ?? null,
        text: parsed.data.text.trim(),
        words: (parsed.data.words ?? [])
          .filter((word) => (word.type ?? 'word') === 'word')
          .map((word) => ({
            text: word.text,
            start: word.start ?? 0,
            end: word.end ?? word.start ?? 0,
            speaker: word.speaker_id ?? null,
          })),
      };
    },
  };
}

export function elevenLabsLiveVoice(options: ElevenLabsOptions): LiveVoice {
  const request = client(options);
  const model = options.streamingModel ?? ELEVENLABS_DEFAULT_STREAMING_MODEL;
  const voice = options.voiceId ?? ELEVENLABS_DEFAULT_VOICE;
  const base = new URL((options.baseUrl ?? ELEVENLABS_API).replace(/\/*$/, '/'));
  return {
    async speak(text, signal) {
      const response = await request(
        `v1/text-to-speech/${voicePath(voice)}/stream?output_format=mp3_44100_64`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: model }),
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.body) throw new VoiceProviderError(response.status);
      return { body: response.body, mime: 'audio/mpeg' };
    },
    async session() {
      const response = await request('v1/single-use-token/realtime_scribe', { method: 'POST' });
      const parsed = tokenReply.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new VoiceProviderError(response.status);
      const url = new URL('v1/speech-to-text/realtime', base);
      url.protocol = base.protocol === 'http:' ? 'ws:' : 'wss:';
      url.searchParams.set('model_id', ELEVENLABS_REALTIME_MODEL);
      url.searchParams.set('token', parsed.data.token);
      url.searchParams.set('audio_format', `pcm_${REALTIME_SAMPLE_RATE}`);
      // The provider decides where an utterance ends, from the silence after it.
      url.searchParams.set('commit_strategy', 'vad');
      return {
        url: url.toString(),
        expires_at: new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString(),
      };
    },
  };
}
