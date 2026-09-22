import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { BrowserContext, Request, Route, WebSocketRoute } from 'playwright';
import {
  type BrowserCommitBinding,
  type BrowserNetworkOptions,
  type BrowserNetworkPolicy,
  type BrowserNetworkResponse,
  BrowserRedirect,
  createBrowserEgress,
  pinnedBrowserRequest,
} from './egress.ts';
import { LiveNetworkBudget, type LiveNoticeCode, LiveSiteScope } from './live-protocol.ts';

type RequestSpec = {
  url?: string;
  method?: string;
  resourceType?: string;
  body?: Buffer;
  headers?: Record<string, string>;
  previous?: Request;
  /** A top-level navigation leaving this document; absent for subresources. */
  from?: string;
  opener?: string;
  /** The top-level document a resource or frame belongs to. */
  top?: string;
  subframe?: boolean;
};

function request(spec: RequestSpec): Request {
  return {
    url: () => spec.url ?? 'https://public.example/form',
    method: () => spec.method ?? 'GET',
    resourceType: () => spec.resourceType ?? 'document',
    postDataBuffer: () => spec.body ?? null,
    allHeaders: async () =>
      spec.headers ??
      (spec.method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    redirectedFrom: () => spec.previous ?? null,
    isNavigationRequest: () => spec.from !== undefined || spec.subframe === true,
    frame: () => ({
      url: () => spec.from ?? 'about:blank',
      parentFrame: () => (spec.subframe ? {} : null),
      page: () => ({
        opener: async () => (spec.opener ? { url: () => spec.opener } : null),
        mainFrame: () => ({ url: () => spec.top ?? 'about:blank' }),
      }),
    }),
  } as unknown as Request;
}

function browserHarness() {
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  let socketHandler: ((socket: WebSocketRoute) => Promise<void>) | undefined;
  let currentUrl = 'about:blank';
  const context = {
    pages: () => [{ url: () => currentUrl }],
    serviceWorkers: () => [],
    route: async (pattern: string, handler: typeof routeHandler) => {
      expect(pattern).toBe('**/*');
      routeHandler = handler;
    },
    routeWebSocket: async (pattern: string, handler: typeof socketHandler) => {
      expect(pattern).toBe('**/*');
      socketHandler = handler;
    },
  } as unknown as BrowserContext;
  return {
    context,
    pageUrl: (url: string) => {
      currentUrl = url;
    },
    async dispatch(spec: RequestSpec = {}) {
      let response: Parameters<Route['fulfill']>[0] | undefined;
      let aborted = false;
      const outgoing = request(spec);
      const route = {
        request: () => outgoing,
        fulfill: async (value: typeof response) => {
          response = value;
        },
        abort: async (reason: string) => {
          expect(reason).toBe('blockedbyclient');
          aborted = true;
        },
      } as unknown as Route;
      if (!routeHandler) throw new Error('route is not installed');
      await routeHandler(route);
      // A refused navigation of a person's is answered 204 so the page stays where it was.
      const stayed = response?.status === 204;
      return { response, aborted: aborted || stayed, stayed, request: outgoing };
    },
    async websocket() {
      let closed = false;
      const socket = {
        close: async (options: { code: number; reason: string }) => {
          expect(options.code).toBe(1008);
          expect(options.reason).toContain('denied');
          closed = true;
        },
      } as unknown as WebSocketRoute;
      if (!socketHandler) throw new Error('websocket guard is not installed');
      await socketHandler(socket);
      return closed;
    },
  };
}

const PUBLIC: BrowserNetworkPolicy = { public_compartment: true, allowed_domains: [] };
const OK: BrowserNetworkResponse = {
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: Buffer.from('<form></form>'),
};

function binding(
  body = Buffer.alloc(0),
  url = 'https://public.example/form',
): BrowserCommitBinding {
  return { url, method: 'POST', body_sha256: createHash('sha256').update(body).digest('hex') };
}

async function setup(options: BrowserNetworkOptions = {}, policy = PUBLIC) {
  const browser = browserHarness();
  const calls: Array<{ url: string; method: string; address: string }> = [];
  const egress = createBrowserEgress(policy, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async (url, address, request) => {
      calls.push({ url: url.href, method: request.method, address: address.address });
      return OK;
    },
    ...options,
  });
  await egress.install(browser.context);
  browser.pageUrl('https://public.example/form');
  return { ...browser, egress, calls };
}

test('browser guard checks every DNS answer and refuses mixed public/private answers before dispatch', async () => {
  for (const addresses of [
    [
      { address: '8.8.8.8', family: 4 as const },
      { address: '127.0.0.1', family: 4 as const },
    ],
    [{ address: '8.8.8.8', family: 6 as const }],
    [],
  ]) {
    const fixture = await setup({ resolve: async () => addresses });
    await expect(fixture.egress.run('navigate', () => fixture.dispatch())).rejects.toThrow(
      'non-public',
    );
    expect(fixture.calls).toHaveLength(0);
  }
});

