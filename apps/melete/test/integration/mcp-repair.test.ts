import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrokerService } from '../../src/broker/service.ts';
import { openMcpWorker } from '../../src/connectors/mcp.ts';
import { mcpConnector, openConfiguredMcpConnector } from '../../src/connectors/mcp-connector.ts';
import { mcpCredentialAccess } from '../../src/connectors/mcp-credentials.ts';
import { type McpTransport, openStdioMcpTransport } from '../../src/connectors/mcp-transport.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { mcpFixtureConfig } from '../fixtures/mcp-config.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const databaseTest = fixture ? test : test.skip;
async function removeFixtureDirectory(directory: string, temp: string) {
  if (dirname(resolve(directory)) !== temp || (await realpath(directory)) !== resolve(directory))
    throw new Error('Unverified repair fixture directory');
  await rm(directory, { recursive: true, force: true });
}
afterAll(async () => {
  await queue?.stop();
  await fixture?.close();
}, 15_000);

for (const failure of ['terminated', 'unauthorized', 'lost-ack'] as const) {
  databaseTest(
    `HTTP MCP ${failure} stops at its repair bound without replaying an uncertain effect`,
    async () => {
      if (!fixture || !queue) throw new Error('Postgres unavailable');
      const seed = await seedJob(fixture.sql, { provider: 'mcp', scopes: ['mcp_fixture.read'] });
      const binding = { connectionId: seed.connectionId, spaceId: seed.claims.space_id };
      const store = new SealedSecretStore(new PostgresSecretRepository(fixture.sql), () =>
        '96'.repeat(32),
      );
      let initializations = 0;
      let refreshes = 0;
      let requests = 0;
      let effects = 0;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname === '/token') {
            refreshes++;
            return Response.json({ access_token: 'fresh-mcp-token', token_type: 'Bearer' });
          }
          if (request.method === 'DELETE') return new Response(null, { status: 204 });
          const message = (await request.json()) as { id?: number; method: string };
          if (message.id === undefined) return new Response(null, { status: 202 });
          if (message.method === 'tools/call') {
            requests++;
            if (failure !== 'lost-ack')
              return new Response(null, { status: failure === 'terminated' ? 404 : 401 });
            effects++;
            return new Response('{"jsonrpc":"2.0","result":', {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (message.method === 'initialize') initializations++;
          return Response.json(
            {
              jsonrpc: '2.0',
              id: message.id,
              result:
                message.method === 'initialize'
                  ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
                  : { tools: [{ name: 'read', inputSchema: { type: 'object' } }] },
            },
            {
              headers:
                message.method === 'initialize'
                  ? { 'MCP-Session-Id': `bounded-${initializations}` }
                  : {},
            },
          );
        },
      });
      const registry = new ConnectorRegistry();
      try {
        const secret = await store.put(
          binding.spaceId,
          JSON.stringify({
            access_token: 'old-mcp-token',
            refresh_token: 'old-refresh-token',
            token_url: `${server.url}token`,
          }),
        );
        await fixture.sql`update connection set secret_ref = ${secret} where id = ${binding.connectionId}`;
        const config = mcpFixtureConfig();
        config.tools = config.tools.filter((tool) => tool.name === 'read');
        registry.register(
          binding.connectionId,
          await openConfiguredMcpConnector(
            { ...config, endpoint: { transport: 'http', url: `${server.url}mcp` } },
            binding,
            fixture.sql,
            store,
          ),
        );
        const broker = new BrokerService({
          sql: fixture.sql,
          connectors: registry,
          boss: queue.boss,
        });
        const result = await broker.propose(seed.claims, {
          kind: 'mcp_fixture.read',
          connection_id: binding.connectionId,
          payload: {},
        });
        expect(result.status).toBe(failure === 'lost-ack' ? 'unknown' : 'failed');
        expect(initializations).toBe(
          failure === 'terminated' ? 3 : failure === 'unauthorized' ? 2 : 1,
        );
        expect(requests).toBe(initializations);
        expect(effects).toBe(failure === 'lost-ack' ? 1 : 0);
        expect(refreshes).toBe(failure === 'unauthorized' ? 1 : 0);
        const [action] =
          await fixture.sql`select receipt, repair_disposition from action where id = ${result.action_id}`;
        expect(action?.receipt).toBeNull();
        expect(action?.repair_disposition).toBe(
          failure === 'lost-ack' ? 'needs_reconciliation' : 'repair_exhausted',
        );
      } finally {
        await registry.close();
        await server.stop(true);
      }
    },
  );
}

