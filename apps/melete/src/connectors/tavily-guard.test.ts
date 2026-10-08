/**
 * What may leave for the hosted reader (Tavily Extract), and what a paid
 * Tavily call is charged. The privacy check here is the real redactor and
 * topic classifier, so an address is held to what a search query is.
 */
import { expect, test } from 'bun:test';
import { PRIVACY_CATEGORIES } from '@melete/contracts';
import { classifyParts } from '../privacy/classify.ts';
import { Redactor } from '../privacy/redact.ts';
import { Vault } from '../privacy/vault.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';
import {
  addressTexts,
  createWebConnector,
  keyShaped,
  shareableAddress,
  WEB_SEARCH_NOTICE,
  type WebResponse,
  type WebTransport,
} from './web.ts';
import {
  createWebSearch,
  type PageExtractor,
  type PaidApiMeter,
  PaidCallRefused,
  type PaidCharge,
  SearchRefused,
  type SearchRequest,
  tavilyExtract,
  tavilySearch,
} from './web-search.ts';

const SHELL =
  '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const shell: WebTransport = async () => ({
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: SHELL,
});

/** The privacy router's last two steps, for real: topic words, then the redactor with a known name. */
const routerLike = async ({ query }: { jobId: string; query: string }) => {
  if (classifyParts([query], ['health', 'therapy', 'finance'], new Map())) return 'topic';
  const redactor = new Redactor(new Vault(), {
    enabled: new Set(PRIVACY_CATEGORIES),
    known: [{ value: 'Jane Marlowe', category: 'name' }] as never,
  });
  return redactor.spans(query).length ? 'details' : null;
};

const allow = async () => null;

/** The addresses a web.fetch handed to the reader. */
async function sent(
  url: string,
  privacy: (scope: { jobId: string; query: string }) => Promise<string | null> = allow,
  transport: WebTransport = shell,
): Promise<string[]> {
  const asked: string[] = [];
  const extractor: PageExtractor = {
    name: 'tavily',
    async read(address) {
      asked.push(address);
      return { text: 'rendered text from the hosted reader', truncated: false };
    },
  };
  const connector = createWebConnector({
    publicReads: async () => null,
    resolve: async () => [{ address: '93.184.215.14', family: 4 }],
    searchPrivacy: privacy,
    transport,
    extract: extractor,
  });
  const action = connectorAction('web.fetch', { url });
  await connector.execute(action, connectorContext(action));
  return asked;
}

// --------------------------------------------------------------------------
// The privacy check reads the address as words
// --------------------------------------------------------------------------

test('details a search query is refused for are refused inside an address too, however it is encoded', async () => {
  // The plain words are refused as a search query.
  expect(await routerLike({ jobId: 'j', query: 'Jane Marlowe biopsy results' })).not.toBeNull();
  expect(await routerLike({ jobId: 'j', query: 'john.doe@gmail.com' })).not.toBeNull();
  for (const url of [
    'https://portal.example/patient?name=Jane%20Marlowe',
    'https://portal.example/patient?name=Jane+Marlowe',
    'https://portal.example/people/jane-marlowe',
    'https://portal.example/lookup?email=john.doe%40gmail.com',
    'https://portal.example/search?q=my%20biopsy%20results',
    'https://example.com/search?q=my+therapist+notes',
    'https://example.com/my-tax-returns-2025',
  ])
    expect({ url, sent: await sent(url, routerLike) }).toEqual({ url, sent: [] });
  // An address with nothing private in it still goes.
  expect(await sent('https://news.example/2026/10/bun-ships-a-new-release', routerLike)).toEqual([
    'https://news.example/2026/10/bun-ships-a-new-release',
  ]);
});

