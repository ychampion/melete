/**
 * Searching the web, as `web.search` does it.
 *
 * A search goes to the first backend that can answer, in this order:
 *
 * 1. A search API the operator configured (`TAVILY_API_KEY`, then
 *    `BRAVE_SEARCH_API_KEY`). Setting one is a choice, so it comes first.
 *    Tavily goes first when both are set because its results carry the
 *    passages of each page that match the query, so the agent can often
 *    answer without reading the pages one by one.
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
  type SearchRecency,
  type WebTransport,
} from './web.ts';

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  /** The passages of the page that match the query, when the backend returns them. */
  content?: string;
  /** When the page was published (an ISO day), when the backend says. */
  published?: string;
};

/** One search, with the job it is for. Everything but the query comes from trusted state. */
export type SearchRequest = {
  query: string;
  maxResults: number;
  /** Only results from this recent past, when asked. */
  recency?: SearchRecency;
  jobId: string;
  spaceId: string;
  /** The attempt that asked, whose model a native search uses. */
  attemptId: string;
  actionId: string;
  signal?: AbortSignal;
  /** Charges a paid backend's call to the job, when given. */
  meter?: PaidApiMeter;
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
  /** Whether the backend kept to the recency asked for. */
  recencyApplied?: boolean;
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
/** The most page text one result carries. */
export const MAX_RESULT_CONTENT = 1_600;

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

/**
 * A result as the receipt keeps it: an http(s) address without credentials,
 * text without markup, clipped. Every backend's results go through this,
 * the model's own search included.
 */
export function searchResult(
  title: unknown,
  url: unknown,
  snippet: unknown,
  extra: { content?: unknown; published?: unknown } = {},
): SearchResult | null {
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
  const content =
    typeof extra.content === 'string' ? clip(plainText(extra.content), MAX_RESULT_CONTENT) : '';
  const published = publishedDay(extra.published);
  return {
    title: clip(name, MAX_TITLE),
    url: address,
    snippet: clip(plainText(typeof snippet === 'string' ? snippet : ''), MAX_SNIPPET),
    ...(content ? { content } : {}),
    ...(published ? { published } : {}),
  };
}

/** A publication date as an ISO day, or null when the value is not a date. */
function publishedDay(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
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

/** The most a search API's reply may be; a larger one is not read. */
export const MAX_API_REPLY_BYTES = 1024 * 1024;

/** An API answered with an error status; only the status is kept, since its body can echo the key. */
class ApiStatusError extends Error {
  constructor(
    name: string,
    readonly status: number,
  ) {
    super(`${name} answered ${status}`);
  }
}

async function apiJson(fetcher: Fetch, request: Request, name: string): Promise<unknown> {
  const response = await fetcher(request);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    // The status only: an API's error body can echo the key.
    throw new ApiStatusError(name, response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_API_REPLY_BYTES) throw new Error(`${name} reply exceeds the size limit`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];

const BRAVE_FRESHNESS: Record<SearchRecency, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

/** Brave Search API (https://api.search.brave.com), with `BRAVE_SEARCH_API_KEY`. */
export function braveSearch(options: { apiKey: string; fetch?: Fetch }): SearchBackend {
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  return {
    name: 'brave',
    async search(request) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', request.query);
      url.searchParams.set('count', String(request.maxResults));
      if (request.recency) url.searchParams.set('freshness', BRAVE_FRESHNESS[request.recency]);
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
          records(body?.web?.results).map((item) =>
            searchResult(item.title, item.url, item.description),
          ),
          request.maxResults,
        ),
        ...(request.recency ? { recencyApplied: true } : {}),
      };
    },
  };
}

/** The only address the Tavily key is ever sent to. */
const TAVILY_API = 'https://api.tavily.com';

const tavilyHeaders = (apiKey: string) => ({
  accept: 'application/json',
  'content-type': 'application/json',
  authorization: `Bearer ${apiKey}`,
});

/** The job a paid call is made for, to be charged to it. */
export type PaidCall = { jobId: string; spaceId: string; attemptId: string; actionId: string };
export type PaidCharge = {
  provider: string;
  kind: 'search' | 'extract';
  /** The most the call can cost, in the provider's credits. */
  maxCredits: number;
};
export type PaidHold = { id: string };

/**
 * Charges an outside API's calls to the job that made them: the most a call
 * can cost is held against the job's spending before it is sent, and settled
 * at what the provider reports once it answers.
 */
