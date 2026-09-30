/**
 * The installation's model, connected from the app.
 *
 * The owner pastes a provider key, tests it, and chooses the model new attempts
 * run on. Keys are sealed with MELETE_MASTER_KEY in one box per provider, bound
 * to the provider's name, and only their last four characters are kept in the
 * clear. Nothing here returns or logs a key.
 *
 * Precedence, so the server's own configuration never changes under it:
 * - A key the environment names for a provider (FIREWORKS_API_KEY and the rest)
 *   is used for that provider, shown as set by the operator, and cannot be
 *   replaced here. The same holds for OPENAI_COMPAT_BASE_URL.
 * - MELETE_DEFAULT_PROVIDER and MELETE_DEFAULT_MODEL are the starting model. A
 *   model chosen in the app replaces them for new attempts until it is cleared,
 *   which goes back to them.
 *
 * Every read goes to the database, so the runner and the gateway see a change
 * on the next attempt and the next model call, in any process, without a restart.
 */
import {
  MODEL_PROVIDERS,
  type ModelConnectionTest,
  type ModelProvider,
  type ModelSettings,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { SealedSecretStore, type SecretRepository } from '../connectors/secrets.ts';
import type { Database } from '../db/client.ts';
import { modelDefault, modelProviderKey } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { Env } from '../env.ts';
import type { ProviderSignIn } from './credentials.ts';
import {
  CHATGPT_PROVIDER,
  compatibleBaseUrl,
  OPENAI_COMPATIBLE,
  openAiCompatibleProvider,
  providersFromEnv,
  providerUrl,
} from './providers.ts';
import type { GatewayProvider, SignedInCredential } from './types.ts';

export const MODEL_PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  fireworks: 'Fireworks',
  'openai-compatible': 'OpenAI-compatible endpoint',
  chatgpt: 'ChatGPT',
};

/** How long a connection test waits for the provider. */
export const MODEL_TEST_TIMEOUT_MS = 10_000;
/** A provider that lists thousands of models is cut to this many, sorted. */
const MODEL_LIST_LIMIT = 1000;

type KeyRow = typeof modelProviderKey.$inferSelect;
type Runner = Database | Transaction;

const isModelProvider = (name: string): name is ModelProvider =>
  (MODEL_PROVIDERS as readonly string[]).includes(name);

/** The built-in providers' addresses, from the one provider table. */
const BUILT_IN = new Map(providersFromEnv({}).map((provider) => [provider.name, provider]));

/**
 * Sealing binds the provider into the box, so a ciphertext copied onto another
 * provider's row does not open.
 */
function keyBox(masterKey: () => string | undefined) {
  const binding = (provider: string) => `model-key:${provider}`;
  return {
    async seal(provider: string, key: string) {
      let written: { id: string; ciphertext: string } | undefined;
      const one: SecretRepository = {
        put: async (id, _space, ciphertext) => {
          written = { id, ciphertext };
        },
        get: async () => null,
      };
      await new SealedSecretStore(one, masterKey).put(binding(provider), key);
      if (!written) throw new Error('Secret unavailable');
      return written;
    },
    async open(row: Pick<KeyRow, 'provider' | 'secretId' | 'ciphertext'>): Promise<string> {
      const one: SecretRepository = {
        put: async () => {},
        get: async (id) => (id === row.secretId ? row.ciphertext : null),
      };
      return new SealedSecretStore(one, masterKey).withSecret(
        row.secretId,
        binding(row.provider),
        async (value) => value,
      );
    },
  };
}

export interface ModelSettingsOptions {
  db: Database;
  env: Env;
  signIn?: ProviderSignIn;
  masterKey?: () => string | undefined;
  /** The transport a connection test uses; tests pass a mock. */
  fetch?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
}

export class ModelSettingsService {
  private readonly box: ReturnType<typeof keyBox>;
  private readonly masterKey: () => string | undefined;

  constructor(private readonly options: ModelSettingsOptions) {
    this.masterKey = options.masterKey ?? (() => options.env.MELETE_MASTER_KEY);
    this.box = keyBox(this.masterKey);
  }

  private get env() {
    return this.options.env;
  }

  /** The environment's key for a provider, which always wins over one entered in the app. */
  operatorKey(provider: string): string | undefined {
    const env = this.env;
    switch (provider) {
      case 'fireworks':
        return env.FIREWORKS_API_KEY || undefined;
      case 'openai':
        return env.OPENAI_API_KEY || undefined;
      case 'anthropic':
        return env.ANTHROPIC_API_KEY || undefined;
      case 'google':
        return env.GOOGLE_API_KEY || undefined;
      case OPENAI_COMPATIBLE: {
        const base = this.operatorBaseUrl();
        if (!base) return undefined;
        return (
          env.OPENAI_COMPAT_API_KEY ||
          (base.startsWith('https:') ? env.OPENAI_API_KEY : undefined) ||
          undefined
        );
      }
      default:
        return undefined;
    }
  }