test('the privacy check is given the address as sent, decoded, and as words', () => {
  expect(
    addressTexts(new URL('https://portal.example/people/jane-marlowe?email=john.doe%40gmail.com')),
  ).toEqual([
    'https://portal.example/people/jane-marlowe?email=john.doe%40gmail.com',
    'portal.example/people/jane-marlowe email john.doe@gmail.com',
    'portal example people jane marlowe email john doe gmail com',
  ]);
  expect(addressTexts(new URL('https://a.example/x?q=a+b%20c'))[2]).toBe('a example x q a b c');
  expect(addressTexts(new URL('https://a.example/people/JaneMarlowe,HTMLParser~v2:x'))[2]).toBe(
    'a example people Jane Marlowe HTML Parser v2 x',
  );
});

test('a name joined by any punctuation, or written in camel case, is read as the name', async () => {
  for (const url of [
    'https://portal.example/people/jane,marlowe',
    'https://portal.example/people/jane~marlowe',
    'https://portal.example/people/jane:marlowe',
    'https://portal.example/people/jane!marlowe',
    'https://portal.example/people/jane;marlowe',
    'https://portal.example/people/jane*marlowe',
    'https://portal.example/people/JaneMarlowe',
    'https://portal.example/patient?name=Jane%2CMarlowe',
  ]) {
    // Each address is shareable, so the privacy check alone keeps it in.
    expect({ url, shareable: shareableAddress(new URL(url)) }).toEqual({ url, shareable: true });
    expect({ url, sent: await sent(url, routerLike) }).toEqual({ url, sent: [] });
  }
});

// --------------------------------------------------------------------------
// Keys, share links and sign-in steps stay in
// --------------------------------------------------------------------------

const KEPT_IN = [
  // OneDrive shares: the key starts with "!", and its name has no separator.
  'https://onedrive.live.com/redir?resid=ABCDEF0123456789!123&authkey=!AHq3xYz9KlMnOpQ',
  'https://onedrive.live.com/?authkey=%21AHq3xYz9KlMnOpQrStUv&id=ABCDEF0123456789%21123',
  // Key names run together, with short values.
  'https://files.example/get?secretkey=AbC123xyz',
  'https://files.example/get?sharekey=abc',
  'https://files.example/get?accesstoken=abc',
  'https://files.example/get?rlkey=abc',
  // Short ids that are the key.
  'https://we.tl/t-AbCdEf1234',
  'https://docsend.com/view/a1b2c3d4e5f6',
  'https://pastebin.example/AbC12dEf',
  // A long run of digits.
  'https://portal.example/p/982347598234759823475',
  // Sign-in steps and where they go next.
  'https://git.example/users/sign_in?redirect_to=%2Facme%2Fproject-nightjar',
  'https://app.example/session/new?next=/acme/secret-roadmap',
  'https://app.example/sso/saml?RelayState=abc',
  'https://app.example/login',
  'https://app.example/oauth/authorize',
  'https://app.example/docs?return=/home',
  'https://git.example/users/sign_in',
  'https://app.example/session/new',
  'https://app.example/sso/saml',
  'https://app.example/signup',
  'https://app.example/logout',
  // A key as a host name.
  'https://k3j4h5g6f7d8s9a0q1w2e3r4.tunnel.example/',
];

test('share keys, short and numeric ids, sign-in steps and keys in host names never reach Extract', async () => {
  for (const url of KEPT_IN) {
    expect({ url, shareable: shareableAddress(new URL(url)) }).toEqual({ url, shareable: false });
    expect({ url, sent: await sent(url) }).toEqual({ url, sent: [] });
  }
  for (const url of [
    'https://news.example/2026/10/bun-ships-a-new-release',
    'https://docs.example/guide/getting-started?lang=en&page=2',
    'https://shop.example/products/blue-mug',
  ])
    expect({ url, shareable: shareableAddress(new URL(url)) }).toEqual({ url, shareable: true });
});

test('what reads as a key: mixed runs of eight or more, long digit runs, tokens, with punctuation between runs', () => {
  for (const value of [
    '!AHq3xYz9KlMnOpQ',
    'AbC12dEf',
    't-AbCdEf1234',
    '1234567890',
    'eyJhbGciOiJIUzI1NiJ9',
    'a1-b2-c3-d4-e5-f6-g7-h8',
  ])
    expect({ value, key: keyShaped(value) }).toEqual({ value, key: true });
  for (const value of [
    '2026',
    'bun-ships-a-new-release',
    'v2',
    'h264',
    'blue-mug',
    '123456789',
    'bun.v1.2.20',
  ])
    expect({ value, key: keyShaped(value) }).toEqual({ value, key: false });
});