export type PaidApiMeter = {
  /** Throws `PaidCallRefused`, with a sentence the model can read, when the call may not be made. */
  reserve(call: PaidCall, charge: PaidCharge): Promise<PaidHold>;
  settle(hold: PaidHold, credits: number): Promise<void>;
};

/** A paid call the job may not make now; the message says why, in plain words. */
export class PaidCallRefused extends Error {}

/** What a Tavily credit is charged as on the job's spending estimate: the pay-as-you-go price. */
export const TAVILY_CREDIT_USD = 0.008;
/** Credits one basic search costs. */
export const TAVILY_SEARCH_CREDITS = 1;
/** The most one advanced extract of a single page costs. */
export const TAVILY_EXTRACT_CREDITS = 2;

/** The credits a reply says it used, held within what was reserved; `fallback` when it does not say. */
function creditsUsed(body: unknown, ceiling: number, fallback: number): number {
  const credits = (body as { usage?: { credits?: unknown } } | null)?.usage?.credits;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0
    ? Math.min(credits, ceiling)
    : fallback;
}

/**
 * One metered call: the hold is taken first and settled whatever happens. A
 * refusal by status was not billed; a call that failed any other way may have
 * been, so it keeps its whole hold.
 */
async function metered<T>(
  meter: PaidApiMeter | undefined,
  call: PaidCall | undefined,
  charge: PaidCharge,
  send: () => Promise<{ value: T; credits: number }>,
): Promise<T> {
  if (!meter || !call) return (await send()).value;
  const hold = await meter.reserve(call, charge);
  let credits = charge.maxCredits;
  try {
    const sent = await send();
    credits = sent.credits;
    return sent.value;
  } catch (error) {
    if (error instanceof ApiStatusError) credits = 0;
    throw error;
  } finally {
    await meter.settle(hold, credits);
  }
}

const paidCall = (request: SearchRequest): PaidCall => ({
  jobId: request.jobId,
  spaceId: request.spaceId,
  attemptId: request.attemptId,
  actionId: request.actionId,
});

/**
 * Tavily Search (https://api.tavily.com/search), with `TAVILY_API_KEY`.
 *
 * `basic` depth costs one credit and returns, for each page, up to three
 * passages reranked against the query. Those passages reach the agent as the
 * result's `content`, so a search often answers without a `web.fetch` for
 * each page. Tavily's own written answer and whole-page text are not asked
 * for: the agent writes the answer from the sources, and whole pages are what
 * `web.fetch` is for. With a meter on the request the credit is charged to
 * the job, and a job that may not spend it searches nowhere else either.
 */
export function tavilySearch(options: { apiKey: string; fetch?: Fetch }): SearchBackend {
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  return {
    name: 'tavily',
    async search(request) {
      const charge: PaidCharge = {
        provider: 'tavily',
        kind: 'search',
        maxCredits: TAVILY_SEARCH_CREDITS,
      };
      let body: { results?: unknown } | null;
      try {
        body = await metered(request.meter, paidCall(request), charge, async () => {
          const reply = (await apiJson(
            fetcher,
            new Request(`${TAVILY_API}/search`, {
              method: 'POST',
              headers: tavilyHeaders(options.apiKey),
              body: JSON.stringify({
                query: request.query,
                max_results: request.maxResults,
                search_depth: 'basic',
                chunks_per_source: 3,
                include_answer: false,
                include_raw_content: false,
                include_images: false,
                include_usage: true,
                ...(request.recency
                  ? { time_range: request.recency, include_published_date: true }
                  : {}),
              }),
              redirect: 'error',
              signal: apiSignal(request.signal),
            }),
            'tavily',
          )) as { results?: unknown } | null;
          return {
            value: reply,
            credits: creditsUsed(reply, charge.maxCredits, charge.maxCredits),
          };
        });
      } catch (error) {
        // Over the job's spending, a search is not moved to a free backend to get round it.
        if (error instanceof PaidCallRefused) throw new SearchRefused(error.message);
        throw error;
      }
      return {
        backend: 'tavily',
        results: distinctResults(
          records(body?.results).map((item) =>
            searchResult(item.title, item.url, item.content, {
              content: item.content,
              published: item.published_date,
            }),
          ),
          request.maxResults,
        ),
        ...(request.recency ? { recencyApplied: true } : {}),
      };
    },
  };
}

