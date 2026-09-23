import { afterAll, describe, expect, test } from 'bun:test';
import { selfSignedPair } from '../gateway/fixtures/self-signed.ts';
import { ConnectorFaultError } from './faults.ts';
import { openHttpMcpTransport } from './mcp-transport.ts';
import { pinnedRequest, publicOnlyFetch } from './public-fetch.ts';
import type { ResolvedAddress } from './web.ts';

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
