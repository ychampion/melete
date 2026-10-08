import { afterAll, describe, expect, test } from 'bun:test';
import { selfSignedPair } from '../gateway/fixtures/self-signed.ts';
import { ConnectorFaultError } from './faults.ts';
import { openHttpMcpTransport } from './mcp-transport.ts';
import {
  asFetch,
  isReachableEndpoint,
  metadataAllowed,
  outOfReach,
  pinnedRequest,
  publicOnlyFetch,
  reachAddresses,
  reachFetch,
  reachTransport,
  UNREACHABLE,
} from './public-fetch.ts';
import { isMetadataAddress, isPublicAddress, type ResolvedAddress } from './web.ts';

const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 };

/** Records where each request would have gone, and sends nothing. */
function recorder() {
  const sent: { url: string; address: string }[] = [];
  return {
    sent,
    request: async (url: URL, address: ResolvedAddress) => {
      sent.push({ url: url.href, address: address.address });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  };
}

const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof ConnectorFaultError ? error.fault : error),
  );

let hits = 0;
const local = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    hits += 1;
    return Response.json({
      host: request.headers.get('host'),
      method: request.method,
      body: await request.text(),
    });
  },
});
afterAll(() => local.stop(true));

describe('a public-only fetch', () => {
  test('refuses private, loopback, link-local and mapped addresses before sending anything', async () => {
    const { sent, request } = recorder();
    const fetch = publicOnlyFetch({ resolve: async () => [PUBLIC], request });
    for (const url of [
      'http://127.0.0.1:3112/mcp',
      'http://10.0.0.8/mcp',
      'http://192.168.1.4/mcp',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/mcp',
      'http://[::ffff:127.0.0.1]/mcp',
      'http://[fd00::1]/mcp',
      'http://user:pass@93.184.216.34/mcp',
      'ftp://93.184.216.34/mcp',
    ]) {
      expect(await refused(fetch(url, { method: 'POST' }))).toMatchObject({
        kind: 'unsupported_route',
        may_have_committed: false,
      });
    }
    expect(sent).toEqual([]);
  });

  test('refuses a name when any answer is private, or when it does not resolve', async () => {
    const { sent, request } = recorder();
    const mixed = publicOnlyFetch({
      resolve: async () => [PUBLIC, { address: '10.1.2.3', family: 4 }],
      request,
    });
    expect(await refused(mixed('https://mcp.example.test/mcp', {}))).toMatchObject({
      kind: 'unsupported_route',
    });
    const missing = publicOnlyFetch({
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
      request,
    });
    expect(await refused(missing('https://mcp.example.test/mcp', {}))).toMatchObject({
      kind: 'unsupported_route',
    });
    expect(sent).toEqual([]);
  });

  test('resolves again on every request, so a name that turns private reaches nothing', async () => {
    const { sent, request } = recorder();
    const answers: ResolvedAddress[][] = [[PUBLIC], [{ address: '127.0.0.1', family: 4 }]];
    const fetch = publicOnlyFetch({ resolve: async () => answers.shift() ?? [], request });
    await fetch('https://mcp.example.test/mcp', { method: 'POST' });
    expect(await refused(fetch('https://mcp.example.test/mcp', { method: 'POST' }))).toMatchObject({
      kind: 'unsupported_route',
    });
    // The one request that went out went to the address that was checked.
    expect(sent).toEqual([{ url: 'https://mcp.example.test/mcp', address: PUBLIC.address }]);
  });

  test('connects to the checked address and never resolves the name itself', async () => {
    // The name does not exist anywhere; only the pin can have delivered this.
    const url = new URL(`http://mcp.unresolvable.invalid:${local.port}/mcp`);
    const response = await pinnedRequest(
      url,
      { address: '127.0.0.1', family: 4 },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      host: `mcp.unresolvable.invalid:${local.port}`,
      method: 'POST',
      body: '{"a":1}',
    });
  });

  test('carries an MCP exchange, event stream included, over the pinned request', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const message = (await request.json()) as { id: number };
        const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } });
        return new Response(`event: message\ndata: ${reply}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    try {
      const transport = openHttpMcpTransport(
        { transport: 'http', url: `http://mcp.unresolvable.invalid:${server.port}/mcp` },
        {
          fetch: (url, init) =>
            pinnedRequest(new URL(url), { address: '127.0.0.1', family: 4 }, init),
        },
      );
      expect(await transport.request('initialize', {})).toEqual({ ok: true });
      await transport.close();
    } finally {
      server.stop(true);
    }
  });

  test('keeps an MCP server on this machine out of reach of a public-only transport', async () => {
    const before = hits;
    const transport = openHttpMcpTransport(
      { transport: 'http', url: `${local.url}mcp` },
      { fetch: publicOnlyFetch() },
    );
    expect(await refused(transport.request('initialize', {}))).toMatchObject({
      kind: 'unsupported_route',
    });
    await transport.close();
    expect(hits).toBe(before);
  });
});