/**
 * Reads one public page through a hosted reader, for a page the direct read
 * got no text from. Null when the reader got nothing either.
 */
export type PageExtractor = {
  name: string;
  read(
    url: string,
    options: {
      signal?: AbortSignal;
      timeoutMs: number;
      maxChars: number;
      /** Charges the read to the job, when given with its call. */
      meter?: PaidApiMeter;
      call?: PaidCall;
    },
  ): Promise<{ text: string; truncated: boolean } | null>;
};

/**
 * Tavily Extract (https://api.tavily.com/extract), with `TAVILY_API_KEY`.
 * `advanced` depth renders the page before reading it, which a page built by
 * scripts needs. It costs at most two credits, and a page it cannot read
 * costs none.
 */
export function tavilyExtract(options: { apiKey: string; fetch?: Fetch }): PageExtractor {
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  return {
    name: 'tavily',
    read(url, read) {
      const charge: PaidCharge = {
        provider: 'tavily',
        kind: 'extract',
        maxCredits: TAVILY_EXTRACT_CREDITS,
      };
      return metered(read.meter, read.call, charge, async () => {
        const timeoutMs = Math.max(1_000, Math.min(read.timeoutMs, 60_000));
        const timeout = AbortSignal.timeout(timeoutMs);
        const body = (await apiJson(
          fetcher,
          new Request(`${TAVILY_API}/extract`, {
            method: 'POST',
            headers: tavilyHeaders(options.apiKey),
            body: JSON.stringify({
              urls: [url],
              extract_depth: 'advanced',
              format: 'text',
              include_images: false,
              include_usage: true,
              // Tavily's own limit, a second inside ours so its answer can arrive.
              timeout: Math.max(1, Math.floor(timeoutMs / 1000) - 1),
            }),
            redirect: 'error',
            signal: read.signal ? AbortSignal.any([read.signal, timeout]) : timeout,
          }),
          'tavily',
        )) as { results?: unknown } | null;
        const [page] = records(body?.results);
        // A NUL never carries meaning in a page, and a receipt cannot store one.
        const text =
          typeof page?.raw_content === 'string'
            ? page.raw_content.replaceAll('\u0000', '').trim()
            : '';
        // A page Tavily could not read is not billed.
        const credits = creditsUsed(body, charge.maxCredits, text ? charge.maxCredits : 0);
        if (!text) return { value: null, credits };
        return {
          value: {
            text: text.length > read.maxChars ? text.slice(0, read.maxChars) : text,
            truncated: text.length > read.maxChars,
          },
          credits,
        };
      });
    },
  };
}

/** The reader `web.fetch` falls back to for a page it got no text from, when one is set. */
export function webExtractFromEnv(
  env: { TAVILY_API_KEY?: string },
  options: { fetch?: Fetch } = {},
): PageExtractor | undefined {
  const tavily = env.TAVILY_API_KEY?.trim();
  return tavily ? tavilyExtract({ apiKey: tavily, fetch: options.fetch }) : undefined;
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
    /** Sent instead of the default user agent, for a service that asks to be told who calls. */
    userAgent?: string;
  } = {},
): PublicGet {
  const resolve = options.resolve ?? resolveHost;
  const transport = options.transport ?? pinnedWebRequest;
  return async (url, accept, signal) => {
    const userAgent = options.userAgent;
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
      ...(userAgent ? { userAgent } : {}),
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
    if (target) found.push(searchResult(title, target, snippet));
    index = next;
  }
  return distinctResults(found, limit);
}

/** A page DuckDuckGo serves instead of results when it suspects automation. */
const looksBlocked = (status: number, body: string) =>
  status === 202 || status === 403 || status === 429 || /anomaly-modal|challenge-form/.test(body);

