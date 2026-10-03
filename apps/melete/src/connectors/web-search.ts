/**
 * Searching the web, as `web.search` does it.
 *
 * A search goes to the first backend that can answer, in this order:
 *
 * 1. A search API the operator configured (`BRAVE_SEARCH_API_KEY`, then
 *    `TAVILY_API_KEY`). Setting one is a choice, so it comes first.
 * 2. The search tool of the model the conversation runs on, when its provider
 *    has one (`modelSupportsNativeSearch`). That call goes through Melete's
 *    model gateway, so it is metered against the job and the privacy router
 *    sees it, like every other model call.
 * 3. A search that needs no key: DuckDuckGo's HTML results page, and Wikipedia's
 *    search API when DuckDuckGo does not answer. Both are read through the same
 *    pinned, public-address-only transport as `web.fetch`.
 *
 * A backend that fails or finds nothing passes the search to the next one. A
 * privacy refusal never does: a search that may not leave is not sent anywhere.
 */
import { isIP } from 'node:net';
import { decodeEntities } from './readable.ts';
import {
  MAX_SEARCH_RESULTS,
  pinnedWebRequest,
  publicPin,
  type ResolvedAddress,
  receiptUrl,
  resolveHost,
  type WebTransport,
} from './web.ts';

export type SearchResult = { title: string; url: string; snippet: string };

/** One search, with the job it is for. Everything but the query comes from trusted state. */
export type SearchRequest = {
  query: string;
  maxResults: number;
  jobId: string;
  spaceId: string;
  /** The attempt that asked, whose model a native search uses. */
  attemptId: string;
  actionId: string;
  signal?: AbortSignal;
};

export type SearchOutcome = {
  /** Which backend answered: `brave`, `tavily`, `native`, `duckduckgo` or `wikipedia`. */
  backend: string;
  results: SearchResult[];
  /** A native search's own summary of what it found, with its sources in `results`. */
  answer?: string;
  /** How many searches the provider ran, when it says. */
  searches?: number;
  /** The provider and model a native search ran on. */
  model?: string;
};

export type SearchBackend = {
  name: string;
  /** The answer, or null when this backend does not apply to this request. */
  search(request: SearchRequest): Promise<SearchOutcome | null>;
};

/** The search may not be sent anywhere; no other backend is tried. */
export class SearchRefused extends Error {}

export type WebSearch = {
  /** Which backends would be tried, in order, for the operator's own view. */
  readonly backends: readonly string[];
  search(request: SearchRequest): Promise<SearchOutcome & { tried: string[] }>;
};

export class SearchUnavailable extends Error {
  constructor(readonly tried: string[]) {
    super('no search backend answered');
  }
}

const MAX_TITLE = 200;
const MAX_SNIPPET = 400;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

/** Markup out, entities decoded, whitespace folded. */
export function plainText(html: string): string {
  let text = '';
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      text += html.slice(index);
      break;
    }
    text += html.slice(index, open);
    const close = html.indexOf('>', open);
    if (close === -1) break;
    index = close + 1;
  }
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** A result as the receipt keeps it: an http(s) address without credentials, clipped text. */
function result(title: unknown, url: unknown, snippet: unknown): SearchResult | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const address = receiptUrl(parsed);
  const name = plainText(typeof title === 'string' ? title : '') || parsed.hostname;
  return {
    title: clip(name, MAX_TITLE),
    url: address,
    snippet: clip(plainText(typeof snippet === 'string' ? snippet : ''), MAX_SNIPPET),
  };
}

/** Distinct by address, in order, at most `limit`. */
export function distinctResults(
  items: readonly (SearchResult | null)[],
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const kept: SearchResult[] = [];
  for (const item of items) {
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    kept.push(item);
    if (kept.length >= limit) break;
  }
  return kept;
}

// --------------------------------------------------------------------------
// Configured search APIs
// --------------------------------------------------------------------------

type Fetch = (request: Request) => Promise<Response>;
const API_TIMEOUT_MS = 15_000;

function apiSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function apiJson(fetcher: Fetch, request: Request, name: string): Promise<unknown> {
  const response = await fetcher(request);
  if (!response.ok) {
    await response.body?.cancel();
    // The status only: an API's error body can echo the key.
    throw new Error(`${name} answered ${response.status}`);
  }
  return response.json();
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];

