import { afterAll, describe, expect, test } from 'bun:test';
import {
  connectionKindListResponse,
  connectionResponse,
  experienceConnectionList,
  mcpSignInStart,
  mcpSignInStatus,
} from '@melete/contracts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { startFakeMcpAuth } from '../../src/connectors/fixtures/fake-mcp-auth.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '93'.repeat(32);
const PUBLIC_URL = 'http://localhost:3000';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const registry = new ConnectorRegistry();
/** Where the catalog's apps are, for this run: the fake servers each test starts. */
const catalogUrls: Record<string, string> = {};
const closers: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => {
  for (const close of closers) await close();
  await registry.close();
  await queue?.stop();
  await fixture?.close();
}, 30_000);

async function harness() {
  if (!fixture || !queue) throw new Error('Postgres unavailable');
  useConnectorFactory(
    registry,
    new ConnectorFactory({
      sql: fixture.sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      masterKey: MASTER_KEY,
      insecureLocalFixtures: true,
      mcpCatalogUrls: catalogUrls,
    }),
  );
  const jobs = new JobService(fixture.db, queue.boss);
  const appAt = (publicUrl: string) =>
    createApp({
      env: loadEnv({
        NODE_ENV: 'test',
        MELETE_MASTER_KEY: MASTER_KEY,
        MELETE_PUBLIC_URL: publicUrl,
      }),
      db: fixture.db,
      sql: fixture.sql,
      registry,
      jobs,
      checkDatabase: async () => 'ok',
    });
  const app = appAt(PUBLIC_URL);
  const as = (cookie: string, body?: unknown): RequestInit => ({
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setup = await app.request(
    '/setup',
    as('', { email: 'sign-in-owner@example.test', password: 'sign-in-owner-password' }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Setup failed: ${setup.status}`);
  const [space] = await fixture.sql`select id from space where kind = 'personal'`;
  if (!space) throw new Error('Missing personal space');
  return { app, appAt, as, cookie, spaceId: space.id as string, sql: fixture.sql };
}

const h = fixture ? await harness() : null;
const withDb = fixture ? describe : describe.skip;

const signInBody = (url: string) => ({
  label: 'Files',
  mcp: {
    id: 'files',
    url,
    allowed_scopes: ['mcp_files.read_file'],
    audience: 'owner',
    tools: [
      {
        name: 'read_file',
        alias: 'read_file',
        required_scopes: ['mcp_files.read_file'],
        effect_class: 'read',
      },
    ],
  },
});

withDb('signing in to a remote MCP server', () => {
  test('the browser returns, and the server is installed with a sealed, resource-bound credential', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const server = await startFakeMcpAuth({ issParameter: true });
    closers.push(server.stop);

    const started = await h.app.request('/mcp-sign-ins', h.as(h.cookie, signInBody(server.mcpUrl)));
    expect(started.status).toBe(201);
    const start = mcpSignInStart.parse(await started.json());
    expect(start.redirect_uri).toBe(`${PUBLIC_URL}/api/oauth/callback`);
    // Where the person will sign in, and what is asked for, before the browser goes there.
    expect(start.issuer).toBe(server.issuer);
    expect(start.scopes.map((item) => item.scope)).toEqual(
      new URL(start.authorize_url).searchParams.get('scope')?.split(' ') ?? [],
    );
    expect(start.scopes.map((item) => item.scope)).toContain('files:read');
    const pending = await h.app.request(`/mcp-sign-ins/${start.sign_in_id}`, h.as(h.cookie));
    expect(mcpSignInStatus.parse(await pending.json()).state).toBe('pending');

    // The person approves; the authorization server sends the browser back.
    const approved = await fetch(start.authorize_url, { redirect: 'manual' });
    expect(approved.status).toBe(302);
    const back = new URL(approved.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(start.redirect_uri);
    // The web app forwards /api/* to this service without the prefix.
    const landed = await h.app.request(`/oauth/callback${back.search}`, h.as(h.cookie));
    const page = await landed.text();
    expect(landed.status).toBe(200);
    expect(page).toContain('Files is connected');

    const done = mcpSignInStatus.parse(
      await (await h.app.request(`/mcp-sign-ins/${start.sign_in_id}`, h.as(h.cookie))).json(),
    );
    if (done.state !== 'connected') throw new Error(`Sign-in ended ${done.state}`);
    const installed = connectionResponse.parse(
      await (await h.app.request(`/connections/${done.connection_id}`, h.as(h.cookie))).json(),
    ).connection;
    expect(installed).toMatchObject({ provider: 'mcp', status: 'active' });

    // The token request named the resource, and no token reaches a reader.
    expect(server.tokenRequests[0]?.get('resource')).toBe(server.mcpUrl);
    const readable =
      page +
      JSON.stringify(await (await h.app.request('/connections', h.as(h.cookie))).json()) +
      JSON.stringify(
        await h.sql`select label, scopes, configuration from connection where id = ${installed.id}`,
      );
    for (const token of server.issued) expect(readable).not.toContain(token);
    const [sealed] =
      await h.sql`select s.ciphertext from connection c join secret s on s.id = c.secret_ref where c.id = ${installed.id}`;
    for (const token of server.issued)
      expect(String(sealed?.ciphertext ?? '')).not.toContain(token);

    // The same response cannot be spent twice.
    const replayed = await h.app.request(`/oauth/callback${back.search}`, h.as(h.cookie));
    expect(replayed.status).toBe(404);

    // Later the server refuses a call for want of a scope, and the transport
    // records it. The connection says it needs more access, and signing in again
    // for it asks for that scope with everything granted before.
    await h.sql`update connection
      set configuration = jsonb_set(configuration, '{needs_scope}', '["files:write"]'::jsonb)
      where id = ${installed.id}`;
    const flagged = connectionResponse.parse(
      await (await h.app.request(`/connections/${installed.id}`, h.as(h.cookie))).json(),
    ).connection;
    expect(flagged.needs_scope).toEqual(['files:write']);
    const [before] = await h.sql`select secret_ref from connection where id = ${installed.id}`;
    const [counted] = await h.sql`select count(*)::int as count from connection`;
    const rowsBefore = counted?.count;
    const again = await h.app.request(
      '/mcp-sign-ins',
      h.as(h.cookie, { connection_id: installed.id }),
    );
    expect(again.status).toBe(201);
    const restart = mcpSignInStart.parse(await again.json());
    expect(new URL(restart.authorize_url).searchParams.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining(['files:read', 'files:write']),
    );
    const approvedAgain = await fetch(restart.authorize_url, { redirect: 'manual' });
    const backAgain = new URL(approvedAgain.headers.get('location') ?? '');
    const renewed = await h.app.request(`/oauth/callback${backAgain.search}`, h.as(h.cookie));
    expect(renewed.status).toBe(200);
    const after = connectionResponse.parse(
      await (await h.app.request(`/connections/${installed.id}`, h.as(h.cookie))).json(),
    ).connection;
    expect(after).toMatchObject({ id: installed.id, status: 'active' });
    expect(after.needs_scope).toBeUndefined();
    const [afterRow] = await h.sql`select secret_ref from connection where id = ${installed.id}`;
    expect(afterRow?.secret_ref).not.toBe(before?.secret_ref);
    const [recounted] = await h.sql`select count(*)::int as count from connection`;
    expect(recounted?.count).toBe(rowsBefore);
  }, 60_000);

  test('someone who may not install in a space is refused before the server is contacted', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const server = await startFakeMcpAuth();
    closers.push(server.stop);
    const member = await h.app.request(
      '/principals',
      h.as(h.cookie, { email: 'sign-in-member@example.test', password: 'sign-in-member-password' }),
    );
    expect(member.status).toBe(201);
    const login = await h.app.request(
      '/login',
      h.as('', { email: 'sign-in-member@example.test', password: 'sign-in-member-password' }),
    );
    const memberCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const refused = await h.app.request(
      '/mcp-sign-ins',
      h.as(memberCookie, { ...signInBody(server.mcpUrl), space_id: h.spaceId }),
    );
    expect(refused.status).toBe(403);
    expect(server.requests).toEqual([]);
    // Nor may they sign in again for someone else's connection.
    const [owned] = await h.sql`select id from connection
      where provider = 'mcp' and status <> 'revoked' order by id limit 1`;
    expect(owned).toBeDefined();
    const again = await h.app.request(
      '/mcp-sign-ins',
      h.as(memberCookie, { connection_id: owned?.id }),
    );
    expect(again.status).toBe(403);
  }, 30_000);

  test('the client metadata document is public, and only published at an https address', async () => {
    if (!h) throw new Error('Postgres unavailable');
    expect((await h.app.request('/oauth/client-metadata.json')).status).toBe(404);
    const published = await h
      .appAt('https://melete.example.test')
      .request('/oauth/client-metadata.json');
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      client_id: 'https://melete.example.test/api/oauth/client-metadata.json',
      redirect_uris: ['https://melete.example.test/api/oauth/callback'],
      token_endpoint_auth_method: 'none',
    });
  }, 30_000);
});

withDb('connecting an app from the catalog', () => {
  test('one click installs the tools the catalog names that the app has, and disconnect removes it', async () => {
    if (!h) throw new Error('Postgres unavailable');
    // The app speaks the stateless revision and lists one tool the catalog does not name.
    const server = await startFakeMcpAuth({
      issParameter: true,
      protocol: '2026-07-28',
      tools: [
        { name: 'notion-search' },
        { name: 'notion-fetch' },
        { name: 'notion-create-comment' },
        { name: 'notion-delete-everything' },
      ],
    });
    closers.push(server.stop);
    catalogUrls.notion = server.mcpUrl;

    const kinds = connectionKindListResponse.parse(
      await (await h.app.request('/connection-kinds', h.as(h.cookie))).json(),
    );
    const notion = kinds.catalog?.find((entry) => entry.id === 'notion');
    if (notion?.connect.method !== 'mcp_sign_in') throw new Error('Notion is not in the catalog');
    expect(notion.available).toBe(true);
    // What it may do is shown before connecting, with what asks first.
    expect(notion.connect.tools).toContainEqual({
      label: 'Comment as you',
      effect_class: 'write_external',
      asks_first: true,
    });
    expect(notion.connect.tools).toContainEqual({
      label: 'Search your workspace',
      effect_class: 'read',
      asks_first: false,
    });

    const started = await h.app.request('/mcp-sign-ins', h.as(h.cookie, { catalog_id: 'notion' }));
    expect(started.status).toBe(201);
    const start = mcpSignInStart.parse(await started.json());
    expect(start.issuer).toBe(server.issuer);
    // The app takes dynamic registration, and is told what kind of client this is.
    expect(server.registrations).toHaveLength(1);
    expect(server.registrations[0]).toMatchObject({ application_type: 'native' });

    const approved = await fetch(start.authorize_url, { redirect: 'manual' });
    const back = new URL(approved.headers.get('location') ?? '');
    expect(new URL(start.authorize_url).searchParams.get('resource')).toBe(server.mcpUrl);
    const landed = await h.app.request(`/oauth/callback${back.search}`, h.as(h.cookie));
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain('Notion is connected');
    const done = mcpSignInStatus.parse(
      await (await h.app.request(`/mcp-sign-ins/${start.sign_in_id}`, h.as(h.cookie))).json(),
    );
    if (done.state !== 'connected') throw new Error(`Sign-in ended ${done.state}`);

    const [row] = await h.sql`select label, scopes, configuration from connection
      where id = ${done.connection_id}`;
    if (!row) throw new Error('Notion was not installed');
    expect(row.label).toBe('Notion');
    expect(row.configuration.catalog).toBe('notion');
    const installed = (row.configuration.server.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(installed.sort()).toEqual(['notion-create-comment', 'notion-fetch', 'notion-search']);
    expect([...(row.scopes as string[])].sort()).toEqual([
      'mcp_notion.create_comment',
      'mcp_notion.fetch',
      'mcp_notion.search',
    ]);
    // The running connector offers exactly those, and asks first only for the comment.
    const connector = registry.get(done.connection_id);
    const offered = Object.fromEntries(
      (connector?.manifest.tools ?? []).map((tool) => [tool.name, tool.requires_approval]),
    );
    expect(offered).toEqual({
      'mcp_notion.create_comment': true,
      'mcp_notion.fetch': false,
      'mcp_notion.search': false,
    });
    // Every request after signing in was a stateless one, with the earned token.
    const signedIn = server.messages;
    expect(signedIn.map((message) => message.method)).not.toContain('initialize');
    expect(signedIn.every((message) => message.headers.authorization?.startsWith('Bearer '))).toBe(
      true,
    );

    // The app shows as Notion, running.
    const listed = experienceConnectionList.parse(
      await (await h.app.request('/experience/connections', h.as(h.cookie))).json(),
    );
    expect(listed.connections.find((item) => item.id === done.connection_id)).toMatchObject({
      app: 'Notion',
      label: 'Notion',
      catalog_id: 'notion',
      status: 'connected',
    });

    // Disconnecting removes it from the list, and its tools from the agent.
    const current = connectionResponse.parse(
      await (await h.app.request(`/connections/${done.connection_id}`, h.as(h.cookie))).json(),
    ).connection;
    const removed = await h.app.request(
      `/connections/${done.connection_id}/lifecycle`,
      h.as(h.cookie, { kind: 'revoke', expected_generation: current.generation }),
    );
    expect(removed.status).toBe(200);
    const after = experienceConnectionList.parse(
      await (await h.app.request('/experience/connections', h.as(h.cookie))).json(),
    );
    expect(after.connections.some((item) => item.id === done.connection_id)).toBe(false);
    // Each call re-reads the row before it goes out, and a revoked row authorizes none.
    const [revoked] = await h.sql`select status from connection where id = ${done.connection_id}`;
    expect(revoked?.status).toBe('revoked');
  }, 60_000);

  test('an app whose server offers none of the catalog tools is not installed', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const server = await startFakeMcpAuth({ tools: [{ name: 'something_else' }] });
    closers.push(server.stop);
    catalogUrls.linear = server.mcpUrl;
    const started = mcpSignInStart.parse(
      await (await h.app.request('/mcp-sign-ins', h.as(h.cookie, { catalog_id: 'linear' }))).json(),
    );
    const approved = await fetch(started.authorize_url, { redirect: 'manual' });
    const back = new URL(approved.headers.get('location') ?? '');
    const landed = await h.app.request(`/oauth/callback${back.search}`, h.as(h.cookie));
    expect(landed.status).toBe(502);
    const [counted] = await h.sql`select count(*)::int as count from connection
      where configuration->>'catalog' = 'linear'`;
    expect(counted?.count).toBe(0);
    const status = mcpSignInStatus.parse(
      await (await h.app.request(`/mcp-sign-ins/${started.sign_in_id}`, h.as(h.cookie))).json(),
    );
    expect(status).toEqual({ state: 'failed', error: 'catalog_tools_unavailable' });
  }, 60_000);

  test('an app that needs a registered client is not offered until the operator sets one', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const kinds = connectionKindListResponse.parse(
      await (await h.app.request('/connection-kinds', h.as(h.cookie))).json(),
    );
    const github = kinds.catalog?.find((entry) => entry.id === 'github');
    expect(github?.available).toBe(false);
    // The operator is told what to set; the URL to register the callback is in it.
    expect(github?.setup_hint).toContain('GITHUB_MCP_CLIENT_ID');
    expect(github?.setup_hint).toContain(`${PUBLIC_URL}/api/oauth/callback`);
    const refused = await h.app.request('/mcp-sign-ins', h.as(h.cookie, { catalog_id: 'github' }));
    expect(refused.status).toBe(409);
    const unknown = await h.app.request('/mcp-sign-ins', h.as(h.cookie, { catalog_id: 'nope' }));
    expect(unknown.status).toBe(404);
  }, 30_000);
});
