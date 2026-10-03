import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  connectionCheckResponse,
  connectionKindListResponse,
  connectionListResponse,
  connectionResponse,
} from '@melete/contracts';
import { BrokerService } from '../../src/broker/service.ts';
import {
  ConnectorFactory,
  configuredConnectors,
  useConnectorFactory,
} from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { selfSignedPair } from '../../src/gateway/fixtures/self-signed.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '93'.repeat(32);
const MAIL_PASSWORD = 'mail-app-password-never-returned';
const DAV_PASSWORD = 'caldav-password-never-returned';
const FEED_TOKEN = 'feed-token-never-returned';
const MCP_TOKEN = 'mcp-access-token-never-returned';
const SECRETS = [MAIL_PASSWORD, DAV_PASSWORD, FEED_TOKEN, MCP_TOKEN];

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const registry = new ConnectorRegistry();
const closers: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => {
  for (const close of closers) await close();
  await registry.close();
  await queue?.stop();
  await fixture?.close();
}, 30_000);

/** A real socket that speaks enough IMAP to log in and open a mailbox, and checks the password. */
async function imapDouble(accepts: () => string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK Local IMAP test double\r\n');
    let buffer = '';
    let authenticating = '';
    const answer = (tag: string, supplied: string | undefined) =>
      socket.write(
        supplied === accepts()
          ? `${tag} OK authenticated\r\n`
          : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`,
      );
    const plain = (encoded: string) => Buffer.from(encoded, 'base64').toString().split('\0').at(-1);
    socket.on('data', (data) => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const at = buffer.indexOf('\r\n');
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (authenticating) {
          // The continuation line of AUTHENTICATE PLAIN carries the credentials and no tag.
          answer(authenticating, plain(line));
          authenticating = '';
          continue;
        }
        const tag = line.split(' ')[0] ?? '';
        const command = line.slice(tag.length + 1);
        const upper = command.toUpperCase();
        if (upper === 'AUTHENTICATE PLAIN') {
          authenticating = tag;
          socket.write('+ \r\n');
          continue;
        }
        if (upper.startsWith('AUTHENTICATE PLAIN ')) {
          answer(tag, plain(command.split(' ')[2] ?? ''));
          continue;
        }
        if (upper.startsWith('LOGIN ')) {
          answer(tag, command.split(' ').at(-1)?.replaceAll('"', ''));
          continue;
        }
        if (upper === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n');
        else if (upper.startsWith('SELECT ') || upper.startsWith('EXAMINE '))
          socket.write(
            '* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] Valid\r\n* OK [UIDNEXT 1] Next\r\n',
          );
        else if (upper === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK done\r\n`);
          continue;
        }
        socket.write(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** A real socket that speaks enough SMTP to sign in, and checks the password. It never takes a message. */
async function smtpDouble(accepts: () => string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 localhost ESMTP test double\r\n');
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const at = buffer.indexOf('\r\n');
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /i.test(line)) {
          const supplied = Buffer.from(line.split(' ')[2] ?? '', 'base64')
            .toString()
            .split('\0')
            .at(-1);
          socket.write(
            supplied === accepts()
              ? '235 authenticated\r\n'
              : '535 5.7.8 Authentication failed\r\n',
          );
        } else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n');
        else socket.write('502 not in this double\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Fixture//Feed//EN',
  'BEGIN:VEVENT',
  'UID:feed-event-1',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260105T090000Z',
  'DTEND:20260105T100000Z',
  'SUMMARY:Feed planning session',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/**
 * AWS STS for the AWS account's check: it knows one key, lets it assume one
 * role, and answers whose the credentials are. `accepted` turns the key away.
 */
const STS_HOST = 'sts.eu-west-1.amazonaws.com';
const AWS_KEY = {
  access_key_id: 'AKIAKINDSTESTKEY0001',
  secret_access_key: 'kinds/Test+Secret0123456789abcdef',
};
const sts = { accepted: false, calls: [] as Array<Record<string, string>> };
const stsPair = selfSignedPair(STS_HOST);
const stsServer = createHttpsServer(
  { key: stsPair.key, cert: stsPair.cert },
  (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      sts.calls.push({
        ...form,
        key: /Credential=([^/]+)\//.exec(String(request.headers.authorization))?.[1] ?? '',
      });
      response.writeHead(sts.accepted ? 200 : 403, { 'content-type': 'text/xml' });
      if (!sts.accepted)
        return response.end(
          '<ErrorResponse><Error><Code>InvalidClientTokenId</Code></Error></ErrorResponse>',
        );
      response.end(
        form.Action === 'AssumeRole'
          ? `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIAKINDSSESSION0001</AccessKeyId><SecretAccessKey>kindsSessionSecret0123456789</SecretAccessKey><SessionToken>kindsSessionToken</SessionToken><Expiration>${new Date(Date.now() + 900_000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`
          : '<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:sts::123456789012:assumed-role/agent/melete-check</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>',
      );
    });
  },
);
await new Promise<void>((resolve) => stsServer.listen(0, '127.0.0.1', resolve));
closers.push(() => stsServer.close());
const awsSts = {
  ca: stsPair.cert.toString(),
  route: (host: string) =>
    host === STS_HOST
      ? {
          address: { address: '127.0.0.1', family: 4 as const },
          port: (stsServer.address() as AddressInfo).port,
        }
      : null,
};

