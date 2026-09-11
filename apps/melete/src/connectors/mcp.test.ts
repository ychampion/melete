import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@melete/contracts';
import { mcpFixtureConfig } from '../../test/fixtures/mcp-config.ts';
import { type McpExecutionContext, mcpServerConfig, openMcpWorker, readMcpConfig } from './mcp.ts';
import {
  filteredMcpEnvironment,
  MCP_PROTOCOL_VERSION,
  type McpTransport,
  openHttpMcpTransport,
  openStdioMcpTransport,
} from './mcp-transport.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

const binding = { connectionId: 'conn_01J00000000000000000000000', spaceId: 'sp_01' };
const scopes = ['mcp_fixture.read', 'mcp_fixture.write'];
function context(action: ReturnType<typeof connectorAction>): McpExecutionContext {
  return { ...connectorContext(action), audience: 'owner', scopes };
}

test('MCP config is strict, operator scoped, and defaults unclassified tools to external writes', async () => {
  const config = mcpFixtureConfig();
  expect(config.tools[1]?.effect_class).toBe('write_external');
  expect(() => mcpServerConfig.parse({ ...config, audience: 'public' })).toThrow();
  expect(() => mcpServerConfig.parse({ ...config, allowed_scopes: ['mcp_fixture.read'] })).toThrow(
    'allowed_scopes',
  );
  expect(() =>
    mcpServerConfig.parse({
      ...config,
      endpoint: { ...config.endpoint, env: { DATABASE_URL: 'forbidden' } },
    }),
  ).toThrow();
  expect(() =>
    mcpServerConfig.parse({
      ...config,
      endpoint: { transport: 'http', url: 'https://user:password@example.test/mcp' },
    }),
  ).toThrow();
  expect(() =>
    mcpServerConfig.parse({ ...config, tools: [...config.tools, config.tools[0]] }),
  ).toThrow('unique');
  const directory = await mkdtemp(join(tmpdir(), 'melete-mcp-config-'));
  try {
    const path = join(directory, 'servers.json');
    await writeFile(path, JSON.stringify([config]));
    expect(await readMcpConfig(path)).toEqual([config]);
    await writeFile(path, JSON.stringify([config, config]));
    expect(await readMcpConfig(path).catch((error: Error) => error.message)).toContain('Duplicate');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP worker launch drops secrets, profile paths, and language startup hooks', () => {
  const env = filteredMcpEnvironment(
    {
      PATH: 'safe-path',
      SystemRoot: 'C:\\Windows',
      HOME: 'private-home',
      DATABASE_URL: 'database-secret',
      MELETE_MASTER_KEY: 'vault-secret',
      FIREWORKS_API_KEY: 'provider-secret',
      MELETE_BROKER_TOKEN: 'broker-secret',
      NODE_OPTIONS: '--require=private-module',
      BUN_OPTIONS: 'private',
      PYTHONPATH: 'private',
    },
    '/worker-temp',
  );
  expect(env).toMatchObject({
    PATH: 'safe-path',
    SystemRoot: 'C:\\Windows',
    HOME: '/worker-temp',
    USERPROFILE: '/worker-temp',
  });
  for (const name of [
    'DATABASE_URL',
    'MELETE_MASTER_KEY',
    'FIREWORKS_API_KEY',
    'MELETE_BROKER_TOKEN',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'PYTHONPATH',
  ]) {
    expect(env[name]).toBeUndefined();
  }
});

test('local stdio worker ignores dishonest annotations, denies client roots, and keeps results untrusted', async () => {
  const worker = await openMcpWorker(mcpFixtureConfig(), binding);
  try {
    expect(worker.tools.map((tool) => tool.name)).toEqual(scopes);
    expect(worker.tools[1]).toMatchObject({
      effect_class: 'write_external',
      requires_approval: true,
      verify: false,
    });
    const action = connectorAction('mcp_fixture.read', {});
    const result = await worker.execute(action, context(action));
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('read failed');
    const data = (result.receipt.detail.result as JsonObject).structuredContent as JsonObject;
    expect(data.client_capabilities).toEqual({});
    expect(data.client_request_denials).toEqual([-32601]);
    expect(data.home).toBe(data.cwd);
    expect(data.cwd).not.toBe(process.cwd());
    expect(result.receipt.detail.origin_trust).toBe('external_content');
    expect(result.receipt.detail.evidence_handle).toBe(`mcp:fixture:${action.id}`);
    for (const name of [
      'DATABASE_URL',
      'MELETE_MASTER_KEY',
      'FIREWORKS_API_KEY',
      'MELETE_BROKER_TOKEN',
    ]) {
      expect(data.environment_names as string[]).not.toContain(name);
    }
    expect((await worker.health()).status).toBe('ok');
    expect((await worker.verify()).decision).toBe('unsupported');
  } finally {
    await worker.close();
  }
});

test('MCP execution rejects changed audience, space, scope, effect, identity and bytes before dispatch', async () => {
  const worker = await openMcpWorker(mcpFixtureConfig(), binding);
  try {
    const action = connectorAction('mcp_fixture.write', { body: 'approved' });
    action.effect_class = 'write_external';
    const expected = {
      outcome: 'failed',
      reason: 'MCP execution authority mismatch',
      retryable: false,
    } as const;
    for (const altered of [
      { ...context(action), audience: 'public' },
      { ...context(action), space_id: 'another-space' },
      { ...context(action), scopes: ['mcp_fixture.read'] },
      { ...context(action), idempotency_key: 'another-action' },
    ]) {
      expect(await worker.execute(action, altered)).toEqual(expected);
    }
    for (const altered of [
      { ...action, effect_class: 'read' as const },
      { ...action, status: 'approved' as const },
      { ...action, connection_id: 'another-connection' },
      { ...action, canonical_payload: { body: 'unapproved' } },
    ]) {
      expect(await worker.execute(altered, context(action))).toEqual(expected);
    }
    const exposed = worker.tools.find((tool) => tool.name === action.kind);
    if (!exposed) throw new Error('write tool missing');
    exposed.effect_class = 'read';
    expect(await worker.execute({ ...action, effect_class: 'read' }, context(action))).toEqual(
      expected,
    );
    const result = await worker.execute(action, context(action));
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('write failed');
    expect((result.receipt.detail.result as JsonObject).structuredContent).toEqual({
      writes: 1,
      idempotency_key: action.id,
    });
  } finally {
    await worker.close();
  }
});

test('MCP lost acknowledgement remains unknown and does not fabricate verification', async () => {
  const worker = await openMcpWorker(mcpFixtureConfig(), binding);
  try {
    const action = connectorAction('mcp_fixture.write', {
      body: 'accepted without ack',
      drop_ack: true,
    });
    action.effect_class = 'write_external';
    expect((await worker.execute(action, context(action))).outcome).toBe('unknown');
    expect((await worker.verify()).decision).toBe('unsupported');
  } finally {
    await worker.close();
  }
});

test('MCP discovery refuses an async server schema before exposing or invoking tools', async () => {
  let closed = false;
  const requests: string[] = [];
  const transport: McpTransport = {
    async request(method) {
      requests.push(method);
      return method === 'initialize'
        ? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } }
        : {
            tools: [
              {
                name: 'read',
                inputSchema: {
                  type: 'object',
                  $async: true,
                  required: ['required_value'],
                  properties: { required_value: { type: 'string' } },
                },
              },
            ],
          };
    },
    async notify() {},
    async close() {
      closed = true;
    },
  };
  const failure = await openMcpWorker(mcpFixtureConfig(), binding, { transport }).catch(
    (error: Error) => error.message,
  );
  expect(failure).toContain('MCP asynchronous schemas ($async) are unsupported');
  expect(requests).toEqual(['initialize', 'tools/list']);
  expect(closed).toBe(true);
});

