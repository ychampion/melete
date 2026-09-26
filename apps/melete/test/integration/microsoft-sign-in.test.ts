import { afterAll, describe, expect, test } from 'bun:test';
import {
  accountSignInAvailability,
  accountSignInStart,
  accountSignInStatus,
  connectionKindListResponse,
  connectionListResponse,
} from '@melete/contracts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { EmailConnector } from '../../src/connectors/email.ts';
import { startFakeMicrosoft } from '../../src/connectors/fixtures/fake-microsoft.ts';
import { OutlookCalendarConnector } from '../../src/connectors/outlook-calendar.ts';
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
const microsoft = await startFakeMicrosoft();
const closers: Array<() => Promise<unknown> | unknown> = [() => microsoft.stop()];
afterAll(async () => {
  for (const close of closers) await close();
  await registry.close();
  await queue?.stop();
  await fixture?.close();
}, 30_000);

async function harness() {
  if (!fixture || !queue) throw new Error('Postgres unavailable');
  const factory = new ConnectorFactory({
    sql: fixture.sql,
    workRoot: 'unused',
    spacesRoot: 'unused',
    masterKey: MASTER_KEY,
    microsoft: { client: microsoft.client, endpoints: microsoft.endpoints },
  });
  useConnectorFactory(registry, factory);
  const app = createApp({
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_MASTER_KEY: MASTER_KEY,
      MELETE_PUBLIC_URL: PUBLIC_URL,
    }),
    db: fixture.db,
    sql: fixture.sql,
    registry,
    jobs: new JobService(fixture.db, queue.boss),
    checkDatabase: async () => 'ok',
  });
  const as = (cookie: string, body?: unknown): RequestInit => ({
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setup = await app.request(
    '/setup',
    as('', { email: 'microsoft-owner@example.test', password: 'microsoft-owner-password' }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Setup failed: ${setup.status}`);

  const signIn = async () => {
    const started = await app.request('/microsoft-sign-ins', as(cookie, {}));
    expect(started.status).toBe(201);
    const start = accountSignInStart.parse(await started.json());
    const approved = await fetch(start.authorize_url, { redirect: 'manual' });
    const back = new URL(approved.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(start.redirect_uri);
    const landed = await app.request(`/oauth/microsoft/callback${back.search}`, as(cookie));
    const page = await landed.text();
    const status = accountSignInStatus.parse(
      await (await app.request(`/microsoft-sign-ins/${start.sign_in_id}`, as(cookie))).json(),
    );
    return { landed, page, status };
  };
  return { app, as, cookie, factory, sql: fixture.sql, signIn };
}

const h = fixture ? await harness() : null;
const withDb = fixture ? describe : describe.skip;

withDb('signing in with Microsoft', () => {
  test('one sign-in connects Outlook mail and calendar, with the tokens only sealed', async () => {
    if (!h) throw new Error('Postgres unavailable');
    expect(
      accountSignInAvailability.parse(
        await (await h.app.request('/microsoft-sign-ins', h.as(h.cookie))).json(),
      ),
    ).toEqual({ available: true, redirect_uri: `${PUBLIC_URL}/api/oauth/microsoft/callback` });
    // Google is not configured here, and says so.
    expect(
      accountSignInAvailability.parse(
        await (await h.app.request('/google-sign-ins', h.as(h.cookie))).json(),
      ).available,
    ).toBe(false);
    // The catalog says the same, and offers the known MCP servers now there is an address to return to.
    const catalog =
      connectionKindListResponse.parse(
        await (await h.app.request('/connection-kinds', h.as(h.cookie))).json(),
      ).catalog ?? [];
    expect(catalog.find((entry) => entry.id === 'microsoft')?.available).toBe(true);
    expect(catalog.find((entry) => entry.id === 'google')?.available).toBe(false);
    expect(catalog.find((entry) => entry.id === 'linear')).toMatchObject({
      available: true,
      connect: { method: 'mcp_sign_in', url: 'https://mcp.linear.app/mcp' },
    });

    const { landed, page, status } = await h.signIn();
    expect(landed.status).toBe(200);
    expect(page).toContain('connected');
    if (status.state !== 'connected') throw new Error(`Sign-in ended ${status.state}`);
    const listed = connectionListResponse
      .parse(await (await h.app.request('/connections', h.as(h.cookie))).json())
      .connections.filter((row) => status.connection_ids.includes(row.id));
    const mail = listed.find((row) => row.provider === 'imap');
    const calendar = listed.find((row) => row.provider === 'caldav');
    expect(mail).toMatchObject({ status: 'active', label: 'Outlook (person@outlook.example)' });
    expect(calendar).toMatchObject({ status: 'active' });
    expect(registry.get(mail?.id ?? '')).toBeInstanceOf(EmailConnector);
    expect(registry.get(calendar?.id ?? '')).toBeInstanceOf(OutlookCalendarConnector);
    expect(h.factory.mailers.has(mail?.id ?? '')).toBe(true);

    const readable =
      page +
      JSON.stringify(listed) +
      JSON.stringify(
        await h.sql`select label, scopes, configuration from connection
          where id in ${h.sql(status.connection_ids)}`,
      );
    const sealed = await h.sql`select s.ciphertext from connection c join secret s
      on s.id = c.secret_ref where c.id in ${h.sql(status.connection_ids)}`;
    for (const token of microsoft.issued) {
      expect(readable).not.toContain(token);
      for (const row of sealed) expect(String(row.ciphertext)).not.toContain(token);
    }
  }, 60_000);

  test('signing in again renews the same connections instead of adding more', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const before = await h.sql`select id from connection
      where configuration->>'account' = 'person@outlook.example' and status <> 'revoked' order by id`;
    const { status } = await h.signIn();
    if (status.state !== 'connected') throw new Error(`Sign-in ended ${status.state}`);
    expect([...status.connection_ids].sort()).toEqual(before.map((row) => row.id));
  }, 60_000);
});