async function harness() {
  if (!fixture || !queue) throw new Error('Postgres unavailable');
  const env = loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: MASTER_KEY });
  // Only this fixture factory may speak plaintext, and only to loopback.
  useConnectorFactory(
    registry,
    new ConnectorFactory({
      sql: fixture.sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      masterKey: MASTER_KEY,
      insecureLocalFixtures: true,
      commandLine: { awsSts },
    }),
  );
  const jobs = new JobService(fixture.db, queue.boss);
  const catalog = new RuntimeCatalog(fixture.db, registry);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'connection-kinds-capability-key-32-bytes',
    liveConnectionScopes: true,
    loadCatalog: catalog.forAttempt,
  });
  const broker = new BrokerService({ sql: fixture.sql, connectors: registry, boss: queue.boss });
  const app = createApp({
    env,
    db: fixture.db,
    sql: fixture.sql,
    registry,
    jobs,
    checkDatabase: async () => 'ok',
  });
  // The same database behind a registry whose connectors are built from the environment alone, as a deployment's are.
  const deployed = createApp({
    env,
    db: fixture.db,
    sql: fixture.sql,
    registry: new ConnectorRegistry(),
    jobs,
    checkDatabase: async () => 'ok',
  });
  const as = (cookie: string, body?: unknown): RequestInit => ({
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setup = await app.request(
    '/setup',
    as('', { email: 'kinds-owner@example.test', password: 'kinds-owner-password' }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Setup failed: ${setup.status}`);
  const [space] = await fixture.sql`select id from space where kind = 'personal'`;
  if (!space) throw new Error('Missing personal space');
  const spaceId: string = space.id;

  /** The tools a newly claimed attempt is handed, from its bundle and from the broker. */
  const offered = async () => {
    const row = await jobs.create({
      space_id: spaceId,
      title: 'Connection kinds',
      objective: 'See what a new attempt may use',
    });
    const claimed = await runner.claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'created',
    });
    if (!claimed) throw new Error('Attempt was not claimed');
    const bundle = claimed.bundle.tools.map((tool) => tool.name);
    const brokered = (await broker.discovery.available(claimed.claims)).map((tool) => tool.name);
    return { claimed, bundle, brokered };
  };
  const install = async (body: Record<string, unknown>, session = cookie) => {
    const response = await app.request('/connections', as(session, body));
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
  const revoke = async (id: string) => {
    const current = connectionResponse.parse(
      await (await app.request(`/connections/${id}`, as(cookie))).json(),
    ).connection;
    return app.request(
      `/connections/${id}/lifecycle`,
      as(cookie, { kind: 'revoke', expected_generation: current.generation }),
    );
  };
  /** Every place a connection is read back, as one string to search for a secret. */
  const everythingReadable = async (id: string) => {
    const responses = await Promise.all([
      ...['/connections', `/connections/${id}`, '/experience/connections', '/connection-kinds'].map(
        (path) => app.request(path, as(cookie)),
      ),
      app.request(`/connections/${id}/health`, as(cookie, {})),
    ]);
    // A route that failed would hide a secret by returning nothing at all.
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    return (
      bodies.join('\n') +
      JSON.stringify(
        await fixture.sql`select label, scopes, configuration from connection where id = ${id}`,
      )
    );
  };
  const sealed = async (id: string) => {
    const [row] =
      await fixture.sql`select s.ciphertext from connection c join secret s on s.id = c.secret_ref where c.id = ${id}`;
    return String(row?.ciphertext ?? '');
  };
  return {
    app,
    deployed,
    as,
    cookie,
    spaceId,
    sql: fixture.sql,
    offered,
    install,
    revoke,
    everythingReadable,
    sealed,
  };
}

const h = fixture ? await harness() : null;
const withDb = fixture ? describe : describe.skip;

withDb('installing each kind of connection through the API', () => {
  const expectNoSecret = (text: string) => {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  };

  test('the kinds a client can install are served with their fields, and need a session', async () => {
    if (!h) throw new Error('Postgres unavailable');
    expect((await h.app.request('/connection-kinds')).status).toBe(401);
    const kinds = connectionKindListResponse.parse(
      await (await h.app.request('/connection-kinds', h.as(h.cookie))).json(),
    ).kinds;
    expect([...new Set(kinds.map((kind) => kind.kind))].sort()).toEqual([
      'caldav',
      'command_line',
      'ics',
      'mail',
      'mcp',
      'sandbox',
    ]);
    expect(kinds.map((kind) => kind.id)).toContain('gmail');
    expect((await h.app.request('/connections', h.as('', { provider: 'imap' }))).status).toBe(401);
  });

  test('the catalog puts sign-ins first, and says what the operator has to set to offer one', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const served = connectionKindListResponse.parse(
      await (await h.app.request('/connection-kinds', h.as(h.cookie))).json(),
    );
    const catalog = served.catalog ?? [];
    expect(catalog.slice(0, 2).map((entry) => entry.id)).toEqual(['google', 'microsoft']);
    const google = catalog.find((entry) => entry.id === 'google');
    expect(google).toMatchObject({
      available: false,
      connect: {
        method: 'sign_in',
        provider: 'google',
        start: '/google-sign-ins',
        issuer: 'https://accounts.google.com',
      },
    });
    // Where the person signs in and what is asked for are known before anything starts.
    if (google?.connect.method !== 'sign_in') throw new Error('Expected a sign-in');
    expect(google.connect.scopes.map((item) => item.scope)).toContain(
      'https://www.googleapis.com/auth/gmail.send',
    );
    // The reason is in plain words; what to set is for the installation's owner, who runs it.
    expect(google.unavailable_reason).toBe(
      'Signing in with Google is not set up on this Melete yet.',
    );
    expect(google.setup_hint).toContain('GOOGLE_OAUTH_CLIENT_ID');
    const notion = catalog.find((entry) => entry.id === 'notion');
    expect(notion).toMatchObject({
      available: false,
      covers: ['tools'],
      connect: { method: 'mcp_sign_in', url: 'https://mcp.notion.com/mcp', start: '/mcp-sign-ins' },
    });
    expect(notion?.unavailable_reason).not.toContain('MELETE_PUBLIC_URL');
    expect(notion?.setup_hint).toContain('MELETE_PUBLIC_URL');
    expect(catalog.find((entry) => entry.id === 'stripe')?.warning).toContain('move money');
    // Another account on this installation reads the plain reasons only.
    const member = { email: 'catalog-reader@example.test', password: 'catalog-reader-password' };
    expect((await h.app.request('/principals', h.as(h.cookie, member))).status).toBe(201);
    const memberCookie = (await h.app.request('/login', h.as('', member))).headers
      .get('set-cookie')
      ?.split(';')[0];
    if (!memberCookie) throw new Error('The member did not sign in');
    const theirs = await (await h.app.request('/connection-kinds', h.as(memberCookie))).text();
    const parsed = connectionKindListResponse.parse(JSON.parse(theirs)).catalog ?? [];
    expect(parsed.find((entry) => entry.id === 'google')?.unavailable_reason).toBe(
      google.unavailable_reason,
    );
    expect(parsed.every((entry) => entry.setup_hint === undefined)).toBe(true);
    expect(theirs).not.toContain('GOOGLE_OAUTH_CLIENT_ID');
    expect(theirs).not.toContain('MELETE_PUBLIC_URL');
    // Every form a person can fill in is in the catalog, and nothing else is a form.
    const forms = catalog.filter((entry) => entry.connect.method === 'form');
    expect(forms.map((entry) => entry.id)).toEqual(served.kinds.map((kind) => kind.id));
    expect(forms.every((entry) => entry.available)).toBe(true);
  });

  test('GitHub for the agent’s computer: GitHub is asked whose the token is before it is kept, and the account is shown', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const token = `github_pat_kinds_${newId('rule').toLowerCase()}`;
    const original = globalThis.fetch;
    const asked: string[] = [];
    let accepted = false;
    // Only GitHub's own answer about the token is stood in for.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== 'https://api.github.com/user') return original(input, init);
      asked.push(new Headers(init?.headers).get('authorization') ?? '');
      return accepted
        ? Response.json({ login: 'alice' })
        : Response.json({ message: 'Bad credentials' }, { status: 401 });
    }) as typeof fetch;
    try {
      const body = {
        provider: 'command_line',
        label: 'GitHub',
        credentials: { token },
        command_line: { adapter: 'github' },
      };
      for (const invalid of [
        { ...body, credentials: undefined },
        { ...body, credentials: { token: 'has a space' } },
        { ...body, scopes: ['email.send'] },
        { ...body, command_line: { adapter: 'bitbucket' } },
        { ...body, scopes: ['egress.gitlab_read'] },
        { ...body, provider: 'sandbox' },
      ]) {
        const refused = await h.install(invalid);
        expect(refused.status).toBe(400);
        expect(refused.text).not.toContain(token);
      }
      expect(asked).toEqual([]);
      // GitHub turns the token away: nothing is kept.
      const refused = await h.install(body);
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text).error.message).toBe(
        'GitHub did not accept this token. Check that it has not expired, then paste it again.',
      );
      expect(refused.text).not.toContain(token);
      expect(await h.sql`select id from connection where provider = 'command_line'`).toHaveLength(
        0,
      );
      accepted = true;
      const created = await h.install(body);
      expect(created.status).toBe(201);
      expect(created.text).not.toContain(token);
      const installed = connectionResponse.parse(created.json);
      expect(installed.connection).toMatchObject({
        provider: 'command_line',
        account: 'alice',
        status: 'active',
        scopes: ['egress.github_read', 'egress.github_write'],
      });
      expect(installed.check).toMatchObject({ status: 'ok', code: 'ok' });
      // Asked once before sealing and once by the connection's own check, with the token itself.
      expect(asked.slice(1)).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
      const [row] = await h.sql`select configuration, secret_ref from connection
        where id = ${installed.connection.id}`;
      expect(row?.configuration).toEqual({
        kind: 'command_line',
        adapter: 'github',
        config: {},
        account: 'alice',
      });
      expect(row?.secret_ref).toBeString();
      expect(JSON.stringify(row)).not.toContain(token);
      // A token GitHub stops accepting shows as refused on the next check.
      accepted = false;
      const checked = connectionCheckResponse.parse(
        await (
          await h.app.request(`/connections/${installed.connection.id}/health`, h.as(h.cookie, {}))
        ).json(),
      );
      expect(checked.check).toMatchObject({ status: 'failing', code: 'credential_refused' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('AWS for the agent’s computer: AWS is asked whose the key is, through the role, before it is kept', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const body = {
      provider: 'command_line',
      label: 'AWS',
      credentials: AWS_KEY,
      command_line: {
        adapter: 'aws',
        region: 'eu-west-1',
        role_arn: 'arn:aws:iam::123456789012:role/agent',
      },
    };
    for (const invalid of [
      { ...body, credentials: { token: 'github_pat_x' } },
      { ...body, command_line: { adapter: 'aws' } },
      { ...body, command_line: { ...body.command_line, role_arn: 'agent' } },
      { ...body, scopes: ['egress.github_read'] },
    ]) {
      const refused = await h.install(invalid);
      expect(refused.status).toBe(400);
      expect(refused.text).not.toContain(AWS_KEY.secret_access_key);
    }
    expect(sts.calls).toEqual([]);
    // AWS turns the key away: nothing is kept.
    sts.accepted = false;
    const refused = await h.install(body);
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.text).error.message).toBe(
      'AWS did not accept this key, or did not let it assume the role. Check both, then try again.',
    );
    expect(
      await h.sql`select id from connection where configuration->>'adapter' = 'aws'`,
    ).toHaveLength(0);
    sts.accepted = true;
    sts.calls.length = 0;
    const created = await h.install(body);
    expect(created.status).toBe(201);
    expect(created.text).not.toContain(AWS_KEY.secret_access_key);
    const installed = connectionResponse.parse(created.json);
    expect(installed.connection).toMatchObject({
      provider: 'command_line',
      account: 'arn:aws:sts::123456789012:assumed-role/agent/melete-check',
      status: 'active',
      scopes: ['egress.aws_read', 'egress.aws_write'],
    });
    // The role was assumed with the stored key, and the identity asked with the session.
    expect(sts.calls.slice(0, 2)).toEqual([
      expect.objectContaining({
        Action: 'AssumeRole',
        RoleArn: 'arn:aws:iam::123456789012:role/agent',
        RoleSessionName: 'melete-check',
        key: AWS_KEY.access_key_id,
      }),
      expect.objectContaining({ Action: 'GetCallerIdentity', key: 'ASIAKINDSSESSION0001' }),
    ]);
    const [row] = await h.sql`select configuration, secret_ref from connection
      where id = ${installed.connection.id}`;
    expect(row?.configuration).toEqual({
      kind: 'command_line',
      adapter: 'aws',
      config: { region: 'eu-west-1', role_arn: 'arn:aws:iam::123456789012:role/agent' },
      account: 'arn:aws:sts::123456789012:assumed-role/agent/melete-check',
    });
    expect(JSON.stringify(row)).not.toContain(AWS_KEY.secret_access_key);
    // A key AWS stops accepting shows as refused on the next check.
    sts.accepted = false;
    const checked = connectionCheckResponse.parse(
      await (
        await h.app.request(`/connections/${installed.connection.id}/health`, h.as(h.cookie, {}))
      ).json(),
    );
    expect(checked.check).toMatchObject({ status: 'failing', code: 'credential_refused' });
  });
  for (const service of [
    {
      adapter: 'gitlab',
      name: 'GitLab',
      url: 'https://gitlab.com/api/v4/user',
      header: 'private-token',
      sent: (token: string) => token,
      answer: { username: 'alice' },
    },
    {
      adapter: 'npm',
      name: 'npm',
      url: 'https://registry.npmjs.org/-/whoami',
      header: 'authorization',
      sent: (token: string) => `Bearer ${token}`,
      answer: { username: 'alice' },
    },
  ])
    test(`${service.name} for the agent’s computer: ${service.name} is asked whose the token is before it is kept, and the account is shown`, async () => {
      if (!h) throw new Error('Postgres unavailable');
      const token = `${service.adapter}_kinds_${newId('rule').toLowerCase()}`;
      const original = globalThis.fetch;
      const asked: string[] = [];
      let accepted = false;
      // Only the service's own answer about the token is stood in for.
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== service.url) return original(input, init);
        asked.push(new Headers(init?.headers).get(service.header) ?? '');
        return accepted
          ? Response.json(service.answer)
          : Response.json({ message: '401 Unauthorized' }, { status: 401 });
      }) as typeof fetch;
      try {
        const body = {
          provider: 'command_line',
          label: service.name,
          credentials: { token },
          command_line: { adapter: service.adapter },
        };
        // Another service's grants are refused before anything is asked.
        const crossed = await h.install({ ...body, scopes: ['egress.github_write'] });
        expect(crossed.status).toBe(400);
        expect(asked).toEqual([]);
        const refused = await h.install(body);
        expect(refused.status).toBe(400);
        expect(JSON.parse(refused.text).error.message).toBe(
          `${service.name} did not accept this token. Check that it has not expired, then paste it again.`,
        );
        expect(refused.text).not.toContain(token);
        expect(
          await h.sql`select id from connection where provider = 'command_line'
            and configuration->>'adapter' = ${service.adapter}`,
        ).toHaveLength(0);
        accepted = true;
        const created = await h.install(body);
        expect(created.status).toBe(201);
        expect(created.text).not.toContain(token);
        const installed = connectionResponse.parse(created.json);
        expect(installed.connection).toMatchObject({
          provider: 'command_line',
          account: 'alice',
          status: 'active',
          scopes: [`egress.${service.adapter}_read`, `egress.${service.adapter}_write`],
        });
        expect(installed.check).toMatchObject({ status: 'ok', code: 'ok' });
        expect(asked.slice(1)).toEqual([service.sent(token), service.sent(token)]);
        const [row] = await h.sql`select configuration from connection
          where id = ${installed.connection.id}`;
        expect(row?.configuration).toEqual({
          kind: 'command_line',
          adapter: service.adapter,
          config: {},
          account: 'alice',
        });
        accepted = false;
        const checked = connectionCheckResponse.parse(
          await (
            await h.app.request(
              `/connections/${installed.connection.id}/health`,
              h.as(h.cookie, {}),
            )
          ).json(),
        );
        expect(checked.check).toMatchObject({ status: 'failing', code: 'credential_refused' });
      } finally {
        globalThis.fetch = original;
      }
    });

  test('mail: validated, sealed, tested, offered to a new attempt, and gone after revocation', async () => {
    if (!h) throw new Error('Postgres unavailable');
    let accepted = 'a-different-password';
    const port = await imapDouble(() => accepted);
    const smtpPort = await smtpDouble(() => accepted);
    const body = {
      provider: 'imap',
      label: 'Personal mail',
      credentials: { password: MAIL_PASSWORD },
      mail: {
        username: 'owner@example.test',
        from: 'owner@example.test',
        imap: { host: '127.0.0.1', port, secure: false },
        smtp: { host: '127.0.0.1', port: smtpPort, secure: false },
      },
    };
    for (const invalid of [
      { ...body, credentials: undefined },
      { ...body, credentials: { password: MAIL_PASSWORD, extra: 'x' } },
      { ...body, scopes: ['calendar.list'] },
      { ...body, mail: { ...body.mail, imap: { ...body.mail.imap, port: 0 } } },
      { ...body, mail: { ...body.mail, from: 'owner' } },
      { ...body, provider: 'caldav' },
      { ...body, caldav: { calendar_url: 'https://dav.example.test/c/', username: 'owner' } },
    ]) {
      const refused = await h.install(invalid);
      expect(refused.status).toBe(400);
      expectNoSecret(refused.text);
    }
    // A refused field is named the way the form names it.
    const named = await h.install({
      ...body,
      mail: { ...body.mail, imap: { ...body.mail.imap, port: 0 } },
    });
    expect(JSON.parse(named.text)).toEqual({
      error: { code: 'invalid_request', message: 'IMAP port is too small.' },
    });
    expect(await h.sql`select id from connection where provider = 'imap'`).toHaveLength(0);

    // The mailbox refuses this password: the row is kept in error and offers nothing.
    const failed = await h.install(body);
    expect(failed.status).toBe(201);
    const failure = connectionResponse.parse(failed.json);
    expect(failure.connection).toMatchObject({ status: 'error', setup_state: 'error' });
    // The mailbox answered and turned the password away, and the person is told which.
    expect(failure.check).toMatchObject({ status: 'failing', code: 'credential_refused' });
    expectNoSecret(failed.text);
    expect((await h.offered()).bundle).not.toContain('email.search');

    // Once the mailbox accepts it, a test is what brings the connection up.
    accepted = MAIL_PASSWORD;
    const retested = connectionCheckResponse.parse(
      await (
        await h.app.request(`/connections/${failure.connection.id}/health`, h.as(h.cookie, {}))
      ).json(),
    );
    expect(retested.check).toMatchObject({ status: 'ok', code: 'ok' });
    expect(retested.connection).toMatchObject({ status: 'active', setup_state: 'connected' });

    const created = await h.install({ ...body, label: 'Second mailbox', scopes: ['email.search'] });
    expect(created.status).toBe(201);
    const second = connectionResponse.parse(created.json);
    expect(second.connection).toMatchObject({ status: 'active', scopes: ['email.search'] });
    expect(second.check?.code).toBe('ok');
    expect((await h.revoke(second.connection.id)).status).toBe(200);

    const id = failure.connection.id;
    expect(await h.sealed(id)).toStartWith('sealed-box-v1:');
    expectNoSecret(await h.sealed(id));
    expectNoSecret(await h.everythingReadable(id));
    const mailTools = ['email.draft', 'email.read', 'email.search', 'email.send'];
    const offered = await h.offered();
    expect(offered.bundle).toEqual(expect.arrayContaining(mailTools));
    expect(offered.brokered).toEqual(expect.arrayContaining(mailTools));

    expect((await h.revoke(id)).status).toBe(200);
    const after = await h.offered();
    for (const tool of mailTools) {
      expect(after.bundle).not.toContain(tool);
      expect(after.brokered).not.toContain(tool);
    }
    const listed = connectionListResponse.parse(
      await (await h.app.request('/connections', h.as(h.cookie))).json(),
    ).connections;
    expect(listed.find((row) => row.id === id)?.status).toBe('revoked');
    const removed = connectionCheckResponse.parse(
      await (await h.app.request(`/connections/${id}/health`, h.as(h.cookie, {}))).json(),
    );
    expect(removed.check.code).toBe('revoked');
  }, 120_000);

  test('CalDAV: validated, sealed, tested, offered to a new attempt, and gone after revocation', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const authorizations: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get('authorization') ?? '');
        const expected = `Basic ${Buffer.from(`owner:${DAV_PASSWORD}`).toString('base64')}`;
        if (request.headers.get('authorization') !== expected)
          return new Response(null, { status: 401 });
        return new Response('<multistatus xmlns="DAV:"/>', { status: 207 });
      },
    });
    closers.push(() => server.stop(true));
    const body = {
      provider: 'caldav',
      label: 'Home calendar',
      credentials: { password: DAV_PASSWORD },
      caldav: { calendar_url: `${server.url}calendars/owner/home/`, username: 'owner' },
    };
    for (const invalid of [
      { ...body, credentials: {} },
      { ...body, scopes: ['email.send'] },
      { ...body, caldav: { ...body.caldav, calendar_url: 'http://dav.example.test/c/' } },
      { ...body, caldav: { ...body.caldav, calendar_url: `${server.url}c/?token=1` } },
      { ...body, provider: 'imap' },
    ]) {
      const refused = await h.install(invalid);
      expect(refused.status).toBe(400);
      expectNoSecret(refused.text);
    }

    const created = await h.install(body);
    expect(created.status).toBe(201);
    const installed = connectionResponse.parse(created.json);
    expect(installed.connection).toMatchObject({ provider: 'caldav', status: 'active' });
    expect(installed.check).toMatchObject({ status: 'ok', code: 'ok' });
    expect(authorizations.length).toBeGreaterThan(0);
    const id = installed.connection.id;
    expect(await h.sealed(id)).toStartWith('sealed-box-v1:');
    expectNoSecret(await h.sealed(id));
    expectNoSecret(created.text);
    expectNoSecret(await h.everythingReadable(id));

    const tools = ['calendar.create', 'calendar.delete', 'calendar.list', 'calendar.update'];
    const offered = await h.offered();
    expect(offered.bundle).toEqual(expect.arrayContaining(tools));
    expect(offered.brokered).toEqual(expect.arrayContaining(tools));

    // A process that stopped while a key switch paused this connection left it
    // disabled; a restart puts it back on its old key rather than leaving it
    // unserved. A connection disabled for any other reason stays disabled.
    const [kept] = await h.sql`select secret_ref from connection where id = ${id}`;
    await h.sql`update connection set status = 'disabled', key_change = 'switch' where id = ${id}`;
    const unrelated = newId('conn');
    await h.sql`insert into connection (id, space_id, provider, label, status, setup_state)
      values (${unrelated}, ${h.spaceId}, 'caldav', 'Turned off', 'disabled', 'connected')`;
    // The same stored row is enough after a restart: no connections file is involved.
    const reopened = await configuredConnectors({
      sql: h.sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      masterKey: MASTER_KEY,
      insecureLocalFixtures: true,
    });
    try {
      expect(reopened.get(id)?.manifest.provider).toBe('caldav');
      const [resumed] =
        await h.sql`select status, key_change, secret_ref from connection where id = ${id}`;
      expect(resumed).toMatchObject({
        status: 'active',
        key_change: null,
        secret_ref: kept?.secret_ref,
      });
      const [left] = await h.sql`select status from connection where id = ${unrelated}`;
      expect(left?.status).toBe('disabled');
      expect(reopened.get(unrelated)).toBeUndefined();
      expect((await reopened.get(id)?.health())?.status).toBe('ok');
    } finally {
      await reopened.close();
      await h.sql`delete from connection where id = ${unrelated}`;
    }

    expect((await h.revoke(id)).status).toBe(200);
    const after = await h.offered();
    for (const tool of tools) {
      expect(after.bundle).not.toContain(tool);
      expect(after.brokered).not.toContain(tool);
    }
  }, 120_000);

  test('CalDAV from the service address alone: the calendar is found, and only its address is stored', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const expected = `Basic ${Buffer.from(`owner:${DAV_PASSWORD}`).toString('base64')}`;
    const ok = (href: string, prop: string) =>
      `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (request.headers.get('authorization') !== expected)
          return new Response(null, { status: 401 });
        const path = new URL(request.url).pathname;
        const body =
          path === '/'
            ? ok(
                '/',
                '<d:current-user-principal><d:href>/p/owner/</d:href></d:current-user-principal>',
              )
            : path === '/p/owner/'
              ? ok(
                  '/p/owner/',
                  '<c:calendar-home-set><d:href>/c/owner/</d:href></c:calendar-home-set>',
                )
              : path === '/c/owner/' && request.headers.get('depth') === '1'
                ? ok(
                    '/c/owner/work/',
                    '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>',
                  )
                : '';
        return new Response(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`,
          { status: 207 },
        );
      },
    });
    closers.push(() => server.stop(true));
    const body = {
      provider: 'caldav',
      label: 'Found calendar',
      credentials: { password: DAV_PASSWORD },
      caldav: { server_url: server.url.toString(), username: 'owner' },
    };

    const refused = await h.install({ ...body, credentials: { password: 'not-the-password' } });
    expect(JSON.parse(refused.text)).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'The calendar service did not accept the account name and password. Use an app password where the provider offers one.',
      },
    });
    expect(await h.sql`select id from connection where label = 'Found calendar'`).toHaveLength(0);
    expect(
      (await h.install({ ...body, caldav: { ...body.caldav, calendar_url: `${server.url}c/` } }))
        .status,
    ).toBe(400);

    const created = await h.install(body);
    expect(created.status).toBe(201);
    const installed = connectionResponse.parse(created.json);
    expect(installed.connection).toMatchObject({ status: 'active' });
    const [row] =
      await h.sql`select configuration from connection where id = ${installed.connection.id}`;
    expect(row?.configuration).toEqual({
      kind: 'caldav',
      caldav: { username: 'owner', calendar_url: `${server.url}c/owner/work/` },
    });
    expectNoSecret(created.text);
    expect((await h.revoke(installed.connection.id)).status).toBe(200);
  }, 120_000);

  test('calendar feed: the address is the secret, the feed is read through the broker, and revocation removes it', async () => {
    if (!h) throw new Error('Postgres unavailable');
    let served = FEED;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        return new URL(request.url).searchParams.get('token') === FEED_TOKEN
          ? new Response(served, { headers: { 'content-type': 'text/calendar' } })
          : new Response(null, { status: 404 });
      },
    });
    closers.push(() => server.stop(true));
    const body = {
      provider: 'caldav',
      label: 'Team feed',
      ics: { url: `${server.url}team.ics?token=${FEED_TOKEN}` },
    };
    for (const invalid of [
      { ...body, credentials: { password: 'unused' } },
      { ...body, scopes: ['calendar.create'] },
      { ...body, ics: { url: 'http://feeds.example.test/team.ics' } },
      { ...body, ics: { url: 'https://owner:pw@feeds.example.test/team.ics' } },
      { ...body, ics: { url: `https://10.0.0.8/team.ics?token=${FEED_TOKEN}` } },
      { ...body, provider: 'mcp' },
    ]) {
      const refused = await h.install(invalid);
      expect(refused.status).toBe(400);
      expectNoSecret(refused.text);
    }
    // Outside a local fixture, plain HTTP is refused before a row or a sealed address exists.
    const rowIds = async () =>
      (await h.sql`select id from connection order by id`).map((row) => String(row.id));
    const rowsBefore = await rowIds();
    const plain = await h.deployed.request('/connections', h.as(h.cookie, body));
    const plainText = await plain.text();
    expect(plain.status).toBe(400);
    expectNoSecret(plainText);
    // Nor does TLS make a private or loopback destination a feed the service will read.
    for (const inside of [
      'https://127.0.0.1:8443/team.ics',
      'https://10.0.0.8/team.ics',
      'https://169.254.169.254/team.ics',
      'https://[::1]/team.ics',
      'https://localhost/team.ics',
    ]) {
      const refused = await h.deployed.request(
        '/connections',
        h.as(h.cookie, { ...body, ics: { url: `${inside}?token=${FEED_TOKEN}` } }),
      );
      expect([inside, refused.status]).toEqual([inside, 400]);
      expectNoSecret(await refused.text());
    }
    expect(await rowIds()).toEqual(rowsBefore);

    const created = await h.install(body);
    expect(created.status).toBe(201);
    const installed = connectionResponse.parse(created.json);
    expect(installed.connection).toMatchObject({ status: 'active', scopes: ['calendar.list'] });
    expect(installed.check?.code).toBe('ok');
    const id = installed.connection.id;
    expect(await h.sealed(id)).toStartWith('sealed-box-v1:');
    expectNoSecret(await h.sealed(id));
    expectNoSecret(created.text);
    expectNoSecret(await h.everythingReadable(id));

    const offered = await h.offered();
    expect(offered.bundle).toContain('calendar.list');
    expect(offered.bundle).not.toContain('calendar.create');
    expect(offered.brokered).toContain('calendar.list');
    const broker = new BrokerService({ sql: h.sql, connectors: registry });
    const read = await broker.propose(offered.claimed.claims, {
      connection_id: id,
      kind: 'calendar.list',
      payload: { limit: 5, from: '2026-01-01', to: '2026-02-01' },
    });
    expect(read.status).toBe('succeeded');
    const recorded = JSON.stringify(await broker.get(offered.claimed.claims, read.action_id));
    expect(recorded).toContain('Feed planning session');
    expectNoSecret(recorded);

    // A person's own account is never offered to a public compartment, nor usable from one.
    const jobId = offered.claimed.claims.job_id;
    await h.sql`update job set constraints = '{"public_compartment":true}'::jsonb where id = ${jobId}`;
    const open = (await broker.discovery.available(offered.claimed.claims)).map(
      (tool) => tool.name,
    );
    expect(open).not.toContain('calendar.list');
    expect(open).toContain('web.fetch');
    expect(
      await rejectionOf(
        broker.propose(offered.claimed.claims, {
          connection_id: id,
          kind: 'calendar.list',
          payload: { limit: 1 },
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    await h.sql`update job set constraints = '{}'::jsonb where id = ${jobId}`;

    // A feed that stops being a calendar fails its test without saying where it lives.
    served = 'not a calendar';
    const broken = await (
      await h.app.request(`/connections/${id}/health`, h.as(h.cookie, {}))
    ).text();
    expect(connectionCheckResponse.parse(JSON.parse(broken)).check.code).toBe('unavailable');
    expectNoSecret(broken);
    expect(broken).not.toContain(String(server.port));
    served = FEED;

    expect((await h.revoke(id)).status).toBe(200);
    const after = await h.offered();
    expect(after.bundle).not.toContain('calendar.list');
    expect(after.brokered).not.toContain('calendar.list');
  }, 120_000);

  test('MCP over HTTP: installed, offered to a new attempt, and gone after revocation', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const bearer: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        bearer.push(request.headers.get('authorization') ?? '');
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
            : message.method === 'tools/list'
              ? {
                  tools: [
                    { name: 'lookup', description: 'Fixture', inputSchema: { type: 'object' } },
                  ],
                }
              : {};
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      },
    });
    closers.push(() => server.stop(true));
    const body = {
      provider: 'mcp',
      label: 'Fixture server',
      credentials: { access_token: MCP_TOKEN },
      mcp: {
        id: 'kinds',
        url: `${server.url}mcp`,
        allowed_scopes: ['mcp_kinds.lookup'],
        audience: 'owner',
        tools: [
          {
            name: 'lookup',
            alias: 'lookup',
            required_scopes: ['mcp_kinds.lookup'],
            effect_class: 'read',
          },
        ],
      },
    };
    for (const invalid of [
      { ...body, scopes: ['mcp_kinds.lookup'] },
      { ...body, mcp: { ...body.mcp, allowed_scopes: ['mcp_other.lookup'] } },
      { ...body, mcp: { ...body.mcp, url: 'ftp://127.0.0.1/mcp' } },
      { ...body, credentials: { access_token: 'has spaces' } },
    ]) {
      const refused = await h.install(invalid);
      expect(refused.status).toBe(400);
      expectNoSecret(refused.text);
    }

    const created = await h.install(body);
    expect(created.status).toBe(201);
    const installed = connectionResponse.parse(created.json);
    expect(installed.connection).toMatchObject({ provider: 'mcp', status: 'active' });
    expect(installed.check?.code).toBe('ok');
    expect(bearer).toContain(`Bearer ${MCP_TOKEN}`);
    const id = installed.connection.id;
    expectNoSecret(await h.sealed(id));
    expectNoSecret(created.text);
    expectNoSecret(await h.everythingReadable(id));
    expect((await h.install(body)).status).toBe(409);

    const offered = await h.offered();
    expect(offered.bundle).toContain('mcp_kinds.lookup');
    expect(offered.brokered).toContain('mcp_kinds.lookup');
    expect((await h.revoke(id)).status).toBe(200);
    const after = await h.offered();
    expect(after.bundle).not.toContain('mcp_kinds.lookup');
    expect(after.brokered).not.toContain('mcp_kinds.lookup');

    // A removed installation no longer holds its short name, so the same server
    // can be installed again with a new token.
    const again = await h.install(body);
    expect(again.status).toBe(201);
    const replacement = connectionResponse.parse(again.json).connection.id;
    expect(replacement).not.toBe(id);
    expect((await h.offered()).bundle).toContain('mcp_kinds.lookup');
    expect((await h.revoke(replacement)).status).toBe(200);
  }, 120_000);

  test("only an owner of the space installs, a room's account serves the room, and a session without a space_id means its own space", async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    const feed = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(FEED, { headers: { 'content-type': 'text/calendar' } }),
    });
    closers.push(() => feed.stop(true));
    const body = { provider: 'caldav', label: 'Member feed', ics: { url: `${feed.url}m.ics` } };

    const member = await h.app.request(
      '/principals',
      h.as(h.cookie, { email: 'kinds-member@example.test', password: 'kinds-member-password' }),
    );
    expect(member.status).toBe(201);
    const login = await h.app.request(
      '/login',
      h.as('', { email: 'kinds-member@example.test', password: 'kinds-member-password' }),
    );
    const memberCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect((await h.install({ ...body, space_id: h.spaceId }, memberCookie)).status).toBe(403);
    // Authority is settled before the address is examined, so nothing is
    // resolved or opened on the word of someone who may not install here.
    expect(
      (
        await h.install(
          { ...body, space_id: h.spaceId, ics: { url: 'https://10.0.0.8/m.ics' } },
          memberCookie,
        )
      ).status,
    ).toBe(403);

    const own = await h.install(body, memberCookie);
    expect(own.status).toBe(201);
    const installed = connectionResponse.parse(own.json).connection;
    expect(installed.space_id).not.toBe(h.spaceId);
    const [owned] =
      await fixture.sql`select owner_principal_id from space where id = ${installed.space_id}`;
    const memberId = ((await member.json()) as { principal: { id: string } }).principal.id;
    expect(owned?.owner_principal_id).toBe(memberId);
    // The owner cannot test, read or remove what is in another person's space.
    expect(
      (await h.app.request(`/connections/${installed.id}/health`, h.as(h.cookie, {}))).status,
    ).toBe(403);
    expect((await h.app.request(`/connections/${installed.id}`, h.as(h.cookie))).status).toBe(403);

    const shared = await h.app.request('/spaces/shared', h.as(h.cookie, { name: 'Household' }));
    expect(shared.status).toBe(201);
    const sharedId = ((await shared.json()) as { space: { id: string } }).space.id;
    // Someone outside the room is refused before the address is examined.
    expect((await h.install({ ...body, space_id: sharedId }, memberCookie)).status).toBe(403);
    expect(
      (
        await h.install(
          { ...body, space_id: sharedId, ics: { url: 'https://10.0.0.8/m.ics' } },
          memberCookie,
        )
      ).status,
    ).toBe(403);
    // The room's owner adds an account the room uses as its own.
    const team = await h.install({ ...body, label: 'Team feed', space_id: sharedId });
    expect(team.status).toBe(201);
    const teamId = connectionResponse.parse(team.json).connection.id;
    const [teamRow] = await h.sql`select space_id, shared_use from connection where id = ${teamId}`;
    expect(teamRow).toMatchObject({ space_id: sharedId, shared_use: 'room' });
    expect((await h.revoke(teamId)).status).toBe(200);

    // A new account's space and a new shared space receive the defaults as they are created.
    for (const created of [installed.space_id, sharedId]) {
      const defaults =
        await h.sql`select provider from connection where space_id = ${created} and configuration ? 'builtin' order by provider`;
      expect(defaults.map((row) => row.provider)).toEqual([
        'apps',
        'artifacts',
        'files',
        'room',
        'web',
      ]);
    }
  }, 120_000);

  test('an MCP server at a private address is the setup owner’s alone', async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    let hits = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        hits += 1;
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
            : {
                tools: [
                  { name: 'lookup', description: 'Fixture', inputSchema: { type: 'object' } },
                ],
              };
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      },
    });
    closers.push(() => server.stop(true));
    const policy = {
      id: 'inside',
      allowed_scopes: ['mcp_inside.lookup'],
      audience: 'owner',
      tools: [
        {
          name: 'lookup',
          alias: 'lookup',
          required_scopes: ['mcp_inside.lookup'],
          effect_class: 'read',
        },
      ],
    };
    const body = (url: string) => ({
      provider: 'mcp',
      label: 'Inside server',
      mcp: { ...policy, url },
    });

    const made = await h.app.request(
      '/principals',
      h.as(h.cookie, { email: 'kinds-inside@example.test', password: 'kinds-inside-password' }),
    );
    expect(made.status).toBe(201);
    const memberId = ((await made.json()) as { principal: { id: string } }).principal.id;
    const login = await h.app.request(
      '/login',
      h.as('', { email: 'kinds-inside@example.test', password: 'kinds-inside-password' }),
    );
    const member = login.headers.get('set-cookie')?.split(';')[0] ?? '';

    // Another account's own space is refused a server on this machine, by address or by name.
    for (const url of [`${server.url}mcp`, `http://localhost:${server.port}/mcp`]) {
      expect((await h.install(body(url), member)).status).toBe(400);
    }
    // A public server with a token endpoint on this machine is refused too, before
    // anything is opened: the refresh would otherwise post there.
    expect(
      (
        await h.install(
          {
            ...body('https://93.184.216.34/mcp'),
            credentials: {
              access_token: 'inside-token',
              refresh_token: 'inside-refresh',
              token_url: `${server.url}token`,
            },
          },
          member,
        )
      ).status,
    ).toBe(400);
    expect(hits).toBe(0);

    // A row that already points inside, however it got there, is refused at every connection.
    const [space] = await fixture.sql`select id from space
      where kind = 'personal' and owner_principal_id = ${memberId}`;
    const planted = newId('conn');
    const configuration = {
      server: { ...policy, endpoint: { transport: 'http', url: `${server.url}mcp` } },
    };
    await fixture.sql`insert into connection (id, space_id, provider, label, scopes, configuration, status, setup_state)
      values (${planted}, ${String(space?.id)}, 'mcp', 'Planted', '["mcp_inside.lookup"]'::jsonb,
        ${JSON.stringify(configuration)}::jsonb, 'error', 'error')`;
    const checked = await h.app.request(`/connections/${planted}/health`, h.as(member, {}));
    // Nothing reached the server on this machine, whatever the check then said.
    expect(hits).toBe(0);
    expect(checked.status).toBe(200);
    expect(((await checked.json()) as { check: { status: string } }).check.status).toBe('failing');
  }, 120_000);

  test('a service without a master key installs nothing that needs sealing, and says why', async () => {
    if (!h || !fixture || !queue) throw new Error('Postgres unavailable');
    const keyless = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: fixture.db,
      sql: fixture.sql,
      registry: new ConnectorRegistry(),
      jobs: new JobService(fixture.db, queue.boss),
      checkDatabase: async () => 'ok',
    });
    const stored = async () => {
      const [counts] = await h.sql`select
        (select count(*)::int from connection) as connections,
        (select count(*)::int from secret) as secrets`;
      return { connections: Number(counts?.connections), secrets: Number(counts?.secrets) };
    };
    const before = await stored();
    for (const body of [
      {
        provider: 'imap',
        label: 'Keyless mail',
        credentials: { password: MAIL_PASSWORD },
        mail: {
          username: 'owner@example.test',
          from: 'owner@example.test',
          imap: { host: 'imap.example.test', port: 993, secure: true },
          smtp: { host: 'smtp.example.test', port: 465, secure: true },
        },
      },
      {
        provider: 'caldav',
        label: 'Keyless feed',
        ics: { url: `https://93.184.216.34/team.ics?token=${FEED_TOKEN}` },
      },
    ]) {
      const refused = await keyless.request('/connections', h.as(h.cookie, body));
      const text = await refused.text();
      expect(refused.status).toBe(409);
      expect(JSON.parse(text).error.code).toBe('sealing_unavailable');
      expectNoSecret(text);
    }
    expect(await stored()).toEqual(before);
  }, 120_000);

  test('the owner-controlled connections file still works, and wins over what a row stores', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const stored = await h.install({
      provider: 'caldav',
      label: 'Stored calendar',
      credentials: { password: DAV_PASSWORD },
      caldav: { calendar_url: 'https://dav.example.test/calendars/owner/', username: 'owner' },
    });
    // Nothing answers at that address, so the row is kept in error; the file below can still select it.
    expect(stored.status).toBe(201);
    const pinned = connectionResponse.parse(stored.json).connection.id;
    const bare = pinned.replace(/.$/, (last) => (last === '0' ? '1' : '0'));
    await h.sql`update connection set status = 'active' where id = ${pinned}`;
    await h.sql`insert into connection (id, space_id, provider, label, scopes, secret_ref)
      select ${bare}, space_id, provider, 'File calendar', scopes, secret_ref from connection where id = ${pinned}`;
    const feed = join(await mkdtemp(join(tmpdir(), 'melete-kinds-')), 'imported.ics');
    await writeFile(feed, FEED);
    closers.push(() => rm(dirname(feed), { recursive: true, force: true }));
    const options = { sql: h.sql, workRoot: 'unused', spacesRoot: 'unused', masterKey: MASTER_KEY };

    const fromRows = await configuredConnectors(options);
    const fromFile = await configuredConnectors({
      ...options,
      connections: [
        { kind: 'ics', id: pinned, icsPath: feed },
        {
          kind: 'caldav',
          id: bare,
          calendarUrl: 'https://dav.example.test/calendars/file/',
          username: 'file',
        },
      ],
    });
    try {
      // Without the file: the stored configuration selects CalDAV, and a row with none selects nothing.
      expect(fromRows.get(pinned)?.manifest.tools).toHaveLength(4);
      expect(fromRows.get(bare)).toBeUndefined();
      // With it: the file's imported ICS replaces the stored CalDAV, and the bare row gets a connector.
      expect(fromFile.get(pinned)?.manifest.tools.map((tool) => tool.name)).toEqual([
        'calendar.list',
      ]);
      expect(fromFile.get(bare)?.manifest.tools).toHaveLength(4);
    } finally {
      await fromRows.close();
      await fromFile.close();
      await h.sql`update connection set status = 'revoked' where id in (${pinned}, ${bare})`;
    }
  }, 120_000);
  test('a mailbox that will not start TLS is stored in error; a calendar address without TLS is refused', async () => {
    if (!h) throw new Error('Postgres unavailable');
    // Through the application whose connectors are built from the environment
    // alone, so no fixture exception permits plaintext.
    const installed = await h.deployed.request(
      '/connections',
      h.as(h.cookie, {
        provider: 'imap',
        label: 'Upgrading mailbox',
        credentials: { password: MAIL_PASSWORD },
        mail: {
          username: 'owner@example.test',
          from: 'owner@example.test',
          imap: { host: 'imap.invalid', port: 143, secure: false },
          smtp: { host: 'smtp.invalid', port: 587, secure: false },
        },
      }),
    );
    const text = await installed.text();
    expect(installed.status).toBe(201);
    expectNoSecret(text);
    const stored = connectionResponse.parse(JSON.parse(text));
    expect(stored.connection).toMatchObject({ status: 'error', setup_state: 'error' });
    expect(stored.check).toMatchObject({ status: 'failing', code: 'unavailable' });
    expect((await h.offered()).bundle).not.toContain('email.search');

    // A calendar address that is not HTTPS never becomes a row at all.
    const rows = async () => (await h.sql`select id from connection`).length;
    const before = await rows();
    const refused = await h.deployed.request(
      '/connections',
      h.as(h.cookie, {
        provider: 'caldav',
        label: 'Plain calendar',
        credentials: { password: DAV_PASSWORD },
        caldav: { calendar_url: 'http://dav.example.test/calendars/owner/', username: 'owner' },
      }),
    );
    expect(refused.status).toBe(400);
    expectNoSecret(await refused.text());
    expect(await rows()).toBe(before);
    await h.sql`update connection set status = 'revoked' where id = ${stored.connection.id}`;
  }, 120_000);
});
