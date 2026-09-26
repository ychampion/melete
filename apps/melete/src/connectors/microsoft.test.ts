import { afterAll, describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { pkcePair } from '../gateway/oauth.ts';
import { type AccountGrant, AccountSignIns, SignInFailure } from './account-sign-in.ts';
import { EmailConnector } from './email.ts';
import { asConnectorFault } from './faults.ts';
import {
  type FakeMicrosoft,
  type FakeMicrosoftOptions,
  PERSONAL_TENANT,
  startFakeMicrosoft,
} from './fixtures/fake-microsoft.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import { MICROSOFT_SCOPES, microsoftIssuer, microsoftProvider } from './microsoft.ts';
import { OutlookCalendarConnector } from './outlook-calendar.ts';
import { OutlookMailTransport } from './outlook-mail.ts';
import type { SealedSecretStore } from './secrets.ts';
import { type SignedInAccess, signedInAccess } from './signed-in.ts';

const fakes: FakeMicrosoft[] = [];
afterAll(async () => {
  for (const fake of fakes) await fake.stop();
});
async function fake(options: FakeMicrosoftOptions = {}) {
  const started = await startFakeMicrosoft(options);
  fakes.push(started);
  return started;
}

function signIns(microsoft: FakeMicrosoft, tenant?: string) {
  const grants: AccountGrant[] = [];
  const service = new AccountSignIns<string>('microsoft', {
    publicUrl: 'http://localhost:3000',
    provider: microsoftProvider(microsoft.client, {
      endpoints: microsoft.endpoints,
      ...(tenant ? { tenant } : {}),
    }),
    authorize: async (_actor, spaceId) => spaceId ?? 'spc_test',
    install: async (_actor, grant) => {
      grants.push(grant);
      return ['conn'];
    },
    connectionId: (id) => id,
  });
  return { service, grants };
}

async function approve(authorizeUrl: string): Promise<URLSearchParams> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => 'no failure',
    (error) => (error instanceof SignInFailure ? error.code : String(error)),
  );

async function signedIn(microsoft: FakeMicrosoft) {
  const { verifier, challenge } = pkcePair();
  const redirect = 'http://localhost:3000/cb';
  const authorize = new URL(microsoft.endpoints.authorize);
  authorize.search = new URLSearchParams({
    redirect_uri: redirect,
    code_challenge: challenge,
    state: 's',
  }).toString();
  const code = (await approve(authorize.href)).get('code') ?? '';
  const answer = (await (
    await fetch(microsoft.endpoints.token, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: microsoft.client.clientId,
        client_secret: microsoft.client.clientSecret,
        code_verifier: verifier,
      }),
    })
  ).json()) as { access_token: string; refresh_token: string };
  const holder: SignedInAccess & { current: string; refresh: string } = {
    current: answer.access_token,
    refresh: answer.refresh_token,
    token: async () => holder.current,
    renew: async () => holder.current,
  };
  return holder;
}

describe('signing in with Microsoft', () => {
  test('one consent asks for Graph mail and calendar, and the address comes from Graph', async () => {
    const microsoft = await fake({ email: 'Person@Outlook.example' });
    const { service, grants } = signIns(microsoft);
    const started = await service.start('prn_owner', {});
    const asked = new URL(started.authorize_url).searchParams;
    expect(started.redirect_uri).toBe('http://localhost:3000/api/oauth/microsoft/callback');
    expect(asked.get('code_challenge_method')).toBe('S256');
    expect(asked.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining(['offline_access', ...Object.values(MICROSOFT_SCOPES)]),
    );
    await service.complete('prn_owner', await approve(started.authorize_url));
    const grant = grants[0];
    expect(grant?.provider).toBe('microsoft');
    expect(grant?.account).toBe('person@outlook.example');
    expect(grant?.mail?.label).toBe('Outlook (person@outlook.example)');
    expect(grant?.mail?.scopes).toContain('email.send');
    expect(grant?.calendar?.scopes).toContain('calendar.create');
    expect(grant?.credential.refresh_token).toBeDefined();
  });

  test('what the person unticks is not connected, in short or full scope names', async () => {
    const noSend = await fake({ grant: ['User.Read', 'Mail.Read', 'Calendars.ReadWrite'] });
    const one = signIns(noSend);
    await one.service.complete(
      'prn_owner',
      await approve((await one.service.start('prn_owner', {})).authorize_url),
    );
    expect(one.grants[0]?.mail?.scopes).not.toContain('email.send');
    expect(one.grants[0]?.calendar).toBeDefined();

    const provider = microsoftProvider(noSend.client, { endpoints: noSend.endpoints });
    expect(provider.grants(`${MICROSOFT_SCOPES.mailRead} ${MICROSOFT_SCOPES.mailSend}`)).toEqual({
      mail: expect.arrayContaining(['email.read', 'email.send']),
    });
    expect(provider.grants('User.Read openid')).toEqual({});
  });

  test('an id token for another client or another issuer, or another tenant than the one named, is refused', async () => {
    for (const [options, tenant] of [
      [{ idTokenAudience: 'another-client' }, undefined],
      [{ idTokenIssuer: 'https://login.example/tenant/v2.0' }, undefined],
      [{}, '11111111-2222-3333-4444-555555555555'],
    ] as const) {
      const microsoft = await fake(options);
      const { service, grants } = signIns(microsoft, tenant);
      const started = await service.start('prn_owner', {});
      expect(
        await failure(service.complete('prn_owner', await approve(started.authorize_url))),
      ).toBe('account_unverified');
      expect(grants).toHaveLength(0);
    }
    const pinned = await fake();
    const ok = signIns(pinned, PERSONAL_TENANT);
    const started = await ok.service.start('prn_owner', {});
    await ok.service.complete('prn_owner', await approve(started.authorize_url));
    expect(ok.grants).toHaveLength(1);
  });

  test('a sign-in without the profile grant has no confirmed address and connects nothing', async () => {
    const microsoft = await fake({ grant: ['Mail.Read', 'Calendars.ReadWrite'] });
    const { service, grants } = signIns(microsoft);
    const started = await service.start('prn_owner', {});
    expect(await failure(service.complete('prn_owner', await approve(started.authorize_url)))).toBe(
      'account_unverified',
    );
    expect(grants).toHaveLength(0);
  });
});