/** Brave Search API (https://api.search.brave.com), with `BRAVE_SEARCH_API_KEY`. */
export function braveSearch(options: { apiKey: string; fetch?: Fetch }): SearchBackend {
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  return {
    name: 'brave',
    async search(request) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', request.query);
      url.searchParams.set('count', String(request.maxResults));
      const body = (await apiJson(
        fetcher,
        new Request(url.href, {
          headers: { accept: 'application/json', 'x-subscription-token': options.apiKey },
          redirect: 'error',
          signal: apiSignal(request.signal),
        }),
        'brave',
      )) as { web?: { results?: unknown } } | null;
      return {
        backend: 'brave',
        results: distinctResults(
          records(body?.web?.results).map((item) => result(item.title, item.url, item.description)),
          request.maxResults,
        ),
      };
    },
  };
}

/** Tavily (https://api.tavily.com), with `TAVILY_API_KEY`. */
export function tavilySearch(options: { apiKey: string; fetch?: Fetch }): SearchBackend {
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  return {
    name: 'tavily',
    async search(request) {
      const body = (await apiJson(
        fetcher,
        new Request('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            query: request.query,
            max_results: request.maxResults,
            search_depth: 'basic',
          }),
          redirect: 'error',
          signal: apiSignal(request.signal),
        }),
        'tavily',
      )) as { results?: unknown } | null;
      return {
        backend: 'tavily',
        results: distinctResults(
          records(body?.results).map((item) => result(item.title, item.url, item.content)),
          request.maxResults,
        ),
      };
    },
  };
}

// --------------------------------------------------------------------------
// Keyless search
// --------------------------------------------------------------------------

type PublicGet = (
  url: URL,
  accept: string,
  signal?: AbortSignal,
) => Promise<{ status: number; body: string }>;

/** A GET to a fixed public host, pinned to an address checked as public, as `web.fetch` reads. */
export function publicGetter(
  options: {
    resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
    transport?: WebTransport;
    timeoutMs?: number;
  } = {},
): PublicGet {
  const resolve = options.resolve ?? resolveHost;
  const transport = options.transport ?? pinnedWebRequest;
  return async (url, accept, signal) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(host);
    const pinned = publicPin(
      family ? [{ address: host, family: family as 4 | 6 }] : await resolve(host),
    );
    if (!pinned) throw new Error('search host is not on a public address');
    const response = await transport(url, pinned, {
      signal,
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 15_000,
      accept,
    });
    return { status: response.status, body: response.body };
  };
}

/** The address DuckDuckGo's redirect link points at, or the link itself when it is direct. */
function duckDuckGoTarget(href: string): string | null {
  const decoded = decodeEntities(href);
  try {
    const link = new URL(decoded, 'https://duckduckgo.com');
    if (link.hostname.endsWith('duckduckgo.com')) {
      // An ad goes through /y.js and carries no uddg target.
      const target = link.searchParams.get('uddg');
      return target ?? null;
    }
    return link.href;
  } catch {
    return null;
  }
}

/** The value of one attribute in a tag's text, or null. */
function attribute(tag: string, name: string): string | null {
  const at = tag.indexOf(`${name}="`);
  if (at === -1) return null;
  const start = at + name.length + 2;
  const end = tag.indexOf('"', start);
  return end === -1 ? null : tag.slice(start, end);
}

/**
 * Results from DuckDuckGo's HTML page (html.duckduckgo.com/html/): each
 * `result__a` link with the `result__snippet` that follows it. One pass of
 * `indexOf`, so a hostile page costs what reading it once does.
 */
export function parseDuckDuckGo(html: string, limit = MAX_SEARCH_RESULTS): SearchResult[] {
  const found: (SearchResult | null)[] = [];
  const marker = 'class="result__a"';
  let index = html.indexOf(marker);
  while (index !== -1 && found.length < limit * 3) {
    const tagStart = html.lastIndexOf('<a', index);
    const tagEnd = html.indexOf('>', index);
    if (tagStart === -1 || tagEnd === -1) break;
    const close = html.indexOf('</a>', tagEnd);
    if (close === -1) break;
    const next = html.indexOf(marker, close);
    const href = attribute(html.slice(tagStart, tagEnd), 'href');
    const title = html.slice(tagEnd + 1, close);
    const block = html.slice(close, next === -1 ? undefined : next);
    const snippetAt = block.indexOf('class="result__snippet"');
    let snippet = '';
    if (snippetAt !== -1) {
      const start = block.indexOf('>', snippetAt);
      const end = block.indexOf('</a>', start);
      if (start !== -1 && end !== -1) snippet = block.slice(start + 1, end);
    }
    const target = href ? duckDuckGoTarget(href) : null;
    if (target) found.push(result(title, target, snippet));
    index = next;
  }
  return distinctResults(found, limit);
}