/** Names the reach tests use, so nothing is looked up outside the process. */
const NAMES: Record<string, ResolvedAddress[]> = {
  'public.example.test': [PUBLIC],
  'inside.example.test': [{ address: '10.0.0.7', family: 4 }],
  'loopback.example.test': [
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ],
  'metadata.example.test': [{ address: '169.254.169.254', family: 4 }],
  'mapped.example.test': [{ address: '::ffff:a9fe:a9fe', family: 6 }],
  'nat64.example.test': [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
  'aws6.example.test': [{ address: 'fd00:ec2::254', family: 6 }],
  'azure.example.test': [{ address: '168.63.129.16', family: 4 }],
  'mixed.example.test': [PUBLIC, { address: '169.254.169.254', family: 4 }],
};
const names = async (host: string) => {
  const found = NAMES[host];
  if (!found) throw new Error(`ENOTFOUND ${host}`);
  return found;
};

/** Cloud metadata however it is written, as a literal or behind a name. */
const METADATA = [
  'http://169.254.169.254/latest/meta-data/',
  'http://2852039166/latest/meta-data/',
  'http://0251.0376.0251.0376/latest/meta-data/',
  'http://0xa9fea9fe/latest/meta-data/',
  'http://169.254.43518/latest/meta-data/',
  'http://169.254.169.254./latest/meta-data/',
  'http://[::ffff:169.254.169.254]/latest/meta-data/',
  'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
  'http://[64:ff9b::a9fe:a9fe]/latest/meta-data/',
  'http://[fd00:ec2::254]/latest/meta-data/',
  'http://[fd20:ce::254]/computeMetadata/v1/',
  'http://169.254.170.2/v2/credentials/',
  'http://100.100.100.200/latest/meta-data/',
  'http://168.63.129.16/machine',
  'http://metadata.example.test/computeMetadata/v1/',
  'http://mapped.example.test/',
  'http://nat64.example.test/',
  'http://aws6.example.test/',
  'http://azure.example.test/',
  'http://mixed.example.test/',
];

/** Inside the server's own network, but not metadata: the installation owner's to name. */
const INSIDE = [
  'http://127.0.0.1:11434/v1',
  'http://017700000001:11434/v1',
  'http://127.1:11434/v1',
  'http://0x7f000001:11434/v1',
  'http://[::1]:11434/v1',
  'http://[::ffff:127.0.0.1]:11434/v1',
  'http://[::ffff:7f00:1]:11434/v1',
  'http://0.0.0.0:11434/v1',
  'http://10.0.0.5:8000/v1',
  'http://172.16.0.3/v1',
  'http://192.168.1.10/v1',
  'http://100.64.0.9/v1',
  'http://169.254.10.10/v1',
  'http://[fe80::1]/v1',
  'http://[fd12:3456::1]/v1',
  'http://inside.example.test/v1',
  'http://loopback.example.test/v1',
];

describe('reaching an address someone named', () => {
  test('cloud metadata is recognised in every spelling, and nothing else is', () => {
    for (const address of [
      '169.254.169.254',
      '169.254.169.123',
      '169.254.170.2',
      '169.254.170.23',
      '100.100.100.200',
      '168.63.129.16',
      '192.0.0.192',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '[::ffff:a9fe:a9fe]',
      '::169.254.169.254',
      '64:ff9b::a9fe:a9fe',
      'fd00:ec2::254',
      'fd00:ec2::23',
      'fd20:ce::254',
    ])
      expect([address, isMetadataAddress(address)]).toEqual([address, true]);
    for (const address of [
      '169.254.10.10',
      '127.0.0.1',
      '10.0.0.5',
      '93.184.216.34',
      '::1',
      'fe80::1',
      'fd00::1',
      '2606:4700::1111',
      'metadata.google.internal',
    ])
      expect([address, isMetadataAddress(address)]).toEqual([address, false]);
    // A metadata service on a routable address is not public either.
    expect(isPublicAddress('168.63.129.16')).toBe(false);
  });

  test('someone else’s address must be public: every inside and metadata spelling is refused', async () => {
    const { sent, request } = recorder();
    const fetch = reachFetch({ reach: 'public', resolve: names, request });
    for (const url of [...INSIDE, ...METADATA]) {
      expect([url, await refused(fetch(url, {}))]).toEqual([
        url,
        expect.objectContaining({ kind: 'unsupported_route', detail: UNREACHABLE }),
      ]);
      expect([url, await isReachableEndpoint(url, 'public', { resolve: names })]).toEqual([
        url,
        false,
      ]);
    }
    expect(sent).toEqual([]);
  });

  test('a public endpoint is reached, at the address that was checked', async () => {
    const { sent, request } = recorder();
    for (const reach of ['public', 'installation'] as const) {
      const fetch = reachFetch({ reach, resolve: names, request });
      expect((await fetch('https://public.example.test/v1/models', {})).status).toBe(200);
      expect((await fetch('https://93.184.216.34/v1/models', {})).status).toBe(200);
    }
    expect(sent.map((entry) => entry.address)).toEqual(Array(4).fill(PUBLIC.address));
  });

  test('the installation owner may reach their own network, never cloud metadata', async () => {
    const { sent, request } = recorder();
    const fetch = reachFetch({
      reach: 'installation',
      resolve: names,
      request,
      allowMetadata: false,
    });
    for (const url of INSIDE) expect([url, (await fetch(url, {})).status]).toEqual([url, 200]);
    for (const url of METADATA)
      expect([url, await refused(fetch(url, {}))]).toEqual([
        url,
        expect.objectContaining({ kind: 'unsupported_route', detail: UNREACHABLE }),
      ]);
    expect(sent).toHaveLength(INSIDE.length);
    expect(sent.some((entry) => entry.address === '169.254.169.254')).toBe(false);
  });

  test('only an operator setting opens metadata, and only to the installation owner', async () => {
    expect(metadataAllowed({})).toBe(false);
    expect(metadataAllowed({ MELETE_ALLOW_CLOUD_METADATA: 'false' })).toBe(false);
    expect(metadataAllowed({ MELETE_ALLOW_CLOUD_METADATA: 'true' })).toBe(true);
    const { sent, request } = recorder();
    const owner = reachFetch({
      reach: 'installation',
      resolve: names,
      request,
      allowMetadata: true,
    });
    expect((await owner('http://metadata.example.test/', {})).status).toBe(200);
    const someone = reachFetch({ reach: 'public', resolve: names, request, allowMetadata: true });
    expect(await refused(someone('http://metadata.example.test/', {}))).toMatchObject({
      kind: 'unsupported_route',
    });
    expect(sent.map((entry) => entry.address)).toEqual(['169.254.169.254']);
  });

  test('a host that is not HTTP is checked the same way, and a name that does not resolve is left to the connection', async () => {
    expect(
      await reachAddresses('imap.inside.example', 'public', { resolve: names }),
    ).toBeUndefined();
    expect(await reachAddresses('10.0.0.5', 'public')).toBeUndefined();
    expect(await reachAddresses('169.254.169.254', 'installation')).toBeUndefined();
    expect(await reachAddresses('10.0.0.5', 'installation')).toEqual([
      { address: '10.0.0.5', family: 4 },
    ]);
    expect(await reachAddresses('public.example.test', 'public', { resolve: names })).toEqual([
      PUBLIC,
    ]);
    expect(await outOfReach('inside.example.test', 'public', { resolve: names })).toBe(true);
    expect(await outOfReach('metadata.example.test', 'installation', { resolve: names })).toBe(
      true,
    );
    expect(await outOfReach('inside.example.test', 'installation', { resolve: names })).toBe(false);
    expect(await outOfReach('nowhere.example.test', 'public', { resolve: names })).toBe(false);
  });

  test('a redirect is never followed, so it cannot lead inside', async () => {
    let followed = 0;
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        followed += 1;
        return new Response('inside');
      },
    });
    const redirecting = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://169.254.169.254/latest/meta-data/` },
        }),
    });
    try {
      // The owner's own server answers with a redirect; the redirect is handed back, not taken.
      const owner = reachFetch({ reach: 'installation' });
      const answer = await owner(`${redirecting.url}models`, {});
      expect(answer.status).toBe(302);
      const asGlobal = asFetch(owner);
      expect((await asGlobal(new URL(`${redirecting.url}models`))).status).toBe(302);
      expect(followed).toBe(0);
    } finally {
      target.stop(true);
      redirecting.stop(true);
    }
  });

  test('the installation owner’s name is pinned to every answer it checked, so loopback still connects', async () => {
    // Answers ::1 first while the server listens on IPv4 only.
    const fetch = reachFetch({ reach: 'installation', resolve: names });
    const response = await fetch(`http://loopback.example.test:${local.port}/v1`, {
      method: 'POST',
      body: '{"model":"llama"}',
    });
    expect(await response.json()).toEqual({
      host: `loopback.example.test:${local.port}`,
      method: 'POST',
      body: '{"model":"llama"}',
    });
    // A form, as an OAuth token request sends it, arrives whole.
    const form = await fetch(`http://loopback.example.test:${local.port}/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
    });
    expect(await form.json()).toMatchObject({
      method: 'POST',
      body: 'grant_type=authorization_code&code=abc',
    });
    // A body it cannot send whole is refused, never sent empty.
    expect(
      await refused(
        fetch(`http://loopback.example.test:${local.port}/v1`, {
          method: 'POST',
          body: new Blob(['x']),
        }),
      ),
    ).toBeInstanceOf(TypeError);
    // A request handed over whole is checked the same way.
    const transport = reachTransport({ reach: 'public', resolve: names });
    expect(
      await refused(transport(new Request(`http://loopback.example.test:${local.port}/v1`))),
    ).toMatchObject({ kind: 'unsupported_route' });
  });
});

