/**
 * A remote MCP server is untrusted. Whatever it sends, a call ends in bounded
 * time and memory with a plain reason: a huge body, an endless stream, a slow
 * drip, one giant event, deeply nested JSON, a giant tool list, too many open
 * requests, and oversized OAuth answers.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ConnectorFaultError } from './faults.ts';
import { mcpServerConfig, openMcpWorker } from './mcp.ts';
import { discoverAuthorizationServer, McpSignInFailure } from './mcp-oauth.ts';
import { jsonDepthWithin, openHttpMcpTransport } from './mcp-transport.ts';

const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A loopback server that answers every request with `answer`. */
function hostile(
  answer: (message: { id?: number; method: string }) => Response | Promise<Response>,
) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 204 });
      return answer((await request.json()) as { id?: number; method: string });
    },
  });
  stops.push(() => server.stop(true));
  return `${server.url}mcp`;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => 'answered',
    (error: Error) => error.message,
  );

/** A stream that sends `chunk` every `everyMs` until it is cancelled. */
function drip(chunk: string, everyMs: number, first = '') {
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(chunk);
      if (first) controller.enqueue(new TextEncoder().encode(first));
      timer = setInterval(() => {
        try {
          controller.enqueue(bytes);
        } catch {
          clearInterval(timer);
        }
      }, everyMs);
    },
    cancel() {
      clearInterval(timer);
    },
  });
}

