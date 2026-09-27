/**
 * Melete's own authorization server and MCP endpoint, one guard at a time.
 *
 * Conformance 11 drives the whole flow with the reference client through the
 * web proxy. These tests hold each refusal on its own: a code without its
 * verifier, a code or refresh token used twice, a token meant for another
 * resource, registration that is not a public client, a metadata document on
 * a private address, a consent answer that was not shown to this session, and
 * the JSON-RPC edges of the endpoint.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { mcpServerAddresses, OAuthError, OAuthStore } from '../../src/mcp-server/oauth.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-mcp-oauth-'));
const PUBLIC = 'https://melete.example';
const addresses = mcpServerAddresses(PUBLIC);
if (!addresses) throw new Error('Expected addresses');
const app = handle
  ? createApp({
      db: handle.db,
      sql: handle.sql,
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root, MELETE_PUBLIC_URL: PUBLIC }),
      checkDatabase: async () => 'ok',
    })
  : null;
const withDb = app ? describe : describe.skip;
const REDIRECT = 'http://127.0.0.1:40111/callback';

afterAll(async () => {
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
    expect(await open.client(clientId)).toMatchObject({ name: 'Hosted assistant' });
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
