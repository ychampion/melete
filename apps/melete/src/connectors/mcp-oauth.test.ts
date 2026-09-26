import { afterEach, describe, expect, test } from 'bun:test';
import type { ConnectionResponse, McpConnectionConfig } from '@melete/contracts';
import {
  type FakeMcpAuth,
  type FakeMcpAuthOptions,
  startFakeMcpAuth,
} from './fixtures/fake-mcp-auth.ts';
import {
  bearerChallenge,
  canonicalResource,
  discoverAuthorizationServer,
  discoverProtectedResource,
  McpSignInFailure,
  metadataLocations,
  type OAuthFetch,
} from './mcp-oauth.ts';
import { type McpSignInRequest, McpSignIns } from './mcp-sign-in.ts';

const fetcher: OAuthFetch = (url, init) => fetch(url, init);
const servers: FakeMcpAuth[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function fake(options: FakeMcpAuthOptions = {}) {
  const server = await startFakeMcpAuth(options);
  servers.push(server);
  return server;
}

const failure = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof McpSignInFailure))
    throw new Error(`expected a sign-in failure, got ${error}`);
  return error.code;
};

const policy = (url: string): McpConnectionConfig => ({
  id: 'files',
  url,
  audience: 'owner',
  allowed_scopes: ['mcp_files.read'],
  tools: [
    { name: 'read_file', alias: 'read', required_scopes: ['mcp_files.read'], effect_class: 'read' },
  ],
});

type Installed = McpSignInRequest & { credentials: Record<string, string> };

function signIns(publicUrl = 'http://localhost:3000', clientMetadata?: boolean) {
  const installed: Installed[] = [];
  const service = new McpSignIns({
    publicUrl,
    ...(clientMetadata === undefined ? {} : { clientMetadata }),
    authorize: async (_actor, spaceId) => spaceId ?? 'sp_fixture',
    fetcherFor: async () => fetcher,
    install: async (_actor, request) => {
      installed.push(request);
      return {
        connection: { id: 'conn_01J00000000000000000000000', label: request.label },
      } as unknown as ConnectionResponse;
    },
  });
  return { service, installed };
}

/** Stands in for the browser: opens the authorize address and returns where it was sent back. */
async function approve(authorizeUrl: string): Promise<URL> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) throw new Error('the authorization server did not redirect');
  return new URL(location);
}

