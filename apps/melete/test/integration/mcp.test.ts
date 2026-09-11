import { afterAll, expect, test } from 'bun:test';
import { type JsonObject, receipt } from '@melete/contracts';
import { loadAction } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { type McpWorker, openMcpWorker } from '../../src/connectors/mcp.ts';
import { mcpConnector } from '../../src/connectors/mcp-connector.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { mcpFixtureConfig } from '../fixtures/mcp-config.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const databaseTest = fixture ? test : test.skip;
const workers: McpWorker[] = [];
afterAll(async () => {
  for (const worker of workers) await worker.close();
  await queue?.stop();
  await fixture?.close();
}, 15_000);

async function setup(untrusted = false) {
  if (!fixture) throw new Error('Postgres unavailable');
  const scopes = ['mcp_fixture.read', 'mcp_fixture.write'];
  const seed = await seedJob(fixture.sql, { scopes, provider: 'mcp' });
  const worker = await openMcpWorker(mcpFixtureConfig(), {
    connectionId: seed.connectionId,
    spaceId: seed.claims.space_id,
  });
  workers.push(worker);
  let calls = 0;
  const connector = mcpConnector(
    worker,
    {
      connectionId: seed.connectionId,
      spaceId: seed.claims.space_id,
    },
    fixture.sql,
  );
  const execute = connector.execute;
  connector.execute = (action, ctx) => {
    calls++;
    return execute(action, ctx);
  };
  const connectors = new ConnectorRegistry().register(seed.connectionId, connector);
  const broker = new BrokerService({
    sql: fixture.sql,
    connectors,
    boss: queue?.boss,
    ...(untrusted
      ? {
          resolveTrust: createTableTrustResolver({
            'stranger@example.com': {
              origin_trust: 'external_content',
              handle: 'mcp:untrusted-address',
            },
          }),
          resolveStandingGrant: async () => true,
        }
      : {}),
  });
  return { ...seed, broker, worker, sql: fixture.sql, calls: () => calls };
}

databaseTest(
  'MCP read reaches a real stdio worker only through a broker action and receipt',
  async () => {
    const s = await setup();
    const proposal = await s.broker.propose(s.claims, {
      kind: 'mcp_fixture.read',
      connection_id: s.connectionId,
      payload: {},
    });
    expect(proposal.status).toBe('succeeded');
    expect(proposal.requires_approval).toBe(false);
    const action = await loadAction(s.sql, proposal.action_id);
    const acknowledgement = receipt.parse(action.receipt);
    expect(acknowledgement.detail.origin_trust).toBe('external_content');
    expect(acknowledgement.detail.evidence_handle).toBe(`mcp:fixture:${action.id}`);
    const result = acknowledgement.detail.result as JsonObject;
    expect((result.structuredContent as JsonObject).rows).toHaveLength(2);
    const [ledger] = await s.sql`select settled from budget_ledger where action_id = ${action.id}`;
    expect(ledger?.settled).toBe(1);
    expect(s.calls()).toBe(1);
  },
);

databaseTest(
  'MCP readOnlyHint cannot bypass approval, and repeated intent dispatches once',
  async () => {
    const s = await setup();
    const request = {
      kind: 'mcp_fixture.write',
      connection_id: s.connectionId,
      payload: { body: 'one external effect' },
    };
    const proposal = await s.broker.propose(s.claims, request);
    expect(proposal.status).toBe('needs_approval');
    expect(proposal.effect_class).toBe('write_external');
    expect(proposal.requires_approval).toBe(true);
    expect(
      await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
    ).toMatchObject({ code: 'action_not_admissible' });
    expect((await s.broker.dispatch(proposal.action_id)).status).toBe('needs_approval');
    expect(s.calls()).toBe(0);
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    const action = await s.broker.dispatch(proposal.action_id);
    expect(action.status).toBe('succeeded');
    const acknowledgement = receipt.parse(action.receipt);
    expect((acknowledgement.detail.result as JsonObject).structuredContent).toEqual({
      writes: 1,
      idempotency_key: action.id,
    });
    const repeated = await s.broker.propose(s.claims, request);
    expect(repeated.action_id).toBe(action.id);
    expect(repeated.intent_key).toBe(proposal.intent_key);
    expect(repeated.repeated).toBe(true);
    expect(s.calls()).toBe(1);
    expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(1);
  },
);

