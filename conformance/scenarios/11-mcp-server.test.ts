/**
 * Conformance 11: Melete as an MCP server, driven by the reference MCP client.
 *
 * Two people on one installation, each connecting an assistant through the
 * whole OAuth flow the client library runs by itself: discovery from the
 * endpoint's 401, dynamic registration, PKCE, the consent page, the code
 * exchange and a refresh. The service runs behind the web server's proxy, as
 * it is deployed, so the public origin, `/api/mcp` and the root discovery
 * documents are the ones a hosted assistant sees.
 *
 * The only fakes are the mailbox the company map reads and the mail
 * connector, which records what it is asked to send instead of sending it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action, DispatchResult } from '@melete/contracts';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadAction } from '../../apps/melete/src/broker/records.ts';
import { BrokerService } from '../../apps/melete/src/broker/service.ts';
import { createTableTrustResolver } from '../../apps/melete/src/broker/trust.ts';
import { fixtureMessages } from '../../apps/melete/src/companies/fixtures.ts';
import { fixtureMailbox } from '../../apps/melete/src/companies/mailbox.ts';
import { PostgresCompanyStore } from '../../apps/melete/src/companies/repository.ts';
import { scriptedExtractor } from '../../apps/melete/src/companies/scripted.ts';
import { emailManifest } from '../../apps/melete/src/connectors/email.ts';
import { ConnectorRegistry } from '../../apps/melete/src/connectors/registry.ts';
import type { Connector } from '../../apps/melete/src/connectors/types.ts';
import { loadEnv } from '../../apps/melete/src/env.ts';
import {
  recordChaseScope,
  resolveChaseScopedGrant,
  resolvePersonGrant,
} from '../../apps/melete/src/experience/chase-scope.ts';
import { ruleRecipient } from '../../apps/melete/src/experience/rules.ts';
import { newId } from '../../apps/melete/src/ids.ts';
import { createApp } from '../../apps/melete/src/index.ts';
import { startQueue } from '../../apps/melete/src/jobs/queue.ts';
import { JobService } from '../../apps/melete/src/jobs/service.ts';
import { provisionMemorySpace } from '../../apps/melete/src/memory/db.ts';
import type { RestrictionRecord } from '../../apps/melete/src/memory/restore.ts';
import { testDatabase } from '../../apps/melete/test/helpers/database.ts';
import { createStaticServer } from '../../deploy/scripts/serve-static.ts';
import { scenario } from '../scenarios.ts';

const spec = scenario(11);
const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-mcp-server-'));
const password = 'a-long-enough-password';

/** What the mail connector was asked to send: the proof that nothing left early. */
const sent: Action[] = [];
const mail: Connector = {
  manifest: emailManifest,
  async execute(action): Promise<DispatchResult> {
    sent.push(action);
    return {
      outcome: 'succeeded',
      receipt: {
        action_id: action.id,
        connection_id: action.connection_id,
        external_ref: `msg-${action.id}`,
        late: false,
        received_at: new Date().toISOString(),
        detail: {},
      },
    };
  },
  async verify() {
    return { decision: 'unsupported', reason: 'fixture' };
  },
  async health() {
    return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
  },
};
const registry = new ConnectorRegistry();
// The standing-permission resolvers the service's own broker is built with. The
// recipient is one the person vouched for, so only the assistant rule stands
// between a standing rule and the send.
const broker = handle
  ? new BrokerService({
      sql: handle.sql,
      connectors: registry,
      resolveTrust: createTableTrustResolver(
        new Map([['landlord@example.test', { origin_trust: 'owner', handle: 'owner:landlord' }]]),
      ),
      resolveStandingGrant: resolvePersonGrant,
      resolveScopedGrant: resolveChaseScopedGrant,
      recordStandingScope: recordChaseScope,
    })
  : null;
const forgotten: RestrictionRecord[] = [];

type Served = { api: ReturnType<typeof Bun.serve>; web: ReturnType<typeof Bun.serve> };
let served: Served | null = null;
let app: ReturnType<typeof createApp> | null = null;
if (handle && jobs && broker) {
  const dist = join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Melete</title>');
  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, server) => {
      if (!app) return new Response('starting', { status: 503 });
      const remoteAddress = server.requestIP(request)?.address;
      return app.fetch(request, { remoteAddress, clientAddress: remoteAddress });
    },
  });
  const web = createStaticServer({
    root: dist,
    port: 0,
    hostname: '127.0.0.1',
    apiOrigin: `http://127.0.0.1:${api.port}`,
  });
  served = { api, web };
  app = createApp({
    db: handle.db,
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_SPACES_DIR: root,
      MELETE_PUBLIC_URL: `http://127.0.0.1:${web.port}`,
    }),
    sql: handle.sql,
    jobs,
    broker,
    registry,
    memory: {
      sql: handle.sql,
      journal: {
        read: async () => forgotten,
        append: async (record) => {
          forgotten.push(record);
        },
      },
    },
    checkDatabase: async () => 'ok',
    companies: {
      store: new PostgresCompanyStore(handle.db),
      mailbox: () => fixtureMailbox(fixtureMessages()),
      extractor: scriptedExtractor(),
      schedule: (work) => work(),
    },
  });
}
const origin = () => `http://127.0.0.1:${served?.web.port}`;
const endpoint = () => new URL(`${origin()}/api/mcp`);
const withDb = app ? describe : describe.skip;

