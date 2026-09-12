import { afterAll, expect, test } from 'bun:test';
import { connectionListResponse, connectionResponse } from '@melete/contracts';
import { BrokerService } from '../../src/broker/service.ts';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const registry = new ConnectorRegistry();
const queue = fixture ? await startQueue(fixture.url) : null;
afterAll(async () => {
  await registry.close();
  await queue?.stop();
  await fixture?.close();
}, 15_000);

(fixture ? test : test.skip)(
  'an operator installs an HTTP MCP connection into the live registry',
  async () => {
    if (!fixture || !queue) throw new Error('Postgres unavailable');
    let calls = 0;
    let fail = false;
    let releaseInitialize = () => {};
    let holdInitialize = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (fail) return new Response(null, { status: 503 });
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        if (message.method === 'initialize') await holdInitialize;
        if (message.method === 'tools/call') calls++;
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
            : message.method === 'tools/list'
              ? {
                  tools: [
                    { name: 'read', description: 'Live fixture', inputSchema: { type: 'object' } },
                  ],
                }
              : { content: [{ type: 'text', text: 'live-result' }] };
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      },
    });
    try {
      const jobs = new JobService(fixture.db, queue.boss);
      const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
        key: 'live-mcp-principal-key-at-least-32-bytes',
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
      const setup = await app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'runtime-mcp@example.test',
          password: 'runtime-mcp-password',
        }),
      });
      const cookie = setup.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error(`Setup failed: ${setup.status}`);
      const [space] = await fixture.sql`select id from space where kind = 'personal'`;
      if (!space) throw new Error('Missing personal space');
      const as = (token: string, body?: unknown): RequestInit => ({
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie: token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const row = await jobs.create({
        space_id: space.id,
        title: 'Live MCP',
        objective: 'Discover a later installation',
      });
      const claimed = await runner.claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'created',
      });
      if (!claimed) throw new Error('Attempt was not claimed');
      expect(claimed.claims.scopes).not.toContain('mcp_live.read');
      expect(claimed.claims.live_connection_scopes).toBe(true);
      expect(await broker.discovery.search(claimed.claims, 'live')).toEqual([]);
      const installation = {
        provider: 'mcp',
        space_id: space.id,
        label: 'Live fixture',
        mcp: {
          id: 'live',
          url: `${server.url}mcp`,
          allowed_scopes: ['mcp_live.read'],
          audience: 'owner',
          tools: [
            {
              name: 'read',
              alias: 'read',
              required_scopes: ['mcp_live.read'],
              effect_class: 'read',
            },
          ],
        },
      };
      expect((await app.request('/connections', as('', installation))).status).toBe(401);
      const pending = app.request('/connections', as(cookie, installation));
      let connectingId = '';
      for (let poll = 0; poll < 100; poll++) {
        const [connecting] =
          await fixture.sql`select id, setup_state from connection where provider = 'mcp'`;
        if (connecting?.setup_state === 'connecting') {
          connectingId = connecting.id;
          break;
        }
        await Bun.sleep(10);
      }
      expect(connectingId).not.toBe('');
      const connecting = await app.request(`/connections/${connectingId}`, as(cookie));
      expect(connectionResponse.parse(await connecting.json()).connection.setup_state).toBe(
        'connecting',
      );
      expect(await broker.discovery.search(claimed.claims, 'live')).toEqual([]);
      releaseInitialize();
      holdInitialize = Promise.resolve();
      const response = await pending;
      expect(response.status).toBe(201);
      const body = (await response.json()) as { connection: { id: string; setup_state: string } };
      expect(body.connection.setup_state).toBe('connected');
      expect(registry.get(body.connection.id)?.manifest.tools[0]?.name).toBe('mcp_live.read');
      expect(await broker.discovery.search(claimed.claims, 'live')).toMatchObject([
        { name: 'mcp_live.read', source: 'mcp' },
      ]);
      expect((await broker.discovery.load(claimed.claims, 'mcp_live.read')).tool.name).toBe(
        'mcp_live.read',
      );
      const proposal = { connection_id: body.connection.id, kind: 'mcp_live.read', payload: {} };
      for (const claims of [
        { ...claimed.claims, live_connection_scopes: undefined },
        { ...claimed.claims, live_connection_scopes: false },
      ]) {
        expect(await broker.discovery.search(claims, 'live')).toEqual([]);
        expect(await rejectionOf(broker.propose(claims, proposal))).toMatchObject({
          code: 'scope_denied',
        });
      }
      expect((await broker.propose(claimed.claims, proposal)).status).toBe('succeeded');
      expect(calls).toBe(1);
      expect((await app.request('/connections', as(cookie, installation))).status).toBe(409);
      const other = await app.request(
        '/principals',
        as(cookie, { email: 'runtime-member@example.test', password: 'runtime-member-password' }),
      );
      const otherId = ((await other.json()) as { principal: { id: string } }).principal.id;
      const login = await app.request(
        '/login',
        as('', { email: 'runtime-member@example.test', password: 'runtime-member-password' }),
      );
      const memberCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect((await app.request('/connections', as(memberCookie, installation))).status).toBe(403);
      expect(
        (await app.request(`/connections/${body.connection.id}`, as(memberCookie))).status,
      ).toBe(403);
      expect(
        connectionListResponse.parse(
          await (await app.request('/connections', as(memberCookie))).json(),
        ).connections,
      ).toEqual([]);
      expect(
        await rejectionOf(
          broker.discovery.search({ ...claimed.claims, principal_id: otherId }, 'live'),
        ),
      ).toMatchObject({ code: 'scope_denied' });
      await fixture.sql`update job set constraints = '{"public_compartment":true}'::jsonb where id = ${row.id}`;
      expect(await broker.discovery.search(claimed.claims, 'live')).toEqual([]);
      expect(
        await rejectionOf(broker.propose(claimed.claims, { ...proposal, payload: { fresh: 1 } })),
      ).toMatchObject({ code: 'scope_denied' });
      await fixture.sql`update job set constraints = '{}'::jsonb where id = ${row.id}`;
      await fixture.sql`update connection set scopes = '[]'::jsonb where id = ${body.connection.id}`;
      expect(await broker.discovery.search(claimed.claims, 'live')).toEqual([]);
      expect(
        await rejectionOf(broker.propose(claimed.claims, { ...proposal, payload: { fresh: 2 } })),
      ).toMatchObject({ code: 'scope_denied' });
      expect(calls).toBe(1);
      await fixture.sql`update connection set scopes = '["mcp_live.read"]'::jsonb where id = ${body.connection.id}`;
      await registry.close();
      const reopened = await configuredConnectors({
        sql: fixture.sql,
        workRoot: 'unused',
        spacesRoot: 'unused',
      });
      expect(reopened.get(body.connection.id)?.manifest.tools[0]?.name).toBe('mcp_live.read');
      await reopened.close();
      fail = true;
      const failed = await app.request(
        '/connections',
        as(cookie, {
          ...installation,
          mcp: {
            ...installation.mcp,
            id: 'unavailable',
            allowed_scopes: ['mcp_unavailable.read'],
            tools: [
              {
                name: 'read',
                alias: 'read',
                required_scopes: ['mcp_unavailable.read'],
                effect_class: 'read',
              },
            ],
          },
        }),
      );
      expect(failed.status).toBe(201);
      const failedBody = connectionResponse.parse(await failed.json()).connection;
      expect(failedBody.setup_state).toBe('error');
      expect(failedBody.status).toBe('error');
      expect(registry.get(failedBody.id)).toBeUndefined();
      expect(JSON.stringify(failedBody)).not.toContain('configuration');
      expect(JSON.stringify(failedBody)).not.toContain('secret_ref');
    } finally {
      releaseInitialize();
      await registry.close();
      await server.stop(true);
    }
  },
);
