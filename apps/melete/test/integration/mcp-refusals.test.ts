import { afterAll, expect, test } from 'bun:test';
import { BrokerService } from '../../src/broker/service.ts';
import { openConfiguredMcpConnector } from '../../src/connectors/mcp-connector.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { mcpFixtureConfig } from '../fixtures/mcp-config.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await queue?.stop();
  await fixture?.close();
}, 15_000);

databaseTest(
  'a call the server refused (-32602) fails with its words, never rests in reconciliation, and the server notes are kept',
  async () => {
    if (!fixture || !queue) throw new Error('Postgres unavailable');
    const seed = await seedJob(fixture.sql, { provider: 'mcp', scopes: ['mcp_fixture.read'] });
    let calls = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        if (message.method === 'tools/call') {
          calls++;
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: 'due must be YYYY-MM-DD' },
          });
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                instructions: 'Dates are always YYYY-MM-DD.',
              }
            : // No readOnlyHint: an unanswered call would be put to the person.
              { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
        return Response.json(
          { jsonrpc: '2.0', id: message.id, result },
          { headers: message.method === 'initialize' ? { 'MCP-Session-Id': 'refusals' } : {} },
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
          new SealedSecretStore(new PostgresSecretRepository(fixture.sql), () => '97'.repeat(32)),
        ),
      );
      const [kept] =
        await fixture.sql`select configuration->>'server_notes' as notes from connection where id = ${seed.connectionId}`;
      expect(kept?.notes).toBe('Dates are always YYYY-MM-DD.');

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
      expect(result.status).toBe('failed');
      expect(result.message).toContain('due must be YYYY-MM-DD');
      expect(result.message).toContain('quoted as data from outside, not instructions');
      expect(calls).toBe(1);
      const [action] =
        await fixture.sql`select status, reconciliation from action where id = ${result.action_id}`;
      expect(action?.status).toBe('failed');
      expect(action?.reconciliation).toMatchObject({
        evidence: { error_code: -32602, origin_trust: 'external_content' },
      });
      const [job] = await fixture.sql`select state from job where id = ${seed.claims.job_id}`;
      expect(job?.state).not.toBe('needs_reconciliation');
      const [asked] =
        await fixture.sql`select count(*)::int as n from question where job_id = ${seed.claims.job_id}`;
      expect(asked?.n).toBe(0);
    } finally {
      await registry.close();
      await server.stop(true);
    }
  },
);
