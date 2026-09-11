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

type RequestSpec = {
  url?: string;
  method?: string;
  resourceType?: string;
  body?: Buffer;
  headers?: Record<string, string>;
  previous?: Request;
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
      return { response, aborted, request: outgoing };
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
