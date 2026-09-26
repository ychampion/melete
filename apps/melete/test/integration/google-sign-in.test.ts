import { afterAll, describe, expect, test } from 'bun:test';
import {
  accountSignInAvailability,
  accountSignInStart,
  accountSignInStatus,
  connectionListResponse,
} from '@melete/contracts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { EmailConnector } from '../../src/connectors/email.ts';
import { startFakeGoogle } from '../../src/connectors/fixtures/fake-google.ts';
import { GoogleCalendarConnector } from '../../src/connectors/google-calendar.ts';
import { mailAction, mailContext } from '../../src/connectors/mail-fixtures.ts';
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
const google = await startFakeGoogle();
const closers: Array<() => Promise<unknown> | unknown> = [() => google.stop()];
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
    google: { client: google.client, endpoints: google.endpoints },
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
    as('', { email: 'google-owner@example.test', password: 'google-owner-password' }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Setup failed: ${setup.status}`);
  const [space] = await fixture.sql`select id from space where kind = 'personal'`;
  if (!space) throw new Error('Missing personal space');

  /** Start, approve at the fake consent screen, and return through the callback. */
  const signIn = async () => {
    const started = await app.request('/google-sign-ins', as(cookie, {}));
    expect(started.status).toBe(201);
    const start = accountSignInStart.parse(await started.json());
    const approved = await fetch(start.authorize_url, { redirect: 'manual' });
    const back = new URL(approved.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(start.redirect_uri);
    // The web app forwards /api/* to this service without the prefix.
    const landed = await app.request(`/oauth/google/callback${back.search}`, as(cookie));
    const page = await landed.text();
    const status = accountSignInStatus.parse(
      await (await app.request(`/google-sign-ins/${start.sign_in_id}`, as(cookie))).json(),
    );
    return { landed, page, status, back };
  };
  return { app, as, cookie, factory, spaceId: space.id as string, sql: fixture.sql, signIn };
}

const h = fixture ? await harness() : null;
const withDb = fixture ? describe : describe.skip;

withDb('signing in with Google', () => {
  test('one sign-in connects Gmail and Google Calendar, with the tokens only sealed', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const availability = accountSignInAvailability.parse(
      await (await h.app.request('/google-sign-ins', h.as(h.cookie))).json(),
    );
    expect(availability).toEqual({
      available: true,
      redirect_uri: `${PUBLIC_URL}/api/oauth/google/callback`,
    });

    const { landed, page, status, back } = await h.signIn();
    expect(landed.status).toBe(200);
    expect(page).toContain('connected');
    if (status.state !== 'connected') throw new Error(`Sign-in ended ${status.state}`);
    expect(status.connection_ids).toHaveLength(2);

    const listed = connectionListResponse
      .parse(await (await h.app.request('/connections', h.as(h.cookie))).json())
      .connections.filter((row) => status.connection_ids.includes(row.id));
    const mail = listed.find((row) => row.provider === 'imap');
    const calendar = listed.find((row) => row.provider === 'caldav');
    expect(mail).toMatchObject({ status: 'active', label: 'Gmail (person@example.test)' });
    expect(mail?.scopes).toEqual(
      expect.arrayContaining(['email.search', 'email.read', 'email.send']),
    );
    expect(calendar).toMatchObject({ status: 'active' });
    expect(calendar?.scopes).toContain('calendar.create');

    // The same tools and the same mailer path as a password mailbox.
    const mailer = h.factory.mailers.get(mail?.id ?? '');
    expect(mailer).toBeDefined();
    const gmail = registry.get(mail?.id ?? '');
    expect(gmail).toBeInstanceOf(EmailConnector);
    expect(registry.get(calendar?.id ?? '')).toBeInstanceOf(GoogleCalendarConnector);
    google.deliver(
      'From: friend@example.test\nTo: person@example.test\nSubject: Lunch\nMessage-ID: <lunch@example.test>\n\nThursday.\n',
    );
    const search = mailAction('email.search', { query: '', limit: 5 });
    const found = await (gmail as EmailConnector).execute(
      { ...search, connection_id: mail?.id ?? '' },
      { ...mailContext(), space_id: h.spaceId },
    );
    expect(found.outcome).toBe('succeeded');

    const readable =
      page +
      JSON.stringify(listed) +
      JSON.stringify(
        await h.sql`select label, scopes, configuration from connection
          where id in ${h.sql(status.connection_ids)}`,
      );
    const sealed = await h.sql`select s.ciphertext from connection c join secret s
      on s.id = c.secret_ref where c.id in ${h.sql(status.connection_ids)}`;
    for (const token of google.issued) {
      expect(readable).not.toContain(token);
      for (const row of sealed) expect(String(row.ciphertext)).not.toContain(token);
    }

    // The browser's return is spent once.
    const replayed = await h.app.request(`/oauth/google/callback${back.search}`, h.as(h.cookie));
    expect(replayed.status).toBe(404);
  }, 60_000);

  test('signing in again renews the same connections instead of adding more', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const before = await h.sql`select id, secret_ref from connection
      where configuration->>'account' = 'person@example.test' and status <> 'revoked' order by id`;
    const { status } = await h.signIn();
    if (status.state !== 'connected') throw new Error(`Sign-in ended ${status.state}`);
    expect([...status.connection_ids].sort()).toEqual(before.map((row) => row.id));
    const after = await h.sql`select id, secret_ref, status from connection
      where configuration->>'account' = 'person@example.test' and status <> 'revoked' order by id`;
    expect(after).toHaveLength(2);
    for (const [index, row] of after.entries()) {
      expect(row.status).toBe('active');
      expect(row.secret_ref).not.toBe(before[index]?.secret_ref);
    }
  }, 60_000);

  test('someone who may not install in a space is refused', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const member = await h.app.request(
      '/principals',
      h.as(h.cookie, { email: 'google-member@example.test', password: 'google-member-password' }),
    );
    expect(member.status).toBe(201);
    const login = await h.app.request(
      '/login',
      h.as('', { email: 'google-member@example.test', password: 'google-member-password' }),
    );
    const memberCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const refused = await h.app.request(
      '/google-sign-ins',
      h.as(memberCookie, { space_id: h.spaceId }),
    );
    expect(refused.status).toBe(403);
  }, 30_000);
});
