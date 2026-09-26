import { afterAll, describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { pkcePair } from '../gateway/oauth.ts';
import { type AccountGrant, AccountSignIns, SignInFailure } from './account-sign-in.ts';
import { EmailConnector } from './email.ts';
import { asConnectorFault } from './faults.ts';
import {
  type FakeGoogle,
  type FakeGoogleOptions,
  startFakeGoogle,
} from './fixtures/fake-google.ts';
import { GmailApiTransport } from './gmail.ts';
import { GOOGLE_SCOPES, googleIssuer, googleProvider } from './google.ts';
import { GoogleCalendarConnector, googleEventId } from './google-calendar.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import type { SealedSecretStore } from './secrets.ts';
import { bearerRequest, type SignedInAccess, SignInEnded, signedInAccess } from './signed-in.ts';

const fakes: FakeGoogle[] = [];
afterAll(async () => {
  for (const fake of fakes) await fake.stop();
});
async function fake(options: FakeGoogleOptions = {}) {
  const started = await startFakeGoogle(options);
  fakes.push(started);
  return started;
}

function signIns(
  google: FakeGoogle | null,
  publicUrl: string | undefined = 'http://localhost:3000',
) {
  const grants: AccountGrant[] = [];
  const service = new AccountSignIns<string>('google', {
    publicUrl,
    ...(google ? { provider: googleProvider(google.client, google.endpoints) } : {}),
    authorize: async (_actor, spaceId) => spaceId ?? 'spc_test',
    install: async (_actor, grant) => {
      grants.push(grant);
      return [grant.mail ? 'conn_mail' : null, grant.calendar ? 'conn_calendar' : null].filter(
        (id): id is string => id !== null,
      );
    },
    connectionId: (id) => id,
  });
  return { service, grants };
}

/** Stands in for the browser: opens the authorize address and returns where Google sent it. */
async function approve(authorizeUrl: string): Promise<URLSearchParams> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => 'no failure',
    (error) => (error instanceof SignInFailure ? error.code : String(error)),
  );

/** A signed-in access token straight from the fake, for the API-level tests. */
async function signedIn(google: FakeGoogle): Promise<SignedInAccess & { current: string }> {
  const { verifier, challenge } = pkcePair();
  const redirect = 'http://localhost:3000/cb';
  const authorize = new URL(google.endpoints.authorize);
  authorize.search = new URLSearchParams({
    client_id: google.client.clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    state: 's',
  }).toString();
  const code = (await approve(authorize.href)).get('code') ?? '';
  const answer = (await (
    await fetch(google.endpoints.token, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: google.client.clientId,
        client_secret: google.client.clientSecret,
        code_verifier: verifier,
      }),
    })
  ).json()) as { access_token: string };
  const holder = {
    current: answer.access_token,
    token: async () => holder.current,
    renew: async () => holder.current,
  };
  return holder;
}

