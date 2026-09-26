import { afterAll, describe, expect, test } from 'bun:test';
import { connectionResponse, mcpSignInStart, mcpSignInStatus } from '@melete/contracts';
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