test('browser SSRF guard rejects metadata, encoded loopback, private IPv6, credentials and schemes', async () => {
  const fixture = await setup();
  for (const url of [
    'http://169.254.169.254/latest/meta-data',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fc00::1]/',
    'file:///etc/passwd',
    'ftp://public.example/',
    'https://name:secret@public.example/',
  ]) {
    await expect(fixture.egress.run('navigate', () => fixture.dispatch({ url }))).rejects.toThrow();
  }
  expect(fixture.calls).toHaveLength(0);
});

test('private context allows exact trusted domains and copies policy before page input can mutate it', async () => {
  const policy = { public_compartment: false, allowed_domains: ['PUBLIC.EXAMPLE.'] };
  const fixture = await setup({}, policy);
  policy.public_compartment = true;
  policy.allowed_domains.push('evil.example');
  for (const url of ['https://public.example.evil.test/', 'https://evil.example/']) {
    await expect(fixture.egress.run('navigate', () => fixture.dispatch({ url }))).rejects.toThrow(
      'private-context',
    );
  }
  expect(fixture.calls).toHaveLength(0);
  expect((await fixture.egress.run('navigate', () => fixture.dispatch())).aborted).toBe(false);
  expect(fixture.calls).toHaveLength(1);
});

test('the fixture injection allows only its exact literal loopback origin and does not bypass compartment policy', async () => {
  const fixture = await setup({ fixtureOrigins: ['http://127.0.0.1:3130'] });
  const allowed = await fixture.egress.run('navigate', () =>
    fixture.dispatch({ url: 'http://127.0.0.1:3130/form' }),
  );
  expect(allowed.aborted).toBe(false);
  expect(fixture.calls[0]?.address).toBe('127.0.0.1');
  await expect(
    fixture.egress.run('navigate', () => fixture.dispatch({ url: 'http://127.0.0.1:3132/form' })),
  ).rejects.toThrow('non-public');
  expect(fixture.calls).toHaveLength(1);
  const privateFixture = await setup(
    { fixtureOrigins: ['http://127.0.0.1:3130'] },
    { public_compartment: false, allowed_domains: ['public.example'] },
  );
  await expect(
    privateFixture.egress.run('navigate', () =>
      privateFixture.dispatch({ url: 'http://127.0.0.1:3130/form' }),
    ),
  ).rejects.toThrow('private-context');
  expect(privateFixture.calls).toHaveLength(0);
  for (const origin of [
    'https://public.example',
    'http://localhost:3130',
    'http://127.0.0.1:3130/path',
  ]) {
    expect(() => createBrowserEgress(PUBLIC, { fixtureOrigins: [origin] })).toThrow(
      'literal loopback',
    );
  }
});

test('navigate admits checked GET/HEAD reads and refuses every mutation without transport', async () => {
  const fixture = await setup();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT']) {
    await expect(
      fixture.egress.run('navigate', () => fixture.dispatch({ method })),
    ).rejects.toThrow('approved submit');
  }
  expect(fixture.calls).toHaveLength(0);
  await fixture.egress.run('navigate', () =>
    fixture.dispatch({ method: 'GET', resourceType: 'image' }),
  );
  await fixture.egress.run('navigate', () => fixture.dispatch({ method: 'HEAD' }));
  expect(fixture.calls.map((call) => call.method)).toEqual(['GET', 'HEAD']);
});

test('reversible input refuses GET and POST even if the page swallows the network error', async () => {
  const fixture = await setup();
  for (const method of ['GET', 'POST']) {
    await expect(
      fixture.egress.run('reversible', async () => {
        expect((await fixture.dispatch({ method })).aborted).toBe(true);
        return 'page claims success';
      }),
    ).rejects.toThrow('reversible browser input');
  }
  expect(fixture.calls).toHaveLength(0);
});

test('a delayed request outside the operation window is refused and cannot inherit approval', async () => {
  const fixture = await setup();
  await fixture.egress.run('commit', () => fixture.dispatch({ method: 'POST' }), binding());
  for (const method of ['GET', 'POST']) {
    expect((await fixture.dispatch({ method })).aborted).toBe(true);
  }
  expect(fixture.calls).toHaveLength(1);
});

test('an approved commit admits one mutation and rejects a racing second mutation in the controller network gate', async () => {
  const fixture = await setup();
  await expect(
    fixture.egress.run(
      'commit',
      () =>
        Promise.all([
          fixture.dispatch({ method: 'POST', resourceType: 'fetch' }),
          fixture.dispatch({ method: 'POST', resourceType: 'fetch' }),
        ]),
      binding(),
    ),
  ).rejects.toThrow('at most one mutation');
  expect(fixture.calls.length).toBeLessThanOrEqual(1);
  const single = await setup();
  await single.egress.run('commit', () => single.dispatch({ method: 'POST' }), binding());
  expect(single.calls).toHaveLength(1);
});