/** How the keyless search is kept polite to DuckDuckGo. */
export type KeylessPacing = {
  /** The least time between two requests from this installation. */
  minIntervalMs?: number;
  /** How long a query's results are reused. */
  cacheMs?: number;
  /** How long nothing is sent after DuckDuckGo served its robot check. */
  coolOffMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const CACHE_ENTRIES = 200;

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * DuckDuckGo's HTML results, which need no key and no account. It is an
 * unofficial use of a page meant for people, sent from this server's address,
 * so it is paced: one request at a time with a gap between them, a query's
 * results reused for a while, and nothing sent for a cool-off period after
 * DuckDuckGo answers with its robot check.
 */
export function duckDuckGoSearch(
  options: { get?: PublicGet; pacing?: KeylessPacing } = {},
): SearchBackend {
  const get = options.get ?? publicGetter();
  const pacing = options.pacing ?? {};
  const minIntervalMs = pacing.minIntervalMs ?? 2_000;
  const cacheMs = pacing.cacheMs ?? 10 * 60_000;
  const coolOffMs = pacing.coolOffMs ?? 15 * 60_000;
  const now = pacing.now ?? Date.now;
  const sleep = pacing.sleep ?? pause;
  const cache = new Map<string, { at: number; results: SearchResult[] }>();
  let blockedUntil = 0;
  let lastAt = Number.NEGATIVE_INFINITY;
  let queue: Promise<unknown> = Promise.resolve();
  const send = async (request: SearchRequest): Promise<SearchResult[]> => {
    if (now() < blockedUntil) throw new Error('duckduckgo is cooling off after a block');
    const wait = lastAt + minIntervalMs - now();
    if (wait > 0) await sleep(wait, request.signal);
    lastAt = now();
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', request.query);
    if (request.recency) url.searchParams.set('df', request.recency.slice(0, 1));
    const response = await get(url, 'text/html', request.signal);
    if (looksBlocked(response.status, response.body)) {
      blockedUntil = now() + coolOffMs;
      throw new Error('duckduckgo did not serve results');
    }
    if (response.status !== 200) throw new Error(`duckduckgo answered ${response.status}`);
    return parseDuckDuckGo(response.body, MAX_SEARCH_RESULTS);
  };
  return {
    name: 'duckduckgo',
    async search(request) {
      const key = `${request.recency ?? 'any'}:${request.query.toLowerCase()}`;
      const kept = cache.get(key);
      let results: SearchResult[];
      if (kept && now() - kept.at < cacheMs) results = kept.results;
      else {
        // One at a time: the gap is between requests, not between callers.
        const turn = queue.then(() => send(request));
        queue = turn.catch(() => {});
        results = await turn;
        cache.delete(key);
        cache.set(key, { at: now(), results });
        if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      }
      return {
        backend: 'duckduckgo',
        results: results.slice(0, request.maxResults),
        ...(request.recency ? { recencyApplied: true } : {}),
      };
    },
  };
}

/** What the operator is told at start when searches may fall to the keyless search. */
export function keylessSearchNotice(env: {
  BRAVE_SEARCH_API_KEY?: string;
  TAVILY_API_KEY?: string;
}): string | null {
  if (env.BRAVE_SEARCH_API_KEY?.trim() || env.TAVILY_API_KEY?.trim()) return null;
  return (
    'web search: no search key is set, so searches the model cannot run itself read ' +
    "DuckDuckGo's results page from this server's address. That page is meant for people, " +
    'is paced and may stop answering; set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for a hosted installation.'
  );
}

/** Wikipedia's API asks callers to say who they are. */
const WIKIPEDIA_USER_AGENT =
  'Melete/0.1 (self-hosted assistant; https://github.com/ychampion/melete)';

/** Wikipedia's search API: narrow, but keyless and steady when DuckDuckGo is not. */
export function wikipediaSearch(options: { get?: PublicGet } = {}): SearchBackend {
  const get = options.get ?? publicGetter({ userAgent: WIKIPEDIA_USER_AGENT });
  return {
    name: 'wikipedia',
    async search(request) {
      // Articles carry no publication date, so a search for recent pages passes on.
      if (request.recency) return null;
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
              ? searchResult(
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
  options: {
    native?: SearchBackend;
    fetch?: Fetch;
    get?: PublicGet;
    pacing?: KeylessPacing;
  } = {},
): WebSearch {
  const backends: SearchBackend[] = [];
  const brave = env.BRAVE_SEARCH_API_KEY?.trim();
  const tavily = env.TAVILY_API_KEY?.trim();
  if (tavily) backends.push(tavilySearch({ apiKey: tavily, fetch: options.fetch }));
  if (brave) backends.push(braveSearch({ apiKey: brave, fetch: options.fetch }));
  if (options.native) backends.push(options.native);
  backends.push(
    duckDuckGoSearch({ ...(options.get ? { get: options.get } : {}), pacing: options.pacing }),
    wikipediaSearch(options.get ? { get: options.get } : {}),
  );
  return createWebSearch(backends);
}