databaseTest(
  'a terminated HTTP MCP session reconnects through repair before one receipted call',
  async () => {
    if (!fixture || !queue) throw new Error('Postgres unavailable');
    const seed = await seedJob(fixture.sql, { provider: 'mcp', scopes: ['mcp_fixture.read'] });
    let initializations = 0;
    let calls = 0;
    let expired = false;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        const message = (await request.json()) as { id?: number; method: string };
        if (message.method === 'tools/call' && !expired) {
          expired = true;
          return new Response(null, { status: 404 });
        }
        if (message.id === undefined) return new Response(null, { status: 202 });
        let result: unknown = {};
        if (message.method === 'initialize') {
          initializations++;
          result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
        } else if (message.method === 'tools/list') {
          result = { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
        } else if (message.method === 'tools/call') {
          calls++;
          result = { content: [{ type: 'text', text: 'reconnected-result' }] };
        }
        return Response.json(
          { jsonrpc: '2.0', id: message.id, result },
          {
            headers:
              message.method === 'initialize'
                ? { 'MCP-Session-Id': `repair-${initializations}` }
                : {},
          },
        );
      },
    });
    const registry = new ConnectorRegistry();
    try {
      const config = mcpFixtureConfig();
      config.tools = config.tools.filter((tool) => tool.name === 'read');
      registry.register(
        seed.connectionId,
        await openConfiguredMcpConnector(
          { ...config, endpoint: { transport: 'http', url: `${server.url}mcp` } },
          { connectionId: seed.connectionId, spaceId: seed.claims.space_id },
          fixture.sql,
        ),
      );
      const broker = new BrokerService({
        sql: fixture.sql,
        connectors: registry,
        boss: queue.boss,
      });
      const result = await broker.propose(seed.claims, {
        kind: 'mcp_fixture.read',
        connection_id: seed.connectionId,
        payload: {},
      });
      expect(result.status).toBe('succeeded');
      expect(initializations).toBe(2);
      expect(calls).toBe(1);
      const [action] =
        await fixture.sql`select receipt, repair_trace from action where id = ${result.action_id}`;
      expect(action?.receipt?.detail?.result?.content?.[0]?.text).toBe('reconnected-result');
      expect(action?.repair_trace).toMatchObject([
        { fault_kind: 'transient_before_dispatch', decision: 'retry_with_backoff' },
        { decision: 'verified_completion' },
      ]);
    } finally {
      await registry.close();
      await server.stop(true);
    }
  },
);