// --------------------------------------------------------------------------
// A 403 is the site's own answer unless a bot wall served it
// --------------------------------------------------------------------------

test("a private resource's 403 keeps its address here", async () => {
  const forbidden: WebTransport = async () => ({
    status: 403,
    headers: {
      'content-type': 'text/html',
      server: 'cloudflare',
      'cf-ray': '8a1b2c3d4e5f6a7b-SJC',
    },
    body: '<p>You need access. Ask the owner.</p>',
  });
  expect(
    await sent(
      'https://drive.example.com/drive/folders/project-nightjar-board-minutes',
      allow,
      forbidden,
    ),
  ).toEqual([]);
});

test('a captcha, an Akamai server, a sign-in page or a session keeps a private page here', async () => {
  const PRIVATE = 'https://intranet-app.example/folders/project-nightjar-board-minutes';
  const answer =
    (status: number, headers: Record<string, string>, body: string): WebTransport =>
    async () => ({ status, headers: { 'content-type': 'text/html', ...headers }, body });
  const kept: [string, WebTransport][] = [
    [
      'a sign-in form with reCAPTCHA',
      answer(403, {}, '<form><div class="g-recaptcha" data-sitekey="x"></div>No access</form>'),
    ],
    ['an hCaptcha widget', answer(403, {}, '<div class="h-captcha"></div><p>Forbidden</p>')],
    ['an Akamai server header alone', answer(403, { server: 'AkamaiGHost' }, '<p>Denied</p>')],
    [
      'a challenge page that also asks to sign in',
      answer(403, { 'cf-mitigated': 'challenge' }, '<p>Sign in to continue</p>'),
    ],
    [
      'a challenge page with a password field',
      answer(403, {}, '<title>Just a moment...</title><input type="password" name="p">'),
    ],
    [
      'a bot wall that also opened a session',
      answer(
        403,
        { 'cf-mitigated': 'challenge', 'set-cookie': '__cf_bm=a; Path=/, app_session=b; Path=/' },
        '<p>Blocked</p>',
      ),
    ],
    ['a site asking for credentials', answer(503, { 'www-authenticate': 'Basic' }, '<p>Busy</p>')],
    ['a script-built page that set a session', answer(200, { 'set-cookie': 'sid=abc' }, SHELL)],
  ];
  for (const [name, transport] of kept)
    expect({ name, sent: await sent(PRIVATE, allow, transport) }).toEqual({ name, sent: [] });

  // A session opened on the way, before a redirect, counts too.
  let hop = 0;
  const redirected: WebTransport = async () =>
    hop++ === 0
      ? { status: 302, headers: { location: '/app', 'set-cookie': 'connect.sid=s%3Aabc' }, body: '' }
      : { status: 200, headers: { 'content-type': 'text/html' }, body: SHELL };
  expect(await sent(PRIVATE, allow, redirected)).toEqual([]);

  // A bot wall's own challenge, cookies included, still goes.
  expect(
    await sent(
      PRIVATE,
      allow,
      answer(
        403,
        { 'cf-mitigated': 'challenge', 'set-cookie': '__cf_bm=abc; Path=/; HttpOnly' },
        '<title>Just a moment...</title>',
      ),
    ),
  ).toEqual([PRIVATE]);
});

