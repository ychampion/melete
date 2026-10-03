/**
 * Connecting the installation's model from the app: a provider key the owner
 * pastes, a test against the provider, and the model new attempts use. No body
 * here carries a key; a stored key is only ever described by its last four
 * characters.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';

/** The providers the gateway serves. `chatgpt` is connected by signing in, the rest by key. */
export const MODEL_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'fireworks',
  'openai-compatible',
  'chatgpt',
] as const;
export const modelProvider = z.enum(MODEL_PROVIDERS);
export type ModelProvider = z.infer<typeof modelProvider>;

/** The providers a key is entered for. */
export const KEYED_MODEL_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'fireworks',
  'openai-compatible',
] as const;
export const keyedModelProvider = z.enum(KEYED_MODEL_PROVIDERS);

export const modelKeyState = z
  .object({
    state: z.enum(['unset', 'set', 'operator']).meta({
      description:
        '`set`: entered in the app and stored sealed. `operator`: the server environment ' +
        'names a key for this provider; it is used, cannot be changed here, and is never shown.',
    }),
    last_four: z
      .string()
      .max(4)
      .nullable()
      .meta({ description: 'The last four characters of a key entered in the app' }),
    updated_at: timestamp.nullable(),
  })
  .strict();

export const modelProviderStatus = z
  .object({
    provider: modelProvider,
    label: z.string(),
    method: z.enum(['key', 'sign_in']),
    key: modelKeyState,
    base_url: z
      .string()
      .nullable()
      .meta({ description: 'The OpenAI-compatible endpoint’s version prefix; null for the rest' }),
    base_url_source: z.enum(['app', 'operator']).nullable(),
    connected: z.boolean().meta({
      description:
        'A key is set or the owner is signed in, so a model call has a credential. It is not ' +
        'a promise that the provider accepts it; test the connection for that.',
    }),
    lists_models: z
      .boolean()
      .meta({ description: 'Whether a successful test returns the provider’s model list' }),
  })
  .strict();

export const activeModel = z
  .object({
    provider: z.string(),
    model: z.string(),
    source: z.enum(['app', 'operator']).meta({
      description:
        '`app`: chosen in Settings, and used until it is cleared. `operator`: the server’s ' +
        'MELETE_DEFAULT_PROVIDER and MELETE_DEFAULT_MODEL, used while nothing is chosen in the app.',
    }),
    connected: z.boolean().meta({ description: 'The active provider has a credential' }),
    vision: z.boolean().meta({
      description:
        'Whether the model is shown the screenshots the agent takes, as pictures. Otherwise ' +
        'it reads their text receipt: where each was saved, its size and digest.',
    }),
    vision_source: z.enum(['catalog', 'app', 'operator']).meta({
      description:
        '`catalog`: Melete’s list of models that read images. `app`: the owner said so when ' +
        'choosing the model. `operator`: MELETE_DEFAULT_MODEL_VISION.',
    }),
    provider_vision: z
      .boolean()
      .nullable()
      .meta({
        description:
          'What the provider’s own model list says about this model reading images, from the ' +
          'last time the list was fetched; null when it has said nothing. Shown beside the ' +
          'switch only: it never changes `vision`.',
      }),
    updated_at: timestamp.nullable(),
  })
  .strict();

export const modelSettingsResponse = z
  .object({
    active: activeModel,
    operator_default: z.object({ provider: z.string(), model: z.string() }).strict(),
    providers: z.array(modelProviderStatus),
    can_edit: z
      .boolean()
      .meta({ description: 'Whether this account may change keys and the model (the owner)' }),
    can_store_keys: z
      .boolean()
      .meta({ description: 'False when MELETE_MASTER_KEY is unset, so no key can be sealed' }),
  })
  .strict();

const baseUrl = z.string().trim().min(1).max(2048).meta({
  description: 'The endpoint’s version prefix, for example https://models.example.net/v1',
});

export const saveModelKeyRequest = z
  .object({
    api_key: z.string().trim().min(1).max(4096),
    base_url: baseUrl
      .optional()
      .meta({ description: 'Required for, and only for, the OpenAI-compatible endpoint' }),
  })
  .strict();

export const testModelConnectionRequest = z
  .object({
    provider: keyedModelProvider,
    api_key: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .optional()
      .meta({ description: 'A key to try before saving it. Left out, the key already set.' }),
    base_url: baseUrl.optional(),
  })
  .strict();

export const MODEL_TEST_FAILURES = [
  'key_refused',
  'not_found',
  'timeout',
  'unreachable',
  'rate_limited',
  'provider_error',
  'no_key',
  'invalid_address',
] as const;

export const testModelConnectionResponse = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      models: z
        .array(z.string())
        .meta({ description: 'The model ids the provider lists, sorted; empty if it lists none' }),
      latency_ms: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(MODEL_TEST_FAILURES),
      message: z.string().meta({ description: 'What went wrong and what to do, in plain words' }),
      status: z
        .number()
        .int()
        .nullable()
        .meta({ description: 'The provider’s HTTP status, when it answered' }),
    })
    .strict(),
]);

export const setDefaultModelRequest = z
  .object({
    provider: modelProvider,
    model: z.string().trim().min(1).max(300),
    supports_vision: z
      .boolean()
      .nullable()
      .optional()
      .meta({
        description:
          'Whether this model reads images. Left out or null, Melete’s model catalog decides; ' +
          'set it for a model the catalog does not know.',
      }),
  })
  .strict();

export type ModelSettings = z.infer<typeof modelSettingsResponse>;
export type ModelProviderStatus = z.infer<typeof modelProviderStatus>;
export type ModelConnectionTest = z.infer<typeof testModelConnectionResponse>;
