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
        '`catalog`: Melete’s list of models that read images. `app`: the owner said so for ' +
        'this model in Settings. `operator`: MELETE_DEFAULT_MODEL_VISION.',
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

/** Which of a person's two models a kind of work runs on. */
export const modelRole = z.enum(['primary', 'secondary']);
export type ModelRole = z.infer<typeof modelRole>;

/**
 * The kinds of work a person may move to their secondary model. A chat
 * answering the person's own message always runs on the primary; a chat a
 * watch or a schedule wakes, with nobody writing, follows `scheduled`.
 */
export const SECONDARY_WORK = ['side_tasks', 'scheduled'] as const;
export type SecondaryWork = (typeof SECONDARY_WORK)[number];

export const secondaryModelUses = z
  .object({
    side_tasks: modelRole.meta({
      description:
        'Short side calls: reading chats into memory and quick voice replies. `secondary` by ' +
        'default once a secondary model is set. The check before a risky action never moves.',
    }),
    scheduled: modelRole.meta({
      description:
        'Scheduled and repeating work: routines, and work that wakes on a trigger. `primary` ' +
        'by default.',
    }),
  })
  .strict();

export const secondaryModel = z
  .object({
    model: z
      .object({
        provider: z.string(),
        model: z.string(),
        connected: z.boolean().meta({
          description:
            'The provider has a credential. While it has none, the work goes to the primary.',
        }),
      })
      .strict()
      .nullable()
      .meta({
        description: 'This account’s secondary model; null uses the primary for everything',
      }),
    uses: secondaryModelUses.meta({
      description:
        'Which work runs on the secondary. Applies only while a secondary model is set. A chat ' +
        'answering the person’s own message always runs on the primary; one a watch or a ' +
        'schedule wakes, with nobody writing, follows `scheduled`.',
    }),
    can_edit: z
      .boolean()
      .meta({ description: 'Whether this account may set the secondary model (the owner)' }),
    leaves_local_primary: z.boolean().meta({
      description:
        'The primary runs on this machine or network and the secondary does not, so work moved ' +
        'to the secondary leaves it, chats a watch or schedule wakes among it. Side calls stay ' +
        'on a local primary either way.',
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
    secondary: secondaryModel.meta({
      description:
        'This account’s secondary model, for cheaper work beside the primary, and which work uses it',
    }),
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

export const setModelVisionRequest = z
  .object({
    provider: z.string().trim().min(1).max(100).meta({
      description: 'The model in use, as the page showed it; a different one is refused',
    }),
    model: z.string().trim().min(1).max(300),
    supports_vision: z
      .boolean()
      .nullable()
      .meta({
        description:
          'Whether this model reads images. Null hands it back to Melete’s list. Neither ' +
          'changes the model in use or where it came from.',
      }),
  })
  .strict();

export const setSecondaryModelRequest = z
  .object({
    provider: modelProvider,
    model: z.string().trim().min(1).max(300),
  })
  .strict();

export const setSecondaryUsesRequest = z
  .object({
    side_tasks: modelRole.optional(),
    scheduled: modelRole.optional(),
  })
  .strict();

export type ModelSettings = z.infer<typeof modelSettingsResponse>;
export type SecondaryModel = z.infer<typeof secondaryModel>;
export type ModelProviderStatus = z.infer<typeof modelProviderStatus>;
export type ModelConnectionTest = z.infer<typeof testModelConnectionResponse>;