test('a checked POST redirect signals a fresh controller read and does not reuse the commit window', async () => {
  const calls: string[] = [];
  const fixture = await setup({
    transport: async (url, _address, request) => {
      calls.push(url.href);
      return request.method === 'POST'
        ? { status: 303, headers: { location: '/receipt' }, body: Buffer.alloc(0) }
        : OK;
    },
  });
  let redirect: BrowserRedirect | undefined;
  try {
    await fixture.egress.run(
      'commit',
      async () => {
        const result = await fixture.dispatch({ method: 'POST' });
        expect(result.response?.status).toBe(303);
        expect(result.aborted).toBe(false);
      },
      binding(),
    );
  } catch (error) {
    if (!(error instanceof BrowserRedirect)) throw error;
    redirect = error;
  }
  expect(redirect?.target_url).toBe('https://public.example/receipt');
  expect(redirect?.after_commit).toBe(true);
  expect(redirect?.status).toBe(303);
  expect(calls).toHaveLength(1);
  await fixture.egress.run('navigate', () => fixture.dispatch({ url: redirect?.target_url }));
  expect(calls).toHaveLength(2);
  await expect(
    fixture.egress.run(
      'commit',
      () => fixture.dispatch({ url: 'https://other.example/submit', method: 'POST' }),
      binding(),
    ),
  ).rejects.toThrow('current page origin');
  await expect(
    fixture.egress.run('commit', () => fixture.dispatch({ resourceType: 'fetch' }), binding()),
  ).rejects.toThrow('fresh controller navigation');
  await expect(
    fixture.egress.run(
      'commit',
      () => fixture.dispatch({ url: 'https://public.example/unrelated' }),
      binding(),
    ),
  ).rejects.toThrow('fresh controller navigation');
  expect(calls).toHaveLength(2);
});

test('a checked read redirect preserves the original response and cookies without following it inside the relay', async () => {
  let dispatches = 0;
  const fixture = await setup({
    transport: async () => {
      dispatches += 1;
      return {
        status: 302,
        headers: { location: '/next', 'set-cookie': ['session=kept; Path=/'] },
        body: Buffer.from('redirect body'),
      };
    },
  });
  await expect(
    fixture.egress.run('navigate', async () => {
      const result = await fixture.dispatch();
      expect(result.response?.status).toBe(302);
      expect(result.response?.headers?.['set-cookie']).toBe('session=kept; Path=/');
      expect(result.response?.body).toEqual(Buffer.from('redirect body'));
    }),
  ).rejects.toMatchObject({
    target_url: 'https://public.example/next',
    status: 302,
    after_commit: false,
  });
  expect(dispatches).toBe(1);
});

test('subresource redirects fail by name without relocating the main page', async () => {
  const fixture = await setup({
    transport: async () => ({ status: 302, headers: { location: '/next' }, body: Buffer.alloc(0) }),
  });
  await expect(
    fixture.egress.run('navigate', () => fixture.dispatch({ resourceType: 'image' })),
  ).rejects.toMatchObject({ code: 'subresource_redirect_unsupported' });
});

test('a commit without an approved binding refuses before input and changed body, endpoint or method never dispatches', async () => {
  const fixture = await setup();
  let input = false;
  await expect(
    fixture.egress.run('commit', async () => {
      input = true;
    }),
  ).rejects.toThrow('bound POST payload');
  expect(input).toBe(false);
  const approved = binding(Buffer.from('name=Approved'));
  for (const spec of [
    { method: 'POST', body: Buffer.from('name=Changed') },
    { method: 'POST', url: 'https://public.example/other', body: Buffer.from('name=Approved') },
    { method: 'PUT', body: Buffer.from('name=Approved') },
    {
      method: 'POST',
      body: Buffer.from('name=Approved'),
      headers: { 'content-type': 'application/json' },
    },
  ]) {
    await expect(
      fixture.egress.run('commit', () => fixture.dispatch(spec), approved),
    ).rejects.toThrow('approved payload');
  }
  expect(fixture.calls).toHaveLength(0);
});

