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
 * A failure is reported by status only. What the provider said is never passed
 * on: it can quote the request, and it is not written for the person anyway.
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

/** The provider answered with an error, or not at all. Carries the status, never the body. */
export class VoiceProviderError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? 'voice provider unreachable' : `voice provider answered ${status}`);
  }
}

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
      // The body is drained and dropped: nothing the provider wrote is passed on.
      await response.body?.cancel().catch(() => undefined);
      throw new VoiceProviderError(response.status);
    }
    return response;
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
