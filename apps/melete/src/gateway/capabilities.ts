/**
 * Which capabilities this installation actually has.
 *
 * Advertising is not the same as having. A capability appears in the catalog
 * only when there is an adapter behind it, which for a real provider means a
 * key. Without one the fake adapters are still there for tests, and in a
 * deployment with neither the capability is absent and the skill that needs it
 * is not offered.
 *
 * ElevenLabs is preferred when its key is set: it speaks, transcribes, and
 * carries voice mode. An OpenAI-compatible endpoint still speaks when it is
 * the only thing configured, and nothing else.
 */
import type { CapabilityManifest } from '@melete/contracts';
import {
  elevenLabsLiveVoice,
  elevenLabsSpeechAdapter,
  elevenLabsTranscriptionAdapter,
  type LiveVoice,
} from '../connectors/elevenlabs.ts';
import {
  fakeTranscriptionAdapter,
  type TranscriptionAdapter,
  transcriptionCapability,
} from '../connectors/transcribe.ts';
import {
  fakeSpeechAdapter,
  openAiSpeechAdapter,
  type SpeechAdapter,
  speechCapability,
} from '../connectors/tts.ts';

export type ConfiguredCapabilities = {
  manifests: CapabilityManifest[];
  speech: SpeechAdapter | null;
  transcription: TranscriptionAdapter | null;
  /** Voice mode: streamed speech and realtime transcription. ElevenLabs only. */
  live: LiveVoice | null;
  provider: string;
  unitCostUsd: number;
  transcriptionUnitCostUsd: number;
};

/**
 * What a call is charged against the job budget, from configuration only. It
 * is an estimate the budget holds back, not the provider's bill.
 */
export const SPEECH_UNIT_COST_USD = 0.015;
export const ELEVENLABS_SPEECH_UNIT_COST_USD = 0.1;
export const TRANSCRIPTION_UNIT_COST_USD = 0.2;

export function capabilitiesFromEnv(
  env: Record<string, string | undefined> = process.env,
): ConfiguredCapabilities {
  const eleven = env.ELEVENLABS_API_KEY?.trim();
  if (eleven) {
    const options = {
      apiKey: eleven,
      ...(env.ELEVENLABS_VOICE_ID ? { voiceId: env.ELEVENLABS_VOICE_ID } : {}),
      ...(env.ELEVENLABS_SECOND_VOICE_ID ? { secondVoiceId: env.ELEVENLABS_SECOND_VOICE_ID } : {}),
      ...(env.ELEVENLABS_SPEECH_MODEL ? { speechModel: env.ELEVENLABS_SPEECH_MODEL } : {}),
      ...(env.ELEVENLABS_STREAMING_MODEL ? { streamingModel: env.ELEVENLABS_STREAMING_MODEL } : {}),
      ...(env.ELEVENLABS_TRANSCRIPTION_MODEL
        ? { transcriptionModel: env.ELEVENLABS_TRANSCRIPTION_MODEL }
        : {}),
    };
    const speech = elevenLabsSpeechAdapter(options);
    const transcription = elevenLabsTranscriptionAdapter(options);
    return {
      speech,
      transcription,
      live: elevenLabsLiveVoice(options),
      provider: 'elevenlabs',
      unitCostUsd: ELEVENLABS_SPEECH_UNIT_COST_USD,
      transcriptionUnitCostUsd: TRANSCRIPTION_UNIT_COST_USD,
      manifests: [
        speechCapability(speech, 'elevenlabs', ELEVENLABS_SPEECH_UNIT_COST_USD),
        transcriptionCapability(transcription, 'elevenlabs', TRANSCRIPTION_UNIT_COST_USD),
      ],
    };
  }
  const key = env.OPENAI_API_KEY;
  const base = env.OPENAI_COMPAT_BASE_URL;
  if (key || base) {
    const speech = openAiSpeechAdapter({
      apiKey: key ?? '',
      ...(base ? { baseUrl: `${base.replace(/\/+$/, '')}/` } : {}),
      ...(env.MELETE_SPEECH_MODEL ? { model: env.MELETE_SPEECH_MODEL } : {}),
    });
    const provider = base ? 'openai-compatible' : 'openai';
    return {
      speech,
      transcription: null,
      live: null,
      provider,
      unitCostUsd: SPEECH_UNIT_COST_USD,
      transcriptionUnitCostUsd: 0,
      manifests: [speechCapability(speech, provider, SPEECH_UNIT_COST_USD)],
    };
  }
  if (env.MELETE_ENABLE_FAKE_PROVIDER === 'true') {
    return {
      speech: fakeSpeechAdapter,
      transcription: fakeTranscriptionAdapter,
      // Voice mode needs a realtime service in the browser; there is no fake one.
      live: null,
      provider: 'fake',
      unitCostUsd: 0,
      transcriptionUnitCostUsd: 0,
      manifests: [
        speechCapability(fakeSpeechAdapter, 'fake', 0),
        transcriptionCapability(fakeTranscriptionAdapter, 'fake', 0),
      ],
    };
  }
  // Nothing configured: the capabilities are absent, not broken.
  return {
    speech: null,
    transcription: null,
    live: null,
    provider: 'none',
    unitCostUsd: 0,
    transcriptionUnitCostUsd: 0,
    manifests: [],
  };
}