describe('a Microsoft connection keeps its access current', () => {
  test('a refresh keeps the rotated refresh token, since the old one is spent', async () => {
    const microsoft = await fake();
    const start = await signedIn(microsoft);
    const stored = new Map([
      [
        'sealed-1',
        JSON.stringify({
          access_token: start.current,
          refresh_token: start.refresh,
          expires_at: Date.now() - 1,
          scope: 'Mail.Read',
          account: 'person@outlook.example',
        }),
      ],
    ]);
    const row = { secret_ref: 'sealed-1', status: 'active' };
    const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (values.length > 2) row.secret_ref = String(values[0]);
      return values.length > 2 ? [] : [row];
    }) as unknown as Sql;
    let serial = 1;
    const secrets = {
      withSecret: async (id: string, _space: string, use: (value: string) => unknown) =>
        use(stored.get(id) ?? ''),
      put: async (_space: string, value: string) => {
        const id = `sealed-${++serial}`;
        stored.set(id, value);
        return id;
      },
    } as unknown as SealedSecretStore;
    const access = signedInAccess({
      sql,
      secrets,
      connectionId: 'conn_1',
      spaceId: 'spc_test',
      issuer: microsoftIssuer(microsoft.client, '', microsoft.endpoints),
    });
    await access.token();
    const first = JSON.parse(stored.get(row.secret_ref) ?? '{}');
    expect(first.refresh_token).not.toBe(start.refresh);
    // A second refresh must present the rotated token, which the fake accepts.
    const again = JSON.parse(stored.get(row.secret_ref) ?? '{}');
    stored.set(row.secret_ref, JSON.stringify({ ...again, expires_at: Date.now() - 1 }));
    expect(await access.token()).not.toBe(first.access_token);
  });
});

const RAW = (subject: string, body: string, id: string) =>
  `From: Friend <friend@example.test>\nTo: person@outlook.example\nSubject: ${subject}\nMessage-ID: <${id}@example.test>\nDate: Thu, 24 Sep 2026 09:00:00 +0000\n\n${body}\n`;

async function outlookMail(options: FakeMicrosoftOptions = {}) {
  const microsoft = await fake(options);
  const access = await signedIn(microsoft);
  const transport = new OutlookMailTransport({
    base: microsoft.endpoints.graph,
    from: 'person@outlook.example',
    access,
  });
  const connector = new EmailConnector({
    kind: 'api',
    id: 'con_test',
    spaceId: 'spc_test',
    from: 'person@outlook.example',
    session: (work) => work(transport),
  });
  return { microsoft, connector };
}

