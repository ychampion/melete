/**
 * Text to speech, as a capability.
 *
 * Two adapters behind one manifest. The fake one writes a valid silent WAV with
 * the script in its metadata, so the whole path — propose, approve, reserve
 * budget, dispatch, receipt, artifact, verify — is exercised by the test suite
 * with no key and no network. The real one posts to an OpenAI-compatible speech
 * endpoint and is only advertised when a key is configured, because a
 * capability that is advertised and then refused is worse than one that was
 * never offered.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  Action,
  CapabilityManifest,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JsonValue,
  VerifyResult,
} from '@melete/contracts';
import { capabilityTool } from '@melete/contracts';
import type { Connector, ConnectorContext } from './types.ts';
import { silentWav, WAV_MIME } from './wav.ts';

const digest = (value: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(value)).digest('hex');

export type SpeechRequest = { script: string; voice: string };
/** What an adapter has to do: bytes in, bytes out. Nothing about files or rows. */
export type SpeechAdapter = {
  model: string;
  synthesize(request: SpeechRequest): Promise<Uint8Array>;
};

export const VOICES = ['alto', 'tenor'] as const;

const speechSchema = {
  type: 'object',
  properties: {
    script: { type: 'string', minLength: 1, maxLength: 20_000 },
    voice: { type: 'string', enum: [...VOICES] },
    path: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['script', 'path'],
  additionalProperties: false,
} as const;

/** The fake adapter: a real file, no key, deterministic bytes for one script. */
export const fakeSpeechAdapter: SpeechAdapter = {
  model: 'fake-tts-v1',
  async synthesize(request) {
    return silentWav({ script: request.script, title: `Melete, ${request.voice}` });
  },
};

/**
 * The real adapter. Key-gated: without `OPENAI_API_KEY` or an OpenAI-compatible
 * base URL there is no adapter, the capability is marked unavailable, and the
 * skill that needs it is not offered.
 */
export function openAiSpeechAdapter(options: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}): SpeechAdapter {
  const base = (options.baseUrl ?? 'https://api.openai.com/v1/').replace(/\/*$/, '/');
  const call = options.fetch ?? fetch;
  const model = options.model ?? 'gpt-4o-mini-tts';
  return {
    model,
    async synthesize(request) {
      const response = await call(new URL('audio/speech', base), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          voice: request.voice === 'tenor' ? 'onyx' : 'nova',
          input: request.script,
          response_format: 'wav',
        }),
      });
      if (!response.ok) throw new Error(`speech provider answered ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export const speechCapability = (
  adapter: SpeechAdapter | null,
  provider: string,
  unitCostUsd: number,
): CapabilityManifest => ({
  kind: 'audio.synthesize',
  provider,
  model: adapter?.model ?? 'unconfigured',
  description:
    'Read a script aloud and write the audio into the space artifacts as a file you can play.',
  effect_class: 'spend',
  unit_cost_usd: unitCostUsd,
  produces: WAV_MIME,
  input_schema: speechSchema,
  required_scopes: ['audio.synthesize'],
  available: adapter !== null,
});

const requiredString = (payload: Record<string, JsonValue>, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a string`);
  return value;
};

/** A file name, not a path: generated audio lands in the space artifacts root. */
function safeName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value) || value.includes('..'))
    throw new Error('path must be a simple file name');
  return value.endsWith('.wav') ? value : `${value}.wav`;
}

export type CapabilityConnectorOptions = {
  spacesRoot: string;
  adapter: SpeechAdapter | null;
  provider: string;
  unitCostUsd?: number;
};

/**
 * A capability behind the connector interface, so a generation call goes down
 * the path every other effect goes down: one action, an approval bound to the
 * payload hash, a budget reservation, an idempotency key, a receipt persisted
 * before the runtime hears anything, and a verify that reads the file back.
 */
export function createCapabilityConnector(options: CapabilityConnectorOptions): Connector {
  const capability = speechCapability(options.adapter, options.provider, options.unitCostUsd ?? 0);
  const manifest: ConnectorManifest = {
    name: 'generation',
    version: '0.1.0',
    provider: 'generation',
    description: 'Generative capabilities the configured providers advertise.',
    credentials: [],
    health: true,
    tools: [capabilityTool(capability)],
  };

  const target = async (ctx: ConnectorContext, name: string) => {
    if (!/^sp_[A-Za-z0-9]+$/.test(ctx.space_id)) throw new Error('invalid trusted file scope');
    const base = await realpath(options.spacesRoot);
    const directory = path.join(base, ctx.space_id, 'artifacts');
    await mkdir(directory, { recursive: true });
    return path.join(directory, safeName(name));
  };

  const readBytes = async (file: string): Promise<Uint8Array | null> => {
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  };

  return {
    manifest,
    capability,
    async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
      if (!options.adapter)
        return { outcome: 'failed', reason: 'no speech provider is configured', retryable: false };
      if (action.id !== ctx.idempotency_key || action.job_id !== ctx.job_id)
        throw new Error('connector action identity mismatch');
      const payload = action.canonical_payload;
      const script = requiredString(payload, 'script');
      const name = requiredString(payload, 'path');
      const voice = typeof payload.voice === 'string' ? payload.voice : 'alto';
      const bytes = await options.adapter.synthesize({ script, voice });
      const file = await target(ctx, name);
      // Written whole and then named, so a crash mid-write never leaves a
      // half-file that verify would hash as a success.
      const temporary = `${file}.${action.id}.part`;
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      try {
        await handle.write(bytes);
      } finally {
        await handle.close();
      }
      const { rename } = await import('node:fs/promises');
      await rename(temporary, file);
      const hash = digest(bytes);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: hash,
          detail: {
            kind: 'artifact',
            path: `artifacts/${safeName(name)}`,
            mime: capability.produces,
            bytes: bytes.length,
            content_hash: hash,
            model: options.adapter.model,
            provider: capability.provider,
          },
          received_at: new Date().toISOString(),
          late: false,
        },
      };
    },
    async verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult> {
      const payload = action.canonical_payload;
      const name = typeof payload.path === 'string' ? payload.path : null;
      if (!name) return { decision: 'undecided', reason: 'the action names no file' };
      const bytes = await readBytes(await target(ctx, name));
      if (!bytes) return { decision: 'failed', evidence: { present: false } };
      return {
        decision: 'succeeded',
        evidence: { present: true, content_hash: digest(bytes), bytes: bytes.length },
        receipt: null,
      };
    },
    async health(): Promise<ConnectorHealth> {
      return {
        status: options.adapter ? 'ok' : 'degraded',
        detail: options.adapter
          ? `${capability.kind} via ${capability.provider}/${options.adapter.model}`
          : 'no speech provider is configured',
        checked_at: new Date().toISOString(),
      };
    },
  };
}