  private operatorBaseUrl(): string | undefined {
    const address = this.env.OPENAI_COMPAT_BASE_URL;
    return address ? compatibleBaseUrl(address) : undefined;
  }

  /** The operator configured sign-in, not a key, for this provider. */
  private operatorSignIn(provider: string): boolean {
    return provider !== CHATGPT_PROVIDER && Boolean(this.options.signIn?.handles(provider));
  }

  private async keyRows(db: Runner = this.options.db): Promise<Map<string, KeyRow>> {
    const rows = await db.select().from(modelProviderKey);
    return new Map(rows.map((row) => [row.provider, row]));
  }

  private async chosen(db: Runner = this.options.db) {
    const [row] = await db.select().from(modelDefault).where(eq(modelDefault.id, 'installation'));
    return row ?? null;
  }

  private async signedIn(provider: string): Promise<boolean> {
    const signIn = this.options.signIn;
    if (!signIn?.handles(provider)) return false;
    return (await signIn.status(provider)).state === 'signed_in';
  }

  /** Whether a model call to this provider would carry a credential. */
  private async connected(provider: string, rows: Map<string, KeyRow>): Promise<boolean> {
    if (provider === 'fake') return this.env.MELETE_ENABLE_FAKE_PROVIDER;
    if (provider === CHATGPT_PROVIDER || this.operatorSignIn(provider))
      return this.signedIn(provider);
    if (this.operatorKey(provider)) return true;
    const row = rows.get(provider);
    if (!row) return false;
    return provider !== OPENAI_COMPATIBLE || Boolean(this.operatorBaseUrl() ?? row.baseUrl);
  }

  /**
   * The model the next attempt runs on: the one chosen in the app, or the
   * server's default. Read inside the claim transaction.
   */
  async activeChoice(db: Runner = this.options.db): Promise<{ provider: string; model: string }> {
    const row = await this.chosen(db);
    return row
      ? { provider: row.provider, model: row.model }
      : { provider: this.env.MELETE_DEFAULT_PROVIDER, model: this.env.MELETE_DEFAULT_MODEL };
  }

  async view(canEdit: boolean): Promise<ModelSettings> {
    const [rows, chosen] = await Promise.all([this.keyRows(), this.chosen()]);
    const active = chosen
      ? { provider: chosen.provider, model: chosen.model }
      : { provider: this.env.MELETE_DEFAULT_PROVIDER, model: this.env.MELETE_DEFAULT_MODEL };
    const providers = await Promise.all(
      MODEL_PROVIDERS.map(async (provider) => {
        const row = rows.get(provider);
        const byOperator =
          provider !== CHATGPT_PROVIDER &&
          (Boolean(this.operatorKey(provider)) || this.operatorSignIn(provider));
        const compatible = provider === OPENAI_COMPATIBLE;
        const operatorBase = compatible ? this.operatorBaseUrl() : undefined;
        return {
          provider,
          label:
            compatible && this.env.OPENAI_COMPAT_OAUTH_LABEL
              ? this.env.OPENAI_COMPAT_OAUTH_LABEL
              : MODEL_PROVIDER_LABELS[provider],
          method: provider === CHATGPT_PROVIDER ? ('sign_in' as const) : ('key' as const),
          key: byOperator
            ? { state: 'operator' as const, last_four: null, updated_at: null }
            : row
              ? {
                  state: 'set' as const,
                  last_four: row.lastFour,
                  updated_at: row.updatedAt.toISOString(),
                }
              : { state: 'unset' as const, last_four: null, updated_at: null },
          base_url: compatible ? (operatorBase ?? row?.baseUrl ?? null) : null,
          base_url_source: compatible
            ? operatorBase
              ? ('operator' as const)
              : row?.baseUrl
                ? ('app' as const)
                : null
            : null,
          connected: await this.connected(provider, rows),
          lists_models: provider !== CHATGPT_PROVIDER,
        };
      }),
    );
    return {
      active: {
        ...active,
        source: chosen ? 'app' : 'operator',
        connected: await this.connected(active.provider, rows),
        updated_at: chosen?.updatedAt.toISOString() ?? null,
      },
      operator_default: {
        provider: this.env.MELETE_DEFAULT_PROVIDER,
        model: this.env.MELETE_DEFAULT_MODEL,
      },
      providers,
      can_edit: canEdit,
      can_store_keys: Boolean(this.masterKey()),
    };
  }

