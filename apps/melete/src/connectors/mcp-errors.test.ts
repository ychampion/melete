import { expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { mcpFixtureConfig } from '../../test/fixtures/mcp-config.ts';
import { type McpExecutionContext, openMcpWorker, SERVER_SAID_BYTES, serverNotes } from './mcp.ts';
import {
  MCP_PROTOCOL_VERSION,
  McpProtocolError,
  type McpTransport,
  openHttpMcpTransport,
} from './mcp-transport.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

const binding = { connectionId: 'conn_01J00000000000000000000000', spaceId: 'sp_01' };
const scopes = ['mcp_fixture.read', 'mcp_fixture.write'];
const context = (action: ReturnType<typeof connectorAction>): McpExecutionContext => ({
  ...connectorContext(action),
  audience: 'owner',
  scopes,
});

const DUE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, due: { type: 'string', format: 'date' } },
  required: ['title', 'due'],
};

/**
 * A server that answers `tools/call` with `call`, lists `listed` (the first
 * listing and every later one), and records every method it is asked.
 */
function server(
  call: (params: JsonObject | undefined) => unknown,
  options: { listed?: () => JsonObject[]; instructions?: unknown } = {},
) {
  const requests: string[] = [];
  const listed =
    options.listed ??
    (() => [
      { name: 'read', inputSchema: { type: 'object' } },
      { name: 'write', inputSchema: DUE_SCHEMA },
    ]);
  const transport: McpTransport = {
    async request(method, params) {
      requests.push(method);
      if (method === 'initialize')
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        };
      if (method === 'tools/list') return { tools: listed() };
      if (method === 'tools/call') return call(params);
      throw new Error(`unexpected ${method}`);
    },
    async notify() {},
    async close() {},
  };
  return { transport, requests };
}

const writeAction = (payload: Record<string, unknown>) => {
  const action = connectorAction('mcp_fixture.write', payload);
  action.effect_class = 'write_external';
  return action;
};

test("a tool's own error reaches the result as its words, marked as outside content", async () => {
  const { transport, requests } = server(() => ({
    isError: true,
    content: [{ type: 'text', text: 'due must be YYYY-MM-DD' }],
  }));
  const worker = await openMcpWorker(mcpFixtureConfig(), binding, { transport });
  try {
    const action = writeAction({ title: 'Renew passport', due: 'next Friday' });
    const result = await worker.execute(action, context(action));
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.evidence).toMatchObject({
      server_id: 'fixture',
      tool: 'write',
      server_said: 'due must be YYYY-MM-DD',
      origin_trust: 'external_content',
      // The error turned the arguments down, so the schema is read again and handed back.
      input_schema: DUE_SCHEMA,
    });
    expect(requests.filter((method) => method === 'tools/call')).toHaveLength(1);
    expect(requests.filter((method) => method === 'tools/list')).toHaveLength(2);
  } finally {
    await worker.close();
  }
});

test("a tool's error that is not about its arguments keeps the words and reads no schema", async () => {
  const long = 'x'.repeat(SERVER_SAID_BYTES * 3);
  const { transport, requests } = server(() => ({
    isError: true,
    content: [{ type: 'text', text: `Quota reached. ${long}` }],
  }));
  const worker = await openMcpWorker(mcpFixtureConfig(), binding, { transport });
  try {
    const action = writeAction({ title: 'A', due: '2026-11-06' });
    const result = await worker.execute(action, context(action));
    if (result.outcome !== 'failed') throw new Error('expected failed');
    const said = String(result.evidence?.server_said);
    expect(said.startsWith('Quota reached.')).toBe(true);
    expect(Buffer.byteLength(said)).toBeLessThanOrEqual(SERVER_SAID_BYTES);
    expect(result.evidence?.input_schema).toBeUndefined();
    expect(requests.filter((method) => method === 'tools/list')).toHaveLength(1);
  } finally {
    await worker.close();
  }
});

test('refused arguments (-32602) end as failed, never unknown, with the message and current schema', async () => {
  const { transport } = server(() => {
    throw new McpProtocolError(
      undefined,
      -32602,
      { field: 'due', expected: 'YYYY-MM-DD' },
      'Invalid params',
    );
  });
  const worker = await openMcpWorker(mcpFixtureConfig(), binding, { transport });
  try {
    const action = writeAction({ title: 'Renew passport', due: 'next Friday' });
    const result = await worker.execute(action, context(action));
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain('nothing was done');
    expect(result.evidence).toMatchObject({
      error_code: -32602,
      origin_trust: 'external_content',
      input_schema: DUE_SCHEMA,
    });
    expect(String(result.evidence?.server_said)).toContain('Invalid params');
    expect(String(result.evidence?.server_said)).toContain('YYYY-MM-DD');
  } finally {
    await worker.close();
  }
});

test('a malformed request (-32600) is a definite failure too', async () => {
  const { transport } = server(() => {
    throw new McpProtocolError(undefined, -32600, undefined, 'Invalid Request');
  });
  const worker = await openMcpWorker(mcpFixtureConfig(), binding, { transport });
  try {
    const action = writeAction({ title: 'A', due: '2026-11-06' });
    const result = await worker.execute(action, context(action));
    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.evidence?.server_said).toBe('Invalid Request');
  } finally {
    await worker.close();
  }
});