afterAll(async () => {
  served?.web.stop(true);
  served?.api.stop(true);
  await queue?.stop();
  await handle?.close();
  await rm(root, { recursive: true, force: true });
}, 30_000);

/** The web API as a signed-in browser calls it, through the proxy. */
async function browser(cookie: string, path: string, method = 'GET', body?: unknown) {
  return fetch(`${origin()}/api${path}`, {
    method,
    redirect: 'manual',
    headers: {
      Cookie: cookie,
      ...(method === 'GET' ? {} : { Origin: origin() }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const cookieOf = (response: Response) => {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
};

type Person = {
  email: string;
  cookie: string;
  principalId: string;
  spaceId: string;
  connectionId: string;
};

async function person(email: string, cookie: string): Promise<Person> {
  if (!handle) throw new Error('Postgres unavailable');
  const me = (await (await browser(cookie, '/me')).json()) as { owner: { id: string } };
  const spaces = (await (await browser(cookie, '/spaces')).json()) as {
    spaces: Array<{ id: string; kind: string }>;
  };
  const spaceId = spaces.spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
  expect(spaceId).not.toBe('');
  // Saved details live under the installation owner's memory catalog, as in
  // the service; another account's space reports them as not connected.
  const [installation] = await handle.sql`select id from owner limit 1`;
  if (installation?.id === me.owner.id) {
    await provisionMemorySpace(handle.sql, me.owner.id, spaceId);
    await handle.sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
  }
  const connectionId = newId('conn');
  await handle.sql`insert into connection (id, space_id, provider, label, scopes)
    values (${connectionId}, ${spaceId}, ${emailManifest.provider}, ${`${email} mail`},
      ${JSON.stringify(emailManifest.tools.map((tool) => tool.name))}::jsonb)`;
  registry.register(connectionId, mail);
  return { email, cookie, principalId: me.owner.id, spaceId, connectionId };
}

/**
 * An assistant's side of OAuth, kept in memory. `redirectToAuthorization` is
 * where a real assistant opens a browser; here the signed-in person's browser
 * is the proxy fetch below, which reads the consent page and presses Allow.
 */
class Assistant {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  consentUrl: URL | undefined;
  constructor(readonly name: string) {}
  get redirectUrl() {
    return 'http://127.0.0.1:53682/callback';
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return `state-${this.name}`;
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.consentUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** The consent page's own form, read the way a browser would submit it. */
function consentForm(html: string) {
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    const value = (match[2] ?? '')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
    fields.set(match[1] ?? '', value);
  }
  return fields;
}

async function agree(who: Person, consentUrl: URL, decision: 'allow' | 'deny' = 'allow') {
  const page = await fetch(consentUrl, { headers: { Cookie: who.cookie } });
  expect(page.status).toBe(200);
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  const html = await page.text();
  expect(html).toContain(who.email);
  const form = consentForm(html);
  form.set('decision', decision);
  const answered = await fetch(consentUrl.origin + consentUrl.pathname, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: who.cookie,
      Origin: origin(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  expect(answered.status).toBe(302);
  return new URL(answered.headers.get('location') ?? '');
}

/** Connect an assistant for one person with the client library's own OAuth flow. */
async function connect(who: Person, name: string) {
  const assistant = new Assistant(name);
  const first = new StreamableHTTPClientTransport(endpoint(), { authProvider: assistant });
  const client = new Client({ name, version: '1.0.0' });
  // No token yet: the endpoint's 401 starts discovery, registration and PKCE.
  await expect(client.connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  const consentUrl = assistant.consentUrl;
  if (!consentUrl) throw new Error('The client was not sent to consent');
  expect(consentUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(consentUrl.searchParams.get('resource')).toBe(endpoint().toString());
  const back = await agree(who, consentUrl);
  expect(back.searchParams.get('state')).toBe(assistant.state());
  expect(back.searchParams.get('iss')).toBe(origin());
  await first.finishAuth(back.searchParams.get('code') ?? '');
  const connected = new Client({ name, version: '1.0.0' });
  await connected.connect(
    new StreamableHTTPClientTransport(endpoint(), { authProvider: assistant }),
  );
  return { assistant, client: connected };
}

type Connected = Awaited<ReturnType<typeof connect>>;
const data = async (who: Connected, name: string, args: Record<string, unknown> = {}) => {
  const result = await who.client.callTool({ name, arguments: args });
  return {
    error: result.isError === true,
    text: (result.content as Array<{ text: string }>)[0]?.text ?? '',
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
};

let first: Person;
let second: Person;
let firstAssistant: Connected;
let secondAssistant: Connected;
let chaseJob = '';
let sendJob = '';

withDb(`conformance 11: ${spec.title}`, () => {
  test('an assistant connects through discovery, registration, PKCE and consent', async () => {
    const setup = await fetch(`${origin()}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin() },
      body: JSON.stringify({ email: 'first@example.test', password }),
    });
    expect(setup.status).toBe(201);
    first = await person('first@example.test', cookieOf(setup));
    expect(
      (
        await browser(first.cookie, '/principals', 'POST', {
          email: 'second@example.test',
          password,
        })
      ).status,
    ).toBe(201);
    const login = await fetch(`${origin()}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin() },
      body: JSON.stringify({ email: 'second@example.test', password }),
    });
    second = await person('second@example.test', cookieOf(login));

    // The discovery documents sit at the root of the public origin.
    const resource = await (
      await fetch(`${origin()}/.well-known/oauth-protected-resource/api/mcp`)
    ).json();
    expect(resource).toMatchObject({
      resource: endpoint().toString(),
      authorization_servers: [origin()],
    });

    firstAssistant = await connect(first, 'First assistant');
    secondAssistant = await connect(second, 'Second assistant');
    expect(firstAssistant.client.getServerVersion()?.name).toBe('melete');
    expect(firstAssistant.assistant.saved?.access_token).toMatch(/^mlta_/);
    // The person sees the assistant they let in.
    const listed = (await (await browser(first.cookie, '/mcp/clients')).json()) as {
      clients: Array<{ name: string }>;
    };
    expect(listed.clients.map((client) => client.name)).toEqual(['First assistant']);
  }, 180_000);

  test('tools/list offers the six tools', async () => {
    const { tools } = await firstAssistant.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'handle',
      'recall',
      'remember',
      'safe_send',
      'status',
      'waiting_on',
    ]);
  });

  test('each tool acts as the person the token names', async () => {
    // The first person's map has what the demonstration mailbox owes them.
    expect(
      (await browser(first.cookie, `/spaces/${first.spaceId}/companies/scan`, 'POST')).status,
    ).toBe(202);
    const owed = await data(firstAssistant, 'waiting_on');
    const items = owed.data.items as Array<{ item_id: string; kind: string }>;
    expect(items.length).toBeGreaterThan(0);
    const refund = items.find((item) => item.kind === 'refund_owed') ?? items[0];
    // The second person has scanned nothing and sees nothing of the first's.
    expect((await data(secondAssistant, 'waiting_on')).data.items).toEqual([]);

    const started = await data(firstAssistant, 'handle', { item_id: refund?.item_id });
    expect(started.error).toBe(false);
    chaseJob = String(started.data.job_id);
    expect(chaseJob).toMatch(/^job_/);
    // Asking again is the same chase.
    expect((await data(firstAssistant, 'handle', { item_id: refund?.item_id })).data.job_id).toBe(
      chaseJob,
    );

    const saved = await data(firstAssistant, 'remember', {
      topic: 'travel',
      name: 'seat',
      value: 'Aisle seat, always',
    });
    expect(saved.error).toBe(false);
    const found = await data(firstAssistant, 'recall', { query: 'seat' });
    expect(found.data.matches).toEqual([expect.objectContaining({ value: 'Aisle seat, always' })]);
    // The memory is the first person's own.
    const theirs = await data(secondAssistant, 'recall', { query: 'seat' });
    expect(JSON.stringify(theirs)).not.toContain('Aisle');

    const state = await data(firstAssistant, 'status', { job_id: chaseJob });
    expect(state.error).toBe(false);
    expect(state.data.job_id).toBe(chaseJob);
  }, 120_000);

  test("another person's token is refused the first person's work", async () => {
    const theirs = await data(secondAssistant, 'status', { job_id: chaseJob });
    expect(theirs.error).toBe(true);
    expect(theirs.text).toBe('Melete has nothing by that id for you.');
    const items = (await data(firstAssistant, 'waiting_on')).data.items as Array<{
      item_id: string;
    }>;
    const chased = await data(secondAssistant, 'handle', { item_id: items[0]?.item_id });
    expect(chased.error).toBe(true);
    // A token that is not one, and one for another resource, get the 401 that starts discovery.
    const forged = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer mlta_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(forged.headers.get('www-authenticate')).toContain(
      `resource_metadata="${origin()}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  }, 60_000);

  test('safe_send waits for approval in Melete and never sends on its own', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const asked = await data(firstAssistant, 'safe_send', {
      to: 'landlord@example.test',
      subject: 'Deposit',
      body: 'Please return my deposit.',
    });
    expect(asked.text.split('\n')[0]).toBe(
      'Awaiting your approval in Melete. Nothing has been sent.',
    );
    expect(asked.data.status).toBe('awaiting_approval');
    sendJob = String(asked.data.job_id);
    const action = await loadAction(handle.sql, String(asked.data.action_id));
    expect(action.status).toBe('needs_approval');
    expect(sent).toHaveLength(0);

    // A standing rule the person made for this very recipient does not cover
    // what an assistant asks for, and the card offers no "Always".
    await handle.sql`insert into experience_rule (id, space_id, connection_id, tool_kind, recipient,
      recipient_class, origin_trust, count_cap, expires_at, reconsent_after_days)
      values (${newId('rule')}, ${first.spaceId}, ${first.connectionId}, 'email.send',
        ${JSON.stringify(ruleRecipient(action))}::jsonb, 'landlord@example.test', 'owner_stated', 5,
        ${new Date(Date.now() + 86_400_000).toISOString()}, 30)`;
    const again = await data(firstAssistant, 'safe_send', {
      to: 'landlord@example.test',
      subject: 'Deposit',
      body: 'A second note about my deposit.',
    });
    expect(again.data.status).toBe('awaiting_approval');
    expect((await loadAction(handle.sql, String(again.data.action_id))).status).toBe(
      'needs_approval',
    );
    expect(sent).toHaveLength(0);

    const cards = (await (await browser(first.cookie, '/permissions')).json()) as {
      permissions: Array<{ id: string; version: string; options: string[] }>;
    };
    const card = cards.permissions.find((entry) => entry.id.length > 0 && entry.options.length);
    expect(cards.permissions.length).toBeGreaterThanOrEqual(2);
    for (const entry of cards.permissions) expect(entry.options).not.toContain('always');
    // The second person has nothing to approve, and cannot approve the first's.
    expect(
      ((await (await browser(second.cookie, '/permissions')).json()) as { permissions: [] })
        .permissions,
    ).toEqual([]);
    expect(
      (
        await browser(second.cookie, `/permissions/${card?.id}`, 'POST', {
          option: 'allow_once',
          version: card?.version,
        })
      ).status,
    ).toBe(404);
    expect(sent).toHaveLength(0);
  }, 60_000);

  test('the person approves the exact text in Melete and the broker sends it once', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const cards = (await (await browser(first.cookie, '/permissions')).json()) as {
      permissions: Array<{ id: string; version: string }>;
    };
    const [row] = await handle.sql`select p.id from approval p join action a on a.id = p.action_id
      where a.job_id = ${sendJob}`;
    const card = cards.permissions.find((entry) => entry.id === row?.id);
    expect(card).toBeDefined();
    const before = sent.length;
    const decided = await browser(first.cookie, `/permissions/${card?.id}`, 'POST', {
      option: 'allow_once',
      version: card?.version,
    });
    expect(decided.status).toBe(200);
    // One send, of the approved words.
    expect(sent.slice(before).map((action) => action.canonical_payload)).toEqual([
      expect.objectContaining({ body: 'Please return my deposit.' }),
    ]);
    const state = await data(firstAssistant, 'status', { job_id: sendJob });
    expect(state.data.actions).toEqual([
      expect.objectContaining({ kind: 'email.send', status: 'succeeded' }),
    ]);
  }, 60_000);

  test('a refresh rotates, and disconnecting ends the assistant’s access', async () => {
    const assistant = firstAssistant.assistant;
    const before = assistant.saved;
    const refreshed = await fetch(`${origin()}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: String(assistant.info?.client_id),
        refresh_token: String(before?.refresh_token),
      }),
    });
    expect(refreshed.status).toBe(200);
    const pair = (await refreshed.json()) as OAuthTokens;
    expect(pair.refresh_token).not.toBe(before?.refresh_token);
    assistant.saved = pair;
    expect((await data(firstAssistant, 'recall', { query: 'seat' })).error).toBe(false);

    const removed = await browser(
      first.cookie,
      `/mcp/clients/${encodeURIComponent(String(assistant.info?.client_id))}`,
      'DELETE',
    );
    expect(removed.status).toBe(204);
    const after = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pair.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(after.status).toBe(401);
    // The other person's assistant is untouched.
    expect((await secondAssistant.client.listTools()).tools).toHaveLength(6);
  }, 60_000);
});