test('IP encodings, mapped forms and private redirect endings never reach Extract', async () => {
  const asked: string[] = [];
  const extractor: PageExtractor = {
    name: 'tavily',
    async read(url) {
      asked.push(url);
      return { text: 'x'.repeat(500), truncated: false };
    },
  };
  const transport: WebTransport = async (url): Promise<WebResponse> => {
    if (url.pathname === '/to-metadata')
      return {
        status: 302,
        headers: { location: 'http://[::ffff:169.254.169.254]/latest' },
        body: '',
      };
    if (url.pathname === '/to-internal')
      return { status: 307, headers: { location: 'https://db.corp.internal/' }, body: '' };
    return { status: 429, headers: { 'content-type': 'text/html' }, body: SHELL };
  };
  const connector = createWebConnector({
    publicReads: async () => null,
    searchPrivacy: async () => null,
    resolve: async (host) =>
      host === 'db.corp.internal'
        ? [{ address: '10.1.2.3', family: 4 }]
        : host === 'rebind.example'
          ? [
              { address: '93.184.215.14', family: 4 },
              { address: '192.168.1.1', family: 4 },
            ]
          : [{ address: '93.184.215.14', family: 4 }],
    transport,
    extract: extractor,
  });
  for (const url of [
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[64:ff9b::a00:1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::1]/',
    'http://0/',
    'http://100.64.0.1/',
    'http://user:pass@public.example/',
    'https://redir.example/to-metadata',
    'https://redir.example/to-internal',
    'https://rebind.example/',
  ]) {
    const action = connectorAction('web.fetch', { url });
    expect((await connector.execute(action, connectorContext(action))).outcome).toBe('failed');
  }
  expect(asked).toEqual([]);
});

// --------------------------------------------------------------------------
// Paid calls are charged to the job
// --------------------------------------------------------------------------

type Metered = { reserved: PaidCharge[]; settled: number[]; meter: PaidApiMeter };

