/**
 * What removing a connection does to the credential it held:
 * - the sealed copy is deleted, and a key the person made for Melete comes
 *   back with the page where they can cancel it themselves;
 * - a sealed copy another connection still points at is kept, and its access
 *   is not withdrawn;
 * - an MCP sign-in is withdrawn at its issuer, found the way signing in found
 *   it, including an issuer with a path and GitHub's own app API;
 * - a provider that cannot be reached never stops the removal;
 * - removing a space withdraws each of its sign-ins, unless another space
 *   still stands on the same grant.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { connectionGeneration } from '@melete/contracts';
import {
  connectionRevocation,
  type RevocationOptions,
  spaceAccessWithdrawal,
} from '../../src/connectors/revocation.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import type { OAuthFetch } from '../../src/gateway/oauth.ts';
import { newId } from '../../src/ids.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = 'c4'.repeat(32);
const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const closers: Array<() => unknown> = [];
afterAll(async () => {
  for (const close of closers) await close();
  await queue?.stop();
  await handle?.close();
}, 30_000);
const withDb = jobs ? describe : describe.skip;

const secrets = handle
  ? new SealedSecretStore(new PostgresSecretRepository(handle.sql), () => MASTER_KEY)
  : null;

async function newSpace(): Promise<string> {
  if (!handle) throw new Error('Postgres unavailable');
  const id = newId('sp');
  await handle.sql`insert into space (id, name, git_path) values (${id}, 'Fixture', ${`spaces/${id}`})`;
  return id;
}

/** A connection holding `value` sealed, as an installation leaves it. */
async function connect(
  spaceId: string,
  provider: string,
  configuration: Record<string, unknown>,
  value: string | null,
  ref?: string,
) {
  if (!handle || !secrets) throw new Error('Postgres unavailable');
  const secretRef = ref ?? (value === null ? null : await secrets.put(spaceId, value));
  const id = newId('conn');
  await handle.sql`insert into connection (id, space_id, provider, label, secret_ref, configuration)
    values (${id}, ${spaceId}, ${provider}, 'Fixture', ${secretRef},
      ${JSON.stringify(configuration)}::jsonb)`;
  return { id, spaceId, provider, configuration, secretRef };
}

/** The connection's row as it now is. */
async function rowOf(id: string) {
  if (!handle) throw new Error('Postgres unavailable');
  const [row] = await handle.sql`select secret_ref, status from connection where id = ${id}`;
  return row;
}

const sealed = async (ref: string | null) =>
  handle && ref ? (await handle.sql`select id from secret where id = ${ref}`).length : 0;

function policyWith(options: Omit<RevocationOptions, 'sql' | 'secrets'>) {
  if (!handle || !secrets || !jobs) throw new Error('Postgres unavailable');
  return new PolicyService(jobs, undefined, {
    afterRevoke: connectionRevocation({ sql: handle.sql, secrets, log: () => {}, ...options }),
  });
}

/** A request as the provider received it. */
type Seen = { method: string; url: string; headers: Headers; body: string };

/** Answers by address, as the providers would; nothing leaves this process. */
function providers(routes: Record<string, (seen: Seen) => Response>) {
  const seen: Seen[] = [];
  const fetcher: OAuthFetch = async (request) => {
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body ? await request.text() : '',
    };
    seen.push(entry);
    const route = routes[`${request.method} ${request.url}`];
    return route ? route(entry) : new Response('not found', { status: 404 });
  };
  return { seen, fetcher };
}

