/**
 * The model's own web search, through Melete's model gateway.
 *
 * When the model a conversation runs on can search the web through its
 * provider (`modelSupportsNativeSearch`), `web.search` asks that model, with
 * its provider's search tool, in one bounded request. The request goes through
 * a model gateway of its own, as auto-review's does: the provider key never
 * leaves the gateway, the privacy router reads the request as the job's own
 * service call, and the call is recorded against the job that searched, as a
 * reservation on its output budget and a pair of notices in its ledger.
 *
 * A call token is good for one call. A model with no search of its own, or a
 * provider that is not connected, is not an error: the search moves on to
 * Melete's own backends.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type CapabilityClaims, effectiveNativeSearch } from '@melete/contracts';
import type { Sql } from 'postgres';
import {
  distinctResults,
  type SearchBackend,
  type SearchOutcome,
  SearchRefused,
  type SearchRequest,
  type SearchResult,
} from '../connectors/web-search.ts';
import type { Env } from '../env.ts';
import { configuredProviders } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import { createModelGateway, type GatewayOptions } from '../gateway/index.ts';
import { type ModelSettingsService, serviceModelSource } from '../gateway/model-settings.ts';
import { modelApiMode, protocolForApiMode } from '../gateway/providers.ts';
import {
  type GatewayBudget,
  GatewayError,
  type GatewayPrincipal,
  type GatewayProtocol,
} from '../gateway/types.ts';
import { reserveLocked } from './budget.ts';
import { appendEvent, lockJob } from './records.ts';

export const SEARCH_INPUT_TOKENS = 4_000;
export const SEARCH_OUTPUT_TOKENS = 3_000;
/** Searches one call may run before it answers. */
export const SEARCH_MAX_USES = 3;

const PRIVACY_REFUSED =
  'This conversation is private, so its words are not sent to an outside search.';

type Target = { provider: string; model: string };
/** One call in flight. `route` is where the privacy router sent it, once it settles. */
type Call = { request: SearchRequest; target: Target; route?: string };

/** The principal of one search call: one request, one model, the job that searched. */
export function searchPrincipal(call: Call): GatewayPrincipal {
  return {
    jobId: call.request.jobId,
    attemptId: call.request.attemptId,
    privacy: {
      kind: 'service',
      purpose: 'web_search',
      spaceId: call.request.spaceId,
      sourceJobId: call.request.jobId,
    },
    epoch: 0,
    revision: 0,
    maxRequests: 1,
    maxTokens: SEARCH_OUTPUT_TOKENS,
    maxInputTokens: SEARCH_INPUT_TOKENS,
    allowedModels: [call.target],
  };
}

/**
 * Records each search call on the job that made it: the output it may produce
 * is reserved on the job's token budget under the web.search action, and the
 * request and its receipt are notices in the job's ledger.
 */
export function jobSearchBudget(
  sql: Sql,
  calls: (principal: GatewayPrincipal) => Call | undefined,
): GatewayBudget {
  const reserved = new Map<string, Call>();
  return {
    async reserve(request) {
      const call = calls(request.principal);
      if (!call) throw new GatewayError(401, 'search_principal_denied');
      if (
        request.provider !== call.target.provider ||
        request.model !== call.target.model ||
        request.maxOutputTokens > SEARCH_OUTPUT_TOKENS
      )
        throw new GatewayError(403, 'search_principal_denied');
      const { jobId, attemptId, actionId } = call.request;
      const id = await sql.begin(async (tx) => {
        const job = await lockJob(tx, jobId);
        // The job's own limits, charged to the attempt and the action that searched.
        const claims = { attempt_id: attemptId, budget: job.budget } as unknown as CapabilityClaims;
        const [tokens] = await reserveLocked(tx, job, claims, actionId, [
          { kind: 'tokens', amount: request.maxOutputTokens },
        ]);
        if (!tokens) throw new Error('Incomplete search reservation');
        await appendEvent(tx, job.id, attemptId, 'notice', {
          phase: 'search_request',
          action_id: actionId,
          reservation_id: tokens.id,
          provider: request.provider,
          model_requested: request.model,
          estimated_tokens: request.estimatedTokens,
          max_output_tokens: request.maxOutputTokens,
        });
        return tokens.id;
      });
      reserved.set(id, call);
      return { id };
    },
    async settle(reservation, settlement) {
      const call = reserved.get(reservation.id);
      reserved.delete(reservation.id);
      if (!call) throw new GatewayError(409, 'reservation_not_found');
      call.route = settlement.privacy?.route;
      const { jobId, attemptId, actionId } = call.request;
      const usage = settlement.usage;
      await sql.begin(async (tx) => {
        const job = await lockJob(tx, jobId);
        if (usage)
          await tx`update budget_ledger set settled = ${usage.outputTokens}
            where id = ${reservation.id} and settled is null`;
        const [attempt] = await tx`select usage from attempt where id = ${attemptId} for update`;
        if (attempt && usage) {
          const previous = (attempt.usage ?? {}) as Record<string, unknown>;
          const next = {
            ...previous,
            input_tokens: Number(previous.input_tokens ?? 0) + usage.inputTokens,
            output_tokens: Number(previous.output_tokens ?? 0) + usage.outputTokens,
            cached_input_tokens:
              Number(previous.cached_input_tokens ?? 0) + usage.cachedInputTokens,
            search_requests: Number(previous.search_requests ?? 0) + 1,
          };
          await tx`update attempt set usage = ${JSON.stringify(next)}::jsonb
            where id = ${attemptId}`;
        }
        await appendEvent(tx, job.id, attemptId, 'notice', {
          phase: 'search_receipt',
          action_id: actionId,
          reservation_id: reservation.id,
          provider: settlement.provider,
          model_requested: settlement.modelRequested,
          model_actual: settlement.modelActual,
          usage: usage
            ? {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cached_input_tokens: usage.cachedInputTokens,
                total_tokens: usage.totalTokens,
              }
            : null,
          latency_ms: settlement.latencyMs,
          status: settlement.status,
          http_status: settlement.httpStatus,
          ...(settlement.privacy ? { privacy: settlement.privacy } : {}),
        });
      });
    },
  };
}

