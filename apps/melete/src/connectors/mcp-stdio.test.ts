import { expect, test } from 'bun:test';
import { type JsonObject, mcpStdioLaunch } from '@melete/contracts';
import { DISHONEST_TOOLS, FakeStdioLauncher } from '../../test/fixtures/stdio-launcher.ts';
import { mcpServerConfig, mcpToolDefinition, openMcpWorker } from './mcp.ts';
import { STDIO_REFUSALS, StdioServer } from './mcp-stdio.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

const binding = { connectionId: 'conn_01J00000000000000000000000', spaceId: 'sp_01' };
const launch = mcpStdioLaunch.parse({
  runner: 'npx',
  source: '@example/notes-server@1.0.0',
  args: ['/data'],
  secret_env_names: ['NOTES_TOKEN'],
});
const config = mcpServerConfig.parse({
  id: 'notes',
  audience: 'owner',
  allowed_scopes: ['mcp_notes.lookup', 'mcp_notes.publish'],
  tools: [
    {
      name: 'lookup',
      alias: 'lookup',
      required_scopes: ['mcp_notes.lookup'],
      effect_class: 'read',
    },
    { name: 'publish', alias: 'publish', required_scopes: ['mcp_notes.publish'] },
  ],
  endpoint: { transport: 'container', launch },
});
const pinned = DISHONEST_TOOLS.filter((tool) => tool.name !== 'grant_everything').map((tool) =>
  mcpToolDefinition.parse(tool),
);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lifecycle(options: { idleMs?: number; authorized?: boolean } = {}) {
  const launcher = new FakeStdioLauncher();
  const server = new StdioServer(
    { ...binding, launch },
    launcher,
    async () => (options.authorized === false ? null : { env: { NOTES_TOKEN: 'sealed-value' } }),
    { idleMs: options.idleMs ?? 60_000 },
  );
  const worker = await openMcpWorker(config, binding, {
    transportFactory: () => server.open(),
    pinned,
  });
  const reopen = () => worker.reconnect();
  return { launcher, server, worker, reopen };
}

test('a stdio server starts for its first call, stops when idle, and starts again', async () => {
  const { launcher, server, worker, reopen } = await lifecycle({ idleMs: 40 });
  // The recorded catalog is enough to offer tools: nothing runs until a call needs the server.
  expect(worker.tools.map((tool) => tool.name)).toEqual(['mcp_notes.lookup', 'mcp_notes.publish']);
  expect(launcher.starts).toHaveLength(0);

  expect(await server.ready(reopen)).toBeUndefined();
  expect(launcher.starts).toHaveLength(1);
  expect(launcher.starts[0]?.env).toEqual({ NOTES_TOKEN: 'sealed-value' });
  const action = connectorAction('mcp_notes.lookup', { q: 'x' });
  const context = {
    ...connectorContext(action),
    audience: 'owner',
    scopes: ['mcp_notes.lookup'],
  };
  expect(
    (await worker.execute({ ...action, connection_id: binding.connectionId }, context)).outcome,
  ).toBe('succeeded');
  // A second call while it runs reuses the same server.
  expect(await server.ready(reopen)).toBeUndefined();
  server.done();
  server.done();
  expect(launcher.starts).toHaveLength(1);

  await pause(120);
  expect(server.status).toBe('stopped');
  expect(launcher.running).toBe(0);
  expect(launcher.stops).toBe(1);

  expect(await server.ready(reopen)).toBeUndefined();
  expect(launcher.starts).toHaveLength(2);
  server.done();
  await worker.close();
  await server.close();
  expect(launcher.running).toBe(0);
});

test('a server that keeps crashing is left stopped until its owner tests it', async () => {
  const { launcher, server, worker, reopen } = await lifecycle();
  // A crash while running counts once.
  expect(await server.ready(reopen)).toBeUndefined();
  launcher.crash();
  server.done();
  expect(server.status).toBe('stopped');

  launcher.behaviour.crashOnStart = true;
  expect(await server.ready(reopen)).toBe(STDIO_REFUSALS.start);
  server.done();
  expect(await server.ready(reopen)).toBe(STDIO_REFUSALS.crashLoop);
  server.done();
  expect(server.status).toBe('crash_loop');
  const attempts = launcher.starts.length;

  // No call starts it again, however many arrive.
  for (let index = 0; index < 5; index++) {
    expect(await server.ready(reopen)).toBe(STDIO_REFUSALS.crashLoop);
    server.done();
  }
  expect(launcher.starts).toHaveLength(attempts);

  // The owner's test is one deliberate retry; a server that now starts serves again.
  launcher.behaviour.crashOnStart = false;
  const health = await server.check(reopen, () => worker.health());
  expect(health.status).toBe('ok');
  expect(launcher.starts).toHaveLength(attempts + 1);
  expect(server.status).toBe('running');
  await worker.close();
  await server.close();
});

test('a restarted server that describes different tools is refused and stopped', async () => {
  const { launcher, server, worker, reopen } = await lifecycle();
  launcher.behaviour.tools = DISHONEST_TOOLS.map((tool) =>
    tool.name === 'lookup'
      ? { ...tool, inputSchema: { type: 'object', properties: { q: { type: 'number' } } } }
      : tool,
  );
  expect(await server.ready(reopen)).toBe(STDIO_REFUSALS.start);
  server.done();
  expect(launcher.starts).toHaveLength(1);
  expect(launcher.running).toBe(0);
  await worker.close();
  await server.close();
});

test('nothing starts once the connection is gone', async () => {
  const { launcher, server, worker, reopen } = await lifecycle({ authorized: false });
  expect(await server.ready(reopen)).toBe(STDIO_REFUSALS.start);
  server.done();
  expect(launcher.starts).toHaveLength(0);
  await worker.close();
  await server.close();
  // A closed server never starts again.
  await expect(server.open()).rejects.toThrow('closed');
});

test("a server's annotations and results never change what a tool may do", async () => {
  const { server, worker, reopen } = await lifecycle();
  // The policy, not readOnlyHint or a description, decides each tool; an unnamed tool is absent.
  expect(
    worker.tools.map((tool) => [tool.name, tool.effect_class, tool.requires_approval]),
  ).toEqual([
    ['mcp_notes.lookup', 'read', false],
    ['mcp_notes.publish', 'write_external', true],
  ]);
  expect(await server.ready(reopen)).toBeUndefined();
  const action = {
    ...connectorAction('mcp_notes.lookup', { q: 'x' }),
    connection_id: binding.connectionId,
  };
  const result = await worker.execute(action, {
    ...connectorContext(action),
    audience: 'owner',
    scopes: ['mcp_notes.lookup'],
  });
  if (result.outcome !== 'succeeded') throw new Error(result.outcome);
  // A result that claims the owner's authority is carried as external content, never obeyed.
  expect(result.receipt.detail.origin_trust).toBe('external_content');
  const structured = (result.receipt.detail.result as JsonObject).structuredContent as JsonObject;
  expect(structured.origin_trust).toBe('owner');
  server.done();
  await worker.close();
  await server.close();
});

test('a deployment with no room refuses a start in plain words without counting it a crash', async () => {
  const { launcher, server, worker, reopen } = await lifecycle();
  launcher.busy = true;
  for (let index = 0; index < 5; index++) {
    expect(await server.ready(reopen)).toBe(STDIO_REFUSALS.busy);
    server.done();
  }
  expect(server.status).toBe('stopped');
  expect(launcher.starts).toHaveLength(0);
  launcher.busy = false;
  expect(await server.ready(reopen)).toBeUndefined();
  server.done();
  await worker.close();
  await server.close();
});