test('a refused certificate is one rejection, with no stray error left behind', async () => {
  const stray: unknown[] = [];
  const count = (error: unknown) => stray.push(error);
  process.on('uncaughtException', count);
  const { cert, key } = selfSignedPair('mcp.example.test');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert, key },
    fetch: () => new Response('ok'),
  });
  try {
    await expect(
      pinnedRequest(
        new URL(`https://mcp.example.test:${server.port}/mcp`),
        { address: '127.0.0.1', family: 4 },
        { method: 'POST', body: '{}' },
      ),
    ).rejects.toBeDefined();
    // The socket reports the failure again after the request has; nobody may be left to hear it alone.
    await Bun.sleep(300);
    expect(stray).toEqual([]);
  } finally {
    process.off('uncaughtException', count);
    server.stop(true);
  }
});

test('an MCP session is closed through the same fetch that opened it', async () => {
  // A listener inside the installation, which the closing DELETE must never reach directly.
  const inside: string[] = [];
  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      inside.push(request.method);
      return new Response(null, { status: 204 });
    },
  });
  try {
    const supplied: string[] = [];
    const transport = openHttpMcpTransport(
      { transport: 'http', url: `http://127.0.0.1:${listener.port}/mcp` },
      {
        fetch: async (_url, init) => {
          supplied.push(init.method ?? 'GET');
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
          });
        },
      },
    );
    await transport.request('initialize', {});
    await transport.close();
    expect(supplied).toEqual(['POST', 'DELETE']);
    expect(inside).toEqual([]);

    // Through the public-only fetch, a name that turns private by the time the
    // session closes gets no DELETE at all.
    const { sent, request } = recorder();
    const answers: ResolvedAddress[][] = [[PUBLIC], [{ address: '127.0.0.1', family: 4 }]];
    const pinnedSession = async (url: URL, address: ResolvedAddress) => {
      await request(url, address);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-2' },
      });
    };
    const flipping = openHttpMcpTransport(
      { transport: 'http', url: 'https://mcp.example.test/mcp' },
      {
        fetch: publicOnlyFetch({
          resolve: async () => answers.shift() ?? [],
          request: pinnedSession,
        }),
      },
    );
    await flipping.request('initialize', {});
    await flipping.close();
    expect(sent).toEqual([{ url: 'https://mcp.example.test/mcp', address: PUBLIC.address }]);
  } finally {
    listener.stop(true);
  }
});
