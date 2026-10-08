/**
 * Speaking to remote MCP servers of each revision over Streamable HTTP: the
 * session-based ones a server settles on with `initialize` (2025-03-26,
 * 2025-06-18, 2025-11-25), and the stateless one (2026-07-28), where every
 * request carries its revision and the headers that mirror it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type FakeMcpAuth, startFakeMcpAuth } from './fixtures/fake-mcp-auth.ts';
import { type McpExecutionContext, mcpServerConfig, openMcpWorker } from './mcp.ts';
import { mcpHeaderValue, mcpParamHeaders, mcpParamHeaderValues } from './mcp-headers.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

const binding = { connectionId: 'conn_01J00000000000000000000000', spaceId: 'sp_01' };
const servers: FakeMcpAuth[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop();
});

const TOOLS: Array<{ name: string; inputSchema: Record<string, unknown> }> = [
  { name: 'read_file', inputSchema: { type: 'object' } },
  {
    name: 'write_file',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        body: { type: 'string' },
      },
    },
  },
  { name: 'needs_input', inputSchema: { type: 'object' } },
];

const config = (url: string, names = ['read_file', 'write_file', 'needs_input']) =>
  mcpServerConfig.parse({
    id: 'files',
    endpoint: { transport: 'http', url },
    allowed_scopes: names.map((name) => `mcp_files.${name}`),
    audience: 'owner',
    tools: names.map((name) => ({
      name,
      alias: name,
      required_scopes: [`mcp_files.${name}`],
      effect_class: name === 'read_file' ? 'read' : 'write_external',
    })),
  });

async function serve(protocol: string, tools = TOOLS) {
  const server = await startFakeMcpAuth({ open: true, protocol, tools });
  servers.push(server);
  return server;
}

function call(kind: string, payload: Record<string, unknown> = {}) {
  const action = connectorAction(kind, payload);
  action.effect_class = kind.endsWith('read_file') ? 'read' : 'write_external';
  const context: McpExecutionContext = {
    ...connectorContext(action),
    audience: 'owner',
    scopes: [kind],
  };
  return { action, context };
}

describe('the revision a server settles on', () => {
  for (const protocol of ['2025-03-26', '2025-06-18', '2025-11-25']) {
    test(`a ${protocol} server is met with the handshake and keeps its session`, async () => {
      const server = await serve(protocol);
      const worker = await openMcpWorker(config(server.mcpUrl), binding);
      try {
        expect(worker.tools.map((tool) => tool.name)).toEqual([
          'mcp_files.needs_input',
          'mcp_files.read_file',
          'mcp_files.write_file',
        ]);
        const { action, context } = call('mcp_files.read_file');
        expect((await worker.execute(action, context)).outcome).toBe('succeeded');
        expect((await worker.health()).status).toBe('ok');
      } finally {
        await worker.close();
      }
      const methods = server.messages.map((message) => message.method);
      // The stateless probe is refused, then the handshake, then the session's requests.
      expect(methods.slice(0, 4)).toEqual([
        'server/discover',
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
      const after = server.messages.slice(2);
      expect(after.every((message) => message.headers['mcp-session-id'] === 'fake-session')).toBe(
        true,
      );
      // Every request after the handshake names the revision the server chose.
      expect(after.every((message) => message.headers['mcp-protocol-version'] === protocol)).toBe(
        true,
      );
    });
  }

  test('a server that settles on a revision Melete does not speak is refused', async () => {
    const server = await serve('2024-11-05');
    const failure = await openMcpWorker(config(server.mcpUrl), binding).catch(
      (error: Error) => error.message,
    );
    expect(failure).toContain('unsupported protocol version');
    expect(server.messages.map((message) => message.method)).not.toContain('tools/list');
  });

  test('a stateless server is spoken to without a handshake or a session', async () => {
    const server = await serve('2026-07-28');
    const worker = await openMcpWorker(config(server.mcpUrl), binding);
    try {
      expect(worker.tools).toHaveLength(3);
      const read = call('mcp_files.read_file');
      const done = await worker.execute(read.action, read.context);
      expect(done.outcome).toBe('succeeded');
      // The parameter its schema marks is mirrored into a header the server checks.
      const write = call('mcp_files.write_file', { region: 'us-west1', body: 'hello' });
      expect((await worker.execute(write.action, write.context)).outcome).toBe('succeeded');
      expect((await worker.health()).status).toBe('ok');
    } finally {
      await worker.close();
    }
    const methods = server.messages.map((message) => message.method);
    expect(methods).not.toContain('initialize');
    expect(methods).not.toContain('notifications/initialized');
    expect(methods).not.toContain('ping');
    expect(methods[0]).toBe('server/discover');
    for (const message of server.messages) {
      expect(message.headers['mcp-session-id']).toBeUndefined();
      expect(message.headers['mcp-protocol-version']).toBe('2026-07-28');
      expect(message.headers['mcp-method']).toBe(message.method);
      const meta = message.params._meta as Record<string, unknown>;
      expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
      expect(meta['io.modelcontextprotocol/clientInfo']).toMatchObject({ name: 'melete' });
      expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({});
    }
    const sent = server.messages.find(
      (message) => message.method === 'tools/call' && message.params.name === 'write_file',
    );
    if (!sent) throw new Error('The write was not sent');
    expect(sent.headers['mcp-name']).toBe('write_file');
    expect(sent.headers['mcp-param-region']).toBe('us-west1');
    // The call's own metadata travels beside the revision's.
    expect((sent.params._meta as Record<string, unknown>)['melete/idempotency_key']).toBe(
      'act_01J00000000000000000000000',
    );
    // No session to close, so nothing is sent on close.
    expect(server.requests.filter((path) => path === '/mcp')).toHaveLength(methods.length);
  });

  test('a stateless server that asks for more input has not acted, and the call fails', async () => {
    const server = await serve('2026-07-28');
    const worker = await openMcpWorker(config(server.mcpUrl), binding);
    try {
      const { action, context } = call('mcp_files.needs_input');
      const result = await worker.execute(action, context);
      expect(result).toMatchObject({ outcome: 'failed', retryable: false });
    } finally {
      await worker.close();
    }
  });

  test('a stateless server whose tool marks a parameter wrongly does not offer that tool', async () => {
    const server = await serve('2026-07-28', [
      ...TOOLS,
      {
        name: 'bad_header',
        inputSchema: {
          type: 'object',
          properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'X' } } },
        },
      },
    ]);
    const failure = await openMcpWorker(
      config(server.mcpUrl, ['read_file', 'bad_header']),
      binding,
    ).catch((error: Error) => error.message);
    expect(failure).toContain('Configured MCP tool is unavailable: bad_header');
  });

  test('a server that answers the stateless probe with something else gets the handshake', async () => {
    const methods: string[] = [];
    const stub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        const message = (await request.json()) as { id?: number; method: string };
        methods.push(message.method);
        if (message.method === 'server/discover')
          return new Response('<html>Not here</html>', {
            headers: { 'content-type': 'text/html' },
          });
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
            : { tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] };
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      },
    });
    try {
      const worker = await openMcpWorker(config(`${stub.url}mcp`, ['read_file']), binding);
      expect(worker.tools.map((tool) => tool.name)).toEqual(['mcp_files.read_file']);
      await worker.close();
      expect(methods).toEqual([
        'server/discover',
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    } finally {
      await stub.stop(true);
    }
  });

  test('a stateless server that speaks no revision Melete knows is refused', async () => {
    const stub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const message = (await request.json()) as { id: number };
        return Response.json(
          {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32022, message: 'no', data: { supported: ['2099-01-01'] } },
          },
          { status: 400 },
        );
      },
    });
    try {
      const failure = await openMcpWorker(config(`${stub.url}mcp`), binding).catch(
        (error: Error) => error.message,
      );
      expect(failure).toContain('unsupported protocol version');
    } finally {
      await stub.stop(true);
    }
  });
});

describe('headers mirrored from a request', () => {
  test('values that are not plain visible ASCII travel Base64-encoded', () => {
    expect(mcpHeaderValue('us-west1')).toBe('us-west1');
    expect(mcpHeaderValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=');
    expect(mcpHeaderValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=');
    expect(mcpHeaderValue('line1\nline2')).toBe('=?base64?bGluZTEKbGluZTI=?=');
    expect(mcpHeaderValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
  });

  test('only parameters reached through properties, of plain types, with unique names, are mirrored', () => {
    const nested = {
      type: 'object',
      properties: {
        where: {
          type: 'object',
          properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
        },
        dry: { type: 'boolean', 'x-mcp-header': 'Dry-Run' },
        count: { type: 'integer', 'x-mcp-header': 'Count' },
      },
    };
    const found = mcpParamHeaders(nested);
    expect(found).toEqual([
      { header: 'Mcp-Param-Region', path: ['where', 'region'] },
      { header: 'Mcp-Param-Dry-Run', path: ['dry'] },
      { header: 'Mcp-Param-Count', path: ['count'] },
    ]);
    expect(
      mcpParamHeaderValues(found ?? [], { where: { region: 'eu' }, dry: false, count: 3 }),
    ).toEqual({ 'Mcp-Param-Region': 'eu', 'Mcp-Param-Dry-Run': 'false', 'Mcp-Param-Count': '3' });
    // An absent or null value sends no header.
    expect(mcpParamHeaderValues(found ?? [], { dry: null })).toEqual({});
    const invalid: Array<Record<string, unknown>> = [
      { type: 'object', properties: { n: { type: 'number', 'x-mcp-header': 'N' } } },
      { type: 'object', properties: { s: { type: 'string', 'x-mcp-header': 'Bad Name' } } },
      { type: 'object', properties: { s: { type: 'string', 'x-mcp-header': '' } } },
      {
        type: 'object',
        properties: {
          a: { type: 'string', 'x-mcp-header': 'Same' },
          b: { type: 'string', 'x-mcp-header': 'same' },
        },
      },
      {
        type: 'object',
        oneOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }],
      },
    ];
    for (const schema of invalid) expect(mcpParamHeaders(schema)).toBeNull();
  });
});