function recordingMeter(refuse?: string): Metered {
  const reserved: PaidCharge[] = [];
  const settled: number[] = [];
  return {
    reserved,
    settled,
    meter: {
      async reserve(_call, charge) {
        if (refuse) throw new PaidCallRefused(refuse);
        reserved.push(charge);
        return { id: `hold_${reserved.length}` };
      },
      async settle(_hold, credits) {
        settled.push(credits);
      },
    },
  };
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

test('a Tavily search is held at one credit and settled at what Tavily reports, nothing for a refusal by status', async () => {
  const charged = recordingMeter();
  const search = tavilySearch({
    apiKey: 'tvly-k',
    fetch: async () => Response.json({ results: [], usage: { credits: 1 } }),
  });
  await search.search(request({ meter: charged.meter }));
  expect(charged.reserved).toEqual([{ provider: 'tavily', kind: 'search', maxCredits: 1 }]);
  expect(charged.settled).toEqual([1]);

  const refusedByStatus = recordingMeter();
  await expect(
    tavilySearch({
      apiKey: 'tvly-k',
      fetch: async () => new Response('{}', { status: 432 }),
    }).search(request({ meter: refusedByStatus.meter })),
  ).rejects.toThrow('tavily answered 432');
  expect(refusedByStatus.settled).toEqual([0]);

  // A call that broke off may have been billed, so it keeps its hold.
  const broken = recordingMeter();
  await expect(
    tavilySearch({
      apiKey: 'tvly-k',
      fetch: async () => {
        throw new Error('connection reset');
      },
    }).search(request({ meter: broken.meter })),
  ).rejects.toThrow('connection reset');
  expect(broken.settled).toEqual([1]);
});

test('a job that may not spend on a Tavily search searches nowhere else either', async () => {
  let fetched = 0;
  let later = 0;
  const search = createWebSearch([
    tavilySearch({
      apiKey: 'tvly-k',
      fetch: async () => {
        fetched += 1;
        return Response.json({ results: [] });
      },
    }),
    {
      name: 'duckduckgo',
      async search() {
        later += 1;
        return { backend: 'duckduckgo', results: [] };
      },
    },
  ]);
  const refusal = 'Over the spending limit of this work.';
  await expect(
    search.search(request({ meter: recordingMeter(refusal).meter })),
  ).rejects.toBeInstanceOf(SearchRefused);
  expect(fetched).toBe(0);
  expect(later).toBe(0);
});

test('an extract is held at two credits, a page Tavily could not read costs none', async () => {
  const call = { jobId: 'job_1', spaceId: 'spc_1', attemptId: 'att_1', actionId: 'act_1' };
  const read = recordingMeter();
  await tavilyExtract({
    apiKey: 'tvly-k',
    fetch: async () =>
      Response.json({ results: [{ url: 'https://a.example/', raw_content: 'Text.' }] }),
  }).read('https://a.example/', { timeoutMs: 5_000, maxChars: 100, meter: read.meter, call });
  expect(read.reserved).toEqual([{ provider: 'tavily', kind: 'extract', maxCredits: 2 }]);
  expect(read.settled).toEqual([2]);
  const failed = recordingMeter();
  await tavilyExtract({
    apiKey: 'tvly-k',
    fetch: async () =>
      Response.json({ results: [], failed_results: [{ url: 'https://a.example/', error: 'x' }] }),
  }).read('https://a.example/', { timeoutMs: 5_000, maxChars: 100, meter: failed.meter, call });
  expect(failed.settled).toEqual([0]);
});

test('when the job may not pay for the reader, web.fetch says so plainly and sends nothing', async () => {
  let fetched = 0;
  const cap =
    'The hosted reader was not used: it reads at most 3 pages each turn, and this turn has used them.';
  const connector = createWebConnector({
    publicReads: async () => null,
    resolve: async () => [{ address: '93.184.215.14', family: 4 }],
    searchPrivacy: allow,
    transport: shell,
    extract: tavilyExtract({
      apiKey: 'tvly-k',
      fetch: async () => {
        fetched += 1;
        return Response.json({ results: [{ url: 'https://a.example/', raw_content: 'Text.' }] });
      },
    }),
    meter: recordingMeter(cap).meter,
  });
  const action = connectorAction('web.fetch', { url: 'https://app.example/' });
  const result = await connector.execute(action, connectorContext(action));
  if (result.outcome !== 'succeeded') throw new Error('expected the direct read');
  const detail = result.receipt.detail as Record<string, unknown>;
  expect(fetched).toBe(0);
  expect(detail.read_through).toBeUndefined();
  expect(detail.note).toBe(`The site gave no readable text to a direct read. ${cap}`);
});

// --------------------------------------------------------------------------
// What the model is told about search results
// --------------------------------------------------------------------------

test('the search notice names the page passages as outside text', () => {
  expect(WEB_SEARCH_NOTICE).toContain('page passages');
});

test('a recency the answering search did not keep to is not recorded, and the model is told', async () => {
  const connector = createWebConnector({
    publicReads: async () => null,
    searchPrivacy: allow,
    search: createWebSearch([
      {
        name: 'native',
        search: async () => ({
          backend: 'native',
          results: [{ title: 'A', url: 'https://a.example/', snippet: '' }],
        }),
      },
    ]),
  });
  const action = connectorAction('web.search', { query: 'bun release', recency: 'day' });
  const result = await connector.execute(action, connectorContext(action));
  if (result.outcome !== 'succeeded') throw new Error('expected results');
  const detail = result.receipt.detail as Record<string, unknown>;
  expect(detail.recency).toBeUndefined();
  expect(detail.note).toBe(
    'These results are not limited to recent pages; check the dates on the pages you use.',
  );
});

test('the web connector charges its searches to the job through its meter', async () => {
  const charged = recordingMeter();
  const connector = createWebConnector({
    publicReads: async () => null,
    searchPrivacy: allow,
    meter: charged.meter,
    search: createWebSearch([
      tavilySearch({
        apiKey: 'tvly-k',
        fetch: async () =>
          Response.json({
            results: [{ title: 'A', url: 'https://a.example/', content: 'x' }],
            usage: { credits: 1 },
          }),
      }),
    ]),
  });
  const action = connectorAction('web.search', { query: 'bun release' });
  expect((await connector.execute(action, connectorContext(action))).outcome).toBe('succeeded');
  expect(charged.reserved).toEqual([{ provider: 'tavily', kind: 'search', maxCredits: 1 }]);
  expect(charged.settled).toEqual([1]);
});
