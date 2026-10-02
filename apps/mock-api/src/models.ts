/**
 * The model settings, served the way the service serves them, with no real
 * provider behind them. A key is kept only as its last four characters. The
 * connection test is scripted by what the key says: a key containing `bad` is
 * refused, one containing `slow` times out, and an address containing
 * `missing` answers 404; anything else lists a few fixture models.
 *
 * `MELETE_MOCK_MODELS=none` starts with no working model, so first-run setup
 * asks for one. Otherwise the server's default provider has an operator key.
 */
import {
  effectiveVision,
  MODEL_PROVIDERS,
  type ModelProvider,
  type ModelSettings,
  modelSettingsResponse,
  providerSignInStatus,
  saveModelKeyRequest,
  setDefaultModelRequest,
  startSignInResponse,
  testModelConnectionRequest,
  testModelConnectionResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

const LABELS: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  fireworks: 'Fireworks',
  'openai-compatible': 'OpenAI-compatible endpoint',
  chatgpt: 'ChatGPT',
};

const FIXTURE_MODELS: Record<string, string[]> = {
  anthropic: ['claude-fixture-large', 'claude-fixture-small'],
  openai: ['gpt-fixture', 'gpt-fixture-mini'],
  google: ['gemini-fixture-flash', 'gemini-fixture-pro'],
  fireworks: [
    'accounts/fireworks/models/deepseek-v4p1-flash',
    'accounts/fireworks/models/fixture-open-model',
  ],
  'openai-compatible': ['local-fixture-model'],
};

const OPERATOR_DEFAULT = {
  provider: 'fireworks',
  model: 'accounts/fireworks/models/deepseek-v4p1-flash',
};