test('MCP discovery fails closed on cyclic pagination and always closes the worker', async () => {
  let closed = false;
  const transport: McpTransport = {
    async request(method) {
      return method === 'initialize'
        ? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } }
        : { tools: [], nextCursor: 'repeat' };
    },
    async notify() {},
    async close() {
      closed = true;
    },
  };
  const failure = await openMcpWorker(mcpFixtureConfig(), binding, { transport }).catch(
    (error: Error) => error.message,
  );
  expect(failure).toContain('Repeated MCP pagination cursor');
  expect(closed).toBe(true);
});

test('MCP request timeout closes a worker even if it ignores normal termination', async () => {
  const transport = await openStdioMcpTransport(
    {
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
    },
    { timeoutMs: 200 },
  );
  try {
    const failure = await transport.request('initialize').catch((error: Error) => error.message);
    expect(failure).toContain('timed out');
  } finally {
    await transport.close();
  }
}, 3000);

test('MCP HTTP transport supports JSON and SSE while pinning session and rejecting redirects', async () => {
  const observed: Array<{
    method: string;
    session: string | null;
    authorization: string | null;
    protocol: string | null;
  }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      const message = (await request.json()) as { id?: number; method: string };
      observed.push({
        method: message.method,
        session: request.headers.get('mcp-session-id'),
        authorization: request.headers.get('authorization'),
        protocol: request.headers.get('mcp-protocol-version'),
      });
      if (message.method === 'initialize')
        return Response.json(
          { jsonrpc: '2.0', id: message.id, result: {} },
          { headers: { 'MCP-Session-Id': 'fixture-session' } },
        );
      if (message.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      if (message.method === 'ping')
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      return new Response(null, { status: 307, headers: { Location: '/elsewhere' } });
    },
  });
  const transport = openHttpMcpTransport({ transport: 'http', url: `${server.url}mcp` });
  try {
    await transport.request('initialize');
    await transport.notify('notifications/initialized');
    expect(await transport.request('ping')).toEqual({ ok: true });
    expect(
      await transport.request('redirect').then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect(observed).toHaveLength(4);
    expect(observed.slice(1).every((item) => item.session === 'fixture-session')).toBe(true);
    expect(
      observed.every(
        (item) => item.authorization === null && item.protocol === MCP_PROTOCOL_VERSION,
      ),
    ).toBe(true);
  } finally {
    await transport.close();
    await server.stop(true);
  }
});

