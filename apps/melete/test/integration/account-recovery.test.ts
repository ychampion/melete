import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { describeReset, operatorReset } from '../../src/account/reset-password.ts';
import { EmailConnector } from '../../src/connectors/email.ts';
import type { MailTransport, OutgoingMail } from '../../src/connectors/mail-transport.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const describeWithDb = handle ? describe : describe.skip;
const email = 'owner@example.test';
const password = 'first-password-1';

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

function app() {
  return createApp({
    env: loadEnv({ NODE_ENV: 'test' }),
    db: database().db,
    sql: database().sql,
    checkDatabase: async () => 'ok',
  });
}

/**
 * An app whose owner has their own mailbox connected, so reset links go out by
 * email. `send` stands in for the mail server.
 */
async function withMailbox(send: (message: OutgoingMail) => Promise<void>) {
  const [space] = await database().sql`select s.id from space s
    join principal p on p.id = s.owner_principal_id where p.email = ${email} limit 1`;
  if (!space) throw new Error('no personal space');
  const connectionId = newId('conn');
  await database().sql`insert into connection (id, space_id, provider, label, scopes)
    values (${connectionId}, ${space.id}, 'imap', 'Mail', '["email.send"]'::jsonb)`;
  const transport: MailTransport = {
    search: async () => [],
    read: async () => null,
    send: async (message) => {
      await send(message);
      return { messageId: message.messageId, sentCopy: true };
    },
    findSent: async () => false,
    health: async () => {},
  };
  const connector = new EmailConnector(
    {
      id: connectionId,
      spaceId: String(space.id),
      secretRef: 'fixture',
      username: email,
      from: email,
      imap: { host: 'mail.example.test', port: 993, secure: true },
      smtp: { host: 'mail.example.test', port: 465, secure: true },
    },
    { withSecret: async (_id, _space, use) => use('fixture-password') },
    () => transport,
  );
  return createApp({
    env: loadEnv({ NODE_ENV: 'test', MELETE_PUBLIC_URL: 'https://melete.test' }),
    db: database().db,
    sql: database().sql,
    registry: new ConnectorRegistry().register(connectionId, connector),
    checkDatabase: async () => 'ok',
  });
}

const tokenIn = (message: OutgoingMail | undefined) => {
  const url = message?.body.match(/https:\/\/\S+/)?.[0];
  const query = url ? new URL(url).hash.split('?')[1] : undefined;
  const token = query ? new URLSearchParams(query).get('token') : null;
  if (!token) throw new Error('No reset link in the mail');
  return token;
};

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let tries = 0; tries < 100; tries++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting');
};

const json = (body: object, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});
const cookieOf = (response: Response) => {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('No session cookie was set');
  return value;
};
const sessionCount = async () =>
  Number((await database().sql`select count(*)::int as n from session`)[0]?.n);

