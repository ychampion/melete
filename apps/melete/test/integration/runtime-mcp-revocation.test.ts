import { expect, test } from 'bun:test';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

for (const initialization of ['succeeds', 'fails'] as const) {
  test(`revocation during MCP initialization remains final when initialization ${initialization}`, async () => {
    const fixture = await testDatabase();
    if (!fixture) throw new Error('Postgres unavailable');
    const registry = new ConnectorRegistry();
    const queue = await startQueue(fixture.url);
    let calls = 0;
    let closedSessions = 0;
    let reachedInitialize = () => {};
    const initializing = new Promise<void>((resolve) => {
      reachedInitialize = resolve;
    });
    let releaseInitialize = () => {};
    const held = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method === 'DELETE') {
          closedSessions++;
          return new Response(null, { status: 204 });
        }
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        if (message.method === 'initialize') {
          reachedInitialize();
          await held;
          if (initialization === 'fails') return new Response(null, { status: 503 });
        }
        if (message.method === 'tools/call') calls++;
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
            : message.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'read',
                      description: 'Revoked fixture',
                      inputSchema: { type: 'object' },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'must-not-be-called' }] };
        return Response.json(
          { jsonrpc: '2.0', id: message.id, result },
          {
            headers: { 'Mcp-Session-Id': 'revoked-initialization-session' },
          },
        );
      },
    });
    let pending: Promise<Response> | undefined;
    try {
      const jobs = new JobService(fixture.db, queue.boss);
      const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
        key: 'revoked-mcp-principal-key-at-least-32-bytes',
        liveConnectionScopes: true,
      });
      const broker = new BrokerService({
        sql: fixture.sql,
        connectors: registry,
        boss: queue.boss,
      });
      const app = createApp({
        env: loadEnv({ NODE_ENV: 'test' }),
        db: fixture.db,
        sql: fixture.sql,
        registry,
        jobs,
        checkDatabase: async () => 'ok',
      });
      const request = (cookie: string, body: unknown): RequestInit => ({
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const setup = await app.request(
        '/setup',
        request('', {
          email: 'initialization-race@example.test',
          password: 'initialization-race-password',
        }),
      );
      expect(setup.status).toBe(201);
      const cookie = setup.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error('Missing owner session');
      const [space] = await fixture.sql`select id from space where kind = 'personal'`;
      if (!space) throw new Error('Missing personal space');
      pending = Promise.resolve(
        app.request(
          '/connections',
          request(cookie, {
            provider: 'mcp',
            space_id: space.id,
            label: 'Paused installation',
            mcp: {
              id: 'paused',
              url: `${server.url}mcp`,
              allowed_scopes: ['mcp_paused.read'],
              audience: 'owner',
              tools: [
                {
                  name: 'read',
                  alias: 'read',
                  required_scopes: ['mcp_paused.read'],
                  effect_class: 'read',
                },
              ],
            },
          }),
        ),
      );
      await initializing;
      const [connection] =
        await fixture.sql`select id, generation, setup_state from connection where space_id = ${space.id}`;
      expect(connection).toMatchObject({ generation: 0, setup_state: 'connecting' });
      if (!connection) throw new Error('Missing connecting row');
      const revoked = await app.request(
        `/connections/${connection.id}/lifecycle`,
        request(cookie, {
          kind: 'revoke',
          expected_generation: connection.generation,
        }),
      );
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ generation: 1, status: 'revoked' });
      const state =
        () => fixture.sql`select status, generation, setup_state, health, last_checked_at
        from connection where id = ${connection.id}`;
      const revokedState = await state();
      releaseInitialize();
      const response = await pending;
      expect(await state()).toEqual(revokedState);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'generation_conflict' } });
      expect(registry.get(connection.id)).toBeUndefined();
      expect(closedSessions).toBe(initialization === 'succeeds' ? 1 : 0);

      // A fresh attempt after revocation must also be refused; stale-token rejection alone is insufficient.
      const row = await jobs.create({
        space_id: space.id,
        title: 'After revocation',
        objective: 'Try the paused tool',
      });
      const fresh = await runner.claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'created',
      });
      if (!fresh) throw new Error('Missing fresh attempt');
      expect(await broker.discovery.search(fresh.claims, 'paused')).toEqual([]);
      await rejectionOf(broker.discovery.load(fresh.claims, 'mcp_paused.read'));
      await rejectionOf(
        broker.propose(fresh.claims, {
          connection_id: connection.id,
          kind: 'mcp_paused.read',
          payload: {},
        }),
      );
      expect(calls).toBe(0);
    } finally {
      releaseInitialize();
      await pending?.catch(() => {});
      await registry.close();
      await server.stop(true);
      await queue.stop();
      await fixture.close();
    }
  }, 30_000);
}
