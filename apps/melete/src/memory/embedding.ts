/**
 * The embedding model semantic recall uses, chosen from the configured model
 * provider at startup.
 *
 * - With an embeddings endpoint and a key (Fireworks, OpenAI, Google, or an
 *   OpenAI-compatible endpoint the operator names a model for), memory is
 *   embedded there and recall ranks by meaning beside the lexical index.
 * - With none, there is no provider and recall stays lexical, with no error.
 * - `MELETE_EMBEDDING_PROVIDER=local` embeds on the local model server
 *   (MELETE_LOCAL_MODEL_URL), checked to be on this machine or network.
 *
 * Privacy follows the router's rules. A cloud embedder never reads what memory
 * learned in a private conversation, nor anything in a space marked private;
 * the details the space's privacy settings detect (addresses, numbers, the
 * person's listed values) are swapped for their kind before anything is sent.
 * Only a local model reads memory as written.
 *
 * Every call is counted in the spending ledger as a `memory_embedding` call,
 * charged to the person whose memory it read.
 */
import { randomUUID } from 'node:crypto';
import { PRIVACY_CATEGORIES } from '@melete/contracts';
import { compatibleBaseUrl, providersFromEnv } from '../gateway/providers.ts';
import type { GatewayPrincipal, GatewaySpending } from '../gateway/types.ts';
import { detect } from '../privacy/detect.ts';
import { isLocalUrl } from '../privacy/local.ts';
import type { ResolvedSettings } from '../privacy/store.ts';
import { knownPattern } from '../privacy/vault.ts';
import { MemoryError } from './db.ts';
import type { EmbeddingCall, EmbeddingProvider } from './views.ts';

/** How a text is turned into what the embedder reads. Part of the vector space's identity. */
export const EMBEDDING_RECIPE = 'memory-text-v1';

type EmbeddingModel = {
  model: string;
  dimensions: number;
  /** Sent as `dimensions` to a model that can shorten its vectors. */
  requestDimensions?: number;
  /** What a model trained with task prefixes expects before a question or a passage. */
  prefixes?: { query: string; document: string };
};

/** The embedding model each provider with an embeddings endpoint uses by default. */
export const DEFAULT_EMBEDDING_MODELS: Readonly<Record<string, EmbeddingModel>> = {
  fireworks: {
    model: 'nomic-ai/nomic-embed-text-v1.5',
    dimensions: 768,
    prefixes: { query: 'search_query: ', document: 'search_document: ' },
  },
  openai: { model: 'text-embedding-3-small', dimensions: 1536 },
  google: { model: 'gemini-embedding-001', dimensions: 768, requestDimensions: 768 },
};

/** Tried in this order when the default provider has no embeddings endpoint (Anthropic). */
const EMBEDDING_PROVIDERS = ['fireworks', 'openai', 'google'] as const;

export type EmbeddingEnv = {
  MELETE_EMBEDDING_PROVIDER?: string;
  MELETE_EMBEDDING_MODEL?: string;
  MELETE_EMBEDDING_DIMENSIONS?: number;
  MELETE_DEFAULT_PROVIDER?: string;
  MELETE_LOCAL_MODEL_URL?: string;
  MELETE_LOCAL_MODEL_KEY?: string;
} & Record<string, unknown>;

/** What the provider needs from the privacy router: a space's settings. */
export type EmbeddingPrivacy = {
  settingsFor(spaceId: string): Promise<ResolvedSettings>;
};

export type EmbeddingOptions = {
  /** Where requests go, ending in its version prefix and a slash. */
  baseUrl: string;
  apiKey?: string;
  /** The provider name the spending ledger records. */
  provider: string;
  model: EmbeddingModel;
  /** Verified to be on the person's machine or network. */
  local: boolean;
  privacy?: EmbeddingPrivacy;
  spending?: GatewaySpending;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Told when a call fails, with a short code; never with the text. */
  onError?: (code: string) => void;
};

/** A provider-agnostic stand-in for a value the privacy settings detect, by its kind. */
const placeholder = (category: string) => `[${category.replace(/_/g, ' ')}]`;

/**
 * The text a cloud embedder may read: every detected value and every value the
 * person listed is replaced by its kind, so "my number is 415 555 0100"
 * embeds as "my number is [phone]". The meaning stays, the value does not.
 */
