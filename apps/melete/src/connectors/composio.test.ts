/**
 * The managed path under Melete's own Google connectors: the Composio client,
 * the proxy fetcher and what it refuses, the answers it maps, and the same
 * recorded Google answers read natively and through Composio giving the same
 * observations and dedup keys.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { mailObservation } from '../signals/observations.ts';
import { ComposioClient, ComposioFault, type ComposioToolkit } from './composio.ts';
import {
  composioProxyFetch,
  MANAGED_GOOGLE_BASES,
  MANAGED_READS,
  MANAGED_WRITES,
  ManagedRequestRefused,
  managedAccess,
  namesManagedAuthority,
} from './composio-fetch.ts';
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

const proxied = (accountId: string, rules: Parameters<typeof composioProxyFetch>[0]['rules']) =>
  composioProxyFetch({ client, connectedAccountId: accountId, rules });

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

describe('the proxy fetcher', () => {
  test('the read fetcher refuses a send, and nothing reaches Composio', async () => {
    const google = recorded(() => ({ body: { id: 'sent', labelIds: ['SENT'] } }));
    const id = await activeAccount(google.upstream);
    const before = fake.proxyCalls.length;
    const read = proxied(id, MANAGED_READS.mail);
    await expect(
      read(`${MANAGED_GOOGLE_BASES.gmail}/messages/send`, {
        method: 'POST',
        body: JSON.stringify({ raw: 'eA' }),
      }),
    ).rejects.toBeInstanceOf(ManagedRequestRefused);
    expect(fake.proxyCalls.length).toBe(before);
    // The same send through the agent's fetcher goes, as a POST with its body.
    const write = proxied(id, MANAGED_WRITES.mail);
    const sent = await write(`${MANAGED_GOOGLE_BASES.gmail}/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw: 'eA' }),
    });
    expect(sent.status).toBe(200);
    expect(fake.proxyCalls.at(-1)).toMatchObject({ account: id, method: 'POST' });
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

  test('Google asking for time keeps its Retry-After, and Composio refusing the key reads as an outage', async () => {
    const id = await activeAccount(
      recorded(() => ({ status: 429, body: { error: { code: 429 } } })).upstream,
    );
    const slowed = await proxied(id, MANAGED_READS.mail)(`${MANAGED_GOOGLE_BASES.gmail}/profile`);
    expect(slowed.status).toBe(429);
    const wrong = composioProxyFetch({
      client: new ComposioClient({ apiKey: 'not-the-key', baseUrl: fake.baseUrl }),
      connectedAccountId: id,
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
    // The headers situations need come through the proxy unchanged.
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
      await occurrences(proxied(id, MANAGED_READS.calendar), managedAccess(client, id)),
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
    expect(await changes(proxied(id, MANAGED_READS.documents), managedAccess(client, id))).toEqual(
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
    const before = fake.proxyCalls.length;
    const refused = await connector
      .execute(
        mailAction('email.search', { query: '', limit: 5, connected_account_id: 'ca_someone' }),
        mailContext(),
      )
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConnectorFaultError);
    expect(fake.proxyCalls.length).toBe(before);
    // The same search without it goes through the row's own account.
    const found = await connector.execute(
      mailAction('email.search', { query: '', limit: 5 }),
      mailContext(),
    );
    expect(found.outcome).toBe('succeeded');
    expect(fake.proxyCalls.slice(before).every((call) => call.account === id)).toBe(true);
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
