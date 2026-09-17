/**
 * Installing the sandbox connection kind through the API.
 *
 * The provider is E2B's documented-API stand-in, so nothing here reaches a
 * provider, and the key in these tests is the stand-in's own fixture key.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { connectionKindListResponse, connectionResponse } from '@melete/contracts';
import {
  ConnectorFactory,
  type SandboxRuntimeOptions,
  useConnectorFactory,
} from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { createE2bStandin } from '../../src/sandbox/adapters/e2b-standin.ts';
import { SandboxSessions } from '../../src/sandbox/sessions.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '71'.repeat(32);
const PROJECT = 'sandbox-connection-test';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const registry = new ConnectorRegistry();
afterAll(async () => {
  await registry.close();
  await queue?.stop();
  await fixture?.close();
}, 30_000);

const standin = createE2bStandin();
/** The stand-in's fixture key, which stands in for a provider key here. */
const { AUTHORING_KEY } = await import('../../src/sandbox/adapters/e2b-standin.ts');

async function harness() {
  if (!fixture || !queue) throw new Error('Postgres unavailable');
  const env = loadEnv({
    NODE_ENV: 'test',
    MELETE_MASTER_KEY: MASTER_KEY,
    MELETE_SANDBOX_PROJECT: PROJECT,
  });
  const sandbox: SandboxRuntimeOptions = {
    sessions: new SandboxSessions(fixture.sql, {
      leaseSeconds: env.MELETE_SANDBOX_LEASE_SECONDS,
      workspaceRetentionSeconds: env.MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS,
    }),
    project: PROJECT,
    e2bPlan: 'hobby',
    snapshotTtlSeconds: env.MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS,
    maxConcurrent: env.MELETE_SANDBOX_MAX_CONCURRENT,
    modalRefusal: null,
    fetch: standin.fetch,
  };
  useConnectorFactory(
    registry,
    new ConnectorFactory({
      sql: fixture.sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      masterKey: MASTER_KEY,
      sandbox,
    }),
  );
  const jobs = new JobService(fixture.db, queue.boss);
  const app = createApp({
    env,
    db: fixture.db,
    sql: fixture.sql,
    registry,
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
    as('', { email: 'sandbox-owner@example.test', password: 'sandbox-owner-password' }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Setup failed: ${setup.status}`);
  const [space] = await fixture.sql`select id from space where kind = 'personal'`;
  const spaceId = String(space?.id);
  const install = async (body: Record<string, unknown>, session = cookie) => {
    const response = await app.request('/connections', as(session, body));
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as unknown };
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
  const sealed = async (id: string) => {
    const [row] =
      await fixture.sql`select s.ciphertext from connection c join secret s on s.id = c.secret_ref where c.id = ${id}`;
    return String(row?.ciphertext ?? '');
  };
  /** Every place a connection is read back, as one string to search. */
  const everythingReadable = async (id: string) => {
    const responses = await Promise.all([
      ...['/connections', `/connections/${id}`, '/connection-kinds'].map((path) =>
        app.request(path, as(cookie)),
      ),
      app.request(`/connections/${id}/health`, as(cookie, {})),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    return `${bodies.join('\n')}${JSON.stringify(
      await fixture.sql`select label, scopes, configuration from connection where id = ${id}`,
    )}`;
  };
  const counts = async () => {
    const [row] = await fixture.sql`select
      (select count(*)::int from connection where provider = 'sandbox') as connections,
      (select count(*)::int from secret) as secrets`;
    return { connections: Number(row?.connections), secrets: Number(row?.secrets) };
  };
  return {
    app,
    as,
    cookie,
    spaceId,
    sql: fixture.sql,
    install,
    revoke,
    sealed,
    everythingReadable,
    counts,
  };
}

const h = fixture ? await harness() : null;
const withDb = fixture ? describe : describe.skip;

const body = (over: Record<string, unknown> = {}) => ({
  provider: 'sandbox',
  label: 'Remote sandbox',
  credentials: { api_key: AUTHORING_KEY },
  sandbox: {
    adapter: 'e2b',
    image: 'base',
    egress: 'deny_all',
    persistence: 'ephemeral',
    lifetime_seconds: 600,
    ...over,
  },
});

withDb('the sandbox connection kind', () => {
  test('the provider key is sealed and never returned', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const kinds = connectionKindListResponse.parse(
      await (await h.app.request('/connection-kinds', h.as(h.cookie))).json(),
    ).kinds;
    const descriptor = kinds.find((kind) => kind.kind === 'sandbox');
    expect(descriptor?.fields.map((field) => field.path)).toContain('credentials.api_key');
    // Every credential field of this kind is marked secret in the form itself.
    for (const field of descriptor?.fields ?? [])
      if (field.path.startsWith('credentials.')) expect(field.secret).toBe(true);

    const created = await h.install(body());
    expect(created.status).toBe(201);
    const installed = connectionResponse.parse(created.json);
    expect(installed.connection).toMatchObject({ provider: 'sandbox', status: 'active' });
    expect(installed.check).toMatchObject({ status: 'ok', code: 'ok' });
    const id = installed.connection.id;
    expect(created.text).not.toContain(AUTHORING_KEY);
    expect(await h.sealed(id)).toStartWith('sealed-box-v1:');
    expect((await h.sealed(id)).includes(AUTHORING_KEY)).toBe(false);
    expect((await h.everythingReadable(id)).includes(AUTHORING_KEY)).toBe(false);
    // What the row keeps is the configuration a dump may show: never the key.
    const [row] = await h.sql`select configuration from connection where id = ${id}`;
    expect(row?.configuration).toEqual({
      kind: 'sandbox',
      sandbox: {
        adapter: 'e2b',
        image: 'base',
        egress: 'deny_all',
        persistence: 'ephemeral',
        lifetime_seconds: 600,
      },
    });
    expect((await h.revoke(id)).status).toBe(200);
  }, 120_000);

  test('a configuration the manifest cannot honour is refused at installation', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const before = await h.counts();
    for (const [over, reason] of [
      [{ lifetime_seconds: 86_400 }, 'lifetime_exceeded'],
      [{ persistence: 'snapshot' }, 'persistence_unsupported'],
      [{ region: 'eu-west-1' }, 'region_unsupported'],
      [{ egress: 'cidr_allowlist' }, 'A CIDR allow-list needs at least one range'],
      [{ egress: 'cidr_allowlist', cidrs: ['not-a-range'] }, 'egress_invalid'],
    ] as const) {
      const refused = await h.install(body(over));
      expect([JSON.stringify(over), refused.status]).toEqual([JSON.stringify(over), 400]);
      expect(refused.text).toContain(reason);
      expect(refused.text).not.toContain(AUTHORING_KEY);
    }
    // A list left behind under another policy is dropped, not stored unused.
    const dropped = await h.install(body({ egress: 'deny_all', cidrs: ['203.0.113.0/24'] }));
    expect(dropped.status).toBe(201);
    const droppedId = connectionResponse.parse(dropped.json).connection.id;
    const [row] = await h.sql`select configuration from connection where id = ${droppedId}`;
    const stored = row?.configuration as { sandbox: Record<string, unknown> } | undefined;
    expect(stored?.sandbox.cidrs).toBeUndefined();
    expect((await h.revoke(droppedId)).status).toBe(200);

    // A key the provider refuses is not stored either.
    const wrongKey = await h.install({ ...body(), credentials: { api_key: 'not-the-key' } });
    expect(wrongKey.status).toBe(400);
    expect(wrongKey.text).not.toContain('not-the-key');
    // Nothing refused above became a row or a sealed secret; only the dropped-range
    // installation did, and it was revoked.
    expect(await h.counts()).toEqual({
      ...before,
      connections: before.connections + 1,
      secrets: before.secrets + 1,
    });
  }, 120_000);

  test('a second execution backend in one space is refused', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const first = await h.install(body());
    expect(first.status).toBe(201);
    const id = connectionResponse.parse(first.json).connection.id;
    const second = await h.install({ ...body(), label: 'Another sandbox' });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.text).error.code).toBe('conflict');
    expect(
      await h.sql`select id from connection where provider = 'sandbox' and status <> 'revoked'`,
    ).toHaveLength(1);
    // Once the first is removed, the space may install another.
    expect((await h.revoke(id)).status).toBe(200);
    const replacement = await h.install({ ...body(), label: 'Replacement sandbox' });
    expect(replacement.status).toBe(201);
    expect((await h.revoke(connectionResponse.parse(replacement.json).connection.id)).status).toBe(
      200,
    );
  }, 120_000);

  test('a member cannot install a sandbox connection in a personal space', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const member = await h.app.request(
      '/principals',
      h.as(h.cookie, { email: 'sandbox-member@example.test', password: 'sandbox-member-password' }),
    );
    expect(member.status).toBe(201);
    const login = await h.app.request(
      '/login',
      h.as('', { email: 'sandbox-member@example.test', password: 'sandbox-member-password' }),
    );
    const memberCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const refused = await h.install({ ...body(), space_id: h.spaceId }, memberCookie);
    expect(refused.status).toBe(403);
    expect(refused.text).not.toContain(AUTHORING_KEY);
    // Nor in a shared space, whose audience is not the owner alone.
    const shared = await h.app.request('/spaces/shared', h.as(h.cookie, { name: 'Workshop' }));
    expect(shared.status).toBe(201);
    const sharedId = (JSON.parse(await shared.text()) as { space: { id: string } }).space.id;
    expect((await h.install({ ...body(), space_id: sharedId })).status).toBe(403);
    expect(
      await h.sql`select id from connection where provider = 'sandbox' and status <> 'revoked'`,
    ).toHaveLength(0);
    // Their own personal space is theirs to install into.
    const own = await h.install(body(), memberCookie);
    expect(own.status).toBe(201);
    const installed = connectionResponse.parse(own.json).connection;
    expect(installed.space_id).not.toBe(h.spaceId);
  }, 120_000);
});
