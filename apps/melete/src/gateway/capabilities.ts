/**
 * Which capabilities this installation actually has.
 *
 * Advertising is not the same as having. A capability appears in the catalog
 * only when there is an adapter behind it, which for the real speech provider
 * means a key. Without one the fake adapter is still there for tests, and in a
 * deployment with neither the capability is absent and the skill that needs it
 * is not offered.
 */
import type { CapabilityManifest } from '@melete/contracts';
import {
  fakeSpeechAdapter,
  openAiSpeechAdapter,
  type SpeechAdapter,
  speechCapability,
} from '../connectors/tts.ts';

export type ConfiguredCapabilities = {
  manifests: CapabilityManifest[];
  speech: SpeechAdapter | null;
  provider: string;
  unitCostUsd: number;
};

/** What a call is charged against the job budget, from configuration only. */
export const SPEECH_UNIT_COST_USD = 0.015;

export function capabilitiesFromEnv(
  env: Record<string, string | undefined> = process.env,
): ConfiguredCapabilities {
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
      provider,
      unitCostUsd: SPEECH_UNIT_COST_USD,
      manifests: [speechCapability(speech, provider, SPEECH_UNIT_COST_USD)],
    };
  }
  if (env.MELETE_ENABLE_FAKE_PROVIDER === 'true') {
    return {
      speech: fakeSpeechAdapter,
      provider: 'fake',
      unitCostUsd: 0,
      manifests: [speechCapability(fakeSpeechAdapter, 'fake', 0)],
    };
  }
  // Nothing configured: the capability is absent, not broken.
  return { speech: null, provider: 'none', unitCostUsd: 0, manifests: [] };
}
