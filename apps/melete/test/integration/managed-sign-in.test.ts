/**
 * Signing in to Google through Composio, end to end against a fake Composio
 * whose proxied calls a fake Google answers: the connect screen's entry, the
 * consent pages one part at a time, what a forged, foreign, inactive or
 * replayed return is told, two accounts, a duplicate, moving an account
 * between its native sign-in and Composio without reporting anything twice,
 * disconnecting, and the monthly limit on calls through Composio.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  accountSignInStart,
  accountSignInStatus,
  connectionKindListResponse,
  connectionListResponse,
  managedSignInStart,
} from '@melete/contracts';
import { COMPOSIO_NOTE } from '../../src/api/connections.ts';
import { ComposioClient } from '../../src/connectors/composio.ts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { EmailConnector } from '../../src/connectors/email.ts';
import { googleUpstream, startFakeComposio } from '../../src/connectors/fixtures/fake-composio.ts';
import { startFakeGoogle } from '../../src/connectors/fixtures/fake-google.ts';
import { GoogleCalendarConnector } from '../../src/connectors/google-calendar.ts';
import { mailAction, mailContext } from '../../src/connectors/mail-fixtures.ts';
import { managedRevocation } from '../../src/connectors/managed-accounts.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import {
  MANAGED_NEAR_WORDS,
  MANAGED_REACHED_WORDS,
  ManagedCallMeter,
  monthOf,
} from '../../src/signals/managed-calls.ts';
import { MANAGED_WATCH_SECONDS, MAX_POLL_SECONDS, SignalPoller } from '../../src/signals/poller.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '5c'.repeat(32);
const PUBLIC_URL = 'http://localhost:3000';
const CAP = 1000;

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const registry = new ConnectorRegistry();
const person = await startFakeGoogle({ email: 'person@example.test' });
const second = await startFakeGoogle({ email: 'second@example.test' });
// The one account that also signs in natively, with the operator's own client.
const switching = await startFakeGoogle({ email: 'switch@example.test' });
const composio = await startFakeComposio();
afterAll(async () => {
  await registry.close();
  for (const stop of [person, second, switching, composio]) await stop.stop();
  await queue?.stop();
  await fixture?.close();
}, 30_000);

const client = new ComposioClient({ apiKey: composio.apiKey, baseUrl: composio.baseUrl });

async function harness() {
  if (!fixture || !queue) throw new Error('Postgres unavailable');
  const meter = new ManagedCallMeter(fixture.sql, CAP);
  const factory = new ConnectorFactory({
    sql: fixture.sql,
    workRoot: 'unused',
    spacesRoot: 'unused',
    masterKey: MASTER_KEY,
    google: { client: switching.client, endpoints: switching.endpoints },
    composio: { client, meter },
  });
  useConnectorFactory(registry, factory);
  const jobs = new JobService(fixture.db, queue.boss);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'managed-sign-in-signing-key-32-bytes',
  });
  const app = createApp({
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_MASTER_KEY: MASTER_KEY,
      MELETE_PUBLIC_URL: PUBLIC_URL,
      COMPOSIO_API_KEY: composio.apiKey,
      COMPOSIO_BASE_URL: composio.baseUrl,
    }),
    db: fixture.db,
    sql: fixture.sql,
    registry,
    jobs,
    policy: new PolicyService(jobs, runner, {
      beforeKeyChange: managedRevocation(fixture.sql, client),
    }),
    checkDatabase: async () => 'ok',
  });
  const as = (cookie: string, body?: unknown): RequestInit => ({
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setup = await app.request(
    '/setup',
    as('', { email: 'managed-owner@example.test', password: 'managed-owner-password' }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Setup failed: ${setup.status}`);
  const [space] = await fixture.sql`select id from space where kind = 'personal'`;
  if (!space) throw new Error('Missing personal space');
  let clock = Date.parse('2026-10-05T12:00:00.000Z');
  const poller = new SignalPoller({
    sql: fixture.sql,
    triggers: new TriggerService(jobs, runner),
    connectors: registry,
    now: () => clock,
    managedCalls: meter,
  });

  /** Start a sign-in; the first consent page is where `authorize_url` points. */
  const start = async (body: Record<string, unknown> = { provider: 'google' }) => {
    const started = await app.request('/managed-sign-ins', as(cookie, body));
    expect(started.status).toBe(201);
    return managedSignInStart.parse(await started.json());
  };
  /** The person at one consent page: where Composio sends the browser back to. */
  const consent = async (page: string) => {
    const approved = await fetch(page, { redirect: 'manual' });
    expect(approved.status).toBe(302);
    const back = new URL(approved.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(`${PUBLIC_URL}/api/managed-sign-ins/callback`);
    return back;
  };
  /** The browser's return; the web app forwards /api/* without the prefix. */
  const land = (back: URL, search = back.search) =>
    app.request(`/managed-sign-ins/callback${search}`, as(cookie));
  const status = async (id: string) =>
    accountSignInStatus.parse(
      await (await app.request(`/managed-sign-ins/${id}`, as(cookie))).json(),
    );
  /** A whole sign-in, as `upstream` at both consent pages. */
  const signIn = async (google: typeof person) => {
    composio.signInAs(googleUpstream(google));
    const started = await start();
    const first = await land(await consent(started.authorize_url));
    expect(first.status).toBe(302);
    const done = await land(await consent(first.headers.get('location') ?? ''));
    return { started, done, page: await done.text(), status: await status(started.sign_in_id) };
  };
  const rows = (account: string) => fixture.sql`select id, provider, secret_ref, generation,
      configuration, status from connection
    where lower(configuration->>'account') = ${account} and status <> 'revoked' order by provider`;
  return {
    app,
    as,
    cookie,
    factory,
    meter,
    poller,
    sql: fixture.sql,
    spaceId: String(space.id),
    start,
    consent,
    land,
    status,
    signIn,
    rows,
    now: () => clock,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const h = fixture ? await harness() : null;
const withDb = fixture ? describe : describe.skip;
const need = () => {
  if (!h) throw new Error('Postgres unavailable');
  return h;
};

withDb('signing in to Google through Composio', () => {
  test('with a Composio key, the Google card signs in through Composio and says so; Microsoft stays its own', async () => {
    const t = need();
    const listed = connectionKindListResponse.parse(
      await (await t.app.request('/connection-kinds', t.as(t.cookie))).json(),
    );
    const google = listed.catalog?.find((entry) => entry.id === 'google');
    expect(google?.connect).toEqual({
      method: 'managed_sign_in',
      provider: 'google',
      via: 'composio',
      start: '/managed-sign-ins',
      note: COMPOSIO_NOTE,
    });
    expect(google?.available).toBe(true);
    expect(listed.catalog?.find((entry) => entry.id === 'microsoft')?.connect.method).toBe(
      'sign_in',
    );
  });

  test('one sign-in connects Gmail and Google Calendar, a consent page each, keeping no token', async () => {
    const t = need();
    const { started, done, page, status } = await t.signIn(person);
    expect(started.connects).toEqual(['mail', 'calendar']);
    expect(new URL(started.authorize_url).origin).toBe(started.issuer);
    expect(done.status).toBe(200);
    expect(page).toContain('connected');
    if (status.state !== 'connected') throw new Error(`Sign-in ended ${status.state}`);
    expect(status.connection_ids).toHaveLength(2);
    const made = await t.rows('person@example.test');
    expect(made.map((row) => row.provider)).toEqual(['caldav', 'imap']);
    for (const row of made) {
      expect(row.secret_ref).toBeNull();
      expect(row.status).toBe('active');
      expect(row.configuration).toMatchObject({ via: 'composio', account: 'person@example.test' });
    }
    // Two toolkits, two Composio accounts, each this person's.
    const accounts = made.map((row) => String(row.configuration.connected_account_id));
    expect(new Set(accounts).size).toBe(2);
    for (const id of accounts) expect(composio.accounts.get(id)?.status).toBe('ACTIVE');
    const users = new Set(accounts.map((id) => composio.accounts.get(id)?.user_id));
    expect(users.size).toBe(1);
    expect([...users][0]).toMatch(/^melete:own_[^:]+:own_/);

    const listed = connectionListResponse
      .parse(await (await t.app.request('/connections', t.as(t.cookie))).json())
      .connections.filter((row) => status.connection_ids.includes(row.id));
    expect(listed.every((row) => row.via === 'composio')).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('ca_');

    // The same tools as a native Gmail, through the row's own account.
    const mail = made.find((row) => row.provider === 'imap');
    const gmail = registry.get(String(mail?.id));
    expect(gmail).toBeInstanceOf(EmailConnector);
    expect(registry.get(String(made.find((row) => row.provider === 'caldav')?.id))).toBeInstanceOf(
      GoogleCalendarConnector,
    );
    person.deliver(
      'From: friend@example.test\nTo: person@example.test\nSubject: Lunch\nMessage-ID: <lunch@example.test>\n\nThursday.\n',
    );
    const found = await (gmail as EmailConnector).execute(
      {
        ...mailAction('email.search', { query: 'Lunch', limit: 5 }),
        connection_id: String(mail?.id),
      },
      { ...mailContext(), space_id: t.spaceId },
    );
    expect(found.outcome).toBe('succeeded');
    expect(JSON.stringify(found)).toContain('Lunch');
  }, 60_000);

  test('a return is spent once: the same callback again is refused', async () => {
    const t = need();
    composio.signInAs(googleUpstream(person));
    const started = await t.start({ provider: 'google', documents: true });
    expect(started.connects).toEqual(['documents']);
    const back = await t.consent(started.authorize_url);
    expect((await t.land(back)).status).toBe(200);
    const replayed = await t.land(back);
    expect(replayed.status).toBe(404);
    expect((await t.rows('person@example.test')).map((row) => row.provider)).toEqual([
      'caldav',
      'drive',
      'imap',
    ]);
  }, 60_000);

  test('a forged account, another user’s account, an inactive one and a declined consent are refused, and the account made for it goes', async () => {
    const t = need();
    const before = (await t.rows('person@example.test')).length;
    const existing = String(
      (await t.rows('person@example.test'))[0]?.configuration.connected_account_id,
    );

    // Forged: the browser comes back naming an account this step did not make.
    composio.signInAs(googleUpstream(person));
    let started = await t.start();
    let back = await t.consent(started.authorize_url);
    const made = String(back.searchParams.get('connected_account_id'));
    back.searchParams.set('connected_account_id', existing);
    let landed = await t.land(back);
    expect(landed.status).toBe(400);
    expect(await landed.text()).toContain('another account');
    expect(composio.removed).toContain(made);
    expect(composio.accounts.get(existing)?.status).toBe('ACTIVE');

    // Foreign: Composio says the account is another user's.
    started = await t.start();
    back = await t.consent(started.authorize_url);
    const foreign = composio.accounts.get(String(back.searchParams.get('connected_account_id')));
    if (!foreign) throw new Error('missing account');
    foreign.user_id = 'melete:someone:else';
    landed = await t.land(back);
    expect(landed.status).toBe(400);
    expect((await t.status(started.sign_in_id)).state).toBe('failed');

    // Inactive: the browser claims success before the consent finished.
    started = await t.start();
    const pending = [...composio.accounts.values()].at(-1);
    if (!pending?.callback_url) throw new Error('missing link');
    const early = new URL(pending.callback_url);
    early.searchParams.set('status', 'success');
    early.searchParams.set('connected_account_id', pending.id);
    landed = await t.land(early);
    expect(landed.status).toBe(400);
    expect(await landed.text()).toContain('did not finish');

    // Declined at the consent page.
    composio.decline = true;
    started = await t.start();
    landed = await t.land(await t.consent(started.authorize_url));
    composio.decline = false;
    expect(landed.status).toBe(400);
    expect(await t.status(started.sign_in_id)).toEqual({
      state: 'failed',
      error: 'sign_in_declined',
    });

    // Someone else's session cannot spend this person's return.
    started = await t.start();
    back = await t.consent(started.authorize_url);
    const stranger = await t.app.request(
      `/managed-sign-ins/callback${back.search}`,
      t.as('melete_session=not-a-session'),
    );
    expect(stranger.status).not.toBe(200);

    expect((await t.rows('person@example.test')).length).toBe(before);
  }, 60_000);

  test('two Gmail accounts give two sets of connections', async () => {
    const t = need();
    const { status } = await t.signIn(second);
    if (status.state !== 'connected') throw new Error(`Sign-in ended ${status.state}`);
    const first = await t.rows('person@example.test');
    const other = await t.rows('second@example.test');
    expect(other.map((row) => row.provider)).toEqual(['caldav', 'imap']);
    const ids = new Set([...first, ...other].map((row) => row.id));
    expect(ids.size).toBe(first.length + other.length);
    const accounts = new Set(
      [...first, ...other].map((row) => String(row.configuration.connected_account_id)),
    );
    expect(accounts.size).toBe(first.length + other.length);
  }, 60_000);

  test('the same address through another Composio account is refused while the first still works', async () => {
    const t = need();
    const before = await t.rows('second@example.test');
    composio.signInAs(googleUpstream(second));
    const started = await t.start();
    const back = await t.consent(started.authorize_url);
    const made = String(back.searchParams.get('connected_account_id'));
    const landed = await t.land(back);
    expect(landed.status).toBe(409);
    expect(await landed.text()).toContain('already connected');
    expect(composio.removed).toContain(made);
    expect(await t.rows('second@example.test')).toEqual(before);
  }, 60_000);

  test('moving an account from its own sign-in to Composio and back keeps its connection, and reports nothing twice', async () => {
    const t = need();
    // Natively first, with the operator's own Google client.
    const native = accountSignInStart.parse(
      await (await t.app.request('/google-sign-ins', t.as(t.cookie, {}))).json(),
    );
    const approved = await fetch(native.authorize_url, { redirect: 'manual' });
    const back = new URL(approved.headers.get('location') ?? '');
    expect(
      (await t.app.request(`/oauth/google/callback${back.search}`, t.as(t.cookie))).status,
    ).toBe(200);
    const nativeRows = await t.rows('switch@example.test');
    const mail = nativeRows.find((row) => row.provider === 'imap');
    if (!mail) throw new Error('no mailbox');
    expect(mail.secret_ref).not.toBeNull();

    const mailEvents = async () => {
      const [row] = await t.sql`select count(*)::int as n from event
        where payload->>'connection_id' = ${String(mail.id)}
          and payload->>'event_name' = 'mail.received'`;
      return Number(row?.n);
    };
    await t.poller.runOnce(); // where watching starts
    const [{ cursor: started } = { cursor: null }] = await t.sql`select cursor from source_cursor
      where connection_id = ${String(mail.id)}`;
    switching.deliver(
      'From: boss@example.test\nTo: switch@example.test\nSubject: Quarterly plan\nMessage-ID: <plan@example.test>\n\nSee attached.\n',
    );
    t.tick(3_600_000);
    await t.poller.runOnce();
    expect(await mailEvents()).toBe(1);

    // Through Composio now: the same row, a new generation, no token kept.
    const calls = composio.proxyCalls.length;
    const { status } = await t.signIn(switching);
    if (status.state !== 'connected') throw new Error(`Sign-in ended ${status.state}`);
    const managedRows = await t.rows('switch@example.test');
    expect(managedRows.map((row) => row.id).sort()).toEqual(nativeRows.map((row) => row.id).sort());
    const managedMail = managedRows.find((row) => row.id === mail.id);
    expect(managedMail?.configuration.via).toBe('composio');
    expect(managedMail?.secret_ref).toBeNull();
    expect(Number(managedMail?.generation)).toBeGreaterThan(Number(mail.generation));

    // Read again from before the message: the same message is the same key.
    await t.sql`update source_cursor set cursor = ${JSON.stringify(started)}::jsonb
      where connection_id = ${String(mail.id)}`;
    t.tick(3_600_000);
    await t.poller.runOnce();
    expect(
      composio.proxyCalls.slice(calls).some((call) => call.endpoint.includes('/history')),
    ).toBe(true);
    expect(await mailEvents()).toBe(1);

    // And back to its own sign-in: the Composio account goes with it.
    const account = String(managedMail?.configuration.connected_account_id);
    const again = accountSignInStart.parse(
      await (await t.app.request('/google-sign-ins', t.as(t.cookie, {}))).json(),
    );
    const returned = new URL(
      (await fetch(again.authorize_url, { redirect: 'manual' })).headers.get('location') ?? '',
    );
    expect(
      (await t.app.request(`/oauth/google/callback${returned.search}`, t.as(t.cookie))).status,
    ).toBe(200);
    const backRows = await t.rows('switch@example.test');
    expect(backRows.map((row) => row.id).sort()).toEqual(nativeRows.map((row) => row.id).sort());
    expect(backRows.find((row) => row.id === mail.id)?.configuration.via).toBeUndefined();
    expect(composio.removed).toContain(account);
    await t.sql`update source_cursor set cursor = ${JSON.stringify(started)}::jsonb
      where connection_id = ${String(mail.id)}`;
    t.tick(3_600_000);
    await t.poller.runOnce();
    expect(await mailEvents()).toBe(1);
  }, 90_000);

  test('watching an account through Composio reads it less often, and the monthly limit slows it further with the reason shown, never stopping a send', async () => {
    const t = need();
    const [mail] = await t.sql`select id from connection where provider = 'imap'
      and configuration->>'account' = 'person@example.test' and status = 'active'`;
    const id = String(mail?.id);
    await t.poller.refresh();
    const cursor = async () => {
      const [row] = await t.sql`select interval_s, next_poll_at, last_error from source_cursor
        where connection_id = ${id} and stream = 'mail'`;
      return row;
    };
    expect(Number((await cursor())?.interval_s)).toBe(MANAGED_WATCH_SECONDS.mail?.day ?? 0);

    const used = async (calls: number) => {
      await t.sql`delete from managed_call`;
      await t.sql`insert into managed_call (principal_id, month, calls)
        values ('own_elsewhere', ${monthOf(Date.now())}, ${calls})`;
    };
    // Close to the limit: read half as often, and said why.
    await used(CAP * 0.9);
    t.tick(3_600_000);
    await t.sql`update source_cursor
      set next_poll_at = ${new Date(t.now() - 1000).toISOString()}::timestamptz
      where connection_id = ${id}`;
    await t.poller.runOnce();
    expect((await cursor())?.last_error).toBe(MANAGED_NEAR_WORDS);

    // Past it: once an hour, still read, and the person sees the reason.
    await used(CAP + 5);
    t.tick(3_600_000);
    await t.sql`update source_cursor
      set next_poll_at = ${new Date(t.now() - 1000).toISOString()}::timestamptz
      where connection_id = ${id}`;
    const before = (await t.meter.used()) as number;
    const result = await t.poller.runOnce();
    expect(result.failed).toBe(0);
    expect(await t.meter.used()).toBeGreaterThan(before);
    const slowed = await cursor();
    expect(slowed?.last_error).toBe(MANAGED_REACHED_WORDS);
    expect(new Date(slowed?.next_poll_at).getTime()).toBe(t.now() + MAX_POLL_SECONDS * 1000);
    const listed = connectionListResponse
      .parse(await (await t.app.request('/connections', t.as(t.cookie))).json())
      .connections.find((row) => row.id === id);
    expect(listed?.reading_note).toBe(MANAGED_REACHED_WORDS);
    // And on the app's own list of connections, where the person reads it.
    const shown = (
      (await (await t.app.request('/experience/connections', t.as(t.cookie))).json()) as {
        connections: { id: string; reading_note?: string; via?: string }[];
      }
    ).connections.find((row) => row.id === id);
    expect(shown).toMatchObject({ reading_note: MANAGED_REACHED_WORDS, via: 'composio' });

    // A send the person approved goes, limit or not.
    const connector = registry.get(id) as EmailConnector;
    const sent = await connector.execute(
      {
        ...mailAction(
          'email.send',
          { to: ['friend@example.test'], subject: 'Thursday', body: 'Yes, Thursday works.' },
          'act_send0001',
        ),
        connection_id: id,
      },
      { ...mailContext('act_send0001'), space_id: t.spaceId },
    );
    expect(sent.outcome).toBe('succeeded');
    expect(person.sent).toHaveLength(1);
    await t.sql`delete from managed_call`;
  }, 60_000);

  test('disconnecting revokes and removes its Composio account, and only that one', async () => {
    const t = need();
    const [mail, calendar] = await t
      .rows('second@example.test')
      .then((rows) => [
        rows.find((row) => row.provider === 'imap'),
        rows.find((row) => row.provider === 'caldav'),
      ]);
    if (!mail || !calendar) throw new Error('missing rows');
    const revoked = await t.app.request(
      `/connections/${mail.id}/lifecycle`,
      t.as(t.cookie, { kind: 'revoke', expected_generation: Number(mail.generation) }),
    );
    expect(revoked.status).toBe(200);
    expect(composio.removed).toContain(String(mail.configuration.connected_account_id));
    expect(composio.removed).not.toContain(String(calendar.configuration.connected_account_id));
    expect(composio.accounts.get(String(calendar.configuration.connected_account_id))?.status).toBe(
      'ACTIVE',
    );
  }, 60_000);
});