databaseTest(
  'MCP external origin cannot use a standing grant or dispatch before warning-bound approval',
  async () => {
    const s = await setup(true);
    const proposal = await s.broker.propose(s.claims, {
      kind: 'mcp_fixture.write',
      connection_id: s.connectionId,
      payload: { to: 'stranger@example.com', body: 'Untrusted destination' },
    });
    expect(proposal.origin_warnings).toMatchObject([
      { field: 'to', origin_trust: 'external_content', handle: 'mcp:untrusted-address' },
    ]);
    expect(
      await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
    ).toMatchObject({ code: 'untrusted_recipient_origin' });
    expect(s.calls()).toBe(0);
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    expect((await s.broker.dispatch(proposal.action_id)).status).toBe('succeeded');
    expect(s.calls()).toBe(1);
  },
);

databaseTest('MCP worker and server claims cannot make an ungranted tool callable', async () => {
  const s = await setup();
  const readOnly = { ...s.claims, scopes: ['mcp_fixture.read'] };
  expect(
    await rejectionOf(
      s.broker.propose(readOnly, {
        kind: 'mcp_fixture.write',
        connection_id: s.connectionId,
        payload: {},
      }),
    ),
  ).toMatchObject({ code: 'scope_denied' });
  expect(
    await rejectionOf(
      s.broker.propose(s.claims, {
        kind: 'mcp_fixture.claim_privileges',
        connection_id: s.connectionId,
        payload: {},
      }),
    ),
  ).toMatchObject({ code: 'unknown_tool' });
  expect(s.calls()).toBe(0);
  expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(0);
});

databaseTest(
  'MCP acknowledgement loss stays unknown across repeated intent and never replays',
  async () => {
    const s = await setup();
    const request = {
      kind: 'mcp_fixture.write',
      connection_id: s.connectionId,
      payload: { body: 'Accepted then disconnected', drop_ack: true },
    };
    const proposal = await s.broker.propose(s.claims, request);
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
    expect((await s.broker.dispatch(proposal.action_id)).status).toBe('unknown');
    const repeated = await s.broker.propose(s.claims, request);
    expect(repeated.status).toBe('unknown');
    expect(repeated.action_id).toBe(proposal.action_id);
    expect((await s.broker.verify(proposal.action_id)).status).toBe('unresolved');
    expect(s.calls()).toBe(1);
  },
);