test('a redirect to a private address or untrusted domain is refused before Location reaches Chromium', async () => {
  for (const target of ['http://169.254.169.254/private', 'https://evil.example/private']) {
    let calls = 0;
    const fixture = await setup(
      {
        transport: async () => {
          calls += 1;
          return { status: 302, headers: { location: target }, body: Buffer.alloc(0) };
        },
      },
      { public_compartment: false, allowed_domains: ['public.example', '169.254.169.254'] },
    );
    await expect(fixture.egress.run('navigate', () => fixture.dispatch())).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test('redirects recheck DNS and never forward a changed private answer', async () => {
  let resolutions = 0;
  let dispatches = 0;
  const fixture = await setup({
    resolve: async () => [{ address: ++resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }],
    transport: async () => {
      dispatches += 1;
      return { status: 302, headers: { location: '/changed' }, body: Buffer.alloc(0) };
    },
  });
  await expect(fixture.egress.run('navigate', () => fixture.dispatch())).rejects.toThrow(
    'non-public',
  );
  expect(resolutions).toBe(2);
  expect(dispatches).toBe(1);
});

test('a redirect cannot replay an approved POST or leave its approved origin', async () => {
  for (const response of [
    { status: 307, headers: { location: '/again' }, body: Buffer.alloc(0) },
    { status: 308, headers: { location: '/again' }, body: Buffer.alloc(0) },
    { status: 303, headers: { location: 'https://other.example/done' }, body: Buffer.alloc(0) },
  ]) {
    let calls = 0;
    const fixture = await setup({
      transport: async () => {
        calls += 1;
        return response;
      },
    });
    await expect(
      fixture.egress.run('commit', () => fixture.dispatch({ method: 'POST' }), binding()),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test('every redirect hop and subresource is checked and bounded', async () => {
  const fixture = await setup({ maxRedirects: 1 });
  await fixture.egress.run('navigate', async () => {
    const first = await fixture.dispatch();
    const second = await fixture.dispatch({
      url: 'https://public.example/next',
      previous: first.request,
    });
    expect(second.aborted).toBe(false);
  });
  await expect(
    fixture.egress.run('navigate', () =>
      fixture.dispatch({
        previous: request({ previous: request({}) }),
      }),
    ),
  ).rejects.toThrow('redirect limit');
  await expect(
    fixture.egress.run('navigate', () =>
      fixture.dispatch({
        url: 'http://127.0.0.1/image.png',
        resourceType: 'image',
      }),
    ),
  ).rejects.toThrow('non-public');
  expect(fixture.calls).toHaveLength(2);
});

test('WebSockets are closed without a connection in every operation mode and while idle', async () => {
  const fixture = await setup();
  for (const mode of ['navigate', 'reversible', 'commit'] as const) {
    await expect(fixture.egress.run(mode, () => fixture.websocket(), binding())).rejects.toThrow(
      'WebSockets are denied',
    );
  }
  expect(await fixture.websocket()).toBe(true);
  expect(fixture.calls).toHaveLength(0);
});

test('request count and body limits refuse additional dispatches', async () => {
  const fixture = await setup({ maxRequests: 1, maxRequestBytes: 4 });
  await expect(
    fixture.egress.run('navigate', async () => {
      await fixture.dispatch();
      await fixture.dispatch({ resourceType: 'image' });
    }),
  ).rejects.toThrow('request limit');
  expect(fixture.calls).toHaveLength(1);
  await expect(
    fixture.egress.run(
      'commit',
      () => fixture.dispatch({ method: 'POST', body: Buffer.alloc(5) }),
      binding(),
    ),
  ).rejects.toThrow('request exceeds');
  expect(fixture.calls).toHaveLength(1);
});

test('oversized responses and header injection are rejected before fulfillment', async () => {
  const responses: BrowserNetworkResponse[] = [
    { status: 200, headers: {}, body: Buffer.alloc(101) },
    {
      status: 200,
      headers: { location: 'https://public.example/\r\nX-Bad: yes' },
      body: Buffer.alloc(0),
    },
    { status: 302, headers: { location: ['/one', '/two'] }, body: Buffer.alloc(0) },
  ];
  for (const response of responses) {
    const fixture = await setup({ maxBytes: 100, transport: async () => response });
    await expect(fixture.egress.run('navigate', () => fixture.dispatch())).rejects.toThrow();
  }
});

test('relay keeps response bytes and cookies while stripping connection-controlled and routing headers', async () => {
  const body = gzipSync(Buffer.from('binary \u0000 content'));
  const fixture = await setup({
    transport: async (_url, address, request) => {
      expect(address.address).toBe('8.8.8.8');
      expect(request.headers.host).toBeUndefined();
      expect(request.headers['proxy-authorization']).toBeUndefined();
      expect(request.headers.cookie).toBe('session=kept');
      return {
        status: 200,
        headers: {
          'content-encoding': 'gzip',
          'content-length': '999',
          connection: 'X-Hop',
          'x-hop': 'remove',
          'alt-svc': 'h3=":443"',
          'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly; Path=/'],
        },
        body,
      };
    },
  });
  const result = await fixture.egress.run('navigate', () =>
    fixture.dispatch({
      headers: {
        host: '127.0.0.1',
        'proxy-authorization': 'secret',
        cookie: 'session=kept',
      },
    }),
  );
  expect(result.response?.body).toEqual(body);
  expect(result.response?.headers?.['content-encoding']).toBe('gzip');
  expect(result.response?.headers?.['set-cookie']).toBe('a=1; Path=/\nb=2; HttpOnly; Path=/');
  for (const header of ['connection', 'x-hop', 'content-length', 'alt-svc']) {
    expect(result.response?.headers?.[header]).toBeUndefined();
  }
});

test('DNS waits are bounded and do not retain a later operation approval', async () => {
  const fixture = await setup({ timeoutMs: 15, resolve: () => new Promise(() => {}) });
  await expect(fixture.egress.run('navigate', () => fixture.dispatch())).rejects.toThrow(
    'timed out',
  );
  expect(fixture.calls).toHaveLength(0);
});

test('an operation ending during DNS refuses the request before it reaches transport', async () => {
  let finishDns: ((addresses: Array<{ address: string; family: 4 }>) => void) | undefined;
  let enteredDns: () => void = () => {};
  const resolving = new Promise<void>((resolve) => {
    enteredDns = resolve;
  });
  const fixture = await setup({
    resolve: () =>
      new Promise((resolve) => {
        finishDns = resolve;
        enteredDns();
      }),
  });
  const run = fixture.egress.run('navigate', async () => {
    void fixture.dispatch();
    await resolving;
  });
  const rejected = run.then(
    () => undefined,
    (error: unknown) => error,
  );
  await resolving;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  finishDns?.([{ address: '8.8.8.8', family: 4 }]);
  expect(await rejected).toMatchObject({ code: 'network_idle' });
  expect(fixture.calls).toHaveLength(0);
});

test('closing the guard leaves a denying route installed and prevents future windows', async () => {
  const fixture = await setup();
  await fixture.egress.close();
  expect((await fixture.dispatch()).aborted).toBe(true);
  await expect(fixture.egress.run('navigate', () => fixture.dispatch())).rejects.toThrow(
    'not available',
  );
  expect(fixture.calls).toHaveLength(0);
});

test('takeover during DNS is checked immediately before transport and refuses the queued POST', async () => {
  let finishDns: ((addresses: Array<{ address: string; family: 4 }>) => void) | undefined;
  let enteredDns: () => void = () => {};
  const resolving = new Promise<void>((resolve) => {
    enteredDns = resolve;
  });
  const fixture = await setup({
    resolve: () =>
      new Promise((resolve) => {
        finishDns = resolve;
        enteredDns();
      }),
  });
  let takenOver = false;
  const result = fixture.egress
    .run(
      'commit',
      () => fixture.dispatch({ method: 'POST' }),
      binding(),
      () => {
        if (takenOver) throw new Error('stale_control_epoch');
      },
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await resolving;
  takenOver = true;
  finishDns?.([{ address: '8.8.8.8', family: 4 }]);
  expect(await result).toMatchObject({ message: 'stale_control_epoch' });
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.egress.commitDispatched).toBe(false);
});

test('commit dispatch evidence survives follow-up read failures and resets only for the next commit', async () => {
  const fixture = await setup();
  await fixture.egress.run('commit', () => fixture.dispatch({ method: 'POST' }), binding());
  expect(fixture.egress.commitDispatched).toBe(true);
  await expect(
    fixture.egress.run('navigate', () => fixture.dispatch({ url: 'http://169.254.169.254/' })),
  ).rejects.toThrow('non-public');
  expect(fixture.egress.commitDispatched).toBe(true);
  await expect(
    fixture.egress.run(
      'commit',
      () => fixture.dispatch({ method: 'POST', body: Buffer.from('changed') }),
      binding(),
    ),
  ).rejects.toThrow('approved payload');
  expect(fixture.egress.commitDispatched).toBe(false);
});

test('a lost response after POST dispatch preserves unknown-outcome evidence', async () => {
  const fixture = await setup({
    transport: async () => {
      throw new Error('connection lost after write');
    },
  });
  await expect(
    fixture.egress.run('commit', () => fixture.dispatch({ method: 'POST' }), binding()),
  ).rejects.toThrow('connection lost after write');
  expect(fixture.egress.commitDispatched).toBe(true);
});

test('real Node relay pins the destination while retaining Host, query, request bytes and response bytes', async () => {
  const bytes = gzipSync(Buffer.from([0, 1, 2, 128, 255]));
  const seen: { host?: string; url?: string; body?: Buffer } = {};
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      seen.host = incoming.headers.host;
      seen.url = incoming.url;
      seen.body = Buffer.concat(chunks);
      response.writeHead(200, { 'content-encoding': 'gzip', 'set-cookie': ['one=1', 'two=2'] });
      response.end(bytes);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const response = await pinnedBrowserRequest(
      new URL(`http://does-not-resolve.invalid:${address.port}/send?keep=1`),
      { address: '127.0.0.1', family: 4 },
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([0, 255]),
        signal: new AbortController().signal,
        maxBytes: 1024,
        maxHeaderBytes: 4096,
        timeoutMs: 1000,
      },
    );
    expect(seen.host).toBe(`does-not-resolve.invalid:${address.port}`);
    expect(seen.url).toBe('/send?keep=1');
    expect(seen.body).toEqual(Buffer.from([0, 255]));
    expect(response.body).toEqual(bytes);
    expect(response.headers['set-cookie']).toEqual(['one=1', 'two=2']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function humanWindow(allowed: string[], page: string, scopeLimit?: number) {
  const notices: Array<{ code: LiveNoticeCode; host?: string }> = [];
  const scope = new LiveSiteScope(allowed, page, scopeLimit);
  // The person has just pressed something, which is what lets a page lead them to a new site.
  scope.acted();
  return {
    notices,
    window: {
      scope,
      budget: new LiveNetworkBudget(),
      redirectHops: 20,
      notice: (code: LiveNoticeCode, host?: string) => {
        notices.push(host === undefined ? { code } : { code, host });
      },
    },
  };
}

const PAGE = 'https://public.example/signin';

const PRIVATE: BrowserNetworkPolicy = {
  public_compartment: false,
  allowed_domains: ['public.example'],
};

test('human mode admits the identity-provider redirect as a checked navigation and refuses off-scope requests', async () => {
  const seen: string[] = [];
  const authorize =
    'https://login.idp-example.net/authorize?return=https%3A%2F%2Fpublic.example%2Faccount&x=1';
  const fixture = await setup(
    {
      transport: async (url, _address, outgoing) => {
        seen.push(`${outgoing.method} ${url.href}`);
        if (url.pathname === '/signin')
          return {
            status: 302,
            headers: { location: authorize, 'set-cookie': ['signin=1; Path=/', 'b=2; HttpOnly'] },
            body: Buffer.alloc(0),
          };
        if (url.hostname === 'login.idp-example.net')
          return {
            status: 303,
            headers: { location: 'https://public.example/account' },
            body: Buffer.alloc(0),
          };
        return OK;
      },
    },
    PRIVATE,
  );
  const { window, notices } = humanWindow(['public.example'], 'https://public.example/signin');
  const results = await fixture.egress.run(
    'human',
    async () => ({
      signin: await fixture.dispatch({
        url: 'https://public.example/signin',
        method: 'POST',
        body: Buffer.from('password=typed-by-the-person'),
        from: 'https://public.example/signin',
      }),
      idp: await fixture.dispatch({ url: authorize, from: 'https://public.example/signin' }),
      account: await fixture.dispatch({ url: 'https://public.example/account', from: authorize }),
      pixel: await fixture.dispatch({
        url: 'https://tracker.example.org/pixel.gif',
        resourceType: 'image',
      }),
      beacon: await fixture.dispatch({
        url: 'https://tracker.example.org/beacon',
        method: 'POST',
        resourceType: 'fetch',
        body: Buffer.from('leak'),
      }),
      typed: await fixture.dispatch({
        url: 'https://evil.example.org/',
        from: 'chrome-error://chromewebdata/',
      }),
    }),
    undefined,
    undefined,
    window,
  );
  expect(seen).toEqual([
    'POST https://public.example/signin',
    `GET ${authorize}`,
    'GET https://public.example/account',
  ]);
  expect(results.signin.response?.status).toBe(200);
  expect(results.signin.response?.headers).toMatchObject({
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'set-cookie': 'signin=1; Path=/\nb=2; HttpOnly',
  });
  expect(String(results.signin.response?.body)).toBe(
    '<!doctype html><meta http-equiv="refresh" content="0;url=https://login.idp-example.net/authorize?return=https%3A%2F%2Fpublic.example%2Faccount&#38;x=1">',
  );
  expect(String(results.idp.response?.body)).toContain('url=https://public.example/account');
  expect(results.account.response?.status).toBe(200);
  for (const refused of [results.pixel, results.beacon, results.typed])
    expect(refused.aborted).toBe(true);
  expect(notices).toEqual([
    { code: 'off_scope', host: 'tracker.example.org' },
    { code: 'off_scope', host: 'tracker.example.org' },
    { code: 'off_scope', host: 'evil.example.org' },
  ]);
  expect(window.scope.list()).toEqual(['public.example', 'idp-example.net']);
});

test('a popup started by an in-scope page may leave the site; one started elsewhere may not', async () => {
  const fixture = await setup({}, PRIVATE);
  const { window, notices } = humanWindow(['public.example'], 'https://public.example/signin');
  const [popup, stray] = await fixture.egress.run(
    'human',
    async () => [
      await fixture.dispatch({
        url: 'https://accounts.provider-example.com/start',
        from: 'about:blank',
        opener: 'https://public.example/signin',
      }),
      await fixture.dispatch({ url: 'https://stray.example/start', from: 'about:blank' }),
    ],
    undefined,
    undefined,
    window,
  );
  expect(popup?.aborted).toBe(false);
  expect(stray?.aborted).toBe(true);
  expect(notices).toEqual([{ code: 'off_scope', host: 'stray.example' }]);
  expect(fixture.calls.map((call) => call.url)).toEqual([
    'https://accounts.provider-example.com/start',
  ]);
});

test('human mode keeps the address floor and refuses downloads, replayed mutations and WebSockets without ending the window', async () => {
  const fixture = await setup(
    {
      resolve: async (name) => [
        { address: name === 'intranet.public.example' ? '10.0.0.5' : '8.8.8.8', family: 4 },
      ],
      transport: async (url) => {
        if (url.pathname === '/report.pdf')
          return {
            status: 200,
            headers: { 'content-disposition': 'attachment; filename="report.pdf"' },
            body: Buffer.from('%PDF'),
          };
        if (url.pathname === '/replay')
          return { status: 307, headers: { location: '/again' }, body: Buffer.alloc(0) };
        if (url.pathname === '/image-hop')
          return { status: 302, headers: { location: '/image.png' }, body: Buffer.alloc(0) };
        if (url.pathname === '/app-hop')
          return {
            status: 302,
            headers: { location: 'app-scheme://callback?code=1' },
            body: Buffer.alloc(0),
          };
        return OK;
      },
    },
    PRIVATE,
  );
  const { window, notices } = humanWindow(['public.example'], 'https://public.example/signin');
  const from = 'https://public.example/signin';
  const results = await fixture.egress.run(
    'human',
    async () => [
      await fixture.dispatch({ url: 'https://intranet.public.example/', from }),
      await fixture.dispatch({ url: 'https://public.example/report.pdf', from }),
      await fixture.dispatch({ url: 'https://public.example/replay', method: 'POST', from }),
      await fixture.dispatch({
        url: 'https://public.example/image-hop',
        resourceType: 'image',
        top: from,
      }),
      await fixture.dispatch({ url: 'https://public.example/app-hop', from }),
      await fixture.websocket(),
      await fixture.dispatch({ url: 'https://public.example/still-open', from }),
    ],
    undefined,
    undefined,
    window,
  );
  expect(results.slice(0, 5).map((result) => (result as { aborted: boolean }).aborted)).toEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(results[5]).toBe(true);
  expect((results[6] as { aborted: boolean }).aborted).toBe(false);
  expect(notices).toEqual([
    { code: 'download_refused' },
    { code: 'redirect_refused' },
    { code: 'redirect_refused' },
    { code: 'redirect_refused' },
    { code: 'websocket_refused' },
  ]);
  expect(fixture.calls.map((call) => call.url)).not.toContain('https://intranet.public.example/');
});

test('human mode stops at the takeover budget while automation stays fenced', async () => {
  const fixture = await setup({}, PRIVATE);
  const { window, notices } = humanWindow(['public.example'], 'https://public.example/');
  await expect(
    fixture.egress.run('human', async () => {}, undefined, undefined, undefined),
  ).rejects.toMatchObject({ code: 'invalid_mode' });
  await expect(
    fixture.egress.run('navigate', async () => {}, undefined, undefined, window),
  ).rejects.toMatchObject({ code: 'invalid_mode' });
  let controlChanged = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  expect(fixture.egress.idle).toBe(true);
  const person = fixture.egress.run(
    'human',
    () => held,
    undefined,
    () => {
      if (controlChanged) throw new Error('epoch_changed');
    },
    window,
  );
  expect(fixture.egress.idle).toBe(false);
  await expect(fixture.egress.run('navigate', () => fixture.dispatch())).rejects.toMatchObject({
    code: 'network_busy',
  });
  window.budget.requests = 1999;
  expect((await fixture.dispatch({ url: 'https://public.example/a', top: PAGE })).aborted).toBe(
    false,
  );
  expect((await fixture.dispatch({ url: 'https://public.example/b', top: PAGE })).aborted).toBe(
    true,
  );
  window.budget.requests = 0;
  window.budget.bytes = 32 * 1024 * 1024 - OK.body.length + 1;
  expect((await fixture.dispatch({ url: 'https://public.example/c', top: PAGE })).aborted).toBe(
    true,
  );
  window.budget.bytes = 0;
  controlChanged = true;
  expect((await fixture.dispatch({ url: 'https://public.example/d', top: PAGE })).aborted).toBe(
    true,
  );
  release();
  await person;
  expect(fixture.egress.idle).toBe(true);
  expect(notices).toEqual([{ code: 'live_budget' }, { code: 'live_budget' }]);
  expect(fixture.calls.map((call) => call.url)).toEqual([
    'https://public.example/a',
    'https://public.example/c',
  ]);
  expect((await fixture.dispatch({ url: 'https://public.example/e', top: PAGE })).aborted).toBe(
    true,
  );
});

test("human mode loads an in-scope page's scripts, images and frames from any public site and keeps navigation scoped", async () => {
  const fixture = await setup({}, PRIVATE);
  const { window, notices } = humanWindow(['public.example'], PAGE, 1);
  const results = await fixture.egress.run(
    'human',
    async () => [
      await fixture.dispatch({
        url: 'https://static.cdn-example.net/app.js',
        resourceType: 'script',
        top: PAGE,
      }),
      await fixture.dispatch({
        url: 'https://images.other-example.com/logo.png',
        resourceType: 'image',
        top: PAGE,
      }),
      await fixture.dispatch({
        url: 'https://challenge.captcha-example.com/frame',
        subframe: true,
        top: PAGE,
      }),
      await fixture.dispatch({ url: 'https://elsewhere.example/', from: PAGE }),
      await fixture.dispatch({
        url: 'https://evil.example.org/next.js',
        resourceType: 'script',
        top: 'https://evil.example.org/',
      }),
    ],
    undefined,
    undefined,
    window,
  );
  expect(results.map((result) => result.aborted)).toEqual([false, false, false, true, true]);
  expect(results.map((result) => result.stayed)).toEqual([false, false, false, true, false]);
  expect(fixture.calls.map((call) => call.url)).toEqual([
    'https://static.cdn-example.net/app.js',
    'https://images.other-example.com/logo.png',
    'https://challenge.captcha-example.com/frame',
  ]);
  expect(notices).toEqual([
    { code: 'off_scope', host: 'elsewhere.example' },
    { code: 'off_scope', host: 'evil.example.org' },
  ]);
  expect(window.scope.list()).toEqual(['public.example']);
});

test("human mode refuses a private address even for an in-scope page's resource", async () => {
  const fixture = await setup(
    {
      resolve: async (name) => [
        { address: name === 'static.public.example' ? '192.168.1.20' : '8.8.8.8', family: 4 },
      ],
    },
    PRIVATE,
  );
  const { window } = humanWindow(['public.example'], PAGE);
  const [image, frame] = await fixture.egress.run(
    'human',
    async () => [
      await fixture.dispatch({
        url: 'https://static.public.example/logo.png',
        resourceType: 'image',
        top: PAGE,
      }),
      await fixture.dispatch({ url: 'http://169.254.169.254/latest', subframe: true, top: PAGE }),
    ],
    undefined,
    undefined,
    window,
  );
  expect([image?.aborted, frame?.aborted]).toEqual([true, true]);
  expect(fixture.calls).toHaveLength(0);
});

test('a redirect chain in human mode stops after twenty hops', async () => {
  let transported = 0;
  const fixture = await setup(
    {
      transport: async (url) => {
        transported++;
        const next = Number(url.searchParams.get('n')) + 1;
        return { status: 302, headers: { location: `/loop?n=${next}` }, body: Buffer.alloc(0) };
      },
    },
    PRIVATE,
  );
  const { window, notices } = humanWindow(['public.example'], PAGE);
  const served = await fixture.egress.run(
    'human',
    async () => {
      let from = PAGE;
      for (let n = 0; n < 30; n++) {
        const url = `https://public.example/loop?n=${n}`;
        const result = await fixture.dispatch({ url, from });
        if (result.aborted) return n;
        expect(String(result.response?.body)).toContain(
          `url=https://public.example/loop?n=${n + 1}`,
        );
        from = url;
      }
      return 30;
    },
    undefined,
    undefined,
    window,
  );
  expect(served).toBe(20);
  expect(transported).toBe(21);
  expect(notices).toEqual([{ code: 'redirect_refused' }]);
});

test("the persistent profile sends no cookie on a cross-site request while the page's own requests keep theirs", async () => {
  const cookies: Record<string, string | undefined> = {};
  const cookieTransport = {
    transport: async (
      url: URL,
      _address: unknown,
      outgoing: { headers: Record<string, string> },
    ) => {
      cookies[url.href] = outgoing.headers.cookie;
      return { status: 200, headers: { 'set-cookie': 'seen=1; Path=/' }, body: Buffer.alloc(0) };
    },
  } as BrowserNetworkOptions;
  const withCookie = { cookie: 'session=signed-in' };
  const policy = {
    public_compartment: false,
    allowed_domains: ['public.example', 'other.example'],
  };
  const persistent = await setup(cookieTransport, policy);
  const [navigation, sameSite, crossSite] = await persistent.egress.run('navigate', async () => [
    await persistent.dispatch({
      url: 'https://other.example/start',
      from: PAGE,
      headers: withCookie,
    }),
    await persistent.dispatch({
      url: 'https://public.example/avatar.png',
      resourceType: 'image',
      top: PAGE,
      headers: withCookie,
    }),
    await persistent.dispatch({
      url: 'https://other.example/avatar.png',
      resourceType: 'image',
      top: PAGE,
      headers: withCookie,
    }),
  ]);
  expect(cookies).toEqual({
    'https://other.example/start': 'session=signed-in',
    'https://public.example/avatar.png': 'session=signed-in',
    'https://other.example/avatar.png': undefined,
  });
  expect(navigation?.response?.headers?.['set-cookie']).toBe('seen=1; Path=/');
  expect(sameSite?.response?.headers?.['set-cookie']).toBe('seen=1; Path=/');
  expect(crossSite?.response?.headers?.['set-cookie']).toBeUndefined();

  const { window } = humanWindow(['public.example'], PAGE);
  const person = await setup(cookieTransport, PRIVATE);
  await person.egress.run(
    'human',
    () =>
      person.dispatch({
        url: 'https://widgets.example.net/frame',
        subframe: true,
        top: PAGE,
        headers: withCookie,
      }),
    undefined,
    undefined,
    window,
  );
  expect(cookies['https://widgets.example.net/frame']).toBeUndefined();

  const research = await setup(cookieTransport, PUBLIC);
  await research.egress.run('navigate', () =>
    research.dispatch({
      url: 'https://third.example/pixel.gif',
      resourceType: 'image',
      top: PAGE,
      headers: withCookie,
    }),
  );
  expect(cookies['https://third.example/pixel.gif']).toBe('session=signed-in');
});