  async saveKey(
    provider: string,
    ownerId: string,
    input: { api_key: string; base_url?: string },
  ): Promise<void> {
    if (!isModelProvider(provider) || provider === CHATGPT_PROVIDER)
      throw new ServiceError(
        'provider_not_available',
        'That provider is not connected by key.',
        404,
      );
    if (this.operatorKey(provider) || this.operatorSignIn(provider))
      throw new ServiceError(
        'set_by_operator',
        'The server configuration already sets this provider’s key, so it cannot be changed here.',
        409,
      );
    if (!this.masterKey())
      throw new ServiceError(
        'master_key_required',
        'Storing a key needs MELETE_MASTER_KEY on the server to seal it.',
        503,
      );
    const key = input.api_key.trim();
    if (key.length < 8 || /\s/.test(key))
      throw new ServiceError(
        'invalid_key',
        'That does not look like an API key. Paste the whole key, without spaces.',
        400,
      );
    let baseUrl: string | null = null;
    if (provider === OPENAI_COMPATIBLE && !this.operatorBaseUrl()) {
      if (!input.base_url)
        throw new ServiceError(
          'invalid_address',
          'Give the endpoint’s address, for example https://models.example.net/v1.',
          400,
        );
      baseUrl = checkedBaseUrl(input.base_url);
    }
    const sealed = await this.box.seal(provider, key);
    const values = {
      provider,
      ownerId,
      secretId: sealed.id,
      ciphertext: sealed.ciphertext,
      lastFour: key.slice(-4),
      baseUrl,
      updatedAt: new Date(),
    };
    await this.options.db
      .insert(modelProviderKey)
      .values(values)
      .onConflictDoUpdate({ target: modelProviderKey.provider, set: values });
  }

  async removeKey(provider: string): Promise<void> {
    await this.options.db.delete(modelProviderKey).where(eq(modelProviderKey.provider, provider));
  }

  async setDefault(provider: string, model: string, ownerId: string): Promise<void> {
    if (!isModelProvider(provider))
      throw new ServiceError(
        'provider_not_available',
        'That is not a provider Melete serves.',
        404,
      );
    if (!(await this.connected(provider, await this.keyRows())))
      throw new ServiceError(
        'model_not_connected',
        provider === CHATGPT_PROVIDER
          ? 'Sign in to ChatGPT before choosing one of its models.'
          : `Add a key for ${MODEL_PROVIDER_LABELS[provider]} before choosing one of its models.`,
        409,
      );
    const values = {
      id: 'installation',
      provider,
      model: model.trim(),
      ownerId,
      updatedAt: new Date(),
    };
    await this.options.db
      .insert(modelDefault)
      .values(values)
      .onConflictDoUpdate({ target: modelDefault.id, set: values });
  }

  async clearDefault(): Promise<void> {
    await this.options.db.delete(modelDefault).where(eq(modelDefault.id, 'installation'));
  }

  /**
   * The gateway's providers for one request: the configured ones, with each
   * key entered in the app attached where the environment gave none, and the
   * OpenAI-compatible endpoint added when the owner connected one. A stored key
   * is opened only when a call is made with it.
   */
  async providers(configured: GatewayProvider[]): Promise<GatewayProvider[]> {
    const rows = await this.keyRows();
    if (!rows.size) return configured;
    const result = configured.map((provider) => {
      const row = rows.get(provider.name);
      return row && !provider.fake && !provider.apiKey && !provider.signedIn
        ? { ...provider, signedIn: this.storedCredential(row) }
        : provider;
    });
    const compatible = rows.get(OPENAI_COMPATIBLE);
    if (compatible?.baseUrl && !result.some((provider) => provider.name === OPENAI_COMPATIBLE))
      result.push({
        ...openAiCompatibleProvider(compatible.baseUrl),
        signedIn: this.storedCredential(compatible),
      });
    return result;
  }

  /** A stored key, handed to the gateway the way a signed-in token is. */
  private storedCredential(row: KeyRow): SignedInCredential {
    return {
      current: async () => ({ token: await this.box.open(row), generation: 0, headers: {} }),
      // A refused key stays as it is; the owner replaces it in Settings.
      rejected: () => {},
    };
  }

  /** The key a test uses when none is typed: the environment's, else the stored one. */
  private async currentKey(provider: string): Promise<string | undefined> {
    const operator = this.operatorKey(provider);
    if (operator) return operator;
    const row = (await this.keyRows()).get(provider);
    return row ? this.box.open(row) : undefined;
  }

