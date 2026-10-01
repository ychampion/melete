import { describe, expect, test } from 'bun:test';
import {
  ELEVENLABS_DEFAULT_VOICE,
  elevenLabsLiveVoice,
  elevenLabsSpeechAdapter,
  elevenLabsTranscriptionAdapter,
  VoiceProviderError,
} from './elevenlabs.ts';
import { wavDurationMs } from './wav.ts';

type Seen = { url: URL; init: RequestInit };

/** A fetch that records each request and answers with what the test gives it. */
function stub(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const request = { url: new URL(String(input)), init };
    seen.push(request);
    return answer(request);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe('ElevenLabs text to speech for the speech capability', () => {
  test('asks for plain PCM with the key in xi-api-key, and returns a playable WAV', async () => {
    const pcm = new Uint8Array(48_000); // one second at 24 kHz, 16-bit mono
    const { fetch, seen } = stub(() => new Response(pcm));
    const adapter = elevenLabsSpeechAdapter({ apiKey: 'el-key', voiceId: 'voiceA', fetch });
    const wav = await adapter.synthesize({ script: 'Hello there.', voice: 'alto' });
    const [call] = seen;
    expect(call?.url.origin).toBe('https://api.elevenlabs.io');
    expect(call?.url.pathname).toBe('/v1/text-to-speech/voiceA');
    expect(call?.url.searchParams.get('output_format')).toBe('pcm_24000');
    expect(call?.init.method).toBe('POST');
    expect(header(call?.init ?? {}, 'xi-api-key')).toBe('el-key');
    expect(header(call?.init ?? {}, 'authorization')).toBeNull();
    expect(JSON.parse(String(call?.init.body))).toEqual({
      text: 'Hello there.',
      model_id: 'eleven_multilingual_v2',
    });
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(wavDurationMs(wav)).toBe(1000);
    expect(adapter.model).toBe('eleven_multilingual_v2');
  });

  test('the second voice reads the tenor lines, and falls back to the first', async () => {
    const { fetch, seen } = stub(() => new Response(new Uint8Array(2)));
    await elevenLabsSpeechAdapter({
      apiKey: 'k',
      voiceId: 'first',
      secondVoiceId: 'second',
      fetch,
    }).synthesize({ script: 'B: hi', voice: 'tenor' });
    await elevenLabsSpeechAdapter({ apiKey: 'k', fetch }).synthesize({
      script: 'hi',
      voice: 'tenor',
    });
    expect(seen.map((call) => call.url.pathname)).toEqual([
      '/v1/text-to-speech/second',
      `/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE}`,
    ]);
  });

  test('a refusal carries the status and never what the provider wrote', async () => {
    const { fetch } = stub(
      () => new Response('{"detail":"invalid key sk-secret-echo"}', { status: 401 }),
    );
    const failure = await elevenLabsSpeechAdapter({ apiKey: 'k', fetch })
      .synthesize({ script: 'x', voice: 'alto' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VoiceProviderError);
    expect((failure as VoiceProviderError).status).toBe(401);
    expect(String((failure as Error).message)).not.toContain('secret');
  });

  test('an unreachable provider is a failure with no status', async () => {
    const fetch = (async () => {
      throw new TypeError('connect ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const failure = await elevenLabsSpeechAdapter({ apiKey: 'k', fetch })
      .synthesize({ script: 'x', voice: 'alto' })
      .catch((error: unknown) => error);
    expect((failure as VoiceProviderError).status).toBeNull();
  });
});

describe('ElevenLabs Scribe batch transcription', () => {
  test('posts the file as multipart with word timestamps, and keeps only the words', async () => {
    const { fetch, seen } = stub(() =>
      Response.json({
        language_code: 'en',
        language_probability: 0.98,
        text: ' Hello there. ',
        words: [
          { text: 'Hello', start: 0.1, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
          { text: ' ', start: 0.4, end: 0.5, type: 'spacing', speaker_id: 'speaker_0' },
          { text: '(laughter)', start: 0.5, end: 0.9, type: 'audio_event' },
          { text: 'there.', start: 0.9, end: 1.2, type: 'word', speaker_id: 'speaker_1' },
        ],
      }),
    );
    const adapter = elevenLabsTranscriptionAdapter({ apiKey: 'el-key', fetch });
    const transcript = await adapter.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      filename: 'meeting.mp3',
      mime: 'audio/mpeg',
      diarize: true,
      language: 'en',
      speakers: 2,
    });
    const [call] = seen;
    expect(call?.url.pathname).toBe('/v1/speech-to-text');
    expect(header(call?.init ?? {}, 'xi-api-key')).toBe('el-key');
    const form = call?.init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('tag_audio_events')).toBe('false');
    expect(form.get('language_code')).toBe('en');
    expect(form.get('num_speakers')).toBe('2');
    const file = form.get('file') as File;
    expect(file.name).toBe('meeting.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(transcript).toEqual({
      language: 'en',
      text: 'Hello there.',
      words: [
        { text: 'Hello', start: 0.1, end: 0.4, speaker: 'speaker_0' },
        { text: 'there.', start: 0.9, end: 1.2, speaker: 'speaker_1' },
      ],
    });
  });

  test('a short clip skips speaker labels and names no speaker count', async () => {
    const { fetch, seen } = stub(() => Response.json({ text: 'hi', words: [] }));
    await elevenLabsTranscriptionAdapter({
      apiKey: 'k',
      transcriptionModel: 'scribe_x',
      fetch,
    }).transcribe({
      audio: new Uint8Array(1),
      filename: 'clip.webm',
      mime: 'audio/webm',
      diarize: false,
      speakers: 3,
    });
    const form = seen[0]?.init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_x');
    expect(form.get('diarize')).toBe('false');
    expect(form.get('num_speakers')).toBeNull();
    expect(form.get('language_code')).toBeNull();
  });

  test('an answer that is not a transcript is a provider failure', async () => {
    const { fetch } = stub(() => Response.json({ nothing: true }));
    const failure = await elevenLabsTranscriptionAdapter({ apiKey: 'k', fetch })
      .transcribe({
        audio: new Uint8Array(1),
        filename: 'a.wav',
        mime: 'audio/wav',
        diarize: false,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VoiceProviderError);
  });
});

describe('ElevenLabs for voice mode', () => {
  test('streams speech from the stream endpoint with the fast model', async () => {
    const { fetch, seen } = stub(() => new Response(new Uint8Array([0xff, 0xfb])));
    const spoken = await elevenLabsLiveVoice({ apiKey: 'el-key', voiceId: 'v1', fetch }).speak(
      'Your first meeting is at nine.',
    );
    const [call] = seen;
    expect(call?.url.pathname).toBe('/v1/text-to-speech/v1/stream');
    expect(call?.url.searchParams.get('output_format')).toBe('mp3_44100_64');
    expect(header(call?.init ?? {}, 'xi-api-key')).toBe('el-key');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      text: 'Your first meeting is at nine.',
      model_id: 'eleven_flash_v2_5',
    });
    expect(spoken.mime).toBe('audio/mpeg');
    expect(new Uint8Array(await new Response(spoken.body).arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xfb]),
    );
  });

  test('a session is a realtime address carrying a single-use token, never the key', async () => {
    const { fetch, seen } = stub(() => Response.json({ token: 'sutkn_abc123' }));
    const before = Date.now();
    const session = await elevenLabsLiveVoice({ apiKey: 'el-key', fetch }).session();
    const [call] = seen;
    expect(call?.url.pathname).toBe('/v1/single-use-token/realtime_scribe');
    expect(call?.init.method).toBe('POST');
    expect(header(call?.init ?? {}, 'xi-api-key')).toBe('el-key');
    const url = new URL(session.url);
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.elevenlabs.io');
    expect(url.pathname).toBe('/v1/speech-to-text/realtime');
    expect(url.searchParams.get('token')).toBe('sutkn_abc123');
    expect(url.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(url.searchParams.get('audio_format')).toBe('pcm_16000');
    expect(url.searchParams.get('commit_strategy')).toBe('vad');
    expect(session.url).not.toContain('el-key');
    const expires = Date.parse(session.expires_at) - before;
    expect(expires).toBeGreaterThan(14 * 60 * 1000);
    expect(expires).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
  });

  test('a regional or local base address keeps its host, and plain http becomes ws', async () => {
    const { fetch } = stub(() => Response.json({ token: 't' }));
    const session = await elevenLabsLiveVoice({
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:9999',
      fetch,
    }).session();
    expect(session.url.startsWith('ws://127.0.0.1:9999/v1/speech-to-text/realtime?')).toBe(true);
  });
});
