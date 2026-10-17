/**
 * Signing in to Google and other apps through Composio, end to end against a
 * fake Composio whose Google tools a fake Google answers: the connect
 * screen's entries, the consent pages one part at a time, what a forged,
 * foreign, inactive or replayed return is told, two accounts, a duplicate,
 * moving an account between its native sign-in and Composio without
 * reporting anything twice, an app's sign-in and tools, triggers ringing the
 * doorbell, disconnecting, and the operator's limits on use through Composio.
 * Nothing goes through Composio's proxy.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  accountSignInStart,
  accountSignInStatus,
  connectionKindListResponse,
  connectionListResponse,
  managedSignInStart,
} from '@melete/contracts';
import { COMPOSIO_NOTE } from '../../src/api/connections.ts';
import { ComposioClient } from '../../src/connectors/composio.ts';
import { ComposioAppConnector } from '../../src/connectors/composio-app.ts';
import { ComposioTriggers } from '../../src/connectors/composio-triggers.ts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { EmailConnector } from '../../src/connectors/email.ts';
import { googleUpstream, startFakeComposio } from '../../src/connectors/fixtures/fake-composio.ts';
import { startFakeGoogle } from '../../src/connectors/fixtures/fake-google.ts';
import { GoogleCalendarConnector } from '../../src/connectors/google-calendar.ts';
import { mailAction, mailContext } from '../../src/connectors/mail-fixtures.ts';
import { managedRevocation, sweepManagedRemovals } from '../../src/connectors/managed-accounts.ts';
import { UNUSED_ACCOUNT_GRACE_MS } from '../../src/connectors/managed-sign-in.ts';
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
  CAP_WORDS,
  ComposioMeter,
  MANAGED_NEAR_WORDS,
  MANAGED_REACHED_WORDS,
} from '../../src/signals/managed-calls.ts';
import {
  MANAGED_WATCH_SECONDS,
  MAX_POLL_SECONDS,
  SignalPoller,
  TRIGGERED_WATCH_SECONDS,
} from '../../src/signals/poller.ts';
import { sweepPrincipals } from '../../src/spaces/plan.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '5c'.repeat(32);
const PUBLIC_URL = 'http://localhost:3000';
const CAP = 1000;
const WEBHOOK_SECRET = 'composio-webhook-secret-for-tests';
const OPERATOR_TOKEN = 'operator-token-for-managed-sign-in-tests';

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
  const meter = new ComposioMeter(fixture.sql, {
    caps: { tool_calls: CAP },
    ratesUsd: { tool_calls: 0.0005, trigger_events: 0.005 },
    billingDay: 1,
  });
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
      COMPOSIO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MELETE_COMPOSIO_TOOL_CALLS_MONTHLY_CAP: String(CAP),
      MELETE_OPERATOR_TOKEN: OPERATOR_TOKEN,
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
    managedTriggers: true,
  });
  const triggers = new ComposioTriggers({ sql: fixture.sql, client, meter });
  /** A delivery from Composio's trigger, signed as Composio signs it. */
  const deliver = (body: unknown, secret = WEBHOOK_SECRET) => {
    const text = JSON.stringify(body);
    const id = `msg_${Math.random().toString(36).slice(2)}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret)
      .update(`${id}.${timestamp}.${text}`)
      .digest('base64');
    return app.request('/composio/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature}`,
      },
      body: text,
    });
  };

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
    triggers,
    deliver,
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
    // The popular apps sign in through Composio too, each one by its toolkit.
    const slack = listed.catalog?.find((entry) => entry.id === 'app-slack');
    expect(slack?.connect).toMatchObject({
      method: 'managed_sign_in',
      provider: 'app',
      toolkit: 'slack',
      via: 'composio',
      start: '/managed-sign-ins',
    });
    expect(slack?.covers).toEqual(['tools']);
    expect(listed.catalog?.some((entry) => entry.id === 'app-gmail')).toBe(false);
    // Any other app is found by searching Composio's catalog.
    const searched = (await (
      await t.app.request('/composio/apps?query=acme', t.as(t.cookie))
    ).json()) as { apps: { toolkit: string }[] };
    expect(searched.apps.map((app) => app.toolkit)).toEqual(['acme_crm']);
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
    // Each is watched by a trigger at Composio, kept on its row.
    for (const row of made) {
      const trigger = composio.triggers.get(String(row.configuration.trigger_id));
      expect(trigger).toMatchObject({
        account: row.configuration.connected_account_id,
        enabled: true,
        slug:
          row.provider === 'imap'
            ? 'GMAIL_NEW_GMAIL_MESSAGE'
            : 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER',
      });
    }
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

  test('while Composio cannot say how the first account stands, the same address is refused and the first kept', async () => {
    const t = need();
    const before = await t.rows('second@example.test');
    const mail = before.find((row) => row.provider === 'imap');
    const first = String(mail?.configuration.connected_account_id);
    composio.unreadable.add(first);
    try {
      composio.signInAs(googleUpstream(second));
      const started = await t.start();
      const back = await t.consent(started.authorize_url);
      const made = String(back.searchParams.get('connected_account_id'));
      const landed = await t.land(back);
      expect(landed.status).toBe(502);
      // Not knowing is not the same as gone: the working account stays, the new one goes.
      expect(composio.removed).not.toContain(first);
      expect(composio.accounts.get(first)?.status).toBe('ACTIVE');
      expect(composio.removed).toContain(made);
      expect(await t.rows('second@example.test')).toEqual(before);
    } finally {
      composio.unreadable.delete(first);
    }
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
    const calls = composio.executions.length;
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
      composio.executions.slice(calls).some((call) => call.tool === 'GMAIL_LIST_HISTORY'),
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

  test('watching an account through Composio reads it less often, slows near the limit, and past it reads nothing and sends nothing', async () => {
    const t = need();
    const [mail] = await t.sql`select id, configuration from connection where provider = 'imap'
      and configuration->>'account' = 'person@example.test' and status = 'active'`;
    const id = String(mail?.id);
    await t.poller.refresh();
    const cursor = async () => {
      const [row] = await t.sql`select interval_s, next_poll_at, last_error from source_cursor
        where connection_id = ${id} and stream = 'mail'`;
      return row;
    };
    // Its trigger rings when mail arrives, so the schedule is only a backstop.
    expect(Number((await cursor())?.interval_s)).toBe(TRIGGERED_WATCH_SECONDS.day);
    expect(TRIGGERED_WATCH_SECONDS.day).toBeGreaterThan(MANAGED_WATCH_SECONDS.mail?.day ?? 0);

    const period = t.meter.period().start;
    const used = async (calls: number) => {
      await t.sql`delete from composio_usage`;
      await t.sql`insert into composio_usage (period, dimension, used)
        values (${period}, 'tool_calls', ${calls})`;
    };
    const due = () => t.sql`update source_cursor
      set next_poll_at = ${new Date(t.now() - 1000).toISOString()}::timestamptz
      where connection_id = ${id}`;
    // Close to the limit: read half as often, and said why.
    await used(CAP * 0.9);
    t.tick(3_600_000);
    await due();
    await t.poller.runOnce();
    expect((await cursor())?.last_error).toBe(MANAGED_NEAR_WORDS);

    // Past it: not read at all, looked at again hourly at no cost, and the person sees the reason.
    await used(CAP);
    t.tick(3_600_000);
    await due();
    const calls = composio.executions.length;
    const result = await t.poller.runOnce();
    expect(result.failed).toBe(0);
    expect(composio.executions.length).toBe(calls);
    expect((await t.meter.standing()).dimensions.tool_calls.used).toBe(CAP);
    const paused = await cursor();
    expect(paused?.last_error).toBe(MANAGED_REACHED_WORDS);
    expect(new Date(paused?.next_poll_at).getTime()).toBe(t.now() + MAX_POLL_SECONDS * 1000);
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

    // A send the person approved is refused too, with the sentence the agent relays.
    const connector = registry.get(id) as EmailConnector;
    const send = (action: string) =>
      connector.execute(
        {
          ...mailAction(
            'email.send',
            { to: ['friend@example.test'], subject: 'Thursday', body: 'Yes, Thursday works.' },
            action,
          ),
          connection_id: id,
        },
        { ...mailContext(action), space_id: t.spaceId },
      );
    const refused = await send('act_send0001');
    expect(refused).toEqual({ outcome: 'failed', reason: CAP_WORDS.tool_calls, retryable: false });
    expect(person.sent).toHaveLength(0);
    expect(composio.executions.length).toBe(calls);

    // The operator sees each limit; nobody else does.
    const detail = await t.app.request('/health/detail', {
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(((await detail.json()) as { composio?: unknown }).composio).toMatchObject({
      period,
      tool_calls: { used: CAP, cap: CAP, state: 'reached' },
      trigger_events: { cap: null },
      connected_accounts: { cap: null },
    });

    // Under the limit again, the send goes.
    await t.sql`delete from composio_usage`;
    const sent = await send('act_send0002');
    expect(sent.outcome).toBe('succeeded');
    expect(person.sent).toHaveLength(1);
    expect(composio.executions.at(-1)?.tool).toBe('GMAIL_SEND_EMAIL');
  }, 60_000);

  test('a trigger delivery is believed only when signed, is counted, and has its account read now; past the event limit the triggers go off until the month resets', async () => {
    const t = need();
    const [mail] = await t.sql`select id, configuration from connection where provider = 'imap'
      and configuration->>'account' = 'person@example.test' and status = 'active'`;
    const id = String(mail?.id);
    const configuration = mail?.configuration as Record<string, string>;
    const event = {
      id: 'evt_1',
      type: 'composio.trigger.message',
      metadata: {
        trigger_id: configuration.trigger_id,
        connected_account_id: configuration.connected_account_id,
        trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      },
      data: {},
    };
    await t.sql`update source_cursor set next_poll_at = now() + interval '1 hour'
      where connection_id = ${id}`;
    const nextRead = async () => {
      const [row] = await t.sql`select next_poll_at <= now() as due from source_cursor
        where connection_id = ${id} and stream = 'mail'`;
      return Boolean(row?.due);
    };
    // Unsigned or signed with another secret: refused, not counted, nothing moved.
    expect((await t.deliver(event, 'not-the-webhook-secret')).status).toBe(401);
    expect(
      (
        await t.app.request('/composio/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        })
      ).status,
    ).toBe(401);
    expect((await t.meter.standing()).dimensions.trigger_events.used).toBe(0);
    expect(await nextRead()).toBe(false);
    // Signed: counted, and the account is read now.
    expect((await t.deliver(event)).status).toBe(204);
    expect((await t.meter.standing()).dimensions.trigger_events.used).toBe(1);
    expect(await nextRead()).toBe(true);

    // A cap on trigger events: the event that spends it switches every trigger off at Composio.
    t.meter.settings.caps.trigger_events = 2;
    try {
      expect((await t.deliver(event)).status).toBe(204);
      const kept = await t.sql`select configuration->>'trigger_id' as id from connection
        where status = 'active' and configuration ? 'trigger_id'`;
      expect(kept.length).toBeGreaterThan(1);
      for (const row of kept) expect(composio.triggers.get(String(row.id))?.enabled).toBe(false);
      // Accounts go back to their schedule while the triggers are off.
      await t.poller.refresh();
      const [watched] = await t.sql`select interval_s from source_cursor
        where connection_id = ${id} and stream = 'mail'`;
      expect(Number(watched?.interval_s)).toBe(MANAGED_WATCH_SECONDS.mail?.day ?? 0);
      // A new month: the triggers come back on.
      await t.sql`delete from composio_usage where dimension = 'trigger_events'`;
      await t.triggers.sweep();
      for (const row of kept) expect(composio.triggers.get(String(row.id))?.enabled).toBe(true);
    } finally {
      delete t.meter.settings.caps.trigger_events;
      await t.sql`delete from composio_usage`;
    }
  }, 60_000);

  test('another app signs in through Composio as one connection whose tools the agent finds and runs there', async () => {
    const t = need();
    composio.signInAs(googleUpstream(person));
    // An app Composio does not sign in to, or one of Google's own parts, is refused.
    for (const toolkit of ['spotify', 'gmail', 'no_such_app'])
      expect(
        (await t.app.request('/managed-sign-ins', t.as(t.cookie, { provider: 'app', toolkit })))
          .status,
      ).toBe(400);
    const started = await t.start({ provider: 'app', toolkit: 'slack' });
    expect(started.connects).toEqual(['tools']);
    const done = await t.land(await t.consent(started.authorize_url));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Slack connected');
    const status = await t.status(started.sign_in_id);
    if (status.state !== 'connected') throw new Error(`Sign-in ended ${status.state}`);
    const [row] = await t.sql`select id, provider, label, secret_ref, scopes, configuration
      from connection where id = ${status.connection_ids[0] ?? ''}`;
    expect(row).toMatchObject({ provider: 'composio', label: 'Slack', secret_ref: null });
    expect(row?.configuration).toMatchObject({
      kind: 'composio_app',
      toolkit: 'slack',
      title: 'Slack',
      via: 'composio',
    });
    expect(row?.configuration.trigger_id).toBeUndefined();
    const connector = registry.get(String(row?.id));
    expect(connector).toBeInstanceOf(ComposioAppConnector);
    const ran = await (connector as ComposioAppConnector).execute(
      {
        ...mailAction('app_slack.read', { tool: 'SLACK_LIST_CHANNELS', arguments: {} }),
        kind: 'app_slack.read',
        connection_id: String(row?.id),
      },
      { ...mailContext(), space_id: t.spaceId },
    );
    expect(ran.outcome).toBe('succeeded');
    expect(composio.executions.at(-1)).toMatchObject({
      account: row?.configuration.connected_account_id,
      tool: 'SLACK_LIST_CHANNELS',
    });
    // The same app again, while the first still works, is refused, and its new account goes.
    const again = await t.start({ provider: 'app', toolkit: 'slack' });
    const back = await t.consent(again.authorize_url);
    const made = String(back.searchParams.get('connected_account_id'));
    expect((await t.land(back)).status).toBe(409);
    expect(composio.removed).toContain(made);
  }, 60_000);

  test('a sign-in past the limit on connected accounts is refused before any account is made', async () => {
    const t = need();
    const [row] = await t.sql`select count(distinct id)::int as n from (
        select configuration->>'connected_account_id' as id from connection
          where status <> 'revoked' and configuration->>'via' = 'composio'
        union select connected_account_id from managed_account_removal) accounts`;
    const inUse = Number(row?.n);
    expect((await t.meter.standing()).accounts.used).toBe(inUse);
    t.meter.settings.accountsCap = inUse;
    try {
      const known = composio.accounts.size;
      const refused = await t.app.request(
        '/managed-sign-ins',
        t.as(t.cookie, { provider: 'app', toolkit: 'notion' }),
      );
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
        CAP_WORDS.connected_accounts,
      );
      expect(composio.accounts.size).toBe(known);
      // One more place, and the sign-in starts.
      t.meter.settings.accountsCap = inUse + 1;
      composio.signInAs(googleUpstream(person));
      await t.start({ provider: 'app', toolkit: 'notion' });
      expect(composio.accounts.size).toBe(known + 1);
    } finally {
      delete t.meter.settings.accountsCap;
    }
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
    // Its trigger goes with it; the calendar's stays.
    expect(composio.triggers.has(String(mail.configuration.trigger_id))).toBe(false);
    expect(composio.triggers.has(String(calendar.configuration.trigger_id))).toBe(true);
    expect(composio.accounts.get(String(calendar.configuration.connected_account_id))?.status).toBe(
      'ACTIVE',
    );
  }, 60_000);

  test('removing a space queues its Composio accounts, which are tried again until Composio confirms them gone', async () => {
    const t = need();
    // An account at Composio, connected in a space of its own.
    composio.signInAs(googleUpstream(second));
    const linked = await client.link({
      authConfigId: await client.authConfig('gmail'),
      userId: 'melete:removal:removal',
      callbackUrl: `${PUBLIC_URL}/api/managed-sign-ins/callback?state=unused`,
    });
    expect((await fetch(linked.redirectUrl, { redirect: 'manual' })).status).toBe(302);
    const ca = linked.connectedAccountId;
    const spaceId = 'spc_managedremoval01';
    await t.sql`insert into space (id, name, git_path) values (${spaceId}, 'Removed', ${`test/${spaceId}`})`;
    await t.sql`insert into connection (id, space_id, provider, label, configuration)
      values ('con_managedremoval01', ${spaceId}, 'imap', 'Gmail (room@example.test)',
        ${JSON.stringify({ kind: 'gmail', account: 'room@example.test', via: 'composio', connected_account_id: ca })}::jsonb)`;
    composio.unremovable.add(ca);
    try {
      await sweepPrincipals(t.sql, spaceId);
      expect(await t.sql`select 1 from connection where space_id = ${spaceId}`).toHaveLength(0);
      const [queued] = await t.sql`select attempts from managed_account_removal
        where connected_account_id = ${ca}`;
      expect(queued?.attempts).toBe(0);
      // Composio cannot be reached: the account stays queued, with its reason and a later try.
      const at = Date.now();
      expect((await sweepManagedRemovals(t.sql, client, at)).failed).toContain(ca);
      const [failed] = await t.sql`select attempts, last_error, next_attempt_at
        from managed_account_removal where connected_account_id = ${ca}`;
      expect(failed?.attempts).toBe(1);
      expect(String(failed?.last_error)).toBe('composio_unavailable_503');
      expect(new Date(failed?.next_attempt_at).getTime()).toBeGreaterThan(at);
      expect(composio.accounts.has(ca)).toBe(true);
      // Not due again yet, so not asked again.
      expect((await sweepManagedRemovals(t.sql, client, at)).failed).not.toContain(ca);
      // Once Composio answers, the next due try removes it and the queue lets it go.
      composio.unremovable.delete(ca);
      const later = await sweepManagedRemovals(t.sql, client, at + 2 * 60 * 60_000);
      expect(later.removed).toContain(ca);
      expect(composio.removed).toContain(ca);
      expect(
        await t.sql`select 1 from managed_account_removal where connected_account_id = ${ca}`,
      ).toHaveLength(0);
    } finally {
      composio.unremovable.delete(ca);
      await t.sql`delete from space where id = ${spaceId}`;
    }
  }, 60_000);

  test('a sign-in left unfinished has its account removed once it expires, and a kept account never is', async () => {
    const t = need();
    composio.signInAs(googleUpstream(second));
    const known = new Set(composio.accounts.keys());
    const started = await t.start();
    const made = [...composio.accounts.keys()].find((id) => !known.has(id));
    if (!made) throw new Error('no account was made');
    const [queued] = await t.sql`select next_attempt_at from managed_account_removal
      where connected_account_id = ${made}`;
    const due = new Date(queued?.next_attempt_at).getTime();
    expect(due).toBe(Date.parse(started.expires_at) + UNUSED_ACCOUNT_GRACE_MS);
    // Before then it is left alone: the person may still finish.
    expect((await sweepManagedRemovals(t.sql, client, due - 1000)).removed).not.toContain(made);
    expect(composio.accounts.has(made)).toBe(true);
    expect((await sweepManagedRemovals(t.sql, client, due)).removed).toContain(made);
    expect(composio.removed).toContain(made);

    // Every account a finished sign-in kept is off the queue.
    const kept = await t.sql<
      { id: string }[]
    >`select distinct configuration->>'connected_account_id' as id
      from connection where status <> 'revoked' and configuration->>'via' = 'composio'`;
    expect(kept.length).toBeGreaterThan(0);
    expect(
      await t.sql`select 1 from managed_account_removal
        where connected_account_id in ${t.sql(kept.map((row) => row.id))}`,
    ).toHaveLength(0);
    // And one queued by mistake is let go, not removed, while a connection acts for it.
    const live = String(kept[0]?.id);
    await t.sql`insert into managed_account_removal (connected_account_id) values (${live})`;
    const swept = await sweepManagedRemovals(t.sql, client, Date.now() + 1000);
    expect(swept.kept).toContain(live);
    expect(swept.removed).not.toContain(live);
    expect(composio.accounts.get(live)?.status).toBe('ACTIVE');
  }, 60_000);
});