export function screenText(
  text: string,
  settings: Pick<ResolvedSettings, 'enabled' | 'known'> | null,
): string {
  const enabled = settings?.enabled ?? new Set(PRIVACY_CATEGORIES);
  const spans = detect(text, enabled).map((span) => ({ ...span, kind: span.category as string }));
  for (const known of settings?.known ?? []) {
    const pattern = knownPattern(known);
    if (!pattern) continue;
    for (const match of text.matchAll(pattern))
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        category: known.category,
        kind: known.category,
      });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    out += text.slice(at, span.start) + placeholder(span.kind);
    at = span.end;
  }
  return out + text.slice(at);
}

/** Tokens for a text when a provider does not say, at the gateway's quarter-byte estimate. */
const estimateTokens = (texts: string[]) =>
  texts.reduce((sum, text) => sum + Math.ceil(Buffer.byteLength(text, 'utf8') / 4), 0);

export function createEmbeddingProvider(options: EmbeddingOptions): EmbeddingProvider {
  const request = options.fetch ?? fetch;
  const endpoint = new URL('embeddings', compatibleBaseUrl(options.baseUrl));
  const { model } = options;
  const principalFor = (call: EmbeddingCall | undefined): GatewayPrincipal | null =>
    call
      ? {
          ...(call.actor ? { actor: call.actor } : {}),
          jobId: `memory:${call.spaceId}`,
          attemptId: `memory-embedding:${randomUUID()}`,
          privacy: {
            kind: 'service',
            purpose: 'memory_embedding',
            spaceId: call.spaceId,
            sourceJobId: call.jobId ?? null,
          },
          epoch: 0,
          revision: 0,
          maxRequests: 1,
          maxTokens: 0,
          allowedModels: [{ provider: options.provider, model: model.model }],
        }
      : null;
  return {
    model: `${options.provider}/${model.model}`,
    version: '1',
    dimensions: model.dimensions,
    recipe: EMBEDDING_RECIPE,
    local: options.local,
    async screen(spaceId, texts) {
      // A local model reads memory as written; it never leaves the person's machine.
      if (options.local) return texts;
      const settings = options.privacy ? await options.privacy.settingsFor(spaceId) : null;
      if (settings?.privateSpace) return null;
      return texts.map((text) => screenText(text, settings));
    },
    async embed(texts, signal, call) {
      if (!texts.length) return [];
      const prefix = model.prefixes?.[call?.purpose ?? 'document'] ?? '';
      const input = texts.map((text) => `${prefix}${text}`.slice(0, 8000));
      const principal = principalFor(call?.call);
      const estimated = estimateTokens(input);
      if (principal && options.spending)
        await options.spending.admit(principal, {
          provider: options.provider,
          model: model.model,
          inputTokens: estimated,
          maxOutputTokens: 0,
          local: options.local,
        });
      const started = Date.now();
      let status: 'succeeded' | 'failed' | 'unknown' = 'unknown';
      let httpStatus: number | null = null;
      let tokens: number | null = null;
      try {
        const response = await request(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: model.model,
            input,
            ...(model.requestDimensions ? { dimensions: model.requestDimensions } : {}),
          }),
          redirect: 'error',
          signal,
        });
        httpStatus = response.status;
        if (!response.ok) {
          status = 'failed';
          await response.body?.cancel();
          throw new MemoryError(
            response.status === 401 || response.status === 403
              ? 'embedding_provider_auth'
              : 'embedding_provider_failed',
          );
        }
        const body = (await response.json()) as {
          data?: { index?: number; embedding?: unknown }[];
          usage?: { prompt_tokens?: number; total_tokens?: number };
        };
        status = 'succeeded';
        tokens = Number(body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? Number.NaN);
        const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const vectors = rows.map((row) => row.embedding);
        if (
          vectors.length !== texts.length ||
          !vectors.every(
            (vector): vector is number[] =>
              Array.isArray(vector) && vector.length === model.dimensions,
          )
        )
          throw new MemoryError('embedding_space_mismatch');
        return vectors;
      } catch (error) {
        options.onError?.(error instanceof MemoryError ? error.code : 'embedding_unreachable');
        throw error;
      } finally {
        if (principal && options.spending) {
          const counted = Number.isFinite(tokens) && tokens !== null ? tokens : estimated;
          await options.spending.record(principal, {
            provider: options.provider,
            modelRequested: model.model,
            modelActual: model.model,
            usage:
              status === 'succeeded'
                ? {
                    inputTokens: counted,
                    outputTokens: 0,
                    totalTokens: counted,
                    cachedInputTokens: 0,
                  }
                : null,
            // A call that was sent but not answered may still have been charged.
            ...(status === 'unknown'
              ? {
                  spendEstimate: {
                    inputTokens: estimated,
                    outputTokens: 0,
                    totalTokens: estimated,
                    cachedInputTokens: 0,
                  },
                }
              : {}),
            latencyMs: Date.now() - started,
            status,
            httpStatus,
            ...(options.local ? { servedLocally: true } : {}),
          });
        }
      }
    },
  };
}

