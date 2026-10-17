/**
 * The managed path under Melete's own Google connectors: the Composio client,
 * the tool fetcher and what it refuses, the answers it maps, and the same
 * recorded Google answers read natively and through Composio's tools giving
 * the same observations and dedup keys. Nothing goes through Composio's proxy.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { MCP_CATALOG, mcpCatalogCovers } from '@melete/contracts';
import type { Sql } from 'postgres';
import { CAP_WORDS, ComposioCapReached, type ComposioMeter } from '../signals/managed-calls.ts';
import { mailObservation } from '../signals/observations.ts';
import { ComposioClient, ComposioFault, type ComposioToolkit } from './composio.ts';
import { ComposioAppConnector } from './composio-app.ts';
import { ComposioCatalog, notOfferedHere, POPULAR_APPS } from './composio-catalog.ts';
import {
  composioToolFetch,
  MANAGED_GOOGLE_BASES,
  MANAGED_READS,
  MANAGED_TOOLKITS,
  MANAGED_WRITES,
  ManagedRequestRefused,
  type ManagedRule,
  managedAccess,
  namesManagedAuthority,
} from './composio-fetch.ts';
import { ComposioRunner } from './composio-sessions.ts';
import { signedByComposio } from './composio-triggers.ts';
import { ConnectorFactory } from './configured.ts';
import type { EmailConnector } from './email.ts';
import { ConnectorFaultError } from './faults.ts';
import { startFakeComposio, type Upstream } from './fixtures/fake-composio.ts';
import { GmailApiTransport } from './gmail.ts';
import { GoogleCalendarConnector } from './google-calendar.ts';
import { GoogleDriveConnector } from './google-drive.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import { COMPOSIO_META_TOOL, listMcpServerTools } from './mcp.ts';
import { type SignedInAccess, SignInEnded } from './signed-in.ts';

type Route = (url: URL, init: RequestInit) => { status?: number; body?: unknown } | undefined;

/** Recorded answers, served the same to the native path and to Composio's upstream. */
function recorded(route: Route) {
  const asked: { method: string; url: URL; authorization: string | null }[] = [];
  const answer = async (url: URL, init: RequestInit = {}) => {
    asked.push({
      method: init.method ?? 'GET',
      url,
      authorization: new Headers(init.headers).get('authorization'),
    });
    const found = route(url, init) ?? { status: 404, body: { error: { code: 404 } } };
    return new Response(JSON.stringify(found.body ?? {}), {
      status: found.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const fetcher = ((input: string | URL | Request, init?: RequestInit) =>
    answer(
      new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      init,
    )) as typeof fetch;
  return { fetcher, upstream: answer as Upstream, asked };
}

const native: SignedInAccess = { token: async () => 'native', renew: async () => 'native' };
const fake = await startFakeComposio();
afterAll(() => fake.stop());
const client = new ComposioClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl });

/** An active connected account whose proxied requests `upstream` answers. */
async function activeAccount(upstream: Upstream, toolkit: ComposioToolkit = 'gmail') {
  fake.signInAs(upstream);
  const linked = await client.link({
    authConfigId: await client.authConfig(toolkit),
    userId: 'melete:own_test:own_test',
    callbackUrl: 'http://localhost:3000/api/managed-sign-ins/callback?state=s',
  });
  const consent = await fetch(linked.redirectUrl, { redirect: 'manual' });
  expect(consent.status).toBe(302);
  return linked.connectedAccountId;
}

const runner = new ComposioRunner(client);
afterAll(() => expect(fake.proxyCalls).toEqual([]));

/** A fetcher that runs one of the part's tools for each request it allows. */
const proxied = (
  accountId: string,
  rules: readonly ManagedRule[],
  part: keyof typeof MANAGED_TOOLKITS = 'mail',
) =>
  composioToolFetch({
    runner,
    connectedAccountId: accountId,
    toolkit: MANAGED_TOOLKITS[part],
    rules,
  });

describe('the Composio client', () => {
  test('a refused key, a missing account and a malformed id are typed faults, with no body in them', async () => {
    const wrong = new ComposioClient({ apiKey: 'not-the-key', baseUrl: fake.baseUrl });
    const refused = await wrong.account('ca_missing').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ComposioFault);
    expect((refused as ComposioFault).kind).toBe('key_refused');
    expect(String((refused as Error).message)).not.toContain('says no');
    const missing = await client.account('ca_missing').catch((error: unknown) => error);
    expect((missing as ComposioFault).kind).toBe('account_unavailable');
    expect((missing as ComposioFault).slug).toBe('ConnectedAccount_NotFound');
    const malformed = await client.account('../auth_configs').catch((error: unknown) => error);
    expect((malformed as ComposioFault).kind).toBe('account_unavailable');
  });

  test('a managed auth config is found or made once per toolkit, and a named one is used as named', async () => {
    const first = await client.authConfig('googledrive');
    expect(await client.authConfig('googledrive')).toBe(first);
    expect([...fake.authConfigs.values()].filter((c) => c.toolkit === 'googledrive')).toHaveLength(
      1,
    );
    expect(await client.authConfig('googledrive', 'ac_own')).toBe('ac_own');
  });

  test('removing an account revokes it, then deletes it; one already gone is taken as removed', async () => {
    const id = await activeAccount(recorded(() => undefined).upstream);
    await client.removeAccount(id);
    expect(fake.removed).toContain(id);
    expect(fake.accounts.has(id)).toBe(false);
    await client.removeAccount(id);
  });
});