withDb('removing a connection that holds a key the person made', () => {
  test('deletes the sealed copy and names the page where the token itself is cancelled', async () => {
    const spaceId = await newSpace();
    const github = { kind: 'command_line', adapter: 'github', config: {}, account: 'someone' };
    const fine = await connect(spaceId, 'command_line', github, 'github_pat_example');
    const classic = await connect(spaceId, 'command_line', github, 'ghp_example');
    const policy = policyWith({});

    const answer = connectionGeneration.parse(
      await policy.changeConnection(fine.id, { kind: 'revoke', expected_generation: 0 }),
    );
    expect(answer.status).toBe('revoked');
    expect(answer.provider_access).toBe('not_offered');
    expect(answer.revoke_at).toEqual({
      name: 'GitHub',
      url: 'https://github.com/settings/personal-access-tokens',
    });
    expect(await sealed(fine.secretRef)).toBe(0);
    expect(await rowOf(fine.id)).toEqual({ secret_ref: null, status: 'revoked' });

    const other = await policy.changeConnection(classic.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(other.revoke_at?.url).toBe('https://github.com/settings/tokens');
    expect(await sealed(classic.secretRef)).toBe(0);
  });

  test('names the page for each kind of key, and none where there is no page to name', async () => {
    const spaceId = await newSpace();
    const policy = policyWith({});
    const cases: Array<[string, Record<string, unknown>, string, string | undefined]> = [
      [
        'command_line',
        { kind: 'command_line', adapter: 'gitlab', config: {} },
        'glpat-example',
        'https://gitlab.com/-/user_settings/personal_access_tokens',
      ],
      [
        'command_line',
        { kind: 'command_line', adapter: 'npm', config: {} },
        'npm_example',
        'https://docs.npmjs.com/revoking-access-tokens',
      ],
      [
        'command_line',
        { kind: 'command_line', adapter: 'aws', config: {} },
        '{"access_key_id":"AKIAEXAMPLE","secret_access_key":"example"}',
        'https://console.aws.amazon.com/iam/',
      ],
      ['twilio', { kind: 'sms', sms: {} }, '{}', 'https://console.twilio.com'],
      [
        'imap',
        { kind: 'mail', mail: { imap: { host: 'imap.gmail.com', port: 993, secure: true } } },
        'app-password',
        'https://myaccount.google.com/apppasswords',
      ],
      [
        'imap',
        { kind: 'mail', mail: { imap: { host: 'mail.example.test', port: 993, secure: true } } },
        'password',
        undefined,
      ],
      [
        'imap',
        { kind: 'outlook_mail', account: 'someone@outlook.com' },
        '{}',
        'https://account.live.com/consent/Manage',
      ],
      [
        'imap',
        { kind: 'outlook_mail', account: 'someone@company.example' },
        '{}',
        'https://myapps.microsoft.com',
      ],
    ];
    for (const [provider, configuration, value, url] of cases) {
      const made = await connect(spaceId, provider, configuration, value);
      const answer = await policy.changeConnection(made.id, {
        kind: 'revoke',
        expected_generation: 0,
      });
      expect(answer.provider_access).toBe('not_offered');
      expect(answer.revoke_at?.url).toBe(url);
      expect(await sealed(made.secretRef)).toBe(0);
    }
  });

  test('keeps a sealed copy another connection still points at, and does not withdraw it', async () => {
    const spaceId = await newSpace();
    const { seen, fetcher } = providers({});
    const configuration = { kind: 'gmail', account: 'shared-copy@example.test' };
    const value = JSON.stringify({
      access_token: 'at-shared',
      refresh_token: 'rt-shared',
      scope: 'x',
      account: 'shared-copy@example.test',
    });
    const leaving = await connect(spaceId, 'imap', configuration, value);
    const staying = await connect(spaceId, 'caldav', configuration, null, leaving.secretRef ?? '');
    const policy = policyWith({
      fetcher,
      google: { client: { clientId: 'client', clientSecret: 'secret' } },
    });
    const answer = await policy.changeConnection(leaving.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.status).toBe('revoked');
    expect(answer.provider_access).toBe('kept_for_other_connections');
    expect(seen).toEqual([]);
    expect(await sealed(leaving.secretRef)).toBe(1);
    expect((await rowOf(staying.id))?.secret_ref).toBe(leaving.secretRef);
  });

  test('a provider that cannot be reached does not stop the removal', async () => {
    const spaceId = await newSpace();
    const google = await connect(
      spaceId,
      'imap',
      { kind: 'gmail', account: 'unreachable@example.test' },
      JSON.stringify({
        access_token: 'at-u',
        refresh_token: 'rt-u',
        scope: 'x',
        account: 'unreachable@example.test',
      }),
    );
    const policy = policyWith({
      google: { client: { clientId: 'client', clientSecret: 'secret' } },
      fetcher: async () => {
        throw new TypeError('fetch failed: connection refused');
      },
    });
    const answer = await policy.changeConnection(google.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.status).toBe('revoked');
    expect(answer.provider_access).toBe('not_confirmed');
    expect(answer.revoke_at?.url).toBe('https://myaccount.google.com/linkedapps');
    expect(await sealed(google.secretRef)).toBe(0);
  });

  test('a provider that never answers is given up on, and the removal finishes', async () => {
    if (!handle || !secrets) return;
    const spaceId = await newSpace();
    const google = await connect(
      spaceId,
      'imap',
      { kind: 'gmail', account: 'silent@example.test' },
      JSON.stringify({ access_token: 'at-s', scope: 'x', account: 'silent@example.test' }),
    );
    const revoke = connectionRevocation(
      {
        sql: handle.sql,
        secrets,
        log: () => {},
        google: { client: { clientId: 'client', clientSecret: 'secret' } },
        fetcher: () => new Promise<Response>(() => {}),
      },
      200,
    );
    const started = Date.now();
    expect((await revoke(google))?.provider_access).toBe('not_confirmed');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await sealed(google.secretRef)).toBe(0);
  });
});