export function mountModelsMock(app: Hono, options: { connected?: boolean } = {}) {
  const connected = options.connected ?? process.env.MELETE_MOCK_MODELS !== 'none';
  const operatorKeys = new Set<string>(connected ? ['fireworks'] : []);
  const keys = new Map<string, { lastFour: string; baseUrl: string | null; at: string }>();
  let chosen: {
    provider: string;
    model: string;
    at: string;
    vision: boolean | null;
  } | null = null;
  let signedIn = false;
  let pending: string | null = null;

  const isConnected = (provider: string) =>
    provider === 'chatgpt'
      ? signedIn
      : operatorKeys.has(provider) ||
        (keys.has(provider) &&
          (provider !== 'openai-compatible' || Boolean(keys.get(provider)?.baseUrl)));

  const view = (): ModelSettings => {
    const active = chosen ?? OPERATOR_DEFAULT;
    return {
      active: {
        provider: active.provider,
        model: active.model,
        source: chosen ? 'app' : 'operator',
        connected: isConnected(active.provider),
        vision: effectiveVision(active.provider, active.model, chosen?.vision),
        vision_source: typeof chosen?.vision === 'boolean' ? 'app' : 'catalog',
        updated_at: chosen?.at ?? null,
      },
      operator_default: OPERATOR_DEFAULT,
      providers: MODEL_PROVIDERS.map((provider) => {
        const key = keys.get(provider);
        return {
          provider,
          label: LABELS[provider],
          method: provider === 'chatgpt' ? 'sign_in' : 'key',
          key: operatorKeys.has(provider)
            ? { state: 'operator', last_four: null, updated_at: null }
            : key
              ? { state: 'set', last_four: key.lastFour, updated_at: key.at }
              : { state: 'unset', last_four: null, updated_at: null },
          base_url: provider === 'openai-compatible' ? (key?.baseUrl ?? null) : null,
          base_url_source: provider === 'openai-compatible' && key?.baseUrl ? 'app' : null,
          connected: isConnected(provider),
          lists_models: provider !== 'chatgpt',
        };
      }),
      can_edit: true,
      can_store_keys: true,
    };
  };

  const send = <T extends z.ZodType>(c: Context, schema: T, body: unknown, status = 200) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      return c.json(
        { error: { code: 'contract_violation', message: 'the mock broke the contract' } },
        500,
      );
    return c.json(parsed.data as object, status as 200);
  };
  const refuse = (c: Context, status: 400 | 404 | 409, code: string, message: string) =>
    c.json({ error: { code, message } }, status);
  const body = async <T extends z.ZodType>(c: Context, schema: T) =>
    schema.safeParse(await c.req.json().catch(() => ({})));
  const now = () => new Date().toISOString();

  app.get('/model-settings', (c) => send(c, modelSettingsResponse, view()));

  app.post('/model-settings/test', async (c) => {
    const input = await body(c, testModelConnectionRequest);
    if (!input.success) return refuse(c, 400, 'invalid_request', 'Request data is invalid.');
    const { provider, api_key: key, base_url: address } = input.data;
    const label = LABELS[provider];
    const result = (() => {
      if (!key && !isConnected(provider))
        return {
          ok: false,
          code: 'no_key',
          message: `Paste your ${label} API key first.`,
          status: null,
        };
      if (key?.includes('bad'))
        return {
          ok: false,
          code: 'key_refused',
          message: `${label} did not accept this key (HTTP 401). Check that the whole key was copied and that it is still active.`,
          status: 401,
        };
      if (key?.includes('slow'))
        return {
          ok: false,
          code: 'timeout',
          message: `${label} did not answer within 10 seconds. Check the address and this server’s network, then try again.`,
          status: null,
        };
      if (address?.includes('missing'))
        return {
          ok: false,
          code: 'not_found',
          message: `Nothing answered at ${address.replace(/\/+$/, '')}/models (HTTP 404). Check the address; it usually ends in /v1.`,
          status: 404,
        };
      return { ok: true, models: FIXTURE_MODELS[provider] ?? [], latency_ms: 180 };
    })();
    return send(c, testModelConnectionResponse, result);
  });

  app.put('/model-settings/keys/:provider', async (c) => {
    const provider = c.req.param('provider');
    const input = await body(c, saveModelKeyRequest);
    if (!input.success || !(provider in FIXTURE_MODELS))
      return refuse(c, 400, 'invalid_request', 'Request data is invalid.');
    if (operatorKeys.has(provider))
      return refuse(
        c,
        409,
        'set_by_operator',
        'The server configuration already sets this provider’s key, so it cannot be changed here.',
      );
    if (provider === 'openai-compatible' && !input.data.base_url)
      return refuse(
        c,
        400,
        'invalid_address',
        'Give the endpoint’s address, for example https://models.example.net/v1.',
      );
    keys.set(provider, {
      lastFour: input.data.api_key.slice(-4),
      baseUrl:
        provider === 'openai-compatible'
          ? `${(input.data.base_url ?? '').replace(/\/+$/, '')}/`
          : null,
      at: now(),
    });
    return send(c, modelSettingsResponse, view());
  });

  app.delete('/model-settings/keys/:provider', (c) => {
    keys.delete(c.req.param('provider'));
    return send(c, modelSettingsResponse, view());
  });

  app.put('/model-settings/default', async (c) => {
    const input = await body(c, setDefaultModelRequest);
    if (!input.success) return refuse(c, 400, 'invalid_request', 'Request data is invalid.');
    if (!isConnected(input.data.provider))
      return refuse(
        c,
        409,
        'model_not_connected',
        `Add a key for ${LABELS[input.data.provider]} before choosing one of its models.`,
      );
    chosen = {
      provider: input.data.provider,
      model: input.data.model,
      at: now(),
      vision: input.data.supports_vision ?? null,
    };
    return send(c, modelSettingsResponse, view());
  });

  app.delete('/model-settings/default', (c) => {
    chosen = null;
    return send(c, modelSettingsResponse, view());
  });

  const signInState = () => ({
    provider: 'chatgpt',
    label: 'ChatGPT',
    state: signedIn ? 'signed_in' : 'signed_out',
    account: signedIn ? 'jamie@example.test' : null,
    expires_at: signedIn ? new Date(Date.now() + 3_600_000).toISOString() : null,
    reason: null,
    message: null,
    methods: ['device', 'browser'],
  });

  app.get('/model-providers/:provider/sign-in', (c) =>
    send(c, providerSignInStatus, signInState()),
  );
  app.post('/model-providers/:provider/sign-in', async (c) => {
    const method = ((await c.req.json().catch(() => ({}))) as { method?: string }).method;
    pending = `si_${Math.random().toString(36).slice(2, 10)}`;
    const expires = new Date(Date.now() + 15 * 60_000).toISOString();
    return send(
      c,
      startSignInResponse,
      method === 'device'
        ? {
            sign_in_id: pending,
            method: 'device',
            verification_url: 'https://auth.example.test/device',
            user_code: 'MLTE-4821',
            interval: 3,
            expires_at: expires,
          }
        : {
            sign_in_id: pending,
            method: 'browser',
            authorize_url: 'https://auth.example.test/authorize?state=mock',
            redirect_uri: 'http://localhost:1455/auth/callback',
            expires_at: expires,
          },
      201,
    );
  });
  app.post('/model-providers/:provider/sign-in/complete', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { sign_in_id?: string };
    if (!pending || input.sign_in_id !== pending)
      return refuse(
        c,
        404,
        'sign_in_not_found',
        'That sign-in has expired or was replaced. Start again.',
      );
    pending = null;
    signedIn = true;
    return send(c, providerSignInStatus, signInState());
  });
  app.delete('/model-providers/:provider/sign-in', (c) => {
    signedIn = false;
    if (chosen?.provider === 'chatgpt') chosen = null;
    return send(c, providerSignInStatus, signInState());
  });
}