  /**
   * One small authenticated call: the provider's model list. It proves the key
   * and address and gives the owner something to choose from. Nothing is saved.
   */
  async test(input: {
    provider: string;
    api_key?: string;
    base_url?: string;
  }): Promise<ModelConnectionTest> {
    const { provider } = input;
    if (!isModelProvider(provider) || provider === CHATGPT_PROVIDER)
      throw new ServiceError(
        'provider_not_available',
        'That provider is not connected by key.',
        404,
      );
    const label = MODEL_PROVIDER_LABELS[provider];
    const failed = (
      code: Extract<ModelConnectionTest, { ok: false }>['code'],
      message: string,
      status: number | null = null,
    ): ModelConnectionTest => ({ ok: false, code, message, status });

    let base: string;
    const configuredBase =
      provider === OPENAI_COMPATIBLE
        ? (this.operatorBaseUrl() ?? (await this.keyRows()).get(provider)?.baseUrl ?? undefined)
        : BUILT_IN.get(provider)?.baseUrl;
    try {
      base =
        provider === OPENAI_COMPATIBLE && input.base_url
          ? checkedBaseUrl(input.base_url)
          : (configuredBase ?? '');
    } catch {
      return failed('invalid_address', INVALID_ADDRESS);
    }
    if (!base) return failed('invalid_address', INVALID_ADDRESS);

    const typed = input.api_key?.trim();
    // A saved key only ever goes to the address it was saved for.
    if (!typed && base !== configuredBase)
      return failed('no_key', 'Paste the key to try it with a new address.');
    let key: string | undefined;
    try {
      key = typed || (await this.currentKey(provider));
    } catch {
      return failed('no_key', 'The saved key could not be opened. Paste it again.');
    }
    if (!key) return failed('no_key', `Paste a ${label} API key first.`);

    const url = new URL('models', base);
    const headers = new Headers({ accept: 'application/json' });
    if (provider === 'anthropic') {
      headers.set('x-api-key', key);
      headers.set('anthropic-version', '2023-06-01');
    } else headers.set('authorization', `Bearer ${key}`);
    const transport = this.options.fetch ?? ((request: Request) => fetch(request));
    const timeoutMs = this.options.timeoutMs ?? MODEL_TEST_TIMEOUT_MS;
    const started = performance.now();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The timer is the service's own, so a transport that ignores the signal
    // still cannot hold the owner's request open.
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        abort.abort(error);
        reject(error);
      }, timeoutMs);
    });
    let response: Response;
    let body: unknown = null;
    try {
      response = await Promise.race([
        transport(
          new Request(url.href, {
            method: 'GET',
            headers,
            redirect: 'manual',
            signal: abort.signal,
          }),
        ),
        expired,
      ]);
      if (response.ok) body = await Promise.race([response.json().catch(() => null), expired]);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError')
        return failed(
          'timeout',
          `${label} did not answer within ${Math.round(timeoutMs / 1000)} seconds. Check the address and this server’s network, then try again.`,
        );
      return failed(
        'unreachable',
        `Couldn’t reach ${url.host}. Check the address and that this server can reach it.`,
      );
    } finally {
      clearTimeout(timer);
    }
    const status = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (status === 401 || status === 403)
        return failed(
          'key_refused',
          `${label} did not accept this key (HTTP ${status}). Check that the whole key was copied and that it is still active.`,
          status,
        );
      if (status === 404 || (status >= 300 && status < 400))
        return failed(
          'not_found',
          provider === OPENAI_COMPATIBLE
            ? `Nothing answered at ${url.href} (HTTP ${status}). Check the address; it usually ends in /v1.`
            : `${label} answered HTTP ${status} for its model list. Check that this key’s account has API access.`,
          status,
        );
      if (status === 429)
        return failed(
          'rate_limited',
          `${label} is limiting requests from this key right now (HTTP 429). Wait a minute and try again.`,
          status,
        );
      return failed(
        'provider_error',
        `${label} answered with an error (HTTP ${status}). Try again shortly.`,
        status,
      );
    }
    const models = modelIds(body);
    return { ok: true, models, latency_ms: Math.round(performance.now() - started) };
  }
}

const INVALID_ADDRESS =
  'Give the endpoint’s http:// or https:// address, without a user name, query or fragment, for example https://models.example.net/v1.';

/** An endpoint address the gateway will accept, as it keeps it; throws otherwise. */
export function checkedBaseUrl(address: string): string {
  let parsed: URL;
  try {
    parsed = new URL(address.trim());
  } catch {
    throw new ServiceError('invalid_address', INVALID_ADDRESS, 400);
  }
  const base = compatibleBaseUrl(`${parsed.origin}${parsed.pathname}`);
  if (parsed.search || parsed.hash || parsed.username || parsed.password)
    throw new ServiceError('invalid_address', INVALID_ADDRESS, 400);
  try {
    providerUrl(openAiCompatibleProvider(base), 'chat/completions');
  } catch {
    throw new ServiceError('invalid_address', INVALID_ADDRESS, 400);
  }
  return base;
}

/** The model ids in an OpenAI-style (`data[].id`) or Gemini-style (`models[].name`) list. */
export function modelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as { data?: unknown; models?: unknown };
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const value =
      (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
    if (typeof value === 'string' && value && value.length <= 300)
      ids.add(value.replace(/^models\//, ''));
  }
  return [...ids].sort().slice(0, MODEL_LIST_LIMIT);
}