describe('signing in with Google', () => {
  test('one consent asks for mail and calendar with PKCE and offline access, and connects both', async () => {
    const google = await fake();
    const { service, grants } = signIns(google);
    const started = await service.start('prn_owner', {});
    const asked = new URL(started.authorize_url).searchParams;
    expect(started.redirect_uri).toBe('http://localhost:3000/api/oauth/google/callback');
    expect(asked.get('code_challenge_method')).toBe('S256');
    expect(asked.get('access_type')).toBe('offline');
    expect(asked.get('prompt')).toBe('consent');
    expect(asked.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining(Object.values(GOOGLE_SCOPES)),
    );
    // Drafts stay in Melete, so no Gmail draft or full-mailbox scope is asked for.
    expect(asked.get('scope')).not.toContain('gmail.compose');
    expect(asked.get('scope')).not.toContain('https://mail.google.com/');

    const back = await approve(started.authorize_url);
    expect(await service.complete('prn_owner', back)).toEqual(['conn_mail', 'conn_calendar']);
    const exchange = google.tokenRequests[0];
    expect(exchange?.get('client_secret')).toBe(google.client.clientSecret);
    expect(exchange?.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
    const grant = grants[0];
    expect(grant?.account).toBe('person@example.test');
    expect(grant?.mail?.scopes).toContain('email.send');
    expect(grant?.calendar?.scopes).toEqual([
      'calendar.list',
      'calendar.create',
      'calendar.update',
      'calendar.delete',
    ]);
    expect(grant?.credential.refresh_token).toBeDefined();
    expect(service.status('prn_owner', started.sign_in_id)).toEqual({
      state: 'connected',
      connection_ids: ['conn_mail', 'conn_calendar'],
    });
    // The browser's return is spent once.
    expect(await failure(service.complete('prn_owner', back))).toBe('sign_in_not_found');
  });

  test('what the person unticks is not connected', async () => {
    const google = await fake({
      grant: ['openid', 'email', GOOGLE_SCOPES.mailRead, GOOGLE_SCOPES.calendar],
    });
    const { service, grants } = signIns(google);
    const started = await service.start('prn_owner', {});
    await service.complete('prn_owner', await approve(started.authorize_url));
    expect(grants[0]?.mail?.scopes).not.toContain('email.send');
    expect(grants[0]?.mail?.scopes).toContain('email.read');

    const calendarOnly = await fake({ grant: ['openid', 'email', GOOGLE_SCOPES.calendar] });
    const second = signIns(calendarOnly);
    const again = await second.service.start('prn_owner', {});
    await second.service.complete('prn_owner', await approve(again.authorize_url));
    expect(second.grants[0]?.mail).toBeUndefined();
    expect(second.grants[0]?.calendar).toBeDefined();

    const nothing = await fake({ grant: ['openid', 'email'] });
    const third = signIns(nothing);
    const none = await third.service.start('prn_owner', {});
    expect(
      await failure(third.service.complete('prn_owner', await approve(none.authorize_url))),
    ).toBe('access_not_granted');
    expect(third.grants).toHaveLength(0);
  });

  test('a declined consent, another person, a forged state or another client are refused', async () => {
    const declined = await fake({ decline: true });
    const one = signIns(declined);
    const started = await one.service.start('prn_owner', {});
    expect(
      await failure(one.service.complete('prn_owner', await approve(started.authorize_url))),
    ).toBe('sign_in_declined');

    const google = await fake();
    const two = signIns(google);
    const mine = await two.service.start('prn_owner', {});
    const back = await approve(mine.authorize_url);
    expect(await failure(two.service.complete('prn_other', back))).toBe('sign_in_not_found');
    const forged = new URLSearchParams(back);
    forged.set('state', 'forged');
    expect(await failure(two.service.complete('prn_owner', forged))).toBe('sign_in_not_found');

    const elsewhere = await fake({ idTokenAudience: 'another-client.apps.example' });
    const three = signIns(elsewhere);
    const theirs = await three.service.start('prn_owner', {});
    expect(
      await failure(three.service.complete('prn_owner', await approve(theirs.authorize_url))),
    ).toBe('account_unverified');
    expect(three.grants).toHaveLength(0);
  });

  test('sign-in is offered only with a Google client and an address to return to', async () => {
    expect(await failure(signIns(null).service.start('prn_owner', {}))).toBe(
      'provider_not_configured',
    );
    const google = await fake();
    const plain = signIns(google, 'http://melete.example.test');
    expect(plain.service.available()).toBe(false);
    expect(await failure(plain.service.start('prn_owner', {}))).toBe('callback_unavailable');
    expect(signIns(google, 'https://melete.example.test').service.redirectUri()).toBe(
      'https://melete.example.test/api/oauth/google/callback',
    );
  });
});

/** One sealed Google credential in a row, and the rotations written to it. */
function heldCredential(credential: Record<string, unknown>) {
  const row = { secret_ref: 'sealed-1', status: 'active' };
  const stored = new Map([['sealed-1', JSON.stringify(credential)]]);
  const updates: unknown[][] = [];
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    if (values.length > 2) {
      updates.push(values);
      row.secret_ref = String(values[0]);
      return [];
    }
    return [row];
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
  return { sql, secrets, updates, stored, row };
}

describe('a Google connection keeps its access current', () => {
  test('an expiring token is refreshed once, and the new one is sealed in its place', async () => {
    const google = await fake();
    const start = await signedIn(google);
    const refreshToken = google.issued.find((value) => value.startsWith('1//refresh')) ?? '';
    const held = heldCredential({
      access_token: start.current,
      refresh_token: refreshToken,
      expires_at: Date.now() + 10_000,
      scope: 'x',
      account: 'person@example.test',
    });
    const access = signedInAccess({
      sql: held.sql,
      secrets: held.secrets,
      connectionId: 'conn_1',
      spaceId: 'spc_test',
      issuer: googleIssuer(google.client, '', google.endpoints),
    });
    const [first, second] = await Promise.all([access.token(), access.token()]);
    expect(first).toBe(second);
    expect(first).not.toBe(start.current);
    expect(
      google.tokenRequests.filter((r) => r.get('grant_type') === 'refresh_token'),
    ).toHaveLength(1);
    expect(held.row.secret_ref).toBe('sealed-2');
    const sealed = JSON.parse(held.stored.get('sealed-2') ?? '{}');
    expect(sealed).toMatchObject({ access_token: first, refresh_token: refreshToken });
  });

  test('a refused refresh ends the sign-in, and a 401 is answered once with a renewed token', async () => {
    const google = await fake({ refreshRefused: true });
    const start = await signedIn(google);
    const held = heldCredential({
      access_token: start.current,
      refresh_token: 'revoked-refresh',
      expires_at: Date.now() - 1,
      scope: 'x',
      account: 'person@example.test',
    });
    const access = signedInAccess({
      sql: held.sql,
      secrets: held.secrets,
      connectionId: 'conn_1',
      spaceId: 'spc_test',
      issuer: googleIssuer(google.client, '', google.endpoints),
    });
    expect(await access.token().catch((error) => error)).toBeInstanceOf(SignInEnded);

    let renewed = 0;
    const live = await signedIn(await fake());
    const stale: SignedInAccess = {
      token: async () => 'stale-token',
      renew: async () => {
        renewed += 1;
        return live.current;
      },
    };
    const liveFake = fakes.at(-1) as FakeGoogle;
    const response = await bearerRequest(stale, `${liveFake.endpoints.gmail}/profile`, {});
    expect(response.status).toBe(200);
    expect(renewed).toBe(1);
  });
});

const RAW = (subject: string, body: string, id: string) =>
  `From: Friend <friend@example.test>\nTo: person@example.test\nSubject: ${subject}\nMessage-ID: <${id}@example.test>\nDate: Thu, 24 Sep 2026 09:00:00 +0000\n\n${body}\n`;

async function gmailConnector(options: FakeGoogleOptions = {}) {
  const google = await fake(options);
  const access = await signedIn(google);
  const transport = new GmailApiTransport({
    base: google.endpoints.gmail,
    from: 'person@example.test',
    access,
  });
  const connector = new EmailConnector({
    kind: 'api',
    id: 'con_test',
    spaceId: 'spc_test',
    from: 'person@example.test',
    session: (work) => work(transport),
  });
  return { google, connector, transport, access };
}

describe('Gmail through the email tools', () => {
  test('search and read address messages by id, and inbox hygiene still withholds codes', async () => {
    const { google, connector } = await gmailConnector();
    const first = google.deliver(RAW('Lunch', 'Thursday works.', 'lunch'));
    google.deliver(RAW('Your verification code', 'Your verification code is 424242.', 'otp'));
    const found = await connector.execute(
      mailAction('email.search', { query: '', limit: 10 }),
      mailContext(),
    );
    if (found.outcome !== 'succeeded') throw new Error(found.outcome);
    const messages = found.receipt.detail.messages as Record<string, unknown>[];
    expect(messages.map((m) => m.subject)).toEqual(['Lunch']);
    expect(messages[0]).toMatchObject({ id: first, message_id: '<lunch@example.test>' });
    expect(messages[0]?.uid).toBeUndefined();

    expect(connector.manifest.tools.find((t) => t.name === 'email.read')?.input_schema).toEqual(
      expect.objectContaining({ required: ['id'] }),
    );
    const read = await connector.execute(mailAction('email.read', { id: first }), mailContext());
    expect(read.outcome).toBe('succeeded');
    expect(
      (await connector.execute(mailAction('email.read', { uid: 1 }), mailContext())).outcome,
    ).toBe('failed');
  });

  test('a send is found in Sent afterwards, even when Gmail gives it a Message-ID of its own', async () => {
    for (const rewriteMessageId of [false, true]) {
      const { google, connector } = await gmailConnector({ rewriteMessageId });
      const payload = { to: 'friend@example.test', subject: 'Hello', body: 'Hi there.' };
      const action = mailAction('email.send', payload, 'act_send1');
      const sent = await connector.execute(action, mailContext('act_send1'));
      if (sent.outcome !== 'succeeded') throw new Error(sent.outcome);
      expect(sent.receipt.detail).toMatchObject({
        message_id: '<act_send1@melete.local>',
        sent_copy: true,
      });
      const raw = google.sent[0]?.raw.toString('utf8') ?? '';
      expect(raw).toMatch(/^From: person@example\.test/m);
      const verified = await connector.verify(action, mailContext('act_send1'));
      expect(verified.decision).toBe('succeeded');
      const other = mailAction('email.send', payload, 'act_never');
      expect((await connector.verify(other, mailContext('act_never'))).decision).toBe('undecided');
    }
  });

  test('a mailbox without the read grant fails its check, and an ended sign-in says to sign in again', async () => {
    const { connector } = await gmailConnector({
      grant: ['openid', 'email', GOOGLE_SCOPES.mailSend],
    });
    expect((await connector.health()).status).toBe('failing');
    const ended = new EmailConnector({
      kind: 'api',
      id: 'con_test',
      spaceId: 'spc_test',
      from: 'person@example.test',
      session: async () => {
        throw new SignInEnded();
      },
    });
    expect(await ended.health()).toMatchObject({ status: 'failing', reason: 'sign_in_required' });
  });
});

describe('Google Calendar through the calendar tools', () => {
  const event = {
    summary: 'Walk with Alex',
    start: '2026-09-30T09:00:00Z',
    end: '2026-09-30T10:00:00Z',
    description: 'Bring tea.',
    location: 'The park',
  };

  async function calendar() {
    const google = await fake();
    const access = await signedIn(google);
    const connector = new GoogleCalendarConnector({
      id: 'con_test',
      spaceId: 'spc_test',
      base: google.endpoints.calendar,
      access,
    });
    return { google, connector };
  }

  test('an event is named by its action, so a second create cannot make a second event', async () => {
    const { google, connector } = await calendar();
    const create = mailAction('calendar.create', event, 'act_event1');
    const made = await connector.execute(create, mailContext('act_event1'));
    if (made.outcome !== 'succeeded') throw new Error(made.outcome);
    expect(made.receipt.external_ref).toBe('act_event1');
    expect([...google.events.keys()]).toEqual([googleEventId('act_event1')]);
    expect(googleEventId('act_event1')).toMatch(/^[a-v0-9]{5,1024}$/);
    expect((await connector.verify(create, mailContext('act_event1'))).decision).toBe('succeeded');
    expect((await connector.execute(create, mailContext('act_event1'))).outcome).toBe('failed');
    expect(google.events.size).toBe(1);

    const listed = await connector.execute(mailAction('calendar.list', {}), mailContext());
    if (listed.outcome !== 'succeeded') throw new Error(listed.outcome);
    const [view] = listed.receipt.detail.events as Record<string, unknown>[];
    expect(view).toMatchObject({ uid: 'act_event1', summary: 'Walk with Alex', etag: '"1"' });
  });

  test('a change or removal names the version it read, and a stale one is refused', async () => {
    const { google, connector } = await calendar();
    await connector.execute(
      mailAction('calendar.create', event, 'act_event2'),
      mailContext('act_event2'),
    );
    const stale = mailAction(
      'calendar.update',
      { ...event, summary: 'Changed', uid: 'act_event2', etag: '"9"' },
      'act_update1',
    );
    expect((await connector.execute(stale, mailContext('act_update1'))).outcome).toBe('failed');
    const update = mailAction(
      'calendar.update',
      { ...event, summary: 'Changed', uid: 'act_event2', etag: '"1"' },
      'act_update2',
    );
    expect((await connector.execute(update, mailContext('act_update2'))).outcome).toBe('succeeded');
    expect((await connector.verify(update, mailContext('act_update2'))).decision).toBe('succeeded');
    const remove = mailAction('calendar.delete', { uid: 'act_event2', etag: '"2"' }, 'act_del');
    expect((await connector.execute(remove, mailContext('act_del'))).outcome).toBe('succeeded');
    expect(google.events.get(googleEventId('act_event2'))?.status).toBe('cancelled');
  });

  test('a refused write raises the same typed faults as the CalDAV calendar', async () => {
    const google = await fake({ grant: ['openid', 'email', GOOGLE_SCOPES.mailRead] });
    const connector = new GoogleCalendarConnector({
      id: 'con_test',
      spaceId: 'spc_test',
      base: google.endpoints.calendar,
      access: await signedIn(google),
    });
    const thrown = await connector
      .execute(mailAction('calendar.create', event, 'act_event3'), mailContext('act_event3'))
      .catch((error) => error);
    expect(asConnectorFault(thrown)?.kind).toBe('revoked_credential');
    expect((await connector.health()).status).toBe('failing');
  });
});