describe('reading the specification headers and addresses', () => {
  test('a Bearer challenge gives its parameters, quoted or not', () => {
    expect(
      bearerChallenge(
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read files:write", error=insufficient_scope',
      ),
    ).toEqual({
      resource_metadata: 'https://mcp.example.com/.well-known/oauth-protected-resource',
      scope: 'files:read files:write',
      error: 'insufficient_scope',
    });
    expect(bearerChallenge('Basic realm="x"')).toBeNull();
    expect(bearerChallenge(null)).toBeNull();
  });

  test('the canonical server URI has a lowercase host and no fragment or bare trailing slash', () => {
    expect(canonicalResource('HTTPS://MCP.Example.com/')).toBe('https://mcp.example.com');
    expect(canonicalResource('https://mcp.example.com/mcp#x')).toBe('https://mcp.example.com/mcp');
  });

  test('authorization server metadata is looked for in the specified order', () => {
    expect(metadataLocations('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
    expect(metadataLocations('https://auth.example.com')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
  });
});

describe('discovery', () => {
  test('follows the 401 challenge to the resource and its authorization server', async () => {
    const server = await fake({ challengeScope: 'files:read' });
    const resource = await discoverProtectedResource(server.mcpUrl, fetcher);
    expect(resource).toEqual({
      resource: server.mcpUrl,
      authorizationServers: [server.issuer],
      challengeScope: 'files:read',
      scopesSupported: ['files:read'],
    });
    expect((await discoverAuthorizationServer(server.issuer, fetcher)).issuer).toBe(server.issuer);
  });

  test('without a challenge header it finds the metadata at the well-known path', async () => {
    const server = await fake({ challengeHeader: false });
    expect((await discoverProtectedResource(server.mcpUrl, fetcher))?.resource).toBe(server.mcpUrl);
  });

  test('a server that answers without a token needs no sign-in', async () => {
    const server = await fake({ open: true });
    expect(await discoverProtectedResource(server.mcpUrl, fetcher)).toBeNull();
  });

  test('metadata that declares another resource is refused', async () => {
    const server = await fake({ declaredResource: () => 'https://other.example/mcp' });
    expect(await failure(discoverProtectedResource(server.mcpUrl, fetcher))).toBe(
      'resource_mismatch',
    );
  });

  test('a resource declared at the origin covers the endpoint beneath it', async () => {
    const server = await fake({ declaredResource: (origin) => origin });
    expect((await discoverProtectedResource(server.mcpUrl, fetcher))?.resource).toBe(server.origin);
  });

  test('OpenID discovery is used when the RFC 8414 document is absent', async () => {
    const server = await fake({ metadataAt: 'openid' });
    expect((await discoverAuthorizationServer(server.issuer, fetcher)).issuer).toBe(server.issuer);
  });

  test('metadata that names another issuer is refused', async () => {
    const server = await fake({ wrongIssuer: true });
    expect(await failure(discoverAuthorizationServer(server.issuer, fetcher))).toBe(
      'issuer_mismatch',
    );
  });

  test('an authorization server without S256 PKCE is refused', async () => {
    const server = await fake({ noS256: true });
    expect(await failure(discoverAuthorizationServer(server.issuer, fetcher))).toBe(
      'pkce_unsupported',
    );
  });

  test('a plain http:// server away from this machine is refused before it is asked anything', async () => {
    expect(await failure(discoverProtectedResource('http://mcp.example.com/mcp', fetcher))).toBe(
      'server_address_refused',
    );
  });
});

describe('signing in', () => {
  test('registers, sends PKCE, state and the resource, and installs with the earned credential', async () => {
    const server = await fake({ challengeScope: 'files:read' });
    const { service, installed } = signIns();
    const started = await service.start('prn_owner', {
      label: 'Files',
      mcp: policy(server.mcpUrl),
    });
    expect(started.redirect_uri).toBe('http://localhost:3000/api/oauth/callback');
    // Dynamic registration, as a native client because the address is on this machine.
    expect(server.registrations).toHaveLength(1);
    expect(server.registrations[0]).toMatchObject({
      redirect_uris: [started.redirect_uri],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    });
    const authorize = new URL(started.authorize_url);
    expect(authorize.origin + authorize.pathname).toBe(`${server.origin}/auth/authorize`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('resource')).toBe(server.mcpUrl);
    expect(authorize.searchParams.get('client_id')).toBe('registered-client');
    // The challenge's scope, plus offline_access because the server offers it.
    expect(authorize.searchParams.get('scope')).toBe('files:read offline_access');
    expect(service.status('prn_owner', started.sign_in_id)?.state).toBe('pending');

    const callback = await approve(started.authorize_url);
    const done = await service.complete('prn_owner', callback.searchParams);
    expect(done.connection.id).toBe('conn_01J00000000000000000000000');
    // The token endpoint checked the verifier against the challenge and the resource.
    const exchange = server.tokenRequests[0];
    expect(exchange?.get('resource')).toBe(server.mcpUrl);
    expect(exchange?.get('code_verifier')).toBeString();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.credentials).toMatchObject({
      client_id: 'registered-client',
      resource: server.mcpUrl,
      token_url: `${server.origin}/auth/token`,
    });
    expect(server.issued).toContain(installed[0]?.credentials.access_token ?? '');
    expect(server.issued).toContain(installed[0]?.credentials.refresh_token ?? '');
    expect(service.status('prn_owner', started.sign_in_id)).toEqual({
      state: 'connected',
      connection_id: 'conn_01J00000000000000000000000',
    });
    // Spent: the same response cannot be used twice.
    expect(await failure(service.complete('prn_owner', callback.searchParams))).toBe(
      'sign_in_not_found',
    );
  });

  test('a client the person registered is used as given, and nothing is registered', async () => {
    const server = await fake();
    const { service } = signIns();
    const started = await service.start('prn_owner', {
      label: 'Files',
      mcp: policy(server.mcpUrl),
      client: { client_id: 'my-client' },
    });
    expect(new URL(started.authorize_url).searchParams.get('client_id')).toBe('my-client');
    expect(server.registrations).toHaveLength(0);
  });

  test("a server that reads client metadata documents is given this service's", async () => {
    const server = await fake({ clientMetadataDocuments: true });
    const { service } = signIns('https://melete.example');
    const started = await service.start('prn_owner', {
      label: 'Files',
      mcp: policy(server.mcpUrl),
    });
    expect(new URL(started.authorize_url).searchParams.get('client_id')).toBe(
      'https://melete.example/api/oauth/client-metadata.json',
    );
    expect(server.registrations).toHaveLength(0);
  });

  test('an https address kept to a private network registers dynamically instead', async () => {
    const server = await fake({ clientMetadataDocuments: true });
    const { service } = signIns('https://melete.tailnet.example', false);
    const started = await service.start('prn_owner', {
      label: 'Files',
      mcp: policy(server.mcpUrl),
    });
    expect(new URL(started.authorize_url).searchParams.get('client_id')).toBe('registered-client');
    expect(server.registrations).toHaveLength(1);
    expect(service.clientMetadataUrl()).toBeUndefined();
  });

  test('a server with no way to register asks for a client', async () => {
    const server = await fake({ dynamicRegistration: false });
    const { service } = signIns();
    expect(
      await failure(service.start('prn_owner', { label: 'Files', mcp: policy(server.mcpUrl) })),
    ).toBe('client_registration_required');
  });

  test('a public address people cannot be returned to is refused before anything is fetched', async () => {
    const server = await fake();
    const { service } = signIns('http://192.168.1.20:3000');
    expect(
      await failure(service.start('prn_owner', { label: 'Files', mcp: policy(server.mcpUrl) })),
    ).toBe('callback_unavailable');
    expect(server.registrations).toHaveLength(0);
  });

  test('a server that needs no sign-in says so', async () => {
    const server = await fake({ open: true });
    const { service } = signIns();
    expect(
      await failure(service.start('prn_owner', { label: 'Files', mcp: policy(server.mcpUrl) })),
    ).toBe('sign_in_not_needed');
  });
});

describe('the returning browser', () => {
  async function started(options: FakeMcpAuthOptions = {}) {
    const server = await fake(options);
    const { service, installed } = signIns();
    const begun = await service.start('prn_owner', { label: 'Files', mcp: policy(server.mcpUrl) });
    return { server, service, installed, begun, callback: await approve(begun.authorize_url) };
  }

  test('a response carrying another issuer is refused before its code is spent', async () => {
    const { server, service, installed, callback } = await started({
      wrongIss: 'https://attacker.example',
    });
    expect(await failure(service.complete('prn_owner', callback.searchParams))).toBe(
      'issuer_mismatch',
    );
    expect(server.tokenRequests).toHaveLength(0);
    expect(installed).toHaveLength(0);
  });

  test('a response without iss is refused when the server promised one', async () => {
    const { server, service, callback } = await started({ issParameter: true });
    callback.searchParams.delete('iss');
    expect(await failure(service.complete('prn_owner', callback.searchParams))).toBe(
      'issuer_missing',
    );
    expect(server.tokenRequests).toHaveLength(0);
  });

  test('the right issuer passes when the server sends it', async () => {
    const { service, installed, callback } = await started({ issParameter: true });
    await service.complete('prn_owner', callback.searchParams);
    expect(installed).toHaveLength(1);
  });

  test("another person cannot finish someone else's sign-in, and a forged state finds nothing", async () => {
    const { server, service, callback } = await started();
    expect(await failure(service.complete('prn_other', callback.searchParams))).toBe(
      'sign_in_not_found',
    );
    const forged = new URLSearchParams(callback.searchParams);
    forged.set('state', 'forged');
    expect(await failure(service.complete('prn_owner', forged))).toBe('sign_in_not_found');
    expect(server.tokenRequests).toHaveLength(0);
  });

  test('a declined sign-in installs nothing and says so', async () => {
    const { service, installed, begun, callback } = await started();
    callback.searchParams.delete('code');
    callback.searchParams.set('error', 'access_denied');
    expect(await failure(service.complete('prn_owner', callback.searchParams))).toBe(
      'sign_in_declined',
    );
    expect(installed).toHaveLength(0);
    expect(service.status('prn_owner', begun.sign_in_id)).toEqual({
      state: 'failed',
      error: 'sign_in_declined',
    });
  });
});