/**
 * The embedding provider this deployment runs, or null: semantic recall is off
 * when the operator says so, when no configured provider has an embeddings
 * endpoint and a key, or when a local embedder is asked for and its address is
 * not on this machine or network.
 */
export async function embeddingFromEnv(
  env: EmbeddingEnv,
  extra: Omit<EmbeddingOptions, 'baseUrl' | 'apiKey' | 'provider' | 'model' | 'local'> & {
    resolve?: (hostname: string) => Promise<{ address: string }[]>;
  } = {},
): Promise<EmbeddingProvider | null> {
  const setting = env.MELETE_EMBEDDING_MODEL?.trim();
  if (setting === 'off') return null;
  const named = env.MELETE_EMBEDDING_PROVIDER?.trim();
  const dimensions = env.MELETE_EMBEDDING_DIMENSIONS;
  const { resolve, ...options } = extra;
  if (named === 'local') {
    const url = env.MELETE_LOCAL_MODEL_URL;
    if (!url || !setting || !dimensions) return null;
    if (!(await isLocalUrl(url, resolve))) return null;
    return createEmbeddingProvider({
      ...options,
      baseUrl: url,
      apiKey: env.MELETE_LOCAL_MODEL_KEY,
      provider: 'local',
      model: { model: setting, dimensions },
      local: true,
    });
  }
  const keyed = new Map(
    providersFromEnv(env as Record<string, string | undefined>)
      .filter((provider) => provider.apiKey)
      .map((provider) => [provider.name, provider]),
  );
  const candidates = named
    ? [named]
    : [
        ...(env.MELETE_DEFAULT_PROVIDER ? [env.MELETE_DEFAULT_PROVIDER] : []),
        ...EMBEDDING_PROVIDERS,
      ];
  for (const name of candidates) {
    const provider = keyed.get(name);
    const defaults = DEFAULT_EMBEDDING_MODELS[name];
    // An OpenAI-compatible endpoint embeds only with a model the operator names.
    if (!provider || (!defaults && !setting)) continue;
    const model: EmbeddingModel =
      setting && setting !== defaults?.model
        ? {
            model: setting,
            dimensions: dimensions ?? 0,
            ...(dimensions ? { requestDimensions: dimensions } : {}),
          }
        : {
            ...(defaults as EmbeddingModel),
            ...(dimensions ? { dimensions, requestDimensions: dimensions } : {}),
          };
    if (!model.dimensions) continue;
    return createEmbeddingProvider({
      ...options,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      provider: name,
      model,
      local: false,
    });
  }
  return null;
}

/**
 * The same embedder, asking once per question: an attempt recalls memory and
 * its own notes by the same request, and pays for one embedding of it.
 */
export function onceForQueries(provider: EmbeddingProvider): EmbeddingProvider {
  const asked = new Map<string, Promise<number[][]>>();
  return {
    ...provider,
    embed(texts, signal, options) {
      const text = texts[0];
      if (texts.length !== 1 || text === undefined || options?.purpose !== 'query')
        return provider.embed(texts, signal, options);
      const prior = asked.get(text);
      if (prior) return prior;
      const made = provider.embed(texts, signal, options);
      asked.set(text, made);
      made.catch(() => asked.delete(text));
      return made;
    },
  };
}
