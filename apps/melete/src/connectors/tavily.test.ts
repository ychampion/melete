/**
 * Tavily as `web.search`'s first backend and as `web.fetch`'s reader for pages
 * a direct read gets no text from. A local HTTP server plays api.tavily.com:
 * the injected fetch keeps every header and the body and changes only where
 * the request goes, after checking it was addressed to Tavily.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DispatchResult } from '@melete/contracts';
import type { BrokerFault } from '../broker/errors.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';
import type { ConnectorContext } from './types.ts';
import { createWebConnector, type ResolvedAddress, type WebTransport } from './web.ts';
import {
  createWebSearch,
  duckDuckGoSearch,
  MAX_API_REPLY_BYTES,
  MAX_RESULT_CONTENT,
  type PageExtractor,
  type SearchRequest,
  tavilyExtract,
  tavilySearch,
  webExtractFromEnv,
  webSearchFromEnv,
  wikipediaSearch,
} from './web-search.ts';

const KEY = 'tvly-secret-0123456789abcdef';

type Seen = {
  host: string;
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
};
type Handler = (seen: Seen, res: ServerResponse) => void;

let server: Server;
let origin = '';
let handler: Handler = (_seen, res) => res.end('{}');
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = {
        host: String(req.headers['x-original-host']),
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: text ? JSON.parse(text) : null,
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Sends a request meant for Tavily to the local server, unchanged but for its address. */
const toFake = async (outbound: Request): Promise<Response> => {
  const target = new URL(outbound.url);
  const headers = new Headers(outbound.headers);
  headers.set('x-original-host', target.host);
  return fetch(`${origin}${target.pathname}`, {
    method: outbound.method,
    headers,
    body: outbound.method === 'POST' ? await outbound.text() : undefined,
    signal: outbound.signal,
  });
};

const json =
  (status: number, value: unknown, headers: Record<string, string> = {}): Handler =>
  (_seen, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof value === 'string' ? value : JSON.stringify(value));
  };

function reset(next: Handler) {
  seen.length = 0;
  handler = next;
}

const request = (extra: Partial<SearchRequest> = {}): SearchRequest => ({
  query: 'bun javascript runtime',
  maxResults: 6,
  jobId: 'job_1',
  spaceId: 'spc_1',
  attemptId: 'att_1',
  actionId: 'act_1',
  ...extra,
});