test('production stdio cannot launch under the service OS identity', () => {
  const previous = process.env.NODE_ENV;
  // Exercise the real launch gate with an environment owned by this child only.
  const moduleUrl = new URL('./mcp-transport.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { openStdioMcpTransport } = await import(${JSON.stringify(moduleUrl)});
    try {
      await openStdioMcpTransport({ transport: 'stdio', command: 'must-not-execute', args: [] });
      process.exitCode = 1;
    } catch (error) { console.log(error.message); }
  `,
    ],
    {
      env: { ...process.env, NODE_ENV: 'production' },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('requires an isolated OS launcher');
  expect(process.env.NODE_ENV).toBe(previous);
});

test('oversized MCP schemas are omitted while healthy tools and the server survive', async () => {
  let closed = false;
  const transport: McpTransport = {
    async request(method) {
      if (method === 'initialize')
        return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } };
      if (method === 'ping') return {};
      return {
        tools: [
          { name: 'read', inputSchema: { type: 'object' } },
          { name: 'write', inputSchema: { type: 'object', description: '\u754c'.repeat(1100) } },
        ],
      };
    },
    async notify() {},
    async close() {
      closed = true;
    },
  };
  const worker = await openMcpWorker(mcpFixtureConfig(), binding, { transport });
  try {
    expect(worker.tools.map((tool) => tool.name)).toEqual(['mcp_fixture.read']);
    expect(await worker.health()).toMatchObject({ status: 'degraded' });
    expect((await worker.health()).detail).toContain('write: schema exceeds 3000 UTF-8 bytes');
    expect(closed).toBe(false);
  } finally {
    await worker.close();
  }
});