describeWithDb('changing and resetting a password', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
  }, 15_000);
  afterAll(async () => {
    await handle?.close();
  });

  async function signedIn(api = app()) {
    const setup = await api.request('/setup', json({ email, password }));
    expect(setup.status).toBe(201);
    const here = cookieOf(setup);
    const elsewhere = cookieOf(await api.request('/login', json({ email, password })));
    return { api, here, elsewhere };
  }

  test('change password checks the current one, keeps this session and ends the others', async () => {
    const { api, here, elsewhere } = await signedIn();
    // A wrong current password is refused without signing the person out.
    const wrong = await api.request(
      '/account/password',
      json({ current_password: 'not-it-at-all', new_password: 'second-password-2' }, here),
    );
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('wrong_password');
    expect((await api.request('/me', { headers: { Cookie: here } })).status).toBe(200);

    const changed = await api.request(
      '/account/password',
      json({ current_password: password, new_password: 'second-password-2' }, here),
    );
    expect(changed.status).toBe(200);
    expect((await api.request('/me', { headers: { Cookie: here } })).status).toBe(200);
    expect((await api.request('/me', { headers: { Cookie: elsewhere } })).status).toBe(401);
    expect(await sessionCount()).toBe(1);
    expect((await api.request('/login', json({ email, password }))).status).toBe(401);
    expect(
      (await api.request('/login', json({ email, password: 'second-password-2' }))).status,
    ).toBe(200);
    // Both rows that carry the account's password moved together.
    const [row] = await database()
      .sql`select (select password_hash from owner) = (select password_hash from principal) as same`;
    expect(row?.same).toBe(true);
  });

  test('change password is throttled per account', async () => {
    const { api, here } = await signedIn();
    const statuses = [];
    for (let index = 0; index < 7; index++)
      statuses.push(
        (
          await api.request(
            '/account/password',
            json(
              { current_password: `wrong-${index}-guess`, new_password: 'another-pass-3' },
              here,
            ),
          )
        ).status,
      );
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 4).every((status) => status === 400)).toBe(true);
  });

  test('the operator command prints a one-time link that sets a password and ends every session', async () => {
    const { api, here, elsewhere } = await signedIn();
    const missing = await operatorReset(database().sql, 'nobody@example.test', undefined);
    expect(missing.ok).toBe(false);
    expect(describeReset(missing)).toContain('No account signs in as nobody@example.test');

    const first = await operatorReset(database().sql, 'Owner@Example.test', 'https://melete.test');
    const second = await operatorReset(database().sql, email, 'https://melete.test');
    if (!first.ok || !second.ok) throw new Error('reset was not issued');
    expect(second.link).toStartWith('https://melete.test/#/reset?token=');
    expect(describeReset(second)).toContain('expires in 60 minutes');
    // Only a digest is stored.
    const stored = await database().sql`select token_hash from password_reset`;
    expect(stored.map((row) => row.token_hash)).toContain(
      createHash('sha256').update(second.code).digest('hex'),
    );
    expect(JSON.stringify(stored)).not.toContain(second.code);

    // The older link stopped working when the newer one was printed.
    const stale = await api.request(
      '/password-reset/consume',
      json({ token: first.code, new_password: 'reset-password-4' }),
    );
    expect(stale.status).toBe(400);

    const used = await api.request(
      '/password-reset/consume',
      json({ token: second.code, new_password: 'reset-password-4' }),
    );
    expect(used.status).toBe(200);
    expect(await sessionCount()).toBe(0);
    for (const cookie of [here, elsewhere])
      expect((await api.request('/me', { headers: { Cookie: cookie } })).status).toBe(401);
    expect(
      (await api.request('/login', json({ email, password: 'reset-password-4' }))).status,
    ).toBe(200);
    // A link works once.
    const again = await api.request(
      '/password-reset/consume',
      json({ token: second.code, new_password: 'reset-password-5' }),
    );
    expect(again.status).toBe(400);
  });

  test('one link used twice at once sets exactly one password', async () => {
    const { api } = await signedIn();
    const issued = await operatorReset(database().sql, email, undefined);
    if (!issued.ok) throw new Error('reset was not issued');
    const tries = ['racing-password-1', 'racing-password-2'];
    const statuses = await Promise.all(
      tries.map(
        async (next) =>
          (
            await api.request(
              '/password-reset/consume',
              json({ token: issued.code, new_password: next }),
            )
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual([200, 400]);
    const signIns = await Promise.all(
      tries.map(
        async (next) => (await api.request('/login', json({ email, password: next }))).status,
      ),
    );
    expect(signIns.filter((status) => status === 200)).toHaveLength(1);
  });

  async function connectApp() {
    const [owner] = await database().sql`select p.id, s.id as space_id from principal p
      join space s on s.owner_principal_id = p.id where p.email = ${email} limit 1`;
    if (!owner) throw new Error('no owner');
    await database().sql`insert into mcp_client (id, name, redirect_uris)
      values ('mcp_client_test', 'Test app', ${JSON.stringify(['https://app.example.test/cb'])}::jsonb)
      on conflict (id) do nothing`;
    for (const kind of ['access', 'refresh'])
      await database().sql`insert into mcp_token (token_hash, kind, family, client_id, principal_id,
        space_id, resource, scope, expires_at)
        values (${`hash-${kind}`}, ${kind}, 'family-1', 'mcp_client_test', ${owner.id},
        ${owner.space_id}, 'https://melete.test/mcp', 'melete', now() + interval '1 day')`;
  }
  const liveAppTokens = async () =>
    Number(
      (await database().sql`select count(*)::int as n from mcp_token where revoked_at is null`)[0]
        ?.n,
    );

  test('a reset also ends what connected apps were granted', async () => {
    await signedIn();
    await connectApp();
    const issued = await operatorReset(database().sql, email, undefined);
    if (!issued.ok) throw new Error('reset was not issued');
    const used = await app().request(
      '/password-reset/consume',
      json({ token: issued.code, new_password: 'reset-password-6' }),
    );
    expect(used.status).toBe(200);
    expect(await liveAppTokens()).toBe(0);
  });

  test('changing the password also ends what connected apps were granted', async () => {
    const { api, here } = await signedIn();
    await connectApp();
    expect(await liveAppTokens()).toBe(2);
    const changed = await api.request(
      '/account/password',
      json({ current_password: password, new_password: 'second-password-2' }, here),
    );
    expect(changed.status).toBe(200);
    expect(await liveAppTokens()).toBe(0);
  });

  test('asking for an email link answers before the mail goes out', async () => {
    await signedIn();
    const sent: OutgoingMail[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = await withMailbox(async (message) => {
      await gate;
      sent.push(message);
    });
    // The owner's address and a stranger's are answered the same way, without
    // waiting on the mail server.
    for (const address of [email, 'stranger@example.test']) {
      const answer = await Promise.race([
        api.request('/password-reset', json({ email: address })),
        Bun.sleep(3_000).then(() => 'waited on the mail server' as const),
      ]);
      if (typeof answer === 'string') throw new Error(answer);
      expect(await answer.json()).toEqual({ status: 'ok' });
    }
    expect(sent).toHaveLength(0);
    release();
    await until(() => sent.length === 1);
    expect(sent[0]?.to).toEqual([email]);
    const used = await api.request(
      '/password-reset/consume',
      json({ token: tokenIn(sent[0]), new_password: 'mailed-password-8' }),
    );
    expect(used.status).toBe(200);
  });

  test('an email link request does not end a printed link, even when the mail fails', async () => {
    await signedIn();
    const printed = await operatorReset(database().sql, email, undefined);
    if (!printed.ok) throw new Error('reset was not issued');
    let attempts = 0;
    const api = await withMailbox(async () => {
      attempts++;
      throw new Error('mail server is down');
    });
    const asked = await api.request('/password-reset', json({ email }));
    expect(await asked.json()).toEqual({ status: 'ok' });
    await until(() => attempts > 0);
    // The failed mail's own link stops working; the printed one still does.
    await until(
      async () =>
        Number(
          (
            await database().sql`select count(*)::int as n from password_reset
              where via = 'email' and used_at is null`
          )[0]?.n,
        ) === 0,
    );
    const used = await api.request(
      '/password-reset/consume',
      json({ token: printed.code, new_password: 'printed-password-9' }),
    );
    expect(used.status).toBe(200);
  });

  test('an expired link is refused and guessing links is throttled', async () => {
    const { api } = await signedIn();
    const issued = await operatorReset(database().sql, email, undefined);
    if (!issued.ok) throw new Error('reset was not issued');
    expect(issued.link).toBeNull();
    expect(describeReset(issued)).toContain(issued.code);
    await database().sql`update password_reset set expires_at = now() - interval '1 second'`;
    const expired = await api.request(
      '/password-reset/consume',
      json({ token: issued.code, new_password: 'reset-password-6' }),
    );
    expect(expired.status).toBe(400);
    const statuses = [];
    for (let index = 0; index < 8; index++)
      statuses.push(
        (
          await api.request(
            '/password-reset/consume',
            json({ token: `guess-${index}-${'x'.repeat(30)}`, new_password: 'reset-password-7' }),
          )
        ).status,
      );
    expect(statuses).toContain(429);
    expect((await api.request('/login', json({ email, password }))).status).toBe(200);
  });

  test('asking for an email link without a mailbox says how to get one instead', async () => {
    const { api } = await signedIn();
    const response = await api.request('/password-reset', json({ email }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason?: string };
    expect(body.status).toBe('not_available');
    expect(body.reason).toContain('print you a reset link');
  });
});