/** A page DuckDuckGo serves instead of results when it suspects automation. */
const looksBlocked = (status: number, body: string) =>
  status === 202 || status === 403 || status === 429 || /anomaly-modal|challenge-form/.test(body);

/** DuckDuckGo's HTML results, which need no key and no account. */
export function duckDuckGoSearch(options: { get?: PublicGet } = {}): SearchBackend {
  const get = options.get ?? publicGetter();
  return {
    name: 'duckduckgo',
    async search(request) {
      const url = new URL('https://html.duckduckgo.com/html/');
      url.searchParams.set('q', request.query);
      const response = await get(url, 'text/html', request.signal);
      if (looksBlocked(response.status, response.body))
        throw new Error('duckduckgo did not serve results');
      if (response.status !== 200) throw new Error(`duckduckgo answered ${response.status}`);
      return {
        backend: 'duckduckgo',
        results: parseDuckDuckGo(response.body, request.maxResults),
      };
    },
  };
}

/** Wikipedia's search API: narrow, but keyless and steady when DuckDuckGo is not. */
export function wikipediaSearch(options: { get?: PublicGet } = {}): SearchBackend {
  const get = options.get ?? publicGetter();
  return {
    name: 'wikipedia',
    async search(request) {
      const url = new URL('https://en.wikipedia.org/w/api.php');
      for (const [name, value] of Object.entries({
        action: 'query',
        list: 'search',
        srsearch: request.query,
        srlimit: String(request.maxResults),
        format: 'json',
        utf8: '1',
      }))
        url.searchParams.set(name, value);
      const response = await get(url, 'application/json', request.signal);
      if (response.status !== 200) throw new Error(`wikipedia answered ${response.status}`);
      const body = JSON.parse(response.body) as { query?: { search?: unknown } } | null;
      return {
        backend: 'wikipedia',
        results: distinctResults(
          records(body?.query?.search).map((item) =>
            typeof item.title === 'string'
              ? result(
                  item.title,
                  `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(' ', '_'))}`,
                  item.snippet,
                )
              : null,
          ),
          request.maxResults,
        ),
      };
    },
  };
}

// --------------------------------------------------------------------------
// The order
// --------------------------------------------------------------------------

export function createWebSearch(backends: readonly SearchBackend[]): WebSearch {
  return {
    backends: backends.map((backend) => backend.name),
    async search(request) {
      const tried: string[] = [];
      let empty: SearchOutcome | null = null;
      for (const backend of backends) {
        request.signal?.throwIfAborted();
        let outcome: SearchOutcome | null;
        try {
          outcome = await backend.search(request);
        } catch (error) {
          if (error instanceof SearchRefused) throw error;
          request.signal?.throwIfAborted();
          tried.push(backend.name);
          continue;
        }
        if (!outcome) continue;
        tried.push(backend.name);
        // Nothing found here may still be found by the next one.
        if (outcome.results.length === 0 && !outcome.answer) {
          empty ??= outcome;
          continue;
        }
        return { ...outcome, tried };
      }
      if (empty) return { ...empty, tried };
      throw new SearchUnavailable(tried);
    },
  };
}

/**
 * The backends this deployment searches with, in order. `native` is the model
 * gateway's search, present wherever the service runs one.
 */
export function webSearchFromEnv(
  env: { BRAVE_SEARCH_API_KEY?: string; TAVILY_API_KEY?: string },
  options: { native?: SearchBackend; fetch?: Fetch; get?: PublicGet } = {},
): WebSearch {
  const backends: SearchBackend[] = [];
  const brave = env.BRAVE_SEARCH_API_KEY?.trim();
  const tavily = env.TAVILY_API_KEY?.trim();
  if (brave) backends.push(braveSearch({ apiKey: brave, fetch: options.fetch }));
  if (tavily) backends.push(tavilySearch({ apiKey: tavily, fetch: options.fetch }));
  if (options.native) backends.push(options.native);
  const get = options.get ?? publicGetter();
  backends.push(duckDuckGoSearch({ get }), wikipediaSearch({ get }));
  return createWebSearch(backends);
}