for (const transport of ['http', 'stdio'] as const) {
  for (const scenario of ['disconnect', 'expired', 'revoked', 'revoked-during-refresh'] as const) {
    databaseTest(
      `${transport} MCP ${scenario} obeys repair, sealed credentials and current grants`,
      async () => {
        if (!fixture || !queue) throw new Error('Postgres unavailable');
        const seed = await seedJob(fixture.sql, {
          provider: 'mcp',
          scopes: ['mcp_fixture.read'],
          budget: { max_attempts: scenario === 'revoked' ? 1 : 3 },
        });
        const binding = { connectionId: seed.connectionId, spaceId: seed.claims.space_id };
        const store = new SealedSecretStore(new PostgresSecretRepository(fixture.sql), () =>
          '93'.repeat(32),
        );
        let calls = 0;
        let initializations = 0;
        let refreshes = 0;
        let rejectSession = scenario === 'disconnect';
        let activated = false;
        let authorized = false;
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(request) {
            if (new URL(request.url).pathname === '/token') {
              refreshes++;
              const form = new URLSearchParams(await request.text());
              expect(form.get('grant_type')).toBe('refresh_token');
              expect(form.get('refresh_token')).toBe('old-refresh-token');
              if (scenario === 'revoked-during-refresh')
                await fixture.sql`update connection set status = 'disabled', generation = generation + 1 where id = ${binding.connectionId}`;
              return Response.json({
                access_token: 'fresh-mcp-token',
                refresh_token: 'rotated-refresh-token',
                token_type: 'Bearer',
                expires_in: 3600,
              });
            }
            if (request.method === 'DELETE') return new Response(null, { status: 204 });
            const message = (await request.json()) as { id?: number; method: string };
            if (message.id === undefined) return new Response(null, { status: 202 });
            if (activated && message.method === 'tools/call') {
              if (rejectSession) {
                rejectSession = false;
                return new Response(null, { status: 404 });
              }
              if (scenario === 'revoked') return new Response(null, { status: 403 });
              if (
                scenario !== 'disconnect' &&
                request.headers.get('authorization') !== 'Bearer fresh-mcp-token'
              )
                return new Response(null, { status: 401 });
            }
            let result: unknown = {};
            if (message.method === 'initialize') {
              initializations++;
              result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
            } else if (message.method === 'tools/list')
              result = { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
            else if (message.method === 'tools/call') {
              calls++;
              authorized = request.headers.get('authorization') === 'Bearer fresh-mcp-token';
              result = { content: [{ type: 'text', text: 'http-repaired-result' }] };
            }
            return Response.json(
              { jsonrpc: '2.0', id: message.id, result },
              {
                headers:
                  message.method === 'initialize'
                    ? { 'MCP-Session-Id': `session-${initializations}` }
                    : {},
              },
            );
          },
        });
        const temp = await realpath(tmpdir());
        const directory = await mkdtemp(join(temp, 'melete-repair-test-'));
        const statePath = join(directory, 'state.json');
        const registry = new ConnectorRegistry();
        try {
          const credential = {
            access_token: 'stale-mcp-token',
            refresh_token: 'old-refresh-token',
            token_url: `${server.url}token`,
            // Stdio has no HTTP auth status; the sealed expiry is checked before its call.
            ...(transport === 'stdio' && scenario !== 'disconnect'
              ? { expires_at: '2020-01-01T00:00:00Z' }
              : {}),
          };
          const oldRef = await store.put(binding.spaceId, JSON.stringify(credential));
          await fixture.sql`update connection set secret_ref = ${oldRef} where id = ${binding.connectionId}`;
          const config = mcpFixtureConfig();
          config.tools = config.tools.filter((tool) => tool.name === 'read');
          let local: McpTransport | undefined;
          if (transport === 'http') {
            registry.register(
              binding.connectionId,
              await openConfiguredMcpConnector(
                { ...config, endpoint: { transport: 'http', url: `${server.url}mcp` } },
                binding,
                fixture.sql,
                store,
              ),
            );
          } else {
            await writeFile(statePath, JSON.stringify({ initializations: 0, calls: 0 }));
            const endpoint = {
              transport: 'stdio' as const,
              command: process.execPath,
              args: [
                fileURLToPath(new URL('../fixtures/mcp-repair-server.ts', import.meta.url)),
                statePath,
              ],
            };
            const credentials = mcpCredentialAccess(fixture.sql, store, binding);
            const worker = await openMcpWorker({ ...config, endpoint }, binding, {
              ...credentials,
              transportFactory: async () => {
                local = await openStdioMcpTransport(endpoint, credentials);
                return local;
              },
            });
            registry.register(
              binding.connectionId,
              mcpConnector(worker, binding, fixture.sql, credentials),
            );
            if (scenario === 'disconnect') await local?.close();
            if (scenario === 'revoked') {
              const ref = await store.put(
                binding.spaceId,
                JSON.stringify({ ...credential, status: 'revoked' }),
              );
              await fixture.sql`update connection set secret_ref = ${ref} where id = ${binding.connectionId}`;
            }
          }
          activated = true;
          const broker = new BrokerService({
            sql: fixture.sql,
            connectors: registry,
            boss: queue.boss,
          });
          const result = await broker.propose(seed.claims, {
            kind: 'mcp_fixture.read',
            connection_id: binding.connectionId,
            payload: {},
          });
          if (transport === 'stdio')
            ({ calls, initializations, authorized } = JSON.parse(
              await readFile(statePath, 'utf8'),
            ));
          const [action] =
            await fixture.sql`select receipt, repair_trace, repair_disposition from action where id = ${result.action_id}`;
          const [connection] =
            await fixture.sql`select secret_ref from connection where id = ${binding.connectionId}`;
          const question =
            await fixture.sql`select id from question where job_id = ${seed.claims.job_id} and state = 'open'`;
          if (scenario === 'revoked' || scenario === 'revoked-during-refresh') {
            expect(result.status).toBe('failed');
            expect(calls).toBe(0);
            expect(action?.repair_disposition).toBe('needs_reconnect');
            expect(question).toHaveLength(1);
            expect(refreshes).toBe(scenario === 'revoked' ? 0 : 1);
            if (scenario === 'revoked') {
              const jobs = new JobService(fixture.db, queue.boss);
              const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
                key: 'mcp-repair-completion-guard-test-key',
              });
              await fixture.sql`update attempt set lease_expires_at = now() + interval '1 minute' where id = ${seed.claims.attempt_id}`;
              await runner.commitOutcome(seed.claims, {
                kind: 'completed',
                summary: 'Runtime claims done',
                evidence: [],
              });
              expect((await jobs.get(seed.claims.job_id)).state).toBe('waiting_for_input');
              expect(
                await fixture.sql`select id from question where job_id = ${seed.claims.job_id} and state = 'open'`,
              ).toHaveLength(1);
            }
            if (scenario === 'revoked-during-refresh') expect(connection?.secret_ref).toBe(oldRef);
          } else {
            expect(result.status).toBe('succeeded');
            expect(calls).toBe(1);
            expect(initializations).toBe(2);
            expect(refreshes).toBe(scenario === 'expired' ? 1 : 0);
            expect(question).toHaveLength(0);
            expect(action?.receipt?.action_id).toBe(result.action_id);
            if (scenario === 'expired') {
              expect(authorized).toBe(true);
              expect(connection?.secret_ref).not.toBe(oldRef);
              const rotated = await store.withSecret(
                connection?.secret_ref,
                binding.spaceId,
                async (value) => JSON.parse(value),
              );
              expect(rotated.refresh_token).toBe('rotated-refresh-token');
            }
          }
          const stored =
            await fixture.sql`select ciphertext from secret where space_id = ${binding.spaceId}`;
          expect(JSON.stringify(stored)).not.toContain('mcp-token');
          expect(JSON.stringify(action)).not.toContain('mcp-token');
          expect(JSON.stringify(action)).not.toContain('refresh-token');
        } finally {
          await registry.close();
          await server.stop(true);
          await removeFixtureDirectory(directory, temp);
        }
      },
    );
  }
}