withDb('removing an MCP connection signed in with OAuth', () => {
  test('finds an issuer with a path, and withdraws the token at its revocation endpoint', async () => {
    // A real server on this machine, standing in for the app's sign-in.
    const received: Array<{ path: string; form: Record<string, string> }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        const base = url.origin;
        if (
          request.method === 'GET' &&
          url.pathname === '/.well-known/oauth-authorization-server/tenant'
        )
          return Response.json({
            issuer: `${base}/tenant`,
            authorization_endpoint: `${base}/tenant/oauth2/authorize`,
            token_endpoint: `${base}/tenant/oauth2/token`,
            revocation_endpoint: `${base}/tenant/oauth2/revoke`,
            code_challenge_methods_supported: ['S256'],
          });
        if (request.method === 'POST' && url.pathname === '/tenant/oauth2/revoke') {
          received.push({
            path: url.pathname,
            form: Object.fromEntries(new URLSearchParams(await request.text())),
          });
          return new Response(null, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    closers.push(() => server.stop(true));
    const base = `http://127.0.0.1:${server.port}`;
    const spaceId = await newSpace();
    const mcp = await connect(
      spaceId,
      'mcp',
      { server: { endpoint: { transport: 'http', url: `${base}/mcp` } } },
      JSON.stringify({
        access_token: 'at-mcp',
        refresh_token: 'rt-mcp',
        token_url: `${base}/tenant/oauth2/token`,
        client_id: 'melete-client',
        resource: `${base}/mcp`,
        status: 'active',
      }),
    );
    const policy = policyWith({ mcpFetch: async () => (request) => fetch(request) });
    const answer = await policy.changeConnection(mcp.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('withdrawn');
    expect(answer.revoke_at).toBeUndefined();
    expect(received).toEqual([
      {
        path: '/tenant/oauth2/revoke',
        form: { token: 'rt-mcp', token_type_hint: 'refresh_token', client_id: 'melete-client' },
      },
    ]);
    expect(await sealed(mcp.secretRef)).toBe(0);
  });

  const GITHUB_SERVER = 'https://api.githubcopilot.com/mcp/';
  const githubRoutes = (answer: number) => ({
    'GET https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp': () =>
      Response.json({
        resource: 'https://api.githubcopilot.com/mcp',
        authorization_servers: ['https://github.com/login/oauth'],
      }),
    'GET https://github.com/.well-known/oauth-authorization-server/login/oauth': () =>
      Response.json({
        issuer: 'https://github.com/login/oauth',
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
        code_challenge_methods_supported: ['S256'],
      }),
    'DELETE https://api.github.com/applications/app-client/grant': () =>
      new Response(null, { status: answer }),
    'DELETE https://api.github.com/applications/app-client/token': () =>
      new Response(null, { status: answer }),
  });
  const githubCredential = JSON.stringify({
    access_token: 'gho_example',
    client_id: 'app-client',
    client_secret: 'app-secret',
    resource: 'https://api.githubcopilot.com/mcp',
    status: 'active',
  });
  const githubConfiguration = { server: { endpoint: { transport: 'http', url: GITHUB_SERVER } } };

  test("withdraws GitHub's grant through its app API with the app's own client", async () => {
    const { seen, fetcher } = providers(githubRoutes(204));
    const spaceId = await newSpace();
    const mcp = await connect(spaceId, 'mcp', githubConfiguration, githubCredential);
    const answer = await policyWith({ mcpFetch: async () => fetcher }).changeConnection(mcp.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('withdrawn');
    const withdrawal = seen.find((entry) => entry.method === 'DELETE');
    expect(withdrawal?.url).toBe('https://api.github.com/applications/app-client/grant');
    expect(withdrawal?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('app-client:app-secret').toString('base64')}`,
    );
    expect(JSON.parse(withdrawal?.body ?? '{}')).toEqual({ access_token: 'gho_example' });
    expect(await sealed(mcp.secretRef)).toBe(0);
  });

  test('withdraws only the token while another connection may stand on the same grant', async () => {
    const { seen, fetcher } = providers(githubRoutes(204));
    const spaceId = await newSpace();
    await connect(spaceId, 'mcp', githubConfiguration, githubCredential);
    const mcp = await connect(spaceId, 'mcp', githubConfiguration, githubCredential);
    const answer = await policyWith({ mcpFetch: async () => fetcher }).changeConnection(mcp.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('withdrawn');
    expect(seen.find((entry) => entry.method === 'DELETE')?.url).toBe(
      'https://api.github.com/applications/app-client/token',
    );
  });

  test('says where to withdraw it when GitHub refuses', async () => {
    const { fetcher } = providers(githubRoutes(422));
    const spaceId = await newSpace();
    const mcp = await connect(spaceId, 'mcp', githubConfiguration, githubCredential);
    const answer = await policyWith({ mcpFetch: async () => fetcher }).changeConnection(mcp.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('not_confirmed');
    expect(answer.revoke_at).toEqual({
      name: 'GitHub',
      url: 'https://github.com/settings/applications',
    });
    expect(await sealed(mcp.secretRef)).toBe(0);
  });

  test('sends its client secret only to the issuer the credential is refreshed at', async () => {
    // A server that now names another authorization server than the one that
    // issued its token: the token's own client secret does not go there.
    const named = {
      'GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp': () =>
        Response.json({
          resource: 'https://mcp.example.test/mcp',
          authorization_servers: ['https://elsewhere.example.test'],
        }),
      'GET https://elsewhere.example.test/.well-known/oauth-authorization-server': () =>
        Response.json({
          issuer: 'https://elsewhere.example.test',
          token_endpoint: 'https://elsewhere.example.test/token',
          revocation_endpoint: 'https://elsewhere.example.test/revoke',
        }),
      'POST https://elsewhere.example.test/revoke': () => new Response(null, { status: 200 }),
      'GET https://as.example.test/.well-known/oauth-authorization-server': () =>
        Response.json({
          issuer: 'https://as.example.test',
          token_endpoint: 'https://as.example.test/token',
          revocation_endpoint: 'https://as.example.test/revoke',
        }),
      'POST https://as.example.test/revoke': () => new Response(null, { status: 200 }),
    };
    const { seen, fetcher } = providers(named);
    const spaceId = await newSpace();
    const configuration = {
      server: { endpoint: { transport: 'http', url: 'https://mcp.example.test/mcp' } },
    };
    const unanchored = await connect(
      spaceId,
      'mcp',
      configuration,
      JSON.stringify({
        access_token: 'at-unanchored',
        client_id: 'app-client',
        client_secret: 'app-secret',
        resource: 'https://mcp.example.test/mcp',
        status: 'active',
      }),
    );
    const policy = policyWith({ mcpFetch: async () => fetcher });
    await policy.changeConnection(unanchored.id, { kind: 'revoke', expected_generation: 0 });
    expect(seen.filter((entry) => entry.body.includes('app-secret'))).toEqual([]);
    expect(await sealed(unanchored.secretRef)).toBe(0);

    // Refreshed at its issuer's token endpoint, the revocation beside it gets the secret.
    seen.length = 0;
    const anchored = await connect(
      spaceId,
      'mcp',
      configuration,
      JSON.stringify({
        access_token: 'at-anchored',
        refresh_token: 'rt-anchored',
        token_url: 'https://as.example.test/token',
        client_id: 'app-client',
        client_secret: 'app-secret',
        resource: 'https://mcp.example.test/mcp',
        status: 'active',
      }),
    );
    const answer = await policy.changeConnection(anchored.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('withdrawn');
    const posts = seen.filter((entry) => entry.method === 'POST');
    expect(posts.map((entry) => entry.url)).toEqual(['https://as.example.test/revoke']);
    expect(Object.fromEntries(new URLSearchParams(posts[0]?.body))).toEqual({
      token: 'rt-anchored',
      token_type_hint: 'refresh_token',
      client_id: 'app-client',
      client_secret: 'app-secret',
    });
  });

  test('a key pasted for an MCP server is never sent anywhere', async () => {
    const { seen, fetcher } = providers({});
    const spaceId = await newSpace();
    const mcp = await connect(
      spaceId,
      'mcp',
      githubConfiguration,
      JSON.stringify({ access_token: 'pasted-key', status: 'active' }),
    );
    const answer = await policyWith({ mcpFetch: async () => fetcher }).changeConnection(mcp.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('not_offered');
    expect(seen).toEqual([]);
    expect(await sealed(mcp.secretRef)).toBe(0);
  });
});

withDb('removing a space', () => {
  test("withdraws its sign-ins, unless another space still stands on the account's grant", async () => {
    if (!handle || !secrets) return;
    const revoked: string[] = [];
    const fetcher: OAuthFetch = async (request) => {
      revoked.push(new URLSearchParams(await request.text()).get('token') ?? '');
      return new Response(null, { status: 200 });
    };
    const google = (account: string, token: string) =>
      JSON.stringify({ access_token: `at-${token}`, refresh_token: token, scope: 'x', account });
    const leaving = await newSpace();
    const other = await newSpace();
    // Mail and calendar on one account, both in the space that goes.
    await connect(
      leaving,
      'imap',
      { kind: 'gmail', account: 'a@example.test' },
      google('a@example.test', 'rt-a-mail'),
    );
    await connect(
      leaving,
      'caldav',
      { kind: 'google_calendar', account: 'a@example.test' },
      google('a@example.test', 'rt-a-calendar'),
    );
    // An account another space still uses.
    await connect(
      leaving,
      'imap',
      { kind: 'gmail', account: 'b@example.test' },
      google('b@example.test', 'rt-b-leaving'),
    );
    await connect(
      other,
      'imap',
      { kind: 'gmail', account: 'b@example.test' },
      google('b@example.test', 'rt-b-staying'),
    );
    // A key the person made: nothing to ask anyone.
    await connect(
      leaving,
      'command_line',
      { kind: 'command_line', adapter: 'github' },
      'github_pat_example',
    );

    await spaceAccessWithdrawal({
      sql: handle.sql,
      secrets,
      log: () => {},
      fetcher,
      google: { client: { clientId: 'client', clientSecret: 'secret' } },
    })(leaving);
    expect(revoked.sort()).toEqual(['rt-a-calendar', 'rt-a-mail']);
  });

  test('a provider that fails or hangs does not stop it', async () => {
    if (!handle || !secrets) return;
    const space = await newSpace();
    for (const account of ['h1@example.test', 'h2@example.test'])
      await connect(
        space,
        'imap',
        { kind: 'gmail', account },
        JSON.stringify({ access_token: 'at', refresh_token: `rt-${account}`, scope: 'x', account }),
      );
    const lines: string[] = [];
    let calls = 0;
    await spaceAccessWithdrawal(
      {
        sql: handle.sql,
        secrets,
        log: (line) => lines.push(line),
        fetcher: () => {
          calls += 1;
          return calls === 1 ? new Promise<Response>(() => {}) : Promise.reject(new Error('down'));
        },
        google: { client: { clientId: 'client', clientSecret: 'secret' } },
      },
      200,
    )(space);
    expect(calls).toBe(2);
    expect(lines).toHaveLength(2);
  });

  test('never writes down what a failed withdrawal said, which can quote the token', async () => {
    if (!handle || !secrets) return;
    const space = await newSpace();
    // Not what a sign-in seals: reading it fails, and the failure quotes it.
    const made = await connect(
      space,
      'imap',
      { kind: 'gmail', account: 'quoted@example.test' },
      'ya29SECRETVALUE',
    );
    const lines: string[] = [];
    await spaceAccessWithdrawal({
      sql: handle.sql,
      secrets,
      log: (line) => lines.push(line),
      fetcher: async () => new Response(null, { status: 200 }),
      google: { client: { clientId: 'client', clientSecret: 'secret' } },
    })(space);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(made.id);
    expect(lines.join('\n')).not.toContain('SECRETVALUE');
  });

  test('withdraws an MCP sign-in whole, because the other connections on its server go too', async () => {
    if (!handle || !secrets) return;
    const issuer = rfc7009Issuer();
    const leaving = await newSpace();
    for (const token of ['one', 'two'])
      await connect(
        leaving,
        'mcp',
        issuer.configuration,
        issuer.credential(token, 'shared-client'),
      );
    await spaceAccessWithdrawal({
      sql: handle.sql,
      secrets,
      log: () => {},
      mcpFetch: async () => (request) => fetch(request),
    })(leaving);
    expect(issuer.received.map((form) => [form.token, form.token_type_hint]).sort()).toEqual([
      ['rt-one', 'refresh_token'],
      ['rt-two', 'refresh_token'],
    ]);
  });
});

/**
 * An MCP server's own sign-in on this machine, with an RFC 7009 revocation
 * endpoint, that records each token it is asked to revoke.
 */
function rfc7009Issuer() {
  const received: Record<string, string>[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server')
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          revocation_endpoint: `${url.origin}/revoke`,
          code_challenge_methods_supported: ['S256'],
        });
      if (request.method === 'POST' && url.pathname === '/revoke') {
        received.push(Object.fromEntries(new URLSearchParams(await request.text())));
        return new Response(null, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  closers.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  return {
    received,
    configuration: { server: { endpoint: { transport: 'http', url: `${base}/mcp` } } },
    credential: (token: string, clientId: string) =>
      JSON.stringify({
        access_token: `at-${token}`,
        refresh_token: `rt-${token}`,
        token_url: `${base}/token`,
        client_id: clientId,
        resource: `${base}/mcp`,
        status: 'active',
      }),
  };
}

/** The sealed store, noting each copy opened through it. */
function noticingStore() {
  if (!handle) throw new Error('Postgres unavailable');
  const opened: string[] = [];
  class Noticing extends SealedSecretStore {
    override withSecret<T>(id: string, spaceId: string, use: (value: string) => Promise<T>) {
      opened.push(id);
      return super.withSecret(id, spaceId, use);
    }
  }
  return {
    opened,
    store: new Noticing(new PostgresSecretRepository(handle.sql), () => MASTER_KEY),
  };
}

/** A policy whose revocation reads sealed copies only through `store`. */
function policyReading(store: SealedSecretStore) {
  if (!handle || !jobs) throw new Error('Postgres unavailable');
  return new PolicyService(jobs, undefined, {
    afterRevoke: connectionRevocation({
      sql: handle.sql,
      secrets: store,
      log: () => {},
      mcpFetch: async () => (request) => fetch(request),
    }),
  });
}

/** The client id a sign-in by Client ID Metadata Document carries: the same for every one. */
const METADATA_CLIENT = 'https://melete.example.test/api/oauth/client-metadata.json';

withDb('removing an MCP sign-in whose server another connection signs in to', () => {
  test('withdraws only its access token while another connection uses the same server and client', async () => {
    const issuer = rfc7009Issuer();
    // Another person's space, signed in to the same server as the same client.
    const theirs = await connect(
      await newSpace(),
      'mcp',
      issuer.configuration,
      issuer.credential('theirs', METADATA_CLIENT),
    );
    const mine = await connect(
      await newSpace(),
      'mcp',
      issuer.configuration,
      issuer.credential('mine', METADATA_CLIENT),
    );
    const { opened, store } = noticingStore();
    const answer = await policyReading(store).changeConnection(mine.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('withdrawn');
    expect(issuer.received).toEqual([
      { token: 'at-mine', token_type_hint: 'access_token', client_id: METADATA_CLIENT },
    ]);
    expect(await sealed(mine.secretRef)).toBe(0);
    // The other person's copy is never opened to find this out.
    expect(opened).not.toContain(theirs.secretRef);
    expect(new Set<string | null>(opened)).toEqual(new Set([mine.secretRef]));
  });

  test("withdraws a dynamically registered sign-in whole, without opening another connection's copy", async () => {
    const issuer = rfc7009Issuer();
    // Registered dynamically, a client is one sign-in's own; another
    // connection's copy is not opened to compare it.
    const theirs = await connect(
      await newSpace(),
      'mcp',
      issuer.configuration,
      issuer.credential('theirs', 'dcr-issued'),
    );
    const mine = await connect(
      await newSpace(),
      'mcp',
      issuer.configuration,
      issuer.credential('mine', 'dcr-issued'),
    );
    const { opened, store } = noticingStore();
    const answer = await policyReading(store).changeConnection(mine.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('withdrawn');
    expect(issuer.received).toEqual([
      { token: 'rt-mine', token_type_hint: 'refresh_token', client_id: 'dcr-issued' },
    ]);
    expect(opened).not.toContain(theirs.secretRef);
  });

  test('withdraws a metadata-document sign-in whole when no other connection uses its server', async () => {
    const issuer = rfc7009Issuer();
    const elsewhere = rfc7009Issuer();
    await connect(
      await newSpace(),
      'mcp',
      elsewhere.configuration,
      elsewhere.credential('elsewhere', METADATA_CLIENT),
    );
    const mine = await connect(
      await newSpace(),
      'mcp',
      issuer.configuration,
      issuer.credential('mine', METADATA_CLIENT),
    );
    const answer = await policyReading(noticingStore().store).changeConnection(mine.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('withdrawn');
    expect(issuer.received).toEqual([
      { token: 'rt-mine', token_type_hint: 'refresh_token', client_id: METADATA_CLIENT },
    ]);
    expect(elsewhere.received).toEqual([]);
  });

  test('withdraws its refresh token when the other connections there are other clients', async () => {
    const issuer = rfc7009Issuer();
    await connect(
      await newSpace(),
      'mcp',
      issuer.configuration,
      issuer.credential('theirs', 'dcr-a'),
    );
    // The same client, but on another server, and one already removed.
    const elsewhere = rfc7009Issuer();
    await connect(
      await newSpace(),
      'mcp',
      elsewhere.configuration,
      elsewhere.credential('elsewhere', 'dcr-b'),
    );
    const gone = await connect(
      await newSpace(),
      'mcp',
      issuer.configuration,
      issuer.credential('gone', 'dcr-b'),
    );
    if (!handle) return;
    await handle.sql`update connection set status = 'revoked' where id = ${gone.id}`;
    const mine = await connect(
      await newSpace(),
      'mcp',
      issuer.configuration,
      issuer.credential('mine', 'dcr-b'),
    );
    const policy = policyWith({ mcpFetch: async () => (request) => fetch(request) });
    const answer = await policy.changeConnection(mine.id, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(answer.provider_access).toBe('withdrawn');
    expect(issuer.received).toEqual([
      { token: 'rt-mine', token_type_hint: 'refresh_token', client_id: 'dcr-b' },
    ]);
    expect(elsewhere.received).toEqual([]);
  });
});