describe('a hostile MCP server', () => {
  test('a huge body is refused, whether its length is declared or streamed', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const declared = hostile((message) =>
      Response.json({ jsonrpc: '2.0', id: message.id, result: { pad: huge } }),
    );
    expect(
      await failure(openHttpMcpTransport({ transport: 'http', url: declared }).request('ping')),
    ).toBe('MCP response limit exceeded');
    const streamed = hostile(
      () =>
        new Response(drip('x'.repeat(64 * 1024), 1, '{"jsonrpc":"2.0","id":1,"result":{"pad":"'), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const started = Date.now();
    expect(
      await failure(openHttpMcpTransport({ transport: 'http', url: streamed }).request('ping')),
    ).toBe('MCP response limit exceeded');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('an endless stream ends at the deadline', async () => {
    const url = hostile(
      () =>
        new Response(drip(': keep-alive\n\n', 50), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const started = Date.now();
    const transport = openHttpMcpTransport({ transport: 'http', url }, { timeoutMs: 800 });
    expect(await failure(transport.request('ping'))).toBe('MCP server did not answer in time');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test('a slow drip ends when the server goes quiet', async () => {
    const url = hostile(
      () =>
        new Response(drip(':', 1_000, ': begin\n\n'), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const started = Date.now();
    const transport = openHttpMcpTransport({ transport: 'http', url }, { idleMs: 200 });
    expect(await failure(transport.request('ping'))).toBe(
      'MCP server stopped sending before it answered',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('one event larger than an event may be is refused', async () => {
    const url = hostile(
      () =>
        new Response(drip('y'.repeat(256 * 1024), 1, 'data: '), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(await failure(openHttpMcpTransport({ transport: 'http', url }).request('ping'))).toBe(
      'MCP event limit exceeded',
    );
  });

  test('deeply nested JSON is refused before it is parsed', async () => {
    const deep = `${'['.repeat(5_000)}${']'.repeat(5_000)}`;
    const url = hostile(
      (message) =>
        new Response(`{"jsonrpc":"2.0","id":${message.id},"result":{"deep":${deep}}}`, {
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await failure(openHttpMcpTransport({ transport: 'http', url }).request('ping'))).toBe(
      'MCP message is nested too deeply',
    );
    expect(jsonDepthWithin('{"a":"[[[[[[[["}', 2)).toBe(true);
    expect(jsonDepthWithin('[[[]]]', 2)).toBe(false);
  });

  test('a giant tool is left out, and a giant tool list is refused', async () => {
    const config = (url: string) =>
      mcpServerConfig.parse({
        id: 'big',
        endpoint: { transport: 'http', url },
        allowed_scopes: ['mcp_big.small'],
        audience: 'owner',
        tools: [
          {
            name: 'small',
            alias: 'small',
            required_scopes: ['mcp_big.small'],
            effect_class: 'read',
          },
        ],
      });
    const handshake = (message: { id?: number; method: string }, tools: () => unknown) => {
      if (message.method === 'server/discover')
        return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601 } });
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result:
          message.method === 'initialize'
            ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
            : tools(),
      });
    };
    const giant = { type: 'object', description: 'z'.repeat(100 * 1024) };
    const oneGiant = hostile((message) =>
      handshake(message, () => ({
        tools: [
          { name: 'small', inputSchema: { type: 'object' } },
          { name: 'giant', inputSchema: giant },
        ],
      })),
    );
    const worker = await openMcpWorker(config(oneGiant), {
      connectionId: 'conn_x',
      spaceId: 'sp_x',
    });
    expect(worker.definitions.map((tool) => tool.name)).toEqual(['small']);
    await worker.close();

    // Pages of 1.5 MB each: the list as a whole passes its limit on the third.
    let page = 0;
    const endless = hostile((message) =>
      handshake(message, () => ({
        tools: Array.from({ length: 24 }, (_, index) => ({
          name: `t${page}_${index}`,
          inputSchema: { type: 'object', description: 'w'.repeat(62 * 1024) },
        })),
        nextCursor: `page-${++page}`,
      })),
    );
    expect(
      await failure(openMcpWorker(config(endless), { connectionId: 'conn_y', spaceId: 'sp_y' })),
    ).toBe('MCP tool list is too large');

    const tooMany = hostile((message) =>
      handshake(message, () => ({
        tools: Array.from({ length: 300 }, (_, index) => ({
          name: `t${index}`,
          inputSchema: { type: 'object' },
        })),
      })),
    );
    expect(
      await failure(openMcpWorker(config(tooMany), { connectionId: 'conn_z', spaceId: 'sp_z' })),
    ).not.toBe('answered');
  });

  test('too many open requests are refused before anything is sent', async () => {
    let received = 0;
    const slow = () =>
      hostile(async (message) => {
        received++;
        await Bun.sleep(400);
        return Response.json({ jsonrpc: '2.0', id: message.id, result: {} });
      });
    const one = openHttpMcpTransport({ transport: 'http', url: slow() });
    const nine = await Promise.allSettled(Array.from({ length: 9 }, () => one.request('ping')));
    const refused = nine.filter((item) => item.status === 'rejected');
    expect(refused).toHaveLength(1);
    const reason = (refused[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ConnectorFaultError);
    expect((reason as ConnectorFaultError).fault.kind).toBe('transient_before_dispatch');
    expect(received).toBe(8);

    // Across one space's connections together.
    received = 0;
    const transports = Array.from({ length: 5 }, () =>
      openHttpMcpTransport({ transport: 'http', url: slow() }, { space: 'sp_limits' }),
    );
    const calls = transports.flatMap((transport, index) =>
      Array.from({ length: index === 4 ? 1 : 8 }, () => transport.request('ping')),
    );
    const settled = await Promise.allSettled(calls);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(received).toBe(32);
    // Once they finish, the space may open requests again.
    expect(await transports[4]?.request('ping')).toEqual({});
  });

  test('an oversized OAuth answer fails the sign-in with a fixed code', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(`{"issuer":"x","pad":"${'p'.repeat(512 * 1024)}"}`, {
          headers: { 'content-type': 'application/json' },
        }),
    });
    stops.push(() => server.stop(true));
    const refused = await discoverAuthorizationServer(`${server.url}auth`, (url, init) =>
      fetch(url, init),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(McpSignInFailure);
  });
});
