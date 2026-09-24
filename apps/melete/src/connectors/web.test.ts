import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { connectorManifest } from '@melete/contracts';
import { selfSignedPair } from '../gateway/fixtures/self-signed.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';
import {
  createWebConnector,
  isPublicAddress,
  pinnedWebRequest,
  type WebTransport,
  webManifest,
} from './web.ts';

test('web SSRF guard denies private, metadata, multicast and mapped private addresses', () => {
  connectorManifest.parse(webManifest);
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.1.1',
    '100.100.100.200',
    '198.19.1.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:a00:1',
    '64:ff9b::a00:1',
    '2002:a00:1::',
    '2001:db8::1',
  ]) {
    expect(isPublicAddress(address)).toBe(false);
  }
  for (const address of [
    '93.184.216.34',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ]) {
    expect(isPublicAddress(address)).toBe(true);
  }
});

test('web validates every DNS answer, so a mixed public/private answer never reaches transport', async () => {
  let calls = 0;
  const connector = createWebConnector({
    resolve: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    transport: async () => {
      calls += 1;
      return { status: 200, headers: {}, body: 'bad' };
    },
  });
  const action = connectorAction('web.fetch', { url: 'https://public.example/' });
  const ctx = connectorContext(action);
  ctx.constraints.public_compartment = true;
  await expect(connector.execute(action, ctx)).rejects.toThrow('non-public');
  expect(calls).toBe(0);
});

test('web blocks literal metadata and non-HTTP schemes before network access', async () => {
  let calls = 0;
  const connector = createWebConnector({
    transport: async () => {
      calls += 1;
      return { status: 200, headers: {}, body: '' };
    },
  });
  for (const url of [
    'http://169.254.169.254/latest/meta-data',
    'http://2130706433/',
    'http://[::ffff:127.0.0.1]/',
    'file:///etc/passwd',
    'https://user:password@public.example/',
  ]) {
    const action = connectorAction('web.fetch', { url });
    const ctx = connectorContext(action);
    ctx.constraints.public_compartment = true;
    await expect(connector.execute(action, ctx)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test('private compartment allowlist is trusted context and exact-host only', async () => {
  let calls = 0;
  const connector = createWebConnector({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async () => {
      calls += 1;
      return { status: 200, headers: {}, body: 'ok' };
    },
  });
  const action = connectorAction('web.fetch', {
    url: 'https://allowed.example.evil.test/?private=secret',
    public_compartment: true,
  });
  const ctx = connectorContext(action);
  ctx.constraints.allowed_domains = ['allowed.example'];
  await expect(connector.execute(action, ctx)).rejects.toThrow('private-context');
  expect(calls).toBe(0);
  const allowed = connectorAction('web.fetch', { url: 'https://allowed.example/?q=secret&x=2' });
  const result = await connector.execute(allowed, ctx);
  if (result.outcome !== 'succeeded') throw new Error('expected fetch');
  expect(result.receipt.detail.url).toBe('https://allowed.example/?q=secret&x=2');
});

test('redirects repeat compartment and DNS checks, with no request to the denied destination', async () => {
  const visited: string[] = [];
  const connector = createWebConnector({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async (url) => {
      visited.push(url.href);
      return { status: 302, headers: { location: 'http://169.254.169.254/secret' }, body: '' };
    },
  });
  const action = connectorAction('web.fetch', { url: 'https://public.example/' });
  const ctx = connectorContext(action);
  ctx.constraints.public_compartment = true;
  await expect(connector.execute(action, ctx)).rejects.toThrow('non-public');
  expect(visited).toEqual(['https://public.example/']);
  ctx.constraints.public_compartment = false;
  ctx.constraints.allowed_domains = ['public.example'];
  await expect(connector.execute(action, ctx)).rejects.toThrow('private-context');
  expect(visited).toHaveLength(2);
});

test('checked DNS answer is passed unchanged to transport and DNS is not repeated', async () => {
  let resolutions = 0;
  const transport: WebTransport = async (_url, address) => {
    expect(address).toEqual({ address: '8.8.8.8', family: 4 });
    return { status: 200, headers: {}, body: 'ok' };
  };
  const connector = createWebConnector({
    resolve: async () => {
      resolutions += 1;
      return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    },
    transport,
  });
  const action = connectorAction('web.fetch', { url: 'https://public.example/' });
  const ctx = connectorContext(action);
  ctx.constraints.public_compartment = true;
  expect((await connector.execute(action, ctx)).outcome).toBe('succeeded');
  expect(resolutions).toBe(1);
});

test('real pinned transport uses the supplied IP while preserving Host and query', async () => {
  const server = createServer((request, response) => {
    response.end(`${request.headers.host} ${request.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const result = await pinnedWebRequest(
      new URL(`http://cannot-resolve.invalid:${address.port}/search?q=kept`),
      { address: '127.0.0.1', family: 4 },
      { maxBytes: 4096, timeoutMs: 1000 },
    );
    expect(result.body).toBe(`cannot-resolve.invalid:${address.port} /search?q=kept`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a refused certificate is one rejection, with no stray error left behind', async () => {
  const stray: unknown[] = [];
  const count = (error: unknown) => stray.push(error);
  process.on('uncaughtException', count);
  const { cert, key } = selfSignedPair('pinned.example.test');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert, key },
    fetch: () => new Response('ok'),
  });
  try {
    await expect(
      pinnedWebRequest(
        new URL(`https://pinned.example.test:${server.port}/`),
        { address: '127.0.0.1', family: 4 },
        { maxBytes: 1000, timeoutMs: 2000 },
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
