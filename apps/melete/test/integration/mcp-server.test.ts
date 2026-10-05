/**
 * Melete's own authorization server and MCP endpoint, one guard at a time.
 *
 * Conformance 11 drives the whole flow with the reference client through the
 * web proxy. These tests hold each refusal on its own: a code without its
 * verifier, a code or refresh token used twice, a token meant for another
 * resource, registration that is not a public client, a metadata document on
 * a private address, a consent answer that was not shown to this session, and
 * the JSON-RPC edges of the endpoint. They also hold what a grant is tied to:
 * the space and membership it was given under, the provenance of what an
 * assistant saves, and the limits on how often it may ask.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordId } from '../../src/broker/records.ts';
import type { BrokerService } from '../../src/broker/service.ts';
import { collectOriginFields, resolveOriginWarnings } from '../../src/broker/trust.ts';
import type { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { actorEnvironment } from '../../src/mcp-server/actor.ts';
import {
  CONNECTION_SECONDS,
  mcpServerAddresses,
  OAuthError,
  OAuthStore,
  UNUSED_CLIENT_LIMIT,
} from '../../src/mcp-server/oauth.ts';
import { MCP_SERVER_OFF, TOOL_CALLS_PER_MINUTE } from '../../src/mcp-server/routes.ts';
import { createMemoryTrustResolver } from '../../src/memory/broker-trust.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import { recordOutput } from '../../src/memory/outputs.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-mcp-oauth-'));
const PUBLIC = 'https://melete.example';
const addresses = mcpServerAddresses(PUBLIC);
if (!addresses) throw new Error('Expected addresses');
const app =
  handle && jobs
    ? createApp({
        db: handle.db,
        sql: handle.sql,
        env: loadEnv({
          MELETE_PREVIEW_MULTIPLAYER: 'true',
          NODE_ENV: 'test',
          MELETE_SPACES_DIR: root,
          MELETE_PUBLIC_URL: PUBLIC,
        }),
        jobs,
        memory: { sql: handle.sql, journal: { read: async () => [], append: async () => {} } },
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const REDIRECT = 'http://127.0.0.1:40111/callback';

afterAll(async () => {
  await queue?.stop();
  await handle?.close();
  await rm(root, { recursive: true, force: true });
}, 30_000);

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Postgres unavailable');
  return value;
}
const store = (options: ConstructorParameters<typeof OAuthStore>[2] = {}) =>
  new OAuthStore(required(handle).sql, required(addresses), options);
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OAuthError) return error.code;
    throw error;
  }
  throw new Error('Expected a refusal');
}

withDb('the MCP server without a public address', () => {
  test('its paths say it is not enabled and how to turn it on, not that they are unbuilt', async () => {
    const off = createApp({
      db: required(handle).db,
      sql: required(handle).sql,
      env: loadEnv({
        MELETE_PREVIEW_MULTIPLAYER: 'true',
        NODE_ENV: 'test',
        MELETE_SPACES_DIR: root,
      }),
      checkDatabase: async () => 'ok',
    });
    for (const [method, path] of [
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/.well-known/oauth-protected-resource/api/mcp'],
      ['POST', '/oauth/register'],
    ] as const) {
      const response = await off.request(path, { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: 'not_enabled', message: MCP_SERVER_OFF },
      });
    }
    const elsewhere = await off.request('/api/no-such-thing');
    expect(
      ((await elsewhere.json()) as { error: { message: string } }).error.message,
    ).not.toContain('not implemented');
  });
});

let cookie = '';
let principalId = '';
let spaceId = '';

async function signedIn() {
  if (cookie) return;
  const setup = await required(app).request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'oauth@example.test', password: 'a-long-enough-password' }),
  });
  expect(setup.status).toBe(201);
  cookie =
    setup.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('melete_session=')) ?? '';
  principalId = ((await setup.json()) as { owner: { id: string } }).owner.id;
  const spaces = (await (
    await required(app).request('/spaces', { headers: { Cookie: cookie } })
  ).json()) as { spaces: Array<{ id: string; kind: string }> };
  spaceId = spaces.spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
}

async function registered() {
  const client = await store().register({ client_name: 'Probe', redirect_uris: [REDIRECT] });
  return client.client_id;
}
async function codeFor(clientId: string, challenge: string) {
  await signedIn();
  return store().issueCode({
    clientId,
    principalId,
    spaceId,
    membershipGeneration: 0,
    resource: required(addresses).resource,
    scope: 'melete',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
}

withDb('the authorization server', () => {
  test('a code needs the verifier behind its challenge, and works once', async () => {
    const clientId = await registered();
    const { verifier, challenge } = pkce();
    const code = await codeFor(clientId, challenge);
    const other = pkce();
    expect(
      await refusal(
        store().exchangeCode({ code, clientId, redirectUri: REDIRECT, verifier: other.verifier }),
      ),
    ).toBe('invalid_grant');
    // The wrong verifier burnt it: the right one is too late now.
    expect(
      await refusal(store().exchangeCode({ code, clientId, redirectUri: REDIRECT, verifier })),
    ).toBe('invalid_grant');

    const fresh = await codeFor(clientId, challenge);
    const pair = await store().exchangeCode({
      code: fresh,
      clientId,
      redirectUri: REDIRECT,
      verifier,
    });
    expect(await store().authenticate(pair.access_token)).toMatchObject({ principalId, spaceId });
    // Replaying a used code ends what it bought.
    expect(
      await refusal(
        store().exchangeCode({ code: fresh, clientId, redirectUri: REDIRECT, verifier }),
      ),
    ).toBe('invalid_grant');
    expect(await store().authenticate(pair.access_token)).toBeUndefined();
  });

  test('a refresh token rotates, and one presented twice ends the whole sign-in', async () => {
    const clientId = await registered();
    const { verifier, challenge } = pkce();
    const first = await store().exchangeCode({
      code: await codeFor(clientId, challenge),
      clientId,
      redirectUri: REDIRECT,
      verifier,
    });
    const second = await store().refresh({ refreshToken: first.refresh_token, clientId });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await store().authenticate(second.access_token)).toBeDefined();
    expect(await refusal(store().refresh({ refreshToken: first.refresh_token, clientId }))).toBe(
      'invalid_grant',
    );
    expect(await store().authenticate(second.access_token)).toBeUndefined();
    expect(await refusal(store().refresh({ refreshToken: second.refresh_token, clientId }))).toBe(
      'invalid_grant',
    );
  });

  test('a token is for this resource and this client only', async () => {
    const clientId = await registered();
    const { verifier, challenge } = pkce();
    const code = await codeFor(clientId, challenge);
    expect(
      await refusal(
        store().exchangeCode({
          code,
          clientId,
          redirectUri: REDIRECT,
          verifier,
          resource: 'https://other.example/api/mcp',
        }),
      ),
    ).toBe('invalid_grant');
    const pair = await store().exchangeCode({
      code: await codeFor(clientId, challenge),
      clientId,
      redirectUri: REDIRECT,
      verifier,
    });
    // The same database behind another public address is another resource.
    const elsewhere = new OAuthStore(
      required(handle).sql,
      required(mcpServerAddresses('https://elsewhere.example')),
    );
    expect(await elsewhere.authenticate(pair.access_token)).toBeUndefined();
    const stranger = await registered();
    expect(
      await refusal(store().refresh({ refreshToken: pair.refresh_token, clientId: stranger })),
    ).toBe('invalid_grant');
  });

  test('registration takes public clients with safe return addresses only', async () => {
    for (const input of [
      { redirect_uris: ['http://assistant.example/callback'] },
      { redirect_uris: ['https://assistant.example/callback#frag'] },
      { redirect_uris: ['https://user:pw@assistant.example/callback'] },
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' },
      { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
      { redirect_uris: [] },
    ])
      expect(await refusal(store().register(input))).toMatch(
        /^invalid_(redirect_uri|client_metadata)$/,
      );
  });

  test('a client metadata document is read from a public address only, and must name itself', async () => {
    const clientId = 'https://assistant.example/oauth/client.json';
    const document = JSON.stringify({
      client_id: clientId,
      client_name: 'Hosted assistant',
      redirect_uris: ['https://assistant.example/callback'],
    });
    let reads = 0;
    const transport = async () => {
      reads++;
      return { status: 200, headers: {}, body: document };
    };
    const hidden = store({
      resolve: async () => [{ address: '10.0.0.5', family: 4 }],
      transport: transport as never,
    });
    expect(await hidden.client(clientId)).toBeUndefined();
    expect(reads).toBe(0);
    const open = store({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: transport as never,
    });
    const read = await open.client(clientId);
    expect(read).toMatchObject({ name: 'Hosted assistant', verifiedHost: 'assistant.example' });
    // Reading a document keeps nothing; only a person's Allow records the client.
    const kept = () => required(handle).sql`select id from mcp_client where id = ${clientId}`;
    expect(await kept()).toHaveLength(0);
    await open.recordClient(required(read));
    expect(await kept()).toHaveLength(1);
    const impostor = store({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: (async () => ({ status: 200, headers: {}, body: document })) as never,
    });
    expect(await impostor.client('https://assistant.example/oauth/other.json')).toBeUndefined();
  });
});

withDb('the consent page', () => {
  const query = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-1',
      ...extra,
    });

  test('an unknown client or return address is refused here, never redirected', async () => {
    const { challenge } = pkce();
    const unknown = await required(app).request(
      `/oauth/authorize?${query('mcpc_nobody', challenge)}`,
    );
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
    const clientId = await registered();
    const elsewhere = await required(app).request(
      `/oauth/authorize?${query(clientId, challenge, { redirect_uri: 'https://evil.example/cb' })}`,
    );
    expect(elsewhere.status).toBe(400);
  });

  test('a request error goes back to the client with its state and this issuer', async () => {
    const clientId = await registered();
    const plain = await required(app).request(
      `/oauth/authorize?${query(clientId, 'x'.repeat(43), { code_challenge_method: 'plain' })}`,
    );
    expect(plain.status).toBe(302);
    const back = new URL(plain.headers.get('location') ?? '');
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('error')).toBe('invalid_request');
    expect(back.searchParams.get('state')).toBe('st-1');
    expect(back.searchParams.get('iss')).toBe(PUBLIC);
  });

  test('only the page shown to this session can say yes', async () => {
    await signedIn();
    const clientId = await registered();
    const { challenge } = pkce();
    const page = await required(app).request(`/oauth/authorize?${query(clientId, challenge)}`, {
      headers: { Cookie: cookie },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    const tag = /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(tag).not.toBe('');
    const answer = (fields: Record<string, string>, withCookie = true) =>
      required(app).request('/oauth/authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(withCookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams({ ...Object.fromEntries(query(clientId, challenge)), ...fields }),
      });
    // No session, no tag, or a tag for a different request: nothing is issued.
    expect((await answer({ consent: tag, decision: 'allow' }, false)).status).toBe(403);
    expect((await answer({ consent: 'forged', decision: 'allow' })).status).toBe(403);
    expect((await answer({ consent: tag, decision: 'allow', state: 'st-2' })).status).toBe(403);
    const codes = await required(handle).sql`select code_hash from mcp_authorization
      where client_id = ${clientId}`;
    expect(codes).toHaveLength(0);
    const allowed = await answer({ consent: tag, decision: 'allow' });
    expect(allowed.status).toBe(302);
    expect(new URL(allowed.headers.get('location') ?? '').searchParams.get('code')).toMatch(
      /^mcpa_/,
    );
  });
});

withDb('the MCP endpoint', () => {
  let token = '';
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    required(app).request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  test('answers one message at a time, as JSON', async () => {
    const clientId = await registered();
    const { verifier, challenge } = pkce();
    token = (
      await store().exchangeCode({
        code: await codeFor(clientId, challenge),
        clientId,
        redirectUri: REDIRECT,
        verifier,
      })
    ).access_token;
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } },
    });
    expect(
      ((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion,
    ).toBe('2025-06-18');
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await rpc([{ jsonrpc: '2.0', id: 2, method: 'ping' }])).status).toBe(400);
    expect((await rpc('{not json')).status).toBe(400);
    expect(
      (
        await rpc(
          { jsonrpc: '2.0', id: 3, method: 'ping' },
          { 'MCP-Protocol-Version': '1999-01-01' },
        )
      ).status,
    ).toBe(400);
    expect(
      await (await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).json(),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      await (
        await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'send_anyway' } })
      ).json(),
    ).toMatchObject({ error: { code: -32602 } });
    const bad = (await (
      await rpc({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'status', arguments: { job_id: '..' } },
      })
    ).json()) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
  });

  test('without a token it says where to get one, and a session cookie is not one', async () => {
    const bare = await required(app).request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/api/mcp", scope="melete"`,
    );
  });
});

/** A live token pair for a registered client, as the person and space given. */
async function connect(
  grant: { principalId: string; spaceId: string; membershipGeneration: number },
  options: ConstructorParameters<typeof OAuthStore>[2] = {},
) {
  const clientId = await registered();
  const { verifier, challenge } = pkce();
  const code = await store(options).issueCode({
    clientId,
    ...grant,
    resource: required(addresses).resource,
    scope: 'melete',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  const pair = await store(options).exchangeCode({
    code,
    clientId,
    redirectUri: REDIRECT,
    verifier,
  });
  return { clientId, ...pair };
}

const call = (token: string, body: unknown, env?: Record<string, string>) =>
  required(app).request(
    '/mcp',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
const tool = async (token: string, name: string, args: Record<string, unknown>) => {
  const response = await call(token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: { isError?: boolean; content: [{ text: string }] } })
    .result;
};
const listTools = (token: string) => call(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

withDb('a grant is tied to the space and membership it was given under', () => {
  let memberId = '';
  let sharedId = '';
  const json = (cookieValue: string, body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { Cookie: cookieValue, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const generation = async () =>
    Number(
      (
        await required(handle).sql`select generation from space_membership
          where space_id = ${sharedId} and principal_id = ${memberId}`
      )[0]?.generation,
    );

  test('a member revoked from the space loses the assistant, and re-adding them does not revive it', async () => {
    await signedIn();
    const created = await required(app).request(
      '/principals',
      json(cookie, { email: 'member@example.test', password: 'member-password-long' }),
    );
    expect(created.status).toBe(201);
    memberId = ((await created.json()) as { principal: { id: string } }).principal.id;
    const shared = await required(app).request('/spaces/shared', json(cookie, { name: 'Flat' }));
    expect(shared.status).toBe(201);
    sharedId = ((await shared.json()) as { space: { id: string } }).space.id;
    const grant = () =>
      required(app).request(
        `/spaces/${sharedId}/memberships`,
        json(cookie, { principal_id: memberId }),
      );
    expect((await grant()).status).toBe(201);

    const pair = await connect({
      principalId: memberId,
      spaceId: sharedId,
      membershipGeneration: await generation(),
    });
    expect((await listTools(pair.access_token)).status).toBe(200);

    const revoked = await required(app).request(
      `/spaces/${sharedId}/memberships/${memberId}`,
      json(cookie, undefined, 'DELETE'),
    );
    expect(revoked.status).toBe(200);
    const refused = await listTools(pair.access_token);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // What the member's assistant held in that space is gone, not just fenced.
    expect(
      await required(handle).sql`select token_hash from mcp_token
        where space_id = ${sharedId} and principal_id = ${memberId}`,
    ).toHaveLength(0);
    expect(
      await refusal(store().refresh({ refreshToken: pair.refresh_token, clientId: pair.clientId })),
    ).toBe('invalid_grant');

    expect((await grant()).status).toBe(201);
    expect((await listTools(pair.access_token)).status).toBe(401);
  });

  test('a token from an earlier membership is refused and its sign-in ends, with no fallback', async () => {
    const stale = (await generation()) - 1;
    const pair = await connect({
      principalId: memberId,
      spaceId: sharedId,
      membershipGeneration: stale,
    });
    const refused = await listTools(pair.access_token);
    expect(refused.status).toBe(401);
    const [row] = await required(handle).sql`select revoked_at from mcp_token
      where client_id = ${pair.clientId} and kind = 'refresh'`;
    expect(row?.revoked_at).not.toBeNull();
    // An in-process tool route for that grant is refused too, rather than
    // answered in the member's personal space.
    const routed = await required(app).request(
      '/memory/items',
      {},
      actorEnvironment({
        principalId: memberId,
        spaceId: sharedId,
        membershipGeneration: stale,
        clientId: pair.clientId,
        clientName: 'Probe',
      }),
    );
    expect(routed.status).toBe(401);
  });

  test('safe_send records nothing in a space the person may no longer use', async () => {
    const connectionId = recordId('conn');
    await required(handle).sql`insert into connection (id, space_id, provider, label, scopes)
      values (${connectionId}, ${sharedId}, 'email', 'Flat mail', ${JSON.stringify(['email.send'])}::jsonb)`;
    const registry = {
      get: () => ({ manifest: { tools: [{ name: 'email.send', required_scopes: [] }] } }),
    } as unknown as ConnectorRegistry;
    const broker = {
      propose: () => {
        throw new Error('The broker is not asked');
      },
    } as unknown as BrokerService;
    const effects = new ExperienceEffects(required(handle).sql, broker, registry);
    const before = await required(handle).sql`select id from job where space_id = ${sharedId}`;
    const proposed = await effects.proposeSend({
      spaceId: sharedId,
      principalId: memberId,
      membershipGeneration: (await generation()) - 1,
      connectionId,
      payload: { to: ['a@example.test'], subject: 'Hi', body: 'Hello' },
      assistant: 'Probe',
      assistantClientId: 'mcpc_probe',
    });
    expect(proposed).toMatchObject({ reason: expect.stringContaining('can no longer use') });
    const after = await required(handle).sql`select id from job where space_id = ${sharedId}`;
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  });
});

withDb("what an assistant saves is the assistant's, not the person's", () => {
  test('remember records the assistant as the source, and a send using it keeps its warning', async () => {
    await signedIn();
    await provisionMemorySpace(required(handle).sql, principalId, spaceId);
    await required(handle).sql`update memory_spaces set restore_ready = true
      where space_id = ${spaceId}`;
    const pair = await connect({ principalId, spaceId, membershipGeneration: 0 });
    const saved = await tool(pair.access_token, 'remember', {
      topic: 'contacts',
      name: 'landlord',
      value: 'landlord@elsewhere.example',
    });
    expect(saved.isError).toBeUndefined();
    // The person states another detail themselves, for contrast.
    const stated = await required(app).request('/memory/items', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'pref.contacts.agent', value: 'agent@example.test' }),
    });
    expect([200, 201]).toContain(stated.status);

    const [source] = await required(handle).sql`select source_type, author, origin_trust
      from memory_sources where space_id = ${spaceId} and stream = ${`mcp:${pair.clientId}`}`;
    expect(source).toMatchObject({
      source_type: 'assistant',
      author: 'external',
      origin_trust: 'inferred',
    });
    const heads = await required(handle).sql`select c.key, c.id, c.head_revision, r.origin_trust
      from memory_claims c join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
      where c.space_id = ${spaceId} and c.key in ('pref.contacts.landlord', 'pref.contacts.agent')`;
    const byKey = new Map(heads.map((row) => [String(row.key), row]));
    expect(byKey.get('pref.contacts.landlord')?.origin_trust).toBe('inferred');
    expect(byKey.get('pref.contacts.agent')?.origin_trust).toBe('owner');

    const listed = (await (
      await required(app).request('/memory/items', { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ value: string; source: string; saved_by?: string }> };
    expect(listed.items.find((item) => item.value === 'landlord@elsewhere.example')).toMatchObject({
      source: 'inferred',
      saved_by: 'Probe',
    });
    expect(
      listed.items.find((item) => item.value === 'agent@example.test')?.saved_by,
    ).toBeUndefined();

    // A job that used both values proposes a send: the broker's question to
    // memory warns about the assistant's value and not about the person's.
    const jobId = recordId('job');
    const attemptId = recordId('att');
    await required(handle).sql`insert into job (id, space_id, principal_id, title, objective,
      state, lease_epoch, budget, constraints)
      values (${jobId}, ${spaceId}, ${principalId}, 'Write', 'Write to the landlord', 'running', 1,
      ${JSON.stringify({ max_actions: 4, max_output_tokens: 4000, max_usd_est: 1, max_wall_ms: 120_000, max_turns: 8 })}::jsonb,
      ${JSON.stringify({ public_compartment: false, allowed_domains: [] })}::jsonb)`;
    await required(handle)
      .sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
    const handleOf = (key: string) =>
      `${byKey.get(key)?.id}@${Number(byKey.get(key)?.head_revision)}`;
    await recordOutput(
      required(handle).sql,
      { ownerId: principalId, spaceId, publisher: 'broker', audience: 'private', role: 'owner' },
      {
        job_id: jobId,
        attempt_id: attemptId,
        kind: 'action',
        output_id: 'mcp-send-1',
        output_version: '1',
        location: 'to',
        uses: [handleOf('pref.contacts.landlord'), handleOf('pref.contacts.agent')],
      },
    );
    const payload = {
      to: ['landlord@elsewhere.example', 'agent@example.test'],
      subject: 'The deposit',
      body: 'Please return it.',
    };
    const warnings = await required(handle).sql.begin((tx) =>
      resolveOriginWarnings(tx, createMemoryTrustResolver(), {
        space_id: spaceId,
        job_id: jobId,
        connection_id: 'conn_unused',
        kind: 'email.send',
        effect_class: 'write_external',
        canonical_payload: payload,
        fields: collectOriginFields(payload, 'email.send'),
      }),
    );
    const flagged = warnings.filter((warning) => warning.handle !== null);
    expect(flagged).toEqual([
      expect.objectContaining({
        origin_trust: 'inferred',
        handle: handleOf('pref.contacts.landlord'),
        description: expect.stringContaining('an assistant you connected'),
      }),
    ]);
  });
});

withDb('limits on what anyone may ask', () => {
  test('an error for a return address nobody allowed is shown here, never redirected', async () => {
    const hosted = await store().register({
      client_name: 'Hosted',
      redirect_uris: ['https://assistant.example/cb'],
    });
    const { challenge } = pkce();
    const bad = new URLSearchParams({
      response_type: 'token',
      client_id: hosted.client_id,
      redirect_uri: 'https://assistant.example/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const refused = await required(app).request(`/oauth/authorize?${bad}`);
    expect(refused.status).toBe(400);
    expect(refused.headers.get('location')).toBeNull();
    // Once a person here has let this client return there, errors go back to it.
    await signedIn();
    await store().issueCode({
      clientId: hosted.client_id,
      principalId,
      spaceId,
      membershipGeneration: 0,
      resource: required(addresses).resource,
      scope: 'melete',
      redirectUri: 'https://assistant.example/cb',
      codeChallenge: challenge,
    });
    const returned = await required(app).request(`/oauth/authorize?${bad}`);
    expect(returned.status).toBe(302);
    expect(returned.headers.get('location')).toStartWith('https://assistant.example/cb?error=');
  });

  test('the consent page names the space, the return host, and an unverified name', async () => {
    await signedIn();
    const clientId = await registered();
    const { challenge } = pkce();
    const html = await (
      await required(app).request(
        `/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })}`,
        { headers: { Cookie: cookie } },
      )
    ).text();
    expect(html).toContain('<strong>Unverified:</strong>');
    expect(html).toContain('in your own space, <strong>Personal</strong>');
    expect(html).toContain('you go back to <strong>127.0.0.1:40111</strong>');
    expect(html).toContain('under Settings, Connections');
  });

  test('the authorization page is limited per address', async () => {
    const env = { clientAddress: '198.51.100.7' };
    const statuses: number[] = [];
    for (let index = 0; index < 31; index++)
      statuses.push(
        (await required(app).request('/oauth/authorize?client_id=mcpc_nobody', {}, env)).status,
      );
    expect(statuses.slice(0, 30).every((status) => status === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  test('registrations nobody allowed are capped, and dropped after a day', async () => {
    const sql = required(handle).sql;
    const [waiting] = await sql`select count(*)::int as n from mcp_client c
      where not exists (select 1 from mcp_authorization a where a.client_id = c.id)`;
    const filler = Array.from(
      { length: UNUSED_CLIENT_LIMIT - Number(waiting?.n ?? 0) },
      (_, index) => `mcpc_filler${index}`,
    );
    for (const id of filler)
      await sql`insert into mcp_client (id, name, redirect_uris)
        values (${id}, 'Filler', ${JSON.stringify([REDIRECT])}::jsonb)`;
    expect(
      await refusal(store().register({ client_name: 'One more', redirect_uris: [REDIRECT] })),
    ).toBe('temporarily_unavailable');
    await sql`update mcp_client set created_at = now() - interval '2 days'
      where id = any(${filler})`;
    expect(
      (await store().register({ client_name: 'One more', redirect_uris: [REDIRECT] })).client_id,
    ).toMatch(/^mcpc_/);
    expect(await sql`select id from mcp_client where id = any(${filler})`).toHaveLength(0);
  });

  test('tool calls are limited per connection', async () => {
    await signedIn();
    const pair = await connect({ principalId, spaceId, membershipGeneration: 0 });
    const statuses: number[] = [];
    for (let index = 0; index <= TOOL_CALLS_PER_MINUTE; index++)
      statuses.push(
        (
          await call(pair.access_token, {
            jsonrpc: '2.0',
            id: index,
            method: 'tools/call',
            params: { name: 'status', arguments: { job_id: '..' } },
          })
        ).status,
      );
    expect(statuses.slice(0, TOOL_CALLS_PER_MINUTE).every((status) => status === 200)).toBe(true);
    expect(statuses[TOOL_CALLS_PER_MINUTE]).toBe(429);
    // Another connection is counted on its own.
    const other = await connect({ principalId, spaceId, membershipGeneration: 0 });
    expect((await listTools(other.access_token)).status).toBe(200);
  });

  test('a connection ends 90 days after the person agreed, however often it is refreshed', async () => {
    await signedIn();
    const start = Date.now();
    let clock = start;
    const timed = { now: () => new Date(clock) };
    const first = await connect({ principalId, spaceId, membershipGeneration: 0 }, timed);
    let refresh = first.refresh_token;
    const day = 24 * 60 * 60 * 1000;
    for (const at of [25, 50, 75, 89]) {
      clock = start + at * day;
      refresh = (await store(timed).refresh({ refreshToken: refresh, clientId: first.clientId }))
        .refresh_token;
    }
    // The last refresh token is cut short at the connection's end.
    const [last] = await required(handle).sql`select expires_at from mcp_token
      where client_id = ${first.clientId} and kind = 'refresh' and used_at is null`;
    expect(new Date(String(last?.expires_at)).getTime()).toBeLessThanOrEqual(
      start + CONNECTION_SECONDS * 1000 + 1000,
    );
    clock = start + 91 * day;
    expect(
      await refusal(store(timed).refresh({ refreshToken: refresh, clientId: first.clientId })),
    ).toBe('invalid_grant');
  });
});
