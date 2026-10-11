import { afterAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { EmailConnector } from '../../src/connectors/email.ts';
import type { MailTransport, OutgoingMail } from '../../src/connectors/mail-transport.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { maskEmail } from '../../src/experience/signin.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const databaseTest = database ? test : test.skip;
afterAll(async () => {
  await database?.close();
});

type Refusal = { error: { code: string } };

test('a sign-in link names its account with most of the address hidden', () => {
  expect(maskEmail('owner@example.test')).toBe('o•••@example.test');
  expect(maskEmail('a@b.co')).toBe('a•••@b.co');
  expect(maskEmail('first.last+tag@mail.example.com')).toBe('f•••@mail.example.com');
  expect(maskEmail('no-at-sign')).toBe('•••');
});

databaseTest(
  'magic links use the owner mailbox, bind its generation, expire, end with their account, and consume once',
  async () => {
    if (!database) throw new Error('Postgres unavailable');
    const sql = database.sql;
    const ownerId = newId('own'),
      spaceId = newId('sp'),
      connectionId = newId('conn');
    const email = 'owner@example.test';
    await sql`insert into owner (id, email) values (${ownerId}, ${email})`;
    await sql`insert into principal (id, email) values (${ownerId}, ${email})`;
    await sql`insert into space (id, name, kind, git_path) values (${spaceId}, 'Personal', 'personal', '/fixture')`;
    await sql`insert into connection (id, space_id, provider, label, scopes) values (${connectionId}, ${spaceId}, 'imap', 'Mail', '["email.send"]'::jsonb)`;
    const sent: OutgoingMail[] = [];
    const transport: MailTransport = {
      search: async () => [],
      read: async () => null,
      send: async (message) => {
        sent.push(message);
        return { messageId: message.messageId, sentCopy: true };
      },
      findSent: async () => false,
      health: async () => {},
    };
    const connector = new EmailConnector(
      {
        id: connectionId,
        spaceId,
        secretRef: 'fixture',
        username: email,
        from: email,
        imap: { host: 'mail.example.test', port: 993, secure: true },
        smtp: { host: 'mail.example.test', port: 465, secure: true },
      },
      { withSecret: async (_id, _space, use) => use('fixture-password') },
      () => transport,
    );
    expect(connector.canSendSignIn(spaceId, 'someone@example.test')).toBe(false);
    expect(connector.canSendSignIn('foreign', email)).toBe(false);
    const app = createApp({
      db: database.db,
      sql,
      registry: new ConnectorRegistry().register(connectionId, connector),
      env: loadEnv({ NODE_ENV: 'test', MELETE_PUBLIC_URL: 'https://melete.example.test' }),
      checkDatabase: async () => 'ok',
    });
    const post = (path: string, body: unknown, headers = {}) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect((await post('/signin/magic-link', { email: 'stranger@example.test' })).status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(
      (await post('/signin/magic-link', { email }, { Origin: 'https://foreign.example.test' }))
        .status,
    ).toBe(403);
    expect(await (await post('/signin/magic-link', { email })).json()).toEqual({ status: 'ok' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual([email]);
    const tokenFromMail = () => {
      const url = sent.at(-1)?.body.match(/https:\/\/[^\s]+/)?.[0];
      if (!url) throw new Error('Missing sign-in URL');
      expect(new URL(url).origin).toBe('https://melete.example.test');
      // The sign-in screen's route, with the token in its query, where the web app reads it.
      const hash = new URL(url).hash;
      expect(hash).toMatch(/^#\/welcome\?token=[A-Za-z0-9_-]+$/);
      const value = new URLSearchParams(hash.split('?')[1]).get('token');
      if (!value) throw new Error('Missing sign-in token');
      return value;
    };
    const first = tokenFromMail();
    const [stored] = await sql`select * from magic_link`;
    expect(stored?.token_hash).toBe(createHash('sha256').update(first).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(first);
    // Opening the link only checks it. However often that happens (a mail
    // scanner opening it, a reload), it signs no one in and spends nothing.
    const sessions = async () => (await sql`select count(*)::int as n from session`)[0]?.n;
    const before = await sessions();
    for (let opened = 0; opened < 3; opened++) {
      const checked = await post('/signin/magic-link/check', { token: first });
      expect(checked.status).toBe(200);
      expect(checked.headers.get('Set-Cookie')).toBeNull();
      expect(await checked.json()).toEqual({ status: 'ok', masked_email: 'o•••@example.test' });
    }
    expect(await sessions()).toBe(before);
    const [unspent] =
      await sql`select used_at from magic_link where token_hash = ${stored?.token_hash}`;
    expect(unspent?.used_at).toBeNull();
    // Pressing Sign in uses it once; a second press, even at the same moment, is refused.
    const responses = await Promise.all([
      post('/signin/magic-link/consume', { token: first }),
      post('/signin/magic-link/consume', { token: first }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const cookie = responses.find((response) => response.status === 200)?.headers.get('Set-Cookie');
    expect(cookie).toContain('HttpOnly');
    expect((await app.request('/home', { headers: { Cookie: cookie ?? '' } })).status).toBe(200);
    expect((await post('/signin/magic-link/consume', { token: first })).status).toBe(400);
    // Opened again after it was used, the link says so and names no account.
    const reopened = await post('/signin/magic-link/check', { token: first });
    expect(reopened.status).toBe(400);
    const refusal = (await reopened.json()) as Refusal;
    expect(refusal.error.code).toBe('invalid_signin_link');
    expect(JSON.stringify(refusal)).not.toContain('example.test');
    // A token cut short, or one never issued, reads the same as a used one.
    for (const token of ['short', 'x'.repeat(43)]) {
      const odd = await post('/signin/magic-link/check', { token });
      expect(odd.status).toBe(400);
      expect(((await odd.json()) as Refusal).error.code).toBe('invalid_signin_link');
    }
    // So does a body that holds no token at all, rather than a server error.
    for (const body of [
      {},
      { token: 7 },
      { token: first, more: true },
      { token: 'x'.repeat(2001) },
    ]) {
      const odd = await post('/signin/magic-link/check', body);
      expect(odd.status).toBe(400);
      expect(((await odd.json()) as Refusal).error.code).toBe('invalid_signin_link');
    }
    await sql`update magic_link set created_at = now() - interval '2 minutes'`;
    await post('/signin/magic-link', { email });
    const second = tokenFromMail();
    await sql`update connection set generation = generation + 1 where id = ${connectionId}`;
    expect((await post('/signin/magic-link/check', { token: second })).status).toBe(400);
    expect((await post('/signin/magic-link/consume', { token: second })).status).toBe(400);
    await sql`update magic_link set created_at = now() - interval '2 minutes'`;
    await post('/signin/magic-link', { email });
    const third = tokenFromMail();
    await sql`update magic_link set expires_at = now() - interval '1 second' where used_at is null`;
    expect((await post('/signin/magic-link/check', { token: third })).status).toBe(400);
    expect((await post('/signin/magic-link/consume', { token: third })).status).toBe(400);
    // A link that works stops working once the operator disables its account.
    const fourth = randomBytes(32).toString('base64url');
    await sql`insert into magic_link (token_hash, owner_id, space_id, expires_at)
      values (${createHash('sha256').update(fourth).digest('hex')}, ${ownerId}, ${spaceId},
        now() + interval '10 minutes')`;
    expect((await post('/signin/magic-link/check', { token: fourth })).status).toBe(200);
    await sql`update principal set disabled_at = now() where id = ${ownerId}`;
    expect((await post('/signin/magic-link/check', { token: fourth })).status).toBe(400);
    expect((await post('/signin/magic-link/consume', { token: fourth })).status).toBe(400);
    const [records] =
      await sql`select (select count(*) from action)::int as actions, (select count(*) from event)::int as events`;
    expect(records).toMatchObject({ actions: 0, events: 0 });
  },
);