function searchPrompt(query: string, count: number): string {
  return (
    `Search the web for: ${query}\n\n` +
    `Answer in a few sentences from what you find, and cite the pages you used. ` +
    `Find up to ${count} relevant pages.`
  );
}

/** The request for one search, or null when this protocol has no search tool here. */
export function searchBody(
  provider: string,
  protocol: GatewayProtocol,
  model: string,
  request: Pick<SearchRequest, 'query' | 'maxResults'>,
): Record<string, unknown> | null {
  const prompt = searchPrompt(request.query, request.maxResults);
  if (provider === 'anthropic' && protocol === 'messages')
    return {
      model,
      max_tokens: SEARCH_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: SEARCH_MAX_USES }],
    };
  if (provider === 'openai' && protocol === 'responses')
    return {
      model,
      input: prompt,
      max_output_tokens: SEARCH_OUTPUT_TOKENS,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
    };
  return null;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const resultOf = (title: unknown, url: unknown, snippet: unknown): SearchResult | null => {
  const address = text(url);
  if (!/^https?:\/\//i.test(address)) return null;
  let host = address;
  try {
    host = new URL(address).hostname;
  } catch {
    return null;
  }
  return {
    title: (text(title).trim() || host).slice(0, 200),
    url: address,
    snippet: text(snippet).replace(/\s+/g, ' ').trim().slice(0, 400),
  };
};

/** What a Messages reply with web search found: the pages, the cited text, the answer. */
export function messagesSearchOutcome(reply: unknown, limit: number) {
  const content = list(object(reply).content).map(object);
  const cited = new Map<string, { title: unknown; text: string }>();
  const answer: string[] = [];
  const found: (SearchResult | null)[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      answer.push(text(block.text));
      for (const citation of list(block.citations).map(object))
        if (typeof citation.url === 'string' && !cited.has(citation.url))
          cited.set(citation.url, { title: citation.title, text: text(citation.cited_text) });
    }
  }
  for (const [url, citation] of cited) found.push(resultOf(citation.title, url, citation.text));
  for (const block of content)
    if (block.type === 'web_search_tool_result')
      for (const item of list(block.content).map(object))
        if (item.type === 'web_search_result')
          found.push(resultOf(item.title, item.url, cited.get(text(item.url))?.text));
  const searches = Number(object(object(object(reply).usage).server_tool_use).web_search_requests);
  return {
    answer: answer.join('').trim(),
    results: distinctResults(found, limit),
    searches: Number.isSafeInteger(searches)
      ? searches
      : content.filter((block) => block.type === 'server_tool_use').length,
  };
}

/** What a Responses reply with web search found: cited pages first, then every source. */
export function responsesSearchOutcome(reply: unknown, limit: number) {
  const output = list(object(reply).output).map(object);
  const answer: string[] = [];
  const found: (SearchResult | null)[] = [];
  for (const item of output)
    if (item.type === 'message')
      for (const part of list(item.content).map(object))
        if (part.type === 'output_text') {
          answer.push(text(part.text));
          for (const note of list(part.annotations).map(object))
            if (note.type === 'url_citation') found.push(resultOf(note.title, note.url, ''));
        }
  const calls = output.filter((item) => item.type === 'web_search_call');
  for (const call of calls)
    for (const source of [...list(object(call.action).sources), ...list(call.sources)]) {
      const entry = typeof source === 'string' ? { url: source } : object(source);
      found.push(resultOf(entry.title, entry.url, ''));
    }
  return {
    answer: answer.join('').trim(),
    results: distinctResults(found, limit),
    searches: calls.length,
  };
}