describe('the tool fetcher', () => {
  test('the read fetcher refuses a send, and nothing reaches Composio', async () => {
    const google = recorded(() => ({ body: { id: 'sent', labelIds: ['SENT'] } }));
    const id = await activeAccount(google.upstream);
    const before = fake.executions.length;
    const read = proxied(id, MANAGED_READS.mail);
    await expect(
      read(`${MANAGED_GOOGLE_BASES.gmail}/messages/send`, {
        method: 'POST',
        body: JSON.stringify({ raw: 'eA' }),
      }),
    ).rejects.toBeInstanceOf(ManagedRequestRefused);
    expect(fake.executions.length).toBe(before);
    // The same send through the agent's fetcher goes, as Gmail's send tool with the message's fields.
    const write = proxied(id, MANAGED_WRITES.mail);
    const raw = Buffer.from(
      'To: Ann <ann@example.test>, bo@example.test\r\nCc: cy@example.test\r\nSubject: Hi\r\n\r\nHello there\r\n',
    ).toString('base64url');
    const sent = await write(`${MANAGED_GOOGLE_BASES.gmail}/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ id: 'sent', labelIds: ['SENT'] });
    expect(fake.executions.at(-1)).toMatchObject({
      account: id,
      tool: 'GMAIL_SEND_EMAIL',
      args: {
        recipient_email: 'ann@example.test',
        extra_recipients: ['bo@example.test'],
        cc: ['cy@example.test'],
        subject: 'Hi',
        is_html: false,
      },
    });
    // A message with an attachment is refused: Composio's send tool takes files only from its own storage.
    const attached = Buffer.from(
      [
        'To: ann@example.test',
        'Subject: File',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary=b',
        '',
        '--b',
        'Content-Type: text/plain',
        '',
        'See attached',
        '--b',
        'Content-Type: text/plain; name=a.txt',
        'Content-Disposition: attachment; filename=a.txt',
        '',
        'file',
        '--b--',
        '',
      ].join('\r\n'),
    ).toString('base64url');
    const count = fake.executions.length;
    await expect(
      write(`${MANAGED_GOOGLE_BASES.gmail}/messages/send`, {
        method: 'POST',
        body: JSON.stringify({ raw: attached }),
      }),
    ).rejects.toBeInstanceOf(ManagedRequestRefused);
    expect(fake.executions.length).toBe(count);
  });

  test('only the listed hosts and paths go, the person’s token is never sent, and queries travel as parameters', async () => {
    const google = recorded(() => ({ body: { messages: [] } }));
    const id = await activeAccount(google.upstream);
    const read = proxied(id, MANAGED_READS.mail);
    for (const address of [
      'https://evil.example/gmail/v1/users/me/messages',
      'http://gmail.googleapis.com/gmail/v1/users/me/messages',
      `${MANAGED_GOOGLE_BASES.gmail}/settings/forwardingAddresses`,
      `${MANAGED_GOOGLE_BASES.calendar}/events`,
      // A segment that would name another path once a server decodes it.
      `${MANAGED_GOOGLE_BASES.gmail}/messages/..%2Fsettings%2FforwardingAddresses`,
      `${MANAGED_GOOGLE_BASES.gmail}/messages/x%2F..%2F..%2Fsettings`,
      `${MANAGED_GOOGLE_BASES.gmail}/messages/..%5Csettings`,
      `${MANAGED_GOOGLE_BASES.gmail}/messages/me@other.example`,
    ])
      await expect(read(address)).rejects.toBeInstanceOf(ManagedRequestRefused);
    const answer = await read(`${MANAGED_GOOGLE_BASES.gmail}/messages?q=from%3Aa&maxResults=5`, {
      headers: { authorization: 'Bearer leaked' },
    });
    expect(answer.status).toBe(200);
    const asked = google.asked.at(-1);
    expect(asked?.url.searchParams.get('q')).toBe('from:a');
    expect(asked?.url.searchParams.get('maxResults')).toBe('5');
    expect(asked?.authorization).toBeNull();
  });

  test('an account Composio no longer acts for reads as a refused sign-in, and ends it on renewal', async () => {
    const id = await activeAccount(recorded(() => ({ body: {} })).upstream);
    const account = fake.accounts.get(id);
    if (!account) throw new Error('missing account');
    account.status = 'EXPIRED';
    const answer = await proxied(id, MANAGED_READS.mail)(`${MANAGED_GOOGLE_BASES.gmail}/profile`);
    expect(answer.status).toBe(401);
    await expect(managedAccess(client, id).renew('managed')).rejects.toBeInstanceOf(SignInEnded);
    account.status = 'ACTIVE';
    expect(await managedAccess(client, id).renew('managed')).toBe('managed');
  });

  test('Google asking for time reads as slowed, and Composio refusing the key reads as an outage', async () => {
    const id = await activeAccount(
      recorded(() => ({ status: 429, body: { error: { code: 429 } } })).upstream,
    );
    const slowed = await proxied(id, MANAGED_READS.mail)(`${MANAGED_GOOGLE_BASES.gmail}/profile`);
    expect(slowed.status).toBe(429);
    const wrong = composioToolFetch({
      runner: new ComposioRunner(
        new ComposioClient({ apiKey: 'not-the-key', baseUrl: fake.baseUrl }),
      ),
      connectedAccountId: id,
      toolkit: 'gmail',
      rules: MANAGED_READS.mail,
    });
    expect((await wrong(`${MANAGED_GOOGLE_BASES.gmail}/profile`)).status).toBe(503);
  });

  test('a tool input naming a Composio account or user is recognised anywhere in it', () => {
    expect(namesManagedAuthority({ query: 'x' })).toBe(false);
    expect(namesManagedAuthority({ connected_account_id: 'ca_x' })).toBe(true);
    expect(namesManagedAuthority({ nested: [{ userId: 'u' }] })).toBe(true);
    expect(namesManagedAuthority({ to: ['a@example.test'], 'Connected-Account-Id': 'ca' })).toBe(
      true,
    );
  });
});

/** Recorded Gmail answers: a history page, then each message's headers. */
const gmailRoute: Route = (url) => {
  if (url.pathname.endsWith('/profile')) return { body: { historyId: '5000' } };
  if (url.pathname.endsWith('/history'))
    return {
      body: {
        history: [
          { id: '5001', messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] },
          { id: '5002', messagesAdded: [{ message: { id: 'd1', labelIds: ['DRAFT'] } }] },
          { id: '5003', messagesAdded: [{ message: { id: 'm2', labelIds: ['INBOX', 'SPAM'] } }] },
        ],
        historyId: '5010',
      },
    };
  const id = /\/messages\/([^/]+)$/.exec(url.pathname)?.[1];
  if (id && url.searchParams.get('format') === 'metadata')
    return {
      body: {
        id,
        labelIds: id === 'm2' ? ['INBOX', 'SPAM'] : ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'Shop <orders@shop.example>' },
            { name: 'To', value: 'me@example.test' },
            { name: 'Subject', value: `Order ${id}` },
            { name: 'Message-ID', value: `<${id}@shop.example>` },
            { name: 'In-Reply-To', value: '<thread@shop.example>' },
            { name: 'References', value: '<thread@shop.example>' },
            { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass' },
            { name: 'Date', value: 'Mon, 05 Oct 2026 10:00:00 +0000' },
          ],
        },
      },
    };
  return undefined;
};

describe('the same recorded answers, natively and through Composio', () => {
  test('Gmail history gives the same messages, observations and dedup keys', async () => {
    const google = recorded(gmailRoute);
    const id = await activeAccount(google.upstream);
    const read = async (fetcher: typeof fetch, access: SignedInAccess) => {
      const transport = new GmailApiTransport({
        base: MANAGED_GOOGLE_BASES.gmail,
        from: 'me@example.test',
        access,
        fetcher,
      });
      const first = await transport.changes(null, { limit: 50 });
      const next = await transport.changes(first.cursor, { limit: 50 });
      return {
        first,
        next,
        observations: next.messages.map((message) =>
          mailObservation('conn_same0001', message, '2026-10-05T12:00:00.000Z'),
        ),
      };
    };
    const direct = await read(google.fetcher, native);
    const managed = await read(proxied(id, MANAGED_READS.mail), managedAccess(client, id));
    expect(managed).toEqual(direct);
    expect(direct.observations.map((o) => o.dedup_key)).toHaveLength(2);
    // The headers situations need come through Composio's tools unchanged.
    expect(JSON.stringify(managed.observations)).toContain('thread@shop.example');
  });

  test('Google Calendar occurrences are the same', async () => {
    const google = recorded((url) =>
      url.pathname.endsWith('/events')
        ? {
            body: {
              items: [
                {
                  id: 'abc_20261006T160000Z',
                  iCalUID: 'abc@google.com',
                  recurringEventId: 'abc',
                  status: 'confirmed',
                  summary: 'Standup',
                  start: { dateTime: '2026-10-06T09:00:00-07:00' },
                  end: { dateTime: '2026-10-06T09:15:00-07:00' },
                  originalStartTime: { dateTime: '2026-10-06T09:00:00-07:00' },
                  attendees: [{ email: 'me@example.test', self: true, responseStatus: 'accepted' }],
                  transparency: 'opaque',
                },
              ],
            },
          }
        : undefined,
    );
    const id = await activeAccount(google.upstream, 'googlecalendar');
    const window = { from: '2026-10-05T12:00:00.000Z', to: '2026-10-19T12:00:00.000Z' };
    const occurrences = async (fetcher: typeof fetch, access: SignedInAccess) => {
      const connector = new GoogleCalendarConnector({
        id: 'conn_same0002',
        spaceId: 'spc_test',
        base: MANAGED_GOOGLE_BASES.calendar,
        access,
        fetcher,
      });
      if (connector.signals?.stream !== 'calendar') throw new Error('expected a calendar');
      return connector.signals.occurrences(window);
    };
    const direct = await occurrences(google.fetcher, native);
    expect(direct.items).toHaveLength(1);
    expect(
      await occurrences(proxied(id, MANAGED_READS.calendar, 'calendar'), managedAccess(client, id)),
    ).toEqual(direct);
  });

  test('Drive changes are the same', async () => {
    const google = recorded((url) => {
      if (url.pathname.endsWith('/changes/startPageToken'))
        return { body: { startPageToken: '7' } };
      if (url.pathname.endsWith('/changes'))
        return {
          body: {
            changes: [
              {
                changeType: 'file',
                fileId: '1AbCdEfGhIjKlMnOpQrStUv',
                removed: false,
                file: {
                  id: '1AbCdEfGhIjKlMnOpQrStUv',
                  name: 'Plan',
                  mimeType: 'application/vnd.google-apps.document',
                  modifiedTime: '2026-10-05T11:00:00.000Z',
                  lastModifyingUser: { displayName: 'A', me: false },
                  shared: true,
                  trashed: false,
                  version: '12',
                },
              },
            ],
            newStartPageToken: '8',
          },
        };
      return undefined;
    });
    const id = await activeAccount(google.upstream, 'googledrive');
    const changes = async (fetcher: typeof fetch, access: SignedInAccess) => {
      const connector = new GoogleDriveConnector({
        id: 'conn_same0003',
        spaceId: 'spc_test',
        base: MANAGED_GOOGLE_BASES.drive,
        access,
        fetcher,
      });
      if (connector.signals?.stream !== 'documents') throw new Error('expected a Drive');
      const first = await connector.signals.changes(null, { limit: 50 });
      return [first, await connector.signals.changes(first.cursor, { limit: 50 })];
    };
    const direct = await changes(google.fetcher, native);
    expect(direct[1]?.changes).toHaveLength(1);
    expect(
      await changes(proxied(id, MANAGED_READS.documents, 'documents'), managedAccess(client, id)),
    ).toEqual(direct);
  });

  test('a calendar page as large as the connector itself reads is read the same', async () => {
    // Three long events: past a megabyte, within the two the connector allows.
    const items = [1, 2, 3].map((n) => ({
      id: `big${n}`,
      iCalUID: `big${n}@google.com`,
      status: 'confirmed',
      summary: `Planning ${n}`,
      description: 'x'.repeat(450 * 1024),
      start: { dateTime: `2026-10-0${n + 5}T09:00:00-07:00` },
      end: { dateTime: `2026-10-0${n + 5}T10:00:00-07:00` },
    }));
    const google = recorded((url) =>
      url.pathname.endsWith('/events') ? { body: { items } } : undefined,
    );
    const id = await activeAccount(google.upstream, 'googlecalendar');
    const window = { from: '2026-10-05T12:00:00.000Z', to: '2026-10-19T12:00:00.000Z' };
    const occurrences = async (fetcher: typeof fetch, access: SignedInAccess) => {
      const connector = new GoogleCalendarConnector({
        id: 'conn_same0004',
        spaceId: 'spc_test',
        base: MANAGED_GOOGLE_BASES.calendar,
        access,
        fetcher,
      });
      if (connector.signals?.stream !== 'calendar') throw new Error('expected a calendar');
      return connector.signals.occurrences(window);
    };
    const direct = await occurrences(google.fetcher, native);
    expect(direct.items).toHaveLength(3);
    expect(
      await occurrences(proxied(id, MANAGED_READS.calendar, 'calendar'), managedAccess(client, id)),
    ).toEqual(direct);
  });

  test('a message too large to read is left out of a search, as natively, rather than failing it', async () => {
    const small = Buffer.from(
      'From: a@example.test\r\nTo: me@example.test\r\nSubject: Hello\r\nMessage-ID: <small@example.test>\r\n\r\nHi\r\n',
    ).toString('base64url');
    const google = recorded((url) => {
      if (url.pathname.endsWith('/messages'))
        return { body: { messages: [{ id: 'big0001' }, { id: 'small001' }] } };
      // A message with a large attachment: larger than any answer Composio is let send back.
      if (url.pathname.endsWith('/messages/big0001'))
        return { body: { id: 'big0001', raw: 'A'.repeat(5 * 1024 * 1024) } };
      if (url.pathname.endsWith('/messages/small001'))
        return { body: { id: 'small001', raw: small } };
      return undefined;
    });
    const id = await activeAccount(google.upstream);
    const search = (fetcher: typeof fetch, access: SignedInAccess) =>
      new GmailApiTransport({
        base: MANAGED_GOOGLE_BASES.gmail,
        from: 'me@example.test',
        access,
        fetcher,
      }).search('', 10);
    const direct = await search(google.fetcher, native);
    expect(direct.map((message) => message.subject)).toEqual(['Hello']);
    expect(await search(proxied(id, MANAGED_READS.mail), managedAccess(client, id))).toEqual(
      direct,
    );
  });
});

describe('a connection signed in through Composio', () => {
  const factory = new ConnectorFactory({
    sql: {} as Sql,
    workRoot: 'unused',
    spacesRoot: 'unused',
    composio: { client },
  });

  test('a tool call naming a Composio account is refused before anything is sent', async () => {
    const google = recorded(gmailRoute);
    const id = await activeAccount(google.upstream);
    const connector = (await factory.open({
      id: 'con_test',
      spaceId: 'spc_test',
      provider: 'imap',
      secretRef: null,
      configuration: {
        kind: 'gmail',
        account: 'me@example.test',
        via: 'composio',
        connected_account_id: id,
      },
    })) as EmailConnector;
    expect(connector).toBeDefined();
    const before = fake.executions.length;
    const refused = await connector
      .execute(
        mailAction('email.search', { query: '', limit: 5, connected_account_id: 'ca_someone' }),
        mailContext(),
      )
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConnectorFaultError);
    expect(fake.executions.length).toBe(before);
    // The same search without it goes through the row's own account.
    const found = await connector.execute(
      mailAction('email.search', { query: '', limit: 5 }),
      mailContext(),
    );
    expect(found.outcome).toBe('succeeded');
    expect(fake.executions.length).toBeGreaterThan(before);
    expect(fake.executions.slice(before).every((call) => call.account === id)).toBe(true);
    // Its receipt says it went through Composio, and never names the account or the key.
    if (found.outcome !== 'succeeded') throw new Error('expected a receipt');
    expect(found.receipt.detail.via).toBe('composio');
    expect(JSON.stringify(found.receipt)).not.toContain(id);
    expect(JSON.stringify(found.receipt)).not.toContain(fake.apiKey);
  });

  test('what the poller reads cannot send, while the agent’s tools can', async () => {
    const google = recorded(gmailRoute);
    const id = await activeAccount(google.upstream);
    const connector = await factory.open({
      id: 'con_test',
      spaceId: 'spc_test',
      provider: 'imap',
      secretRef: null,
      configuration: {
        kind: 'gmail',
        account: 'me@example.test',
        via: 'composio',
        connected_account_id: id,
      },
    });
    const signals = (connector as { signals?: { stream: string } }).signals;
    expect(signals?.stream).toBe('mail');
    // The poller's source is not the tools' own.
    expect(signals).not.toBe(
      (
        await factory.open({
          id: 'con_test',
          spaceId: 'spc_test',
          provider: 'imap',
          secretRef: null,
          configuration: { kind: 'gmail', account: 'me@example.test' },
        })
      )?.signals,
    );
  });

  test('without Composio set up, or without an account, it offers nothing', async () => {
    const bare = new ConnectorFactory({ sql: {} as Sql, workRoot: 'unused', spacesRoot: 'unused' });
    const row = {
      id: 'con_test',
      spaceId: 'spc_test',
      provider: 'imap',
      secretRef: null,
      configuration: { kind: 'gmail', account: 'me@example.test', via: 'composio' },
    };
    expect(await bare.open(row)).toBeUndefined();
    expect(await factory.open(row)).toBeUndefined();
  });
});

describe('Composio’s meta tools', () => {
  test('are never offered, whatever an MCP server lists', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'listing', version: '1.0.0' },
              }
            : message.method === 'tools/list'
              ? {
                  tools: ['COMPOSIO_MULTI_EXECUTE_TOOL', 'composio_search_tools', 'GMAIL_SEND'].map(
                    (name) => ({ name, inputSchema: { type: 'object' } }),
                  ),
                }
              : null;
        return result
          ? Response.json({ jsonrpc: '2.0', id: message.id, result })
          : Response.json({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'no' },
            });
      },
    });
    try {
      expect(await listMcpServerTools({ transport: 'http', url: `${server.url}mcp` })).toEqual([
        'GMAIL_SEND',
      ]);
      expect(COMPOSIO_META_TOOL.test('COMPOSIO_MANAGE_CONNECTIONS')).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});

/** A meter that only records what it was asked, refusing once `cap` calls are held. */
function countingMeter(cap = Number.POSITIVE_INFINITY) {
  const held = { count: 0, released: 0 };
  const meter = {
    async reserve(dimension: 'tool_calls') {
      if (held.count >= cap) throw new ComposioCapReached(dimension);
      held.count += 1;
      return { period: '2026-10-01', dimension, units: 1 };
    },
    async release() {
      held.count -= 1;
      held.released += 1;
    },
  } as unknown as ComposioMeter;
  return { meter, held };
}

describe('running a tool for one account', () => {
  test('each run is one session tool call, sessions are opened once per account and reopened when Composio drops them', async () => {
    const id = await activeAccount(recorded(gmailRoute).upstream);
    const own = new ComposioRunner(client);
    const opened = fake.sessions.size;
    for (let i = 0; i < 3; i++)
      expect(
        await own.run({
          connectedAccountId: id,
          toolkit: 'gmail',
          tool: 'GMAIL_GET_PROFILE',
          args: {},
        }),
      ).toMatchObject({ ok: true, data: { historyId: '5000' } });
    expect(fake.sessions.size).toBe(opened + 1);
    const [session] = [...fake.sessions.values()].slice(-1);
    expect(session).toMatchObject({ toolkit: 'gmail', account: id });
    // What Composio is asked for: one toolkit, pinned to this account and its own
    // user, with every extra that could cost more than a plain tool call off.
    expect(session?.request).toEqual({
      user_id: 'melete:own_test:own_test',
      toolkits: { enable: ['gmail'] },
      connected_accounts: { gmail: [id] },
      manage_connections: { enable: false },
      workbench: { enable: false },
      proxy_execute: { enable: false },
      instant: false,
      search: { enable: false },
    });
    fake.dropSessions();
    expect(
      await own.run({
        connectedAccountId: id,
        toolkit: 'gmail',
        tool: 'GMAIL_GET_PROFILE',
        args: {},
      }),
    ).toMatchObject({ ok: true });
    // A session for another toolkit than the account's is never opened.
    await expect(
      own.run({ connectedAccountId: id, toolkit: 'slack', tool: 'SLACK_LIST_CHANNELS', args: {} }),
    ).rejects.toBeInstanceOf(ComposioFault);
  });

  test('a call refused before it ran is given back; one that may have run, or timed out, stays counted', async () => {
    const id = await activeAccount(recorded(gmailRoute).upstream);
    const { meter, held } = countingMeter();
    const own = new ComposioRunner(client, meter);
    const run = () =>
      own.run({ connectedAccountId: id, toolkit: 'gmail', tool: 'GMAIL_GET_PROFILE', args: {} });
    await run();
    expect(held).toEqual({ count: 1, released: 0 });
    fake.failNext.push(400);
    await expect(run()).rejects.toBeInstanceOf(ComposioFault);
    expect(held).toEqual({ count: 1, released: 1 });
    fake.failNext.push(502);
    await expect(run()).rejects.toBeInstanceOf(ComposioFault);
    expect(held.count).toBe(2);
    // A timeout: Composio may have run it, so it is spent.
    const slow = new ComposioRunner(
      new ComposioClient({ apiKey: fake.apiKey, baseUrl: fake.baseUrl, timeoutMs: 300 }),
      meter,
    );
    await slow.run({
      connectedAccountId: id,
      toolkit: 'gmail',
      tool: 'GMAIL_GET_PROFILE',
      args: {},
    });
    fake.failNext.push('hang');
    const timedOut = await slow
      .run({ connectedAccountId: id, toolkit: 'gmail', tool: 'GMAIL_GET_PROFILE', args: {} })
      .catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(ComposioFault);
    expect((timedOut as ComposioFault).mayHaveRun).toBe(true);
    expect(held.count).toBe(4);
  });

  test('Composio’s own tools are never run, and their place is given back', async () => {
    const id = await activeAccount(recorded(gmailRoute).upstream);
    const { meter, held } = countingMeter();
    const own = new ComposioRunner(client, meter);
    const before = fake.executions.length;
    for (const tool of [
      'COMPOSIO_MULTI_EXECUTE_TOOL',
      'COMPOSIO_REMOTE_WORKBENCH',
      'COMPOSIO_MANAGE_CONNECTIONS',
    ]) {
      const error = await own
        .run({ connectedAccountId: id, toolkit: 'gmail', tool, args: {} })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ComposioFault);
      expect((error as ComposioFault).kind).toBe('refused');
    }
    expect(fake.executions.length).toBe(before);
    expect(held).toEqual({ count: 0, released: 3 });
  });

  test('a spent limit refuses the call before anything reaches Composio, an approved send included', async () => {
    const google = recorded(gmailRoute);
    const id = await activeAccount(google.upstream);
    const { meter } = countingMeter(0);
    const spent = new ComposioFactoryHarness(meter);
    const connector = (await spent.factory.open({
      id: 'con_capped',
      spaceId: 'spc_test',
      provider: 'imap',
      secretRef: null,
      configuration: {
        kind: 'gmail',
        account: 'me@example.test',
        via: 'composio',
        connected_account_id: id,
      },
    })) as EmailConnector;
    const before = fake.executions.length;
    const sent = await connector.execute(
      mailAction(
        'email.send',
        { to: ['a@example.test'], subject: 'Hi', body: 'Hello' },
        'act_capped01',
      ),
      mailContext('act_capped01'),
    );
    expect(sent).toEqual({ outcome: 'failed', reason: CAP_WORDS.tool_calls, retryable: false });
    expect(fake.executions.length).toBe(before);
  });
});

/** A connector factory whose Composio calls are held to `meter`, as configured from the environment. */
class ComposioFactoryHarness {
  readonly factory: ConnectorFactory;
  constructor(meter: ComposioMeter) {
    const spent = Object.assign(meter, {
      spent: async () => {
        try {
          const held = await meter.reserve('tool_calls');
          await meter.release(held);
          return false;
        } catch {
          return true;
        }
      },
    });
    this.factory = new ConnectorFactory({
      sql: {} as Sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      composio: { client, meter: spent },
    });
  }
}

describe('an app connected through Composio', () => {
  const action = (kind: string, payload: Record<string, unknown>) => ({
    ...mailAction(kind, payload),
    kind,
    connection_id: 'con_slack',
  });
  const open = async (meter?: ComposioMeter) => {
    const id = await activeAccount(recorded(() => undefined).upstream, 'slack' as ComposioToolkit);
    const connector = (await new ConnectorFactory({
      sql: {} as Sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      composio: { client, ...(meter ? { meter, runner: new ComposioRunner(client, meter) } : {}) },
    }).open({
      id: 'con_slack',
      spaceId: 'spc_test',
      provider: 'composio',
      secretRef: null,
      configuration: {
        kind: 'composio_app',
        account: 'slack',
        toolkit: 'slack',
        title: 'Slack',
        via: 'composio',
        connected_account_id: id,
      },
    })) as ComposioAppConnector;
    return { id, connector };
  };

  test('offers three tools: finding, reading without asking, and acting after approval', async () => {
    const { connector } = await open();
    expect(connector).toBeInstanceOf(ComposioAppConnector);
    expect(connector.manifest.provider).toBe('composio');
    expect(
      connector.manifest.tools.map((tool) => [
        tool.name,
        tool.effect_class,
        tool.requires_approval,
      ]),
    ).toEqual([
      ['app_slack.find_tools', 'read', false],
      ['app_slack.read', 'read', false],
      ['app_slack.act', 'write_external', true],
    ]);
    // Searched for, never all in the prompt; reads are declared as reads.
    expect(connector.catalog.source).toBe('mcp');
    expect(connector.readOnlyDeclared('app_slack.read')).toBe(true);
    expect(connector.readOnlyDeclared('app_slack.act')).toBe(false);
  });

  test('finds tools for free, runs a reading tool, refuses a changing one through read, and runs it through act', async () => {
    const { id, connector } = await open();
    const before = fake.executions.length;
    const found = await connector.execute(
      action('app_slack.find_tools', { query: 'send message' }),
      mailContext(),
    );
    if (found.outcome !== 'succeeded') throw new Error('expected tools');
    expect(JSON.stringify(found.receipt.detail)).toContain('SLACK_SEND_MESSAGE');
    expect(found.receipt.detail).toMatchObject({
      via: 'composio',
      origin_trust: 'external_content',
    });
    // Finding tools is a listing, not a tool call.
    expect(fake.executions.length).toBe(before);
    const listed = await connector.execute(
      action('app_slack.read', { tool: 'SLACK_LIST_CHANNELS', arguments: {} }),
      mailContext(),
    );
    expect(listed.outcome).toBe('succeeded');
    expect(JSON.stringify(listed)).toContain('general');
    const sneaked = await connector.execute(
      action('app_slack.read', { tool: 'SLACK_SEND_MESSAGE', arguments: { channel: 'C1' } }),
      mailContext(),
    );
    expect(sneaked).toMatchObject({ outcome: 'failed' });
    const sent = await connector.execute(
      action('app_slack.act', {
        tool: 'SLACK_SEND_MESSAGE',
        arguments: { channel: 'C1', text: 'hi' },
      }),
      mailContext(),
    );
    expect(sent.outcome).toBe('succeeded');
    expect(fake.executions.slice(before).map((run) => [run.account, run.tool])).toEqual([
      [id, 'SLACK_LIST_CHANNELS'],
      [id, 'SLACK_SEND_MESSAGE'],
    ]);
    // Another app's tool, or one naming an account, never runs.
    expect(
      await connector.execute(
        action('app_slack.act', { tool: 'GMAIL_SEND_EMAIL', arguments: {} }),
        mailContext(),
      ),
    ).toMatchObject({ outcome: 'failed' });
    await expect(
      connector.execute(
        action('app_slack.act', {
          tool: 'SLACK_SEND_MESSAGE',
          arguments: { connected_account_id: 'ca_x' },
        }),
        mailContext(),
      ),
    ).rejects.toBeInstanceOf(ConnectorFaultError);
    expect(fake.executions.length).toBe(before + 2);
  });

  test('a spent limit is told as a plain sentence the agent relays, and nothing is sent', async () => {
    const { meter } = countingMeter(0);
    const { connector } = await open(meter);
    const before = fake.executions.length;
    const sent = await connector.execute(
      action('app_slack.act', { tool: 'SLACK_SEND_MESSAGE', arguments: { channel: 'C1' } }),
      mailContext(),
    );
    expect(sent).toEqual({ outcome: 'failed', reason: CAP_WORDS.tool_calls, retryable: false });
    expect(fake.executions.length).toBe(before);
  });
});

describe('the app catalog', () => {
  test('the popular list leaves out Google’s parts, and search offers only apps that can be signed in to here', async () => {
    expect(POPULAR_APPS.length).toBeGreaterThanOrEqual(15);
    expect(
      POPULAR_APPS.some((app) => ['gmail', 'googlecalendar', 'googledrive'].includes(app.toolkit)),
    ).toBe(false);
    const catalog = new ComposioCatalog(client);
    const found = await catalog.search('a');
    const slugs = found.map((app) => app.toolkit);
    expect(slugs).toContain('slack');
    expect(slugs).toContain('acme_crm');
    // Not managed, no sign-in at all, or Google's own parts: not offered.
    for (const slug of ['spotify', 'weather_tool', 'gmail', 'googledrive'])
      expect(slugs).not.toContain(slug);
    expect(await catalog.title('acme_crm')).toBe('Acme CRM');
    expect(await catalog.title('spotify')).toBeNull();
    expect(await catalog.title('gmail')).toBeNull();
    // With the operator's own auth config, an app Composio does not sign in to is offered.
    expect(await new ComposioCatalog(client, new Set(['spotify'])).title('spotify')).toBe(
      'Spotify',
    );
    expect(await catalog.search('<script>')).toEqual([]);
  });

  test('an app the remote MCP catalog offers is offered there only, worked out from that catalog', async () => {
    // Every MCP catalog entry, and each product it names, hides its Composio twin.
    const covered = MCP_CATALOG.flatMap((entry) => [entry.id, ...(entry.products ?? [])]);
    expect(covered).toEqual(
      expect.arrayContaining(['notion', 'linear', 'jira', 'confluence', 'github', 'stripe']),
    );
    for (const toolkit of covered) expect(mcpCatalogCovers(toolkit)).toBe(true);
    for (const toolkit of ['slack', 'asana', 'hubspot', 'atlassian_bitbucket', 'notionx', ''])
      expect(mcpCatalogCovers(toolkit)).toBe(false);
    expect(mcpCatalogCovers('Microsoft-Teams')).toBe(false);
    for (const toolkit of covered)
      expect(POPULAR_APPS.some((app) => app.toolkit === toolkit)).toBe(false);
    expect(POPULAR_APPS.some((app) => app.toolkit === 'slack')).toBe(true);
    // The fake lists Notion as an app Composio signs in to; it is still not offered.
    const catalog = new ComposioCatalog(client, new Set(['notion', 'jira']));
    expect((await catalog.search('notion')).map((app) => app.toolkit)).toEqual([]);
    expect(await catalog.title('notion')).toBeNull();
    expect(await catalog.title('jira')).toBeNull();
    expect(await catalog.title('slack')).toBe('Slack');
    // Composio's own toolkits are never offered either.
    expect(notOfferedHere('composio_search')).toBe(true);
  });
});

describe('a trigger delivery’s signature', () => {
  const secret = 'whsec-test-secret-value';
  const sign = (id: string, timestamp: string, body: string, key = secret) =>
    `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  test('is accepted only when made with the secret, over this body, recently', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    const timestamp = String(now / 1000);
    const body = '{"type":"composio.trigger.message"}';
    const headers = { id: 'msg_1', timestamp, signature: sign('msg_1', timestamp, body) };
    expect(signedByComposio(secret, headers, body, now)).toBe(true);
    // One of several signatures is enough, as Standard Webhooks allows.
    expect(
      signedByComposio(
        secret,
        { ...headers, signature: `v1,AAAA ${headers.signature}` },
        body,
        now,
      ),
    ).toBe(true);
    expect(signedByComposio(secret, headers, `${body} `, now)).toBe(false);
    expect(signedByComposio('another-secret-value', headers, body, now)).toBe(false);
    expect(signedByComposio(secret, { ...headers, id: 'msg_2' }, body, now)).toBe(false);
    expect(signedByComposio(secret, headers, body, now + 10 * 60_000)).toBe(false);
    expect(signedByComposio(secret, { ...headers, signature: null }, body, now)).toBe(false);
  });

  test('is checked over the exact bytes sent, whatever they decode to, and needs a plain id', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    const timestamp = String(now / 1000);
    // A byte-order mark and a byte that is not UTF-8: decoding would change both.
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"a":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    const signature = `v1,${createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`msg_1.${timestamp}.`), bytes]))
      .digest('base64')}`;
    const headers = { id: 'msg_1', timestamp, signature };
    expect(signedByComposio(secret, headers, bytes, now)).toBe(true);
    expect(signedByComposio(secret, headers, bytes.toString('utf8'), now)).toBe(false);
    expect(signedByComposio(secret, { ...headers, id: 'msg 1' }, bytes, now)).toBe(false);
    expect(signedByComposio(secret, { ...headers, timestamp: `${timestamp}.5` }, bytes, now)).toBe(
      false,
    );
  });
});