test('an unknown tool (-32601) reads the catalog again and names what is offered now', async () => {
  let listings = 0;
  const { transport, requests } = server(
    () => {
      throw new McpProtocolError(undefined, -32601, undefined, 'Tool not found: write');
    },
    {
      listed: () =>
        ++listings === 1
          ? [
              { name: 'read', inputSchema: { type: 'object' } },
              { name: 'write', inputSchema: DUE_SCHEMA },
            ]
          : // The server dropped the tool since the session opened.
            [{ name: 'read', inputSchema: { type: 'object' } }],
    },
  );
  const worker = await openMcpWorker(mcpFixtureConfig(), binding, { transport });
  try {
    const action = writeAction({ title: 'A', due: '2026-11-06' });
    const result = await worker.execute(action, context(action));
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.retryable).toBe(false);
    expect(result.evidence).toMatchObject({
      error_code: -32601,
      server_said: 'Tool not found: write',
      tools_offered: ['mcp_fixture.read'],
      origin_trust: 'external_content',
    });
    expect(requests.filter((method) => method === 'tools/list')).toHaveLength(2);
  } finally {
    await worker.close();
  }
});

test('another JSON-RPC error still rests as unknown: it does not prove nothing was done', async () => {
  const { transport } = server(() => {
    throw new McpProtocolError(undefined, -32603, undefined, 'Internal error');
  });
  const worker = await openMcpWorker(mcpFixtureConfig(), binding, { transport });
  try {
    const action = writeAction({ title: 'A', due: '2026-11-06' });
    expect((await worker.execute(action, context(action))).outcome).toBe('unknown');
  } finally {
    await worker.close();
  }
});

/** An HTTP server whose tools/call answer starts streaming and then breaks. */
function breakingFetch(answer: 'break' | 'refuse') {
  return async (_url: string, init: RequestInit): Promise<Response> => {
    const message = JSON.parse(String(init.body)) as { id?: number; method?: string };
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', ...headers },
      });
    if (message.method === 'server/discover')
      return new Response('{}', { status: 400, headers: { 'content-type': 'text/plain' } });
    if (message.method === 'initialize')
      return json(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            instructions: 'Dates are YYYY-MM-DD.',
          },
        },
        { 'mcp-session-id': 'session-1' },
      );
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === 'tools/list')
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'read', inputSchema: { type: 'object' } },
            { name: 'write', inputSchema: DUE_SCHEMA },
          ],
        },
      });
    if (answer === 'refuse')
      return json({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: 'due must be YYYY-MM-DD' },
      });
    // The call went out; the answer began and the connection broke before it ended.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":'));
        controller.error(new TypeError('socket closed'));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const httpConfig = () => ({
  ...mcpFixtureConfig(),
  endpoint: { transport: 'http' as const, url: 'https://tracker.example.test/mcp' },
});

test('a network break after the call went out stays unknown', async () => {
  const worker = await openMcpWorker(httpConfig(), binding, {
    transport: openHttpMcpTransport(
      { transport: 'http', url: 'https://tracker.example.test/mcp' },
      { fetch: breakingFetch('break') },
    ),
  });
  try {
    const action = writeAction({ title: 'A', due: '2026-11-06' });
    expect((await worker.execute(action, context(action))).outcome).toBe('unknown');
  } finally {
    await worker.close();
  }
});

test('over HTTP, a -32602 answer keeps the server message and the notes from initialize', async () => {
  const kept: (string | null)[] = [];
  const worker = await openMcpWorker(httpConfig(), binding, {
    transport: openHttpMcpTransport(
      { transport: 'http', url: 'https://tracker.example.test/mcp' },
      { fetch: breakingFetch('refuse') },
    ),
    onSession: ({ instructions }) => {
      kept.push(instructions);
    },
  });
  try {
    expect(worker.instructions).toBe('Dates are YYYY-MM-DD.');
    expect(kept).toEqual(['Dates are YYYY-MM-DD.']);
    const action = writeAction({ title: 'A', due: 'next Friday' });
    const result = await worker.execute(action, context(action));
    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.evidence?.server_said).toBe(
      'due must be YYYY-MM-DD',
    );
  } finally {
    await worker.close();
  }
});

test("a server's notes are kept bounded, and none is kept when it gave none", async () => {
  expect(serverNotes(undefined)).toBeNull();
  expect(serverNotes('   ')).toBeNull();
  expect(serverNotes(42)).toBeNull();
  const long = serverNotes('n'.repeat(5000));
  expect(long?.length).toBeLessThanOrEqual(800);
  expect(long?.endsWith('…')).toBe(true);
  const { transport } = server(() => ({ content: [] }), { instructions: '  Use ISO dates.  ' });
  const worker = await openMcpWorker(mcpFixtureConfig(), binding, { transport });
  try {
    expect(worker.instructions).toBe('Use ISO dates.');
  } finally {
    await worker.close();
  }
});