describe('Outlook mail through the email tools', () => {
  test('search and read address messages by Graph id, and inbox hygiene still withholds codes', async () => {
    const { microsoft, connector } = await outlookMail();
    const first = microsoft.deliver(RAW('Lunch', 'Thursday works.', 'lunch'));
    microsoft.deliver(RAW('Reset your password', 'Use this link to reset your password.', 'reset'));
    expect(first).toContain('=');
    const found = await connector.execute(
      mailAction('email.search', { query: '', limit: 10 }),
      mailContext(),
    );
    if (found.outcome !== 'succeeded') throw new Error(found.outcome);
    const messages = found.receipt.detail.messages as Record<string, unknown>[];
    expect(messages.map((m) => m.subject)).toEqual(['Lunch']);
    expect(messages[0]).toMatchObject({ id: first, message_id: '<lunch@example.test>' });
    const read = await connector.execute(mailAction('email.read', { id: first }), mailContext());
    expect(read.outcome).toBe('succeeded');
    const searched = await connector.execute(
      mailAction('email.search', { query: 'thursday', limit: 10 }),
      mailContext(),
    );
    if (searched.outcome !== 'succeeded') throw new Error(searched.outcome);
    expect((searched.receipt.detail.messages as unknown[]).length).toBe(1);
  });

  test('a send is found in Sent Items afterwards, even when Graph gives it a Message-ID of its own', async () => {
    for (const rewriteMessageId of [false, true]) {
      const { microsoft, connector } = await outlookMail({ rewriteMessageId });
      const payload = { to: 'friend@example.test', subject: 'Hello', body: 'Hi there.' };
      const action = mailAction('email.send', payload, 'act_send1');
      const sent = await connector.execute(action, mailContext('act_send1'));
      if (sent.outcome !== 'succeeded') throw new Error(sent.outcome);
      expect(sent.receipt.detail).toMatchObject({
        message_id: '<act_send1@melete.local>',
        sent_copy: true,
      });
      expect(microsoft.sent[0]?.raw.toString('utf8')).toMatch(/^From: person@outlook\.example/m);
      expect((await connector.verify(action, mailContext('act_send1'))).decision).toBe('succeeded');
      const other = mailAction('email.send', payload, 'act_never');
      expect((await connector.verify(other, mailContext('act_never'))).decision).toBe('undecided');
    }
  });

  test('a mailbox without the read grant fails its check', async () => {
    const { connector } = await outlookMail({ grant: ['User.Read', 'Mail.Send'] });
    expect((await connector.health()).status).toBe('failing');
  });
});

describe('Outlook calendar through the calendar tools', () => {
  const event = {
    summary: 'Walk with Alex',
    start: '2026-09-30T09:00:00Z',
    end: '2026-09-30T10:00:00+00:00',
    description: 'Bring tea.',
    location: 'The park',
  };

  async function calendar(options: FakeMicrosoftOptions = {}) {
    const microsoft = await fake(options);
    const connector = new OutlookCalendarConnector({
      id: 'con_test',
      spaceId: 'spc_test',
      base: microsoft.endpoints.graph,
      access: await signedIn(microsoft),
    });
    return { microsoft, connector };
  }

  test('an event carries its action, so a second create for it cannot make a second event', async () => {
    const { microsoft, connector } = await calendar();
    const create = mailAction('calendar.create', event, 'act_event1');
    const made = await connector.execute(create, mailContext('act_event1'));
    if (made.outcome !== 'succeeded') throw new Error(made.outcome);
    expect(made.receipt.detail).toMatchObject({ uid: 'act_event1', etag: '"1"' });
    const [stored] = [...microsoft.events.values()];
    expect(stored?.transactionId).toBe('act_event1');
    expect((await connector.verify(create, mailContext('act_event1'))).decision).toBe('succeeded');
    expect((await connector.execute(create, mailContext('act_event1'))).outcome).toBe('failed');
    expect(microsoft.events.size).toBe(1);

    const listed = await connector.execute(mailAction('calendar.list', {}), mailContext());
    if (listed.outcome !== 'succeeded') throw new Error(listed.outcome);
    const [view] = listed.receipt.detail.events as Record<string, unknown>[];
    expect(view).toMatchObject({
      uid: 'act_event1',
      summary: 'Walk with Alex',
      start: '2026-09-30T09:00:00.000Z',
      etag: '"1"',
    });
  });

  test('a change or removal names the version it read, and a stale one is refused', async () => {
    const { microsoft, connector } = await calendar();
    await connector.execute(
      mailAction('calendar.create', event, 'act_event2'),
      mailContext('act_event2'),
    );
    const stale = mailAction(
      'calendar.update',
      { ...event, summary: 'Changed', uid: 'act_event2', etag: '"9"' },
      'act_u1',
    );
    expect((await connector.execute(stale, mailContext('act_u1'))).outcome).toBe('failed');
    const update = mailAction(
      'calendar.update',
      { ...event, summary: 'Changed', uid: 'act_event2', etag: '"1"' },
      'act_u2',
    );
    expect((await connector.execute(update, mailContext('act_u2'))).outcome).toBe('succeeded');
    expect((await connector.verify(update, mailContext('act_u2'))).decision).toBe('succeeded');
    const unknown = mailAction(
      'calendar.update',
      { ...event, uid: 'act_missing', etag: '"1"' },
      'act_u3',
    );
    expect((await connector.execute(unknown, mailContext('act_u3'))).outcome).toBe('failed');
    const remove = mailAction('calendar.delete', { uid: 'act_event2', etag: '"2"' }, 'act_del');
    expect((await connector.execute(remove, mailContext('act_del'))).outcome).toBe('succeeded');
    expect(microsoft.events.size).toBe(0);
  });

  test('a refused write raises the same typed faults as the CalDAV calendar', async () => {
    const { connector } = await calendar({ grant: ['User.Read', 'Mail.Read'] });
    const thrown = await connector
      .execute(mailAction('calendar.create', event, 'act_event3'), mailContext('act_event3'))
      .catch((error) => error);
    expect(asConnectorFault(thrown)?.kind).toBe('revoked_credential');
    expect((await connector.health()).status).toBe('failing');
  });
});