export type SearchGatewayOptions = {
  sql: Sql;
  providers: NonNullable<GatewayOptions['providers']>;
  /** Keys and endpoints the owner connects in the app, read per call. */
  currentProviders?: GatewayOptions['currentProviders'];
  privacy: GatewayOptions['privacy'];
  /** The operator's word on the server default model searching (MELETE_DEFAULT_MODEL_NATIVE_SEARCH). */
  defaultModel?: Target & { search?: boolean };
  fetch?: GatewayOptions['fetch'];
  timeoutMs?: number;
  /** Test injection: how a call's ledger is kept. */
  budget?: (calls: (principal: GatewayPrincipal) => Call | undefined) => GatewayBudget;
  /** Test injection: the model an attempt runs on. */
  attemptModel?: (request: SearchRequest) => Promise<Target | null>;
};

/** Opens the search gateway and returns the backend that searches through it. */
export async function openSearchGateway(options: SearchGatewayOptions) {
  const live = new Map<string, Call>();
  const byPrincipal = new WeakMap<GatewayPrincipal, Call>();
  const server = createModelGateway({
    budget: (options.budget ?? ((calls) => jobSearchBudget(options.sql, calls)))((principal) =>
      byPrincipal.get(principal),
    ),
    providers: options.providers,
    ...(options.currentProviders ? { currentProviders: options.currentProviders } : {}),
    fetch: options.fetch,
    privacy: options.privacy,
    providerSearch: true,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 2 * 1024 * 1024,
    async authenticate(token) {
      // One token, one call: spent the moment the gateway accepts it.
      const call = live.get(token);
      live.delete(token);
      if (!call) throw new GatewayError(401, 'search_principal_denied');
      const principal = searchPrincipal(call);
      byPrincipal.set(principal, call);
      return principal;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const attemptModel =
    options.attemptModel ??
    (async (request: SearchRequest) => {
      const [row] = await options.sql`select provider, model from attempt
        where id = ${request.attemptId} and job_id = ${request.jobId}`;
      return row ? { provider: String(row.provider), model: String(row.model) } : null;
    });

  /** Whether this model searches through its provider, by the catalog or the operator's word. */
  const searches = (target: Target) => {
    const operator =
      options.defaultModel &&
      options.defaultModel.provider === target.provider &&
      options.defaultModel.model === target.model
        ? options.defaultModel.search
        : undefined;
    return effectiveNativeSearch(target.provider, target.model, operator);
  };

  const backend: SearchBackend = {
    name: 'native',
    async search(request): Promise<SearchOutcome | null> {
      const target = await attemptModel(request);
      if (!target || !searches(target)) return null;
      const protocol = protocolForApiMode(modelApiMode(target.provider, target.model));
      const body = searchBody(target.provider, protocol, target.model, request);
      if (!body) return null;
      const token = randomUUID();
      const sent: Call = { request, target };
      live.set(token, sent);
      try {
        const response = await fetch(`${base}/providers/${target.provider}/v1/${protocol}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-melete-capability': token,
            ...(protocol === 'messages'
              ? { 'x-api-key': 'melete-surrogate-search' }
              : { authorization: 'Bearer melete-surrogate-search' }),
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: request.signal,
        });
        if (!response.ok) {
          // The gateway's own code: never the provider's body.
          const code = String(
            object(object(await response.json().catch(() => null)).error).code ?? '',
          );
          if (/^privacy_/.test(code)) throw new SearchRefused(PRIVACY_REFUSED);
          throw new Error(`search gateway ${response.status} ${code}`);
        }
        const reply = await response.json();
        const call = live.get(token) ?? sent;
        // Sent to the person's own model instead: that is no web search, and
        // the conversation is private, so nothing else may search either.
        if (call.route === 'local') throw new SearchRefused(PRIVACY_REFUSED);
        const found =
          protocol === 'messages'
            ? messagesSearchOutcome(reply, request.maxResults)
            : responsesSearchOutcome(reply, request.maxResults);
        // A reply with no sources searched nothing; Melete's own search tries.
        if (found.results.length === 0) throw new Error('native search returned no sources');
        return {
          backend: 'native',
          model: `${target.provider}/${target.model}`,
          results: found.results,
          ...(found.answer ? { answer: found.answer.slice(0, 4_000) } : {}),
          searches: found.searches,
        };
      } finally {
        live.delete(token);
      }
    },
  };
  return {
    backend,
    async close() {
      live.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * The search gateway this deployment runs: the configured providers, with the
 * keys and endpoints the owner connects in the app read per call.
 */
export async function configuredSearchGateway(
  sql: Sql,
  env: Env,
  privacy: GatewayOptions['privacy'],
  connected: {
    signIn?: ProviderSignIn;
    settings?: ModelSettingsService;
    /** The upstream transport; tests pass a stand-in provider. */
    fetch?: GatewayOptions['fetch'];
  } = {},
) {
  const source = serviceModelSource({ env, settings: connected.settings });
  return openSearchGateway({
    sql,
    providers: configuredProviders(env, () => {}, connected.signIn),
    currentProviders: source.providers,
    privacy,
    defaultModel: {
      provider: env.MELETE_DEFAULT_PROVIDER,
      model: env.MELETE_DEFAULT_MODEL,
      search: env.MELETE_DEFAULT_MODEL_NATIVE_SEARCH,
    },
    ...(connected.fetch ? { fetch: connected.fetch } : {}),
  });
}