databaseTest(
  'MCP owner-only tools disappear and reject direct calls in a public compartment',
  async () => {
    const s = await setup();
    expect((await s.broker.discovery.search(s.claims, 'fixture')).length).toBe(2);
    await s.broker.discovery.load(s.claims, 'mcp_fixture.read');
    await s.sql`update job set constraints = '{"public_compartment":true}'::jsonb where id = ${s.claims.job_id}`;
    expect(await s.broker.discovery.search(s.claims, 'fixture')).toEqual([]);
    expect((await s.broker.catalog(s.claims)).map((tool) => tool.name)).not.toContain(
      'mcp_fixture.read',
    );
    expect(
      await rejectionOf(
        s.broker.propose(s.claims, {
          kind: 'mcp_fixture.read',
          connection_id: s.connectionId,
          payload: {},
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    expect(s.calls()).toBe(0);
  },
);

databaseTest('MCP audience revocation after admission prevents worker dispatch', async () => {
  const s = await setup();
  const proposal = await s.broker.propose(s.claims, {
    kind: 'mcp_fixture.write',
    connection_id: s.connectionId,
    payload: { body: 'pending' },
  });
  await s.broker.decide(proposal.action_id, {
    decision: 'approved',
    payload_hash: proposal.payload_hash,
  });
  await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
  await s.sql`update space set audience = 'public' where id = ${s.claims.space_id}`;
  expect((await s.broker.dispatch(proposal.action_id)).status).toBe('failed');
  expect(s.calls()).toBe(0);
});

databaseTest(
  'operator HTTP installation registers as MCP, enforces 2020-12 schemas and closes its session',
  async () => {
    if (!fixture) throw new Error('Postgres unavailable');
    const seed = await seedJob(fixture.sql, {
      provider: 'mcp',
      scopes: ['mcp_fixture.read', 'mcp_fixture.write'],
    });
    let calls = 0;
    let closed = 0;
    const headers: Headers[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        headers.push(request.headers);
        if (request.method === 'DELETE') {
          closed++;
          return new Response(null, { status: 204 });
        }
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        let result: unknown = {};
        if (message.method === 'initialize') {
          result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
        } else if (message.method === 'tools/list') {
          result = {
            tools: [
              {
                name: 'read',
                description: 'Read fixture tuples',
                inputSchema: {
                  type: 'object',
                  properties: {
                    tuple: { type: 'array', prefixItems: [{ type: 'string' }], items: false },
                  },
                  required: ['tuple'],
                  additionalProperties: false,
                },
              },
              {
                name: 'write',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
              },
            ],
          };
        } else if (message.method === 'tools/call') {
          calls++;
          result = {
            content: [{ type: 'text', text: 'Rows' }],
            structuredContent: { rows: [1, 2] },
          };
        }
        return Response.json(
          { jsonrpc: '2.0', id: message.id, result },
          {
            headers:
              message.method === 'initialize' ? { 'MCP-Session-Id': 'configured-fixture' } : {},
          },
        );
      },
    });
    let registry: ConnectorRegistry | undefined;
    try {
      registry = await configuredConnectors({
        sql: fixture.sql,
        workRoot: 'unused',
        spacesRoot: 'unused',
        connections: [
          {
            kind: 'mcp',
            id: seed.connectionId,
            server: {
              ...mcpFixtureConfig(),
              endpoint: { transport: 'http', url: `${server.url}mcp` },
            },
          },
        ],
      });
      expect(registry.get(seed.connectionId)?.manifest.provider).toBe('mcp');
      const broker = new BrokerService({
        sql: fixture.sql,
        connectors: registry,
        boss: queue?.boss,
      });
      expect((await broker.discovery.search(seed.claims, 'tuples'))[0]?.source).toBe('mcp');
      const loaded = await broker.discovery.load(seed.claims, 'mcp_fixture.read');
      expect(loaded.tool.input_schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      const request = { kind: 'mcp_fixture.read', connection_id: seed.connectionId };
      for (const tuple of [[99], ['valid', 'extra']]) {
        expect(
          await rejectionOf(broker.propose(seed.claims, { ...request, payload: { tuple } })),
        ).toMatchObject({ code: 'payload_invalid' });
      }
      expect(calls).toBe(0);
      expect(
        (await broker.propose(seed.claims, { ...request, payload: { tuple: ['valid'] } })).status,
      ).toBe('succeeded');
      expect(calls).toBe(1);
      await fixture.sql`update connection set scopes = '[]'::jsonb where id = ${seed.connectionId}`;
      expect(
        await rejectionOf(
          broker.propose(seed.claims, { ...request, payload: { tuple: ['another'] } }),
        ),
      ).toMatchObject({ code: 'scope_denied' });
      expect(calls).toBe(1);
      await registry.close();
      expect(closed).toBe(1);
      expect(headers.every((value) => value.get('authorization') === null)).toBe(true);
      expect(
        headers.slice(1).every((value) => value.get('mcp-session-id') === 'configured-fixture'),
      ).toBe(true);
    } finally {
      await registry?.close();
      await server.stop(true);
    }
  },
);

databaseTest(
  'operator stdio configuration is refused before an unisolated service launch',
  async () => {
    if (!fixture) throw new Error('Postgres unavailable');
    const seed = await seedJob(fixture.sql, { provider: 'mcp' });
    const failure = await rejectionOf(
      configuredConnectors({
        sql: fixture.sql,
        workRoot: 'unused',
        spacesRoot: 'unused',
        connections: [{ kind: 'mcp', id: seed.connectionId, server: mcpFixtureConfig() }],
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('requires an isolated OS launcher');
  },
);
