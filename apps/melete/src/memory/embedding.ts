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
 * learned in a private conversation, nor anything in a space marked private,
 * and every text it is sent first goes through the gateway's own redactor
 * (`PrivacyRouter.screenForCloud`): the listed values, every value memory
 * learned privately, the detectors, the local name detector and the
 * conversation's vault. Only a local model reads memory as written.
 *
 * A provider that answers busy or briefly down is asked once more. One that
 * still fails three times in a row is not asked again for a minute:
 * recall stays lexical meanwhile instead of waiting on it every turn.
 *
 * Every call is counted in the spending ledger as a `memory_embedding` call,
 * charged to the person whose memory it read.
 */
import { randomUUID } from 'node:crypto';
import { compatibleBaseUrl, providersFromEnv } from '../gateway/providers.ts';
import type { GatewayPrincipal, GatewaySpending } from '../gateway/types.ts';
import { isLocalUrl } from '../privacy/local.ts';
import { MemoryError, type MemorySql } from './db.ts';
import { QUERY_EMBED_MS } from './recall.ts';
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

/** What the provider needs from the privacy router: its cloud redaction. */
export type EmbeddingPrivacy = {
  screenForCloud(
    spaceId: string,
    texts: readonly string[],
    jobId?: string | null,
  ): Promise<string[] | null>;
};

/** Answers that say the provider is busy or briefly down: asked once more, after `RETRY_MS`. */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
export const RETRY_MS = 200;

/** Failures in a row after which the provider is left alone for `PAUSE_MS`. */
export const BREAKER_FAILURES = 3;
export const PAUSE_MS = 60_000;

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

/** What health reports about the embedder: never a text, only how calls went. */
export type EmbeddingStatus = {
  configured: boolean;
  model: string | null;
  local: boolean;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  /** Set while the provider is left alone after failing in a row. */
  paused_until: string | null;
};

/** Tokens for a text when a provider does not say, at the gateway's quarter-byte estimate. */
const estimateTokens = (texts: string[]) =>
  texts.reduce((sum, text) => sum + Math.ceil(Buffer.byteLength(text, 'utf8') / 4), 0);

export function createEmbeddingProvider(options: EmbeddingOptions): EmbeddingProvider {
  const request = options.fetch ?? fetch;
  const endpoint = new URL('embeddings', compatibleBaseUrl(options.baseUrl));
  const { model } = options;
  const state: EmbeddingStatus = {
    configured: true,
    model: `${options.provider}/${model.model}`,
    local: options.local,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    paused_until: null,
  };
  const failed = (code: string) => {
    state.last_error = code;
    state.consecutive_failures++;
    if (state.consecutive_failures >= BREAKER_FAILURES)
      state.paused_until = new Date(Date.now() + PAUSE_MS).toISOString();
    options.onError?.(code);
  };
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
    status: () => ({ ...state }),
    async screen(spaceId, texts, jobId) {
      // A local model reads memory as written; it never leaves the person's machine.
      if (options.local) return texts;
      // Without the privacy router nothing goes to a cloud embedder.
      if (!options.privacy) return null;
      return options.privacy.screenForCloud(spaceId, texts, jobId ?? null);
    },
    async embed(texts, signal, call) {
      if (!texts.length) return [];
      if (state.paused_until && Date.now() < Date.parse(state.paused_until))
        throw new MemoryError('embedding_paused');
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
      const send = () =>
        request(endpoint, {
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
      try {
        let response = await send();
        // A busy or briefly failing provider is asked once more before recall
        // gives up on meaning for this turn.
        if (RETRY_STATUSES.has(response.status)) {
          await response.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
          signal?.throwIfAborted();
          response = await send();
        }
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
        state.consecutive_failures = 0;
        state.paused_until = null;
        state.last_success_at = new Date().toISOString();
        return vectors;
      } catch (error) {
        failed(
          error instanceof MemoryError
            ? error.code
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'embedding_timeout'
              : 'embedding_unreachable',
        );
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
      // A failure is kept too: the attempt does not wait on the same question twice.
      made.catch(() => {});
      return made;
    },
  };
}

/**
 * Start embedding an attempt's request now, so recall finds it ready. Only
 * when the space's index was built with this embedding: otherwise recall
 * would not use it, and the call would be wasted. The result lands in the
 * attempt's `onceForQueries` cache; a failure is left for recall to see.
 */
export function prefetchQuery(
  sql: MemorySql,
  provider: EmbeddingProvider,
  request: { spaceId: string; query: string; jobId: string; actor: string | null },
): void {
  if (!request.query.trim()) return;
  void (async () => {
    const [manifest] =
      await sql`select embedding->>'model' as model from memory_index_manifest where space_id = ${request.spaceId}`;
    if (manifest?.model !== provider.model) return;
    const screened = provider.screen
      ? await provider.screen(request.spaceId, [request.query], request.jobId)
      : [request.query];
    const text = screened?.[0];
    if (!text) return;
    await provider.embed([text], AbortSignal.timeout(QUERY_EMBED_MS), {
      purpose: 'query',
      call: { spaceId: request.spaceId, jobId: request.jobId, actor: request.actor },
    });
  })().catch(() => {});
}