/** Each error a failing backend raises, collected so its text can be checked for the key. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? `${error.message} ${error.stack ?? ''}` : String(error);
  }
  throw new Error('expected a failure');
}

// --------------------------------------------------------------------------
// Search
// --------------------------------------------------------------------------

test('a Tavily search goes to api.tavily.com with the key as a bearer token and asks for passages', async () => {
  reset(json(200, { results: [] }));
  await tavilySearch({ apiKey: KEY, fetch: toFake }).search(request());
  expect(seen).toHaveLength(1);
  const [sent] = seen;
  expect(sent?.host).toBe('api.tavily.com');
  expect(sent?.method).toBe('POST');
  expect(sent?.path).toBe('/search');
  expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
  expect(sent?.headers['content-type']).toBe('application/json');
  expect(sent?.body).toEqual({
    query: 'bun javascript runtime',
    max_results: 6,
    search_depth: 'basic',
    chunks_per_source: 3,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
  });
  // The key travels only in the header.
  expect(JSON.stringify(sent?.body)).not.toContain(KEY);
});

test("Tavily's passages reach the result as content, clipped; the snippet stays short", async () => {
  const passages = `Bun is a fast JavaScript runtime. [...] ${'It bundles and tests. '.repeat(200)}`;
  reset(
    json(200, {
      results: [
        { title: '<b>Bun</b>', url: 'https://bun.sh/', content: passages, score: 0.9 },
        {
          title: 'Docs',
          url: 'https://bun.sh/docs?api_key=abcdefghij0123456789',
          content: 'Docs.',
        },
        { title: 'Bad', url: 'javascript:alert(1)', content: 'x' },
        { title: 'Bun again', url: 'https://bun.sh/', content: 'duplicate' },
      ],
    }),
  );
  const found = await tavilySearch({ apiKey: KEY, fetch: toFake }).search(request());
  expect(found?.backend).toBe('tavily');
  expect(found?.results.map((item) => item.url)).toEqual([
    'https://bun.sh/',
    'https://bun.sh/docs?api_key=%5Bredacted%5D',
  ]);
  const [first, second] = found?.results ?? [];
  expect(first?.title).toBe('Bun');
  expect(first?.content?.startsWith('Bun is a fast JavaScript runtime. [...] It bundles')).toBe(
    true,
  );
  expect(first?.content?.length).toBe(MAX_RESULT_CONTENT);
  expect(first?.snippet.length).toBeLessThanOrEqual(400);
  expect(second?.content).toBe('Docs.');
  // No date was asked for, so none is kept.
  expect(first?.published).toBeUndefined();
});

test('recency: Tavily gets a time range and dates, Brave a freshness, DuckDuckGo a df, Wikipedia steps aside', async () => {
  reset(
    json(200, {
      results: [
        {
          title: 'Bun 2',
          url: 'https://bun.sh/blog',
          content: 'Released.',
          published_date: 'Wed, 01 Oct 2026 10:00:00 GMT',
        },
        { title: 'Undated', url: 'https://u.example/', content: 'x', published_date: 'soon' },
      ],
    }),
  );
  const found = await tavilySearch({ apiKey: KEY, fetch: toFake }).search(
    request({ recency: 'week' }),
  );
  expect(seen[0]?.body).toMatchObject({ time_range: 'week', include_published_date: true });
  expect(found?.results[0]?.published).toBe('2026-10-01');
  expect(found?.results[1]?.published).toBeUndefined();

  const braveUrls: URL[] = [];
  await webSearchFromEnv(
    { BRAVE_SEARCH_API_KEY: 'brave-key' },
    {
      fetch: async (outbound) => {
        braveUrls.push(new URL(outbound.url));
        return Response.json({ web: { results: [] } });
      },
      get: async () => ({ status: 200, body: '' }),
    },
  ).search(request({ recency: 'month' }));
  expect(braveUrls[0]?.searchParams.get('freshness')).toBe('pm');

  const ddgUrls: URL[] = [];
  await duckDuckGoSearch({
    get: async (url) => {
      ddgUrls.push(url);
      return { status: 200, body: '' };
    },
  }).search(request({ recency: 'day' }));
  expect(ddgUrls[0]?.searchParams.get('df')).toBe('d');

  let wikipediaAsked = 0;
  const wikipedia = wikipediaSearch({
    get: async () => {
      wikipediaAsked += 1;
      return { status: 200, body: '{"query":{"search":[]}}' };
    },
  });
  expect(await wikipedia.search(request({ recency: 'year' }))).toBeNull();
  expect(wikipediaAsked).toBe(0);
});

test('with both keys Tavily is asked first, and Brave answers when Tavily fails', async () => {
  const native = { name: 'native', search: async () => null };
  const brave = async () =>
    Response.json({
      web: { results: [{ title: 'B', url: 'https://b.example/', description: '' }] },
    });
  const routed = (outbound: Request) =>
    new URL(outbound.url).host === 'api.tavily.com' ? toFake(outbound) : brave();
  const both = { TAVILY_API_KEY: KEY, BRAVE_SEARCH_API_KEY: 'brave-key' };
  const search = webSearchFromEnv(both, { native, fetch: routed });
  expect(search.backends).toEqual(['tavily', 'brave', 'native', 'duckduckgo', 'wikipedia']);
  expect(webSearchFromEnv({ TAVILY_API_KEY: KEY }).backends).toEqual([
    'tavily',
    'duckduckgo',
    'wikipedia',
  ]);
  expect(webSearchFromEnv({ TAVILY_API_KEY: '   ' }).backends).toEqual(['duckduckgo', 'wikipedia']);

  reset(json(200, { results: [{ title: 'T', url: 'https://t.example/', content: 'Passage.' }] }));
  expect((await search.search(request())).backend).toBe('tavily');

  reset(json(429, { detail: { error: `rate limited for ${KEY}` } }, { 'retry-after': '30' }));
  const found = await search.search(request());
  expect(found.backend).toBe('brave');
  expect(found.tried).toEqual(['tavily', 'brave']);
});

test('a Tavily error says only its status, never the key or the body that echoed it', async () => {
  for (const status of [400, 401, 432, 433, 500]) {
    reset(json(status, { detail: { error: `Unauthorized: ${KEY} is not valid` } }));
    const text = await failure(tavilySearch({ apiKey: KEY, fetch: toFake }).search(request()));
    expect(text).toContain(`tavily answered ${status}`);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Unauthorized');
    const extracted = await failure(
      tavilyExtract({ apiKey: KEY, fetch: toFake }).read('https://a.example/', {
        timeoutMs: 5_000,
        maxChars: 1_000,
      }),
    );
    expect(extracted).toContain(`tavily answered ${status}`);
    expect(extracted).not.toContain(KEY);
  }
});

test('a Tavily reply over the size limit is not read, and the search moves on', async () => {
  reset(json(200, JSON.stringify({ results: [], pad: 'x'.repeat(MAX_API_REPLY_BYTES) })));
  expect(await failure(tavilySearch({ apiKey: KEY, fetch: toFake }).search(request()))).toContain(
    'size limit',
  );
  const found = await webSearchFromEnv(
    { TAVILY_API_KEY: KEY },
    { fetch: toFake, get: async () => ({ status: 200, body: '' }) },
  ).search(request());
  expect(found.tried[0]).toBe('tavily');
  expect(found.backend).not.toBe('tavily');
});

test('a Tavily that does not answer is given up on: the caller can stop a search, Extract has its own limit', async () => {
  reset(() => {
    // Never answers.
  });
  const started = Date.now();
  const stopped = await failure(
    tavilySearch({ apiKey: KEY, fetch: toFake }).search(
      request({ signal: AbortSignal.timeout(300) }),
    ),
  );
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(stopped).not.toContain(KEY);
  const extractStarted = Date.now();
  await failure(
    tavilyExtract({ apiKey: KEY, fetch: toFake }).read('https://a.example/', {
      timeoutMs: 1_000,
      maxChars: 1_000,
    }),
  );
  expect(Date.now() - extractStarted).toBeLessThan(5_000);
  expect(seen.at(-1)?.body).toMatchObject({ timeout: 1 });
  // The chain stops too when the caller does, rather than trying the next backend.
  const chain = createWebSearch([tavilySearch({ apiKey: KEY, fetch: toFake })]);
  await expect(chain.search(request({ signal: AbortSignal.timeout(300) }))).rejects.toBeDefined();
});

// --------------------------------------------------------------------------
// Extract
// --------------------------------------------------------------------------

test('Tavily Extract is asked for one page, rendered, as text, within the time left', async () => {
  reset(json(200, { results: [{ url: 'https://app.example/', raw_content: 'Rendered text.' }] }));
  const page = await tavilyExtract({ apiKey: KEY, fetch: toFake }).read('https://app.example/', {
    timeoutMs: 20_000,
    maxChars: 1_000,
  });
  expect(page).toEqual({ text: 'Rendered text.', truncated: false });
  const [sent] = seen;
  expect(sent?.host).toBe('api.tavily.com');
  expect(sent?.path).toBe('/extract');
  expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
  expect(sent?.body).toEqual({
    urls: ['https://app.example/'],
    extract_depth: 'advanced',
    format: 'text',
    include_images: false,
    include_usage: true,
    timeout: 19,
  });
});

test('Extract text is held to the reading limit, and a page Tavily failed on is nothing', async () => {
  reset(
    json(200, {
      results: [{ url: 'https://a.example/', raw_content: `ab\u0000c${'d'.repeat(50)}` }],
    }),
  );
  const extractor = tavilyExtract({ apiKey: KEY, fetch: toFake });
  expect(await extractor.read('https://a.example/', { timeoutMs: 5_000, maxChars: 10 })).toEqual({
    text: 'abcddddddd',
    truncated: true,
  });
  reset(
    json(200, { results: [], failed_results: [{ url: 'https://a.example/', error: 'blocked' }] }),
  );
  expect(await extractor.read('https://a.example/', { timeoutMs: 5_000, maxChars: 10 })).toBeNull();
  reset(json(200, { results: [{ url: 'https://a.example/', raw_content: '   ' }] }));
  expect(await extractor.read('https://a.example/', { timeoutMs: 5_000, maxChars: 10 })).toBeNull();
  expect(webExtractFromEnv({})).toBeUndefined();
  expect(webExtractFromEnv({ TAVILY_API_KEY: ' ' })).toBeUndefined();
  expect(webExtractFromEnv({ TAVILY_API_KEY: KEY })?.name).toBe('tavily');
});

// --------------------------------------------------------------------------
// web.fetch falling back to Extract
// --------------------------------------------------------------------------

const PUBLIC: ResolvedAddress = { address: '93.184.215.14', family: 4 };
const SHELL =
  '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

type Answer = { status: number; headers?: Record<string, string>; body?: string };

function site(respond: (url: URL) => Answer) {
  const visited: string[] = [];
  const transport: WebTransport = async (url) => {
    visited.push(url.href);
    const answer = respond(url);
    return { status: answer.status, headers: answer.headers ?? {}, body: answer.body ?? '' };
  };
  return { visited, transport };
}

const html = (body: string, status = 200): Answer => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body,
});

function recordingExtractor(
  text: string | null | Error = 'The text the page builds with its scripts.',
) {
  const asked: { url: string; timeoutMs: number; maxChars: number }[] = [];
  const extractor: PageExtractor = {
    name: 'tavily',
    async read(url, options) {
      asked.push({ url, timeoutMs: options.timeoutMs, maxChars: options.maxChars });
      if (text instanceof Error) throw text;
      return text === null ? null : { text, truncated: false };
    },
  };
  return { asked, extractor };
}

async function fetchPage(
  url: string,
  options: Parameters<typeof createWebConnector>[0],
  payload: Record<string, unknown> = {},
  constraints: Partial<ConnectorContext['constraints']> = {},
): Promise<DispatchResult> {
  const connector = createWebConnector({
    publicReads: async () => null,
    resolve: async () => [PUBLIC],
    searchPrivacy: async () => null,
    ...options,
  });
  const action = connectorAction('web.fetch', { url, ...payload });
  const ctx = connectorContext(action);
  return connector.execute(action, { ...ctx, constraints: { ...ctx.constraints, ...constraints } });
}

const detail = (result: DispatchResult) => {
  if (result.outcome !== 'succeeded')
    throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result.receipt.detail as Record<string, unknown>;
};

test('a page built by scripts is read through Extract at the address the redirects ended on', async () => {
  const { transport, visited } = site((url) =>
    url.pathname === '/start'
      ? { status: 302, headers: { location: 'https://app.example/home#top' } }
      : html(SHELL),
  );
  const { asked, extractor } = recordingExtractor();
  const page = detail(
    await fetchPage('https://app.example/start', { transport, extract: extractor }),
  );
  expect(visited).toEqual(['https://app.example/start', 'https://app.example/home#top']);
  expect(asked).toHaveLength(1);
  expect(asked[0]?.url).toBe('https://app.example/home');
  expect(asked[0]?.maxChars).toBe(60_000);
  expect(asked[0]?.timeoutMs).toBeLessThanOrEqual(30_000);
  expect(page).toMatchObject({
    status: 200,
    title: 'App',
    body: 'The text the page builds with its scripts.',
    read_through: 'tavily',
    final_url: 'https://app.example/home',
  });
  expect(String(page.note)).toContain('hosted reader');
  expect(page.about_this_text).toBeDefined();
});

test('a bot wall, a rate limit or an unavailable site is tried through Extract; other failures are not', async () => {
  const walls: Answer[] = [
    { ...html('<p>Access denied</p>', 403), headers: { 'cf-mitigated': 'challenge' } },
    html('<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>', 403),
    {
      status: 403,
      headers: { 'content-type': 'text/html', server: 'AkamaiGHost' },
      body: '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>',
    },
    html('<div id="px-captcha"></div>', 403),
    html('<p>Slow down</p>', 429),
    html('<p>Try later</p>', 503),
  ];
  for (const answer of walls) {
    const { asked, extractor } = recordingExtractor();
    const page = detail(
      await fetchPage('https://blocked.example/', {
        transport: site(() => answer).transport,
        extract: extractor,
      }),
    );
    expect(asked).toHaveLength(1);
    expect(page.read_through).toBe('tavily');
    expect(page.status).toBe(answer.status);
  }
  for (const status of [404, 410, 500]) {
    const { asked, extractor } = recordingExtractor();
    await fetchPage('https://gone.example/', {
      transport: site(() => html('', status)).transport,
      extract: extractor,
    });
    expect(asked).toEqual([]);
  }
});

test('Extract is not asked when the page has text, is not a page, or is only a HEAD', async () => {
  const article = `<html><body><article>${'<p>Plenty of readable text here. </p>'.repeat(20)}</article></body></html>`;
  const cases: { answer: Answer; payload?: Record<string, unknown> }[] = [
    { answer: html(article) },
    { answer: { status: 200, headers: { 'content-type': 'image/png' }, body: '' } },
    { answer: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' } },
    { answer: html(SHELL), payload: { method: 'HEAD' } },
  ];
  for (const { answer, payload } of cases) {
    const { asked, extractor } = recordingExtractor();
    const page = detail(
      await fetchPage(
        'https://a.example/',
        { transport: site(() => answer).transport, extract: extractor },
        payload,
      ),
    );
    expect(asked).toEqual([]);
    expect(page.read_through).toBeUndefined();
  }
});

test('an address with a credential in it, or one the privacy check keeps in, is never sent to Extract', async () => {
  for (const url of [
    'https://app.example/view?token=abc',
    'https://app.example/view?id=a1b2c3d4e5f6g7h8i9j0k1l2',
  ]) {
    const { asked, extractor } = recordingExtractor();
    const page = detail(
      await fetchPage(url, { transport: site(() => html(SHELL)).transport, extract: extractor }),
    );
    expect(asked).toEqual([]);
    expect(page.body).toBe('');
  }
  const { asked, extractor } = recordingExtractor();
  const queried: string[] = [];
  detail(
    await fetchPage('https://clinic.example/results?q=a%20b', {
      transport: site(() => html(SHELL)).transport,
      extract: extractor,
      searchPrivacy: async ({ query }) => {
        queried.push(query);
        return 'kept private';
      },
    }),
  );
  expect(queried).toEqual(['https://clinic.example/results?q=a%20b']);
  expect(asked).toEqual([]);
  // A check that cannot answer keeps the address in.
  const broken = recordingExtractor();
  await fetchPage('https://clinic.example/', {
    transport: site(() => html(SHELL)).transport,
    extract: broken.extractor,
    searchPrivacy: async () => {
      throw new Error('settings unreadable');
    },
  });
  expect(broken.asked).toEqual([]);
});

test('a page read only because the job lists its site is never sent to Extract when public reads are refused', async () => {
  // A private agent may read the sites its work was given, but nothing it
  // reads may go to an outside service: the public-read rule is asked for the
  // reader even when the job's own list allowed the direct read.
  const { asked, extractor } = recordingExtractor();
  const policy: { jobId: string }[] = [];
  const page = detail(
    await fetchPage(
      'https://tools.example.org/dashboard',
      {
        transport: site(() => html(SHELL)).transport,
        extract: extractor,
        publicReads: async (_query, scope) => {
          policy.push(scope);
          return 'This space or agent is private, so it does not read the web.';
        },
      },
      {},
      { allowed_domains: ['tools.example.org'] },
    ),
  );
  expect(page.final_url).toBe('https://tools.example.org/dashboard');
  expect(page.read_through).toBeUndefined();
  expect(asked).toEqual([]);
  expect(policy).toHaveLength(1);
  // Public research reads any public page, and so may use the reader.
  const research = recordingExtractor();
  const open = detail(
    await fetchPage(
      'https://tools.example.org/dashboard',
      {
        transport: site(() => html(SHELL)).transport,
        extract: research.extractor,
        publicReads: async () => 'refused',
      },
      {},
      { public_compartment: true },
    ),
  );
  expect(open.read_through).toBe('tavily');
});

test('a link that is its own key, in its path, is never sent to Extract', async () => {
  for (const url of [
    'https://files.example/s/k3j4h5g6f7d8s9a0q1w2e3r4/report.pdf.html',
    'https://app.example/reset/abc',
    'https://app.example/invite/team',
    'https://app.example/a/eyJhbGciOiJIUzI1NiJ9.payload',
    'https://app.example/d/550e8400-e29b-41d4-a716-446655440000/edit',
    'https://app.example/x;jsessionid=A1B2C3D4E5F6G7H8I9J0K1L2',
    'https://app.example/%E0%A4%A',
  ]) {
    const { asked, extractor } = recordingExtractor();
    const page = detail(
      await fetchPage(url, { transport: site(() => html(SHELL)).transport, extract: extractor }),
    );
    expect({ url, asked }).toEqual({ url, asked: [] });
    expect(page.read_through).toBeUndefined();
  }
  // An ordinary address still goes.
  const { asked, extractor } = recordingExtractor();
  await fetchPage('https://news.example/2026/10/bun-ships-a-new-release', {
    transport: site(() => html(SHELL)).transport,
    extract: extractor,
  });
  expect(asked).toHaveLength(1);
});

test('a private address, a refused read or a redirect to a private address never reaches Extract', async () => {
  const { asked, extractor } = recordingExtractor();
  const privateHost = await fetchPage('https://intranet.example/', {
    transport: site(() => html(SHELL)).transport,
    resolve: async () => [{ address: '10.0.0.5', family: 4 }],
    extract: extractor,
  });
  expect(privateHost.outcome).toBe('failed');
  const literal = await fetchPage('http://169.254.169.254/latest/', {
    transport: site(() => html(SHELL)).transport,
    extract: extractor,
  });
  expect(literal.outcome).toBe('failed');
  const redirected = await fetchPage('https://public.example/', {
    transport: site(() => ({ status: 302, headers: { location: 'http://127.0.0.1/admin' } }))
      .transport,
    extract: extractor,
  });
  expect(redirected.outcome).toBe('failed');
  const off = await fetchPage('https://public.example/', {
    transport: site(() => html(SHELL)).transport,
    publicReads: async () => 'Reading public web pages is turned off for this space.',
    extract: extractor,
  });
  expect(off.outcome).toBe('failed');
  expect(asked).toEqual([]);
});

test("when Extract fails, finds less, or there is too little time left, the direct read's result stands", async () => {
  for (const outcome of [new Error('tavily answered 500'), null, 'x']) {
    const { asked, extractor } = recordingExtractor(outcome);
    const page = detail(
      await fetchPage('https://app.example/', {
        transport: site(() => html('<p>Access denied</p>', 503)).transport,
        extract: extractor,
      }),
    );
    expect(asked).toHaveLength(1);
    expect(page.read_through).toBeUndefined();
    expect(page.note).toBeUndefined();
    expect(page.body).toBe('Access denied');
  }
  const { asked, extractor } = recordingExtractor();
  detail(
    await fetchPage('https://app.example/', {
      transport: site(() => html(SHELL)).transport,
      extract: extractor,
      totalTimeoutMs: 2_000,
    }),
  );
  expect(asked).toEqual([]);
});

test('the key never appears in what web.fetch hands back', async () => {
  reset(json(200, { results: [{ url: 'https://app.example/', raw_content: 'Rendered.' }] }));
  const result = await fetchPage('https://app.example/', {
    transport: site(() => html(SHELL)).transport,
    extract: tavilyExtract({ apiKey: KEY, fetch: toFake }),
  });
  expect(detail(result).body).toBe('Rendered.');
  expect(JSON.stringify(result)).not.toContain(KEY);
  reset(json(401, { error: `bad key ${KEY}` }));
  const failed = await fetchPage('https://app.example/', {
    transport: site(() => html(SHELL)).transport,
    extract: tavilyExtract({ apiKey: KEY, fetch: toFake }),
  });
  expect(JSON.stringify(failed)).not.toContain(KEY);
});

// --------------------------------------------------------------------------
// The web.search tool's recency
// --------------------------------------------------------------------------

test('web.search takes a recency, keeps it in the payload and the receipt, and refuses any other value', async () => {
  const calls: SearchRequest[] = [];
  const connector = createWebConnector({
    publicReads: async () => null,
    searchPrivacy: async () => null,
    search: createWebSearch([
      {
        name: 'tavily',
        async search(searchRequest) {
          calls.push(searchRequest);
          return {
            backend: 'tavily',
            results: [
              {
                title: 'Bun 2',
                url: 'https://bun.sh/blog',
                snippet: 'Released.',
                content: 'Released today.',
                published: '2026-10-01',
              },
            ],
            recencyApplied: true,
          };
        },
      },
    ]),
  });
  const action = connectorAction('web.search', { query: 'bun release', recency: 'week' });
  const ctx = connectorContext(action);
  const prepared = await connector.prepare?.(action.canonical_payload, ctx, undefined as never);
  expect(prepared).toEqual({ query: 'bun release', recency: 'week' });
  const result = await connector.execute(action, ctx);
  expect(calls[0]?.recency).toBe('week');
  const receipt = detail(result);
  expect(receipt.recency).toBe('week');
  expect(receipt.results).toEqual([
    {
      title: 'Bun 2',
      url: 'https://bun.sh/blog',
      snippet: 'Released.',
      content: 'Released today.',
      published: '2026-10-01',
    },
  ]);
  for (const recency of ['hour', 'WEEK', 7]) {
    const bad = connectorAction('web.search', { query: 'bun release', recency });
    const admission = await connector
      .prepare?.(bad.canonical_payload, connectorContext(bad), undefined as never)
      .catch((error: unknown) => error);
    expect((admission as BrokerFault).code).toBe('payload_invalid');
    expect(await connector.execute(bad, connectorContext(bad))).toMatchObject({
      outcome: 'failed',
      retryable: false,
    });
  }
  expect(calls).toHaveLength(1);
});
