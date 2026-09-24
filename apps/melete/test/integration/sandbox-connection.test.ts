/**
 * Installing the sandbox connection kind through the API.
 *
 * The provider is E2B's documented-API stand-in, so nothing here reaches a
 * provider, and the key in these tests is the stand-in's own fixture key.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectionKindListResponse, connectionResponse } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import {
  ConnectorFactory,
  type SandboxRuntimeOptions,
  useConnectorFactory,
} from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { createE2bStandin } from '../../src/sandbox/adapters/e2b-standin.ts';
import { sandboxKeyCheck, sandboxTeardownProviders } from '../../src/sandbox/connection.ts';
import { FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { SandboxRefusal } from '../../src/sandbox/manifest.ts';
import { sessionSpec } from '../../src/sandbox/session-fixtures.ts';
import { SandboxSessions, sessionHandle } from '../../src/sandbox/sessions.ts';
import { sandboxKeyChange } from '../../src/sandbox/wiring.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '71'.repeat(32);
const PROJECT = 'sandbox-connection-test';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const registry = new ConnectorRegistry();
const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-sandbox-connection-'));
afterAll(async () => {
  await registry.close();
  await queue?.stop();
  await fixture?.close();
  await rm(workRoot, { recursive: true, force: true });
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
  /**
   * Offered every call the provider receives, until it says it has run. An
   * installation talks to the provider both before its row exists and again
   * after, so a test that needs one of those two moments says which by
   * answering false until it sees what it is waiting for.
   */
  let duringHandshake: (() => Promise<boolean>) | null = null;
  /** Every provider key the stand-in was sent, in order. */
  const sentKeys: string[] = [];
  const sandboxFetch: SandboxRuntimeOptions['fetch'] = async (input, init) => {
    if (duringHandshake && (await duringHandshake())) duringHandshake = null;
    const key = new Headers(init?.headers).get('x-api-key');
    if (key) sentKeys.push(key);
    return standin.fetch(input, init);
  };
  const sandbox: SandboxRuntimeOptions = {
    sessions: new SandboxSessions(fixture.sql, {
      leaseSeconds: env.MELETE_SANDBOX_LEASE_SECONDS,
      workspaceRetentionSeconds: env.MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS,
    }),
    project: PROJECT,
    e2bPlan: 'hobby',
    snapshotTtlSeconds: env.MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS,
    maxConcurrent: env.MELETE_SANDBOX_MAX_CONCURRENT,
    maxPerConnection: env.MELETE_SANDBOX_MAX_CONCURRENT,
    modalRefusal: null,
    fetch: sandboxFetch,
  };
  const factory = new ConnectorFactory({
    sql: fixture.sql,
    workRoot,
    spacesRoot: 'unused',
    masterKey: MASTER_KEY,
    sandbox,
  });
  useConnectorFactory(registry, factory);
  const jobs = new JobService(fixture.db, queue.boss);
  const catalog = new RuntimeCatalog(fixture.db, registry);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'sandbox-connection-capability-key-32-bytes',
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
  /** What a newly claimed attempt is offered, from its bundle and from the broker. */
  const offered = async () => {
    const row = await jobs.create({
      space_id: spaceId,
      title: 'Sandbox work',
      objective: 'Run something in the sandbox',
    });
    const claimed = await runner.claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'created',
    });
    if (!claimed) throw new Error('Attempt was not claimed');
    await mkdir(path.join(workRoot, row.id), { recursive: true });
    return {
      claimed,
      bundle: claimed.bundle.tools.map((tool) => tool.name),
      brokered: (await broker.discovery.available(claimed.claims)).map((tool) => tool.name),
    };
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
    offered,
    broker,
    jobs,
    sessions: sandbox.sessions,
    secrets: factory.secrets,
    served: factory.sandboxProviders,
    sentKeys,
    sandboxFetch,
    onHandshake: (hook: () => Promise<boolean>) => {
      duringHandshake = hook;
    },
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

  test('an attempt is offered terminal.run, and the broker runs it in the sandbox', async () => {
    if (!h) throw new Error('Postgres unavailable');
    // Before the connection exists, nothing offers a terminal.
    const before = await h.offered();
    expect(before.bundle).not.toContain('terminal.run');
    expect(before.brokered).not.toContain('terminal.run');

    const created = await h.install(body());
    expect(created.status).toBe(201);
    const installed = connectionResponse.parse(created.json).connection;
    expect(installed.scopes).toEqual(['terminal.run']);

    const offered = await h.offered();
    expect(offered.bundle).toContain('terminal.run');
    expect(offered.brokered).toContain('terminal.run');

    // The whole path: the model asks for a command, the broker admits it, the
    // service runs it in the sandbox and records what came back.
    const ran = await h.broker.propose(offered.claimed.claims, {
      connection_id: installed.id,
      kind: 'terminal.run',
      payload: { command: "printf 'through the broker'" },
    });
    expect(ran.status).toBe('succeeded');
    const recorded = await h.broker.get(offered.claimed.claims, ran.action_id);
    expect(recorded.receipt?.detail).toMatchObject({
      command: "printf 'through the broker'",
      exit_code: 0,
      digest_verified: true,
      adapter: 'e2b',
      image_ref: 'base',
      egress: 'deny_all',
    });
    expect(JSON.stringify(recorded).includes(AUTHORING_KEY)).toBe(false);
    // The session the command opened belongs to this installation and is leased.
    const [session] = await h.sql`select connection_id, status, adapter from sandbox_session
      where space_id = ${h.spaceId} order by opened_at desc limit 1`;
    expect(session).toMatchObject({
      connection_id: installed.id,
      status: 'ready',
      adapter: 'e2b',
    });

    // Removing the connection takes the terminal away again.
    expect((await h.revoke(installed.id)).status).toBe(200);
    const after = await h.offered();
    expect(after.bundle).not.toContain('terminal.run');
    expect(after.brokered).not.toContain('terminal.run');
  }, 180_000);

  test('a key of the wrong shape for its adapter is refused before anything is sealed', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const before = await h.counts();
    for (const [adapter, key, expected] of [
      // One field serves both adapters, so each says what it expects.
      ['modal', 'ak-only-the-token-id', 'token_id:token_secret'],
      // Two colons are not a token id and a secret. Splitting at the first one
      // would keep half of whatever this really is, so it is refused instead.
      ['modal', 'ak-token-id:as-token-secret:and-more', 'token_id:token_secret'],
      ['modal', ':as-token-secret', 'token_id:token_secret'],
      ['e2b', 'e2b_1234:5678', 'has no colon in it'],
    ] as const) {
      const refused = await h.install({
        ...body({ adapter }),
        credentials: { api_key: key },
      });
      expect([key, refused.status]).toEqual([key, 400]);
      // A closed code, and words naming what to paste.
      expect(refused.text).toContain('credential_invalid');
      expect(refused.text).toContain(expected);
      // The value itself is never echoed back.
      expect(refused.text).not.toContain(key);
    }
    // Nothing was stored, and no Modal token ever reached a provider.
    expect(await h.counts()).toEqual(before);
  }, 120_000);

  test('the audience checked at the door is checked again before the row is activated', async () => {
    if (!h) throw new Error('Postgres unavailable');
    // The request passes the door, and its row is written, as the owner of an
    // owner-audience space. The space stops being the owner's alone while the
    // installation is still talking to the provider, which is after the locked
    // check at insertion and before the one that publishes the row.
    h.onHandshake(async () => {
      const [pending] = await h.sql`select id from connection
        where provider = 'sandbox' and setup_state = 'connecting'`;
      if (!pending) return false;
      await h.sql`update space set audience = 'space' where id = ${h.spaceId}`;
      return true;
    });
    const created = await h.install(body());
    const installed = connectionResponse.parse(created.json).connection;
    try {
      // The handshake itself succeeded, so only the check under the activation
      // lock can have stopped this row from going active.
      expect(installed.status).toBe('error');
      expect(connectionResponse.parse(created.json).check?.code).toBe('not_running');
      const [row] = await h.sql`select status, setup_state from connection
        where id = ${installed.id}`;
      expect(row).toMatchObject({ status: 'error', setup_state: 'error' });
    } finally {
      await h.sql`update space set audience = 'owner' where id = ${h.spaceId}`;
      await h.sql`delete from secret where id in
        (select secret_ref from connection where id = ${installed.id})`;
      await h.sql`delete from connection where id = ${installed.id}`;
    }
  }, 120_000);
  /**
   * Sessions for an installed connection, on the in-memory provider under the
   * adapter name the row selects, and the revocation the service runs.
   */
  const revocationSetup = async () => {
    if (!h) throw new Error('Postgres unavailable');
    const created = await h.install(body());
    expect(created.status).toBe(201);
    const id = connectionResponse.parse(created.json).connection.id;
    // Earlier tests here revoke through the route, which runs no teardown, and
    // their stand-in sandboxes share this provider's identifiers; their rows
    // are finished with so the unique sandbox index only sees this test's.
    await h.sql`update sandbox_session set status = 'closed', closed_at = now()
      where space_id = ${h.spaceId} and status not in ('closed', 'lost')`;
    const provider = new FakeSandboxProvider({ capabilities: { adapter: 'e2b' } });
    const teardown = sandboxTeardownProviders({
      sql: h.sql,
      secrets: h.secrets,
      project: PROJECT,
      open: () => ({ provider, close: async () => {} }),
    });
    const job = await h.jobs.create({
      space_id: h.spaceId,
      title: 'Sandbox work',
      objective: 'Run something in the sandbox',
    });
    const opened = [];
    for (const _ of [1, 2])
      opened.push(
        await h.sessions.open(
          { connectionId: id, spaceId: h.spaceId, jobId: job.id, attemptId: null, agentId: null },
          provider,
          sessionSpec(PROJECT, h.spaceId, id),
          AbortSignal.timeout(30_000),
        ),
      );
    const policy = new PolicyService(h.jobs, undefined, {
      beforeKeyChange: sandboxKeyChange({
        sessions: h.sessions,
        providerFor: teardown.providerFor,
        log: () => {},
      }),
    });
    const generation = async () =>
      Number((await h.sql`select generation from connection where id = ${id}`)[0]?.generation);
    const revoke = async () =>
      policy.changeConnection(id, { kind: 'revoke', expected_generation: await generation() });
    const switchKey = async () => {
      const replacement = await h.secrets.put(
        h.spaceId,
        JSON.stringify({ api_key: AUTHORING_KEY }),
      );
      const changed = await policy.changeConnection(id, {
        kind: 'switch',
        secret_ref: replacement,
        expected_generation: await generation(),
      });
      return { changed, replacement };
    };
    return { id, provider, teardown, opened, revoke, switchKey };
  };

  test('revoking a sandbox connection destroys what it holds while the key is still there', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const { id, provider, teardown, opened, revoke } = await revocationSetup();
    expect((await revoke()).status).toBe('revoked');
    for (const session of opened) {
      expect(await provider.inspect(sessionHandle(session), AbortSignal.timeout(10_000))).toBe(
        'gone',
      );
      expect((await h.sessions.get(session.id))?.status).toBe('closed');
    }
    const [row] = await h.sql`select status, secret_ref from connection where id = ${id}`;
    expect(row).toMatchObject({ status: 'revoked', secret_ref: null });
    await teardown.close();
  }, 120_000);

  test('a revocation whose teardown fails still completes, and says what it left', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const { id, provider, teardown, opened, revoke } = await revocationSetup();
    provider.destroy = async () => {
      throw new Error('the provider did not answer');
    };
    expect((await revoke()).status).toBe('revoked');
    for (const session of opened) {
      const row = await h.sessions.get(session.id);
      expect(row?.status).toBe('lost');
      expect(row?.lastError).toContain('revoked before this sandbox could be destroyed');
      expect(row?.lastError).toContain('the provider did not answer');
      expect(await provider.inspect(sessionHandle(session), AbortSignal.timeout(10_000))).toBe(
        'running',
      );
    }
    // Nothing is left looking live: asked what the space still holds, the
    // answer names both, since no key can reach them now.
    const left = await h.sessions.listWorkspacesForSpace(h.spaceId, teardown.providerFor);
    for (const session of opened) expect(left.sessions).toContain(session.id);
    const [row] = await h.sql`select status, secret_ref from connection where id = ${id}`;
    expect(row).toMatchObject({ status: 'revoked', secret_ref: null });
    await teardown.close();
  }, 120_000);
  test('switching a sandbox connection to another key destroys what the old key holds first', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const { id, provider, teardown, opened, switchKey } = await revocationSetup();
    const [before] = await h.sql`select secret_ref from connection where id = ${id}`;
    // Which key the connection held at the moment each sandbox was destroyed.
    const heldAtDestroy: unknown[] = [];
    const destroy = provider.destroy.bind(provider);
    provider.destroy = async (handle, signal) => {
      const [row] = await h.sql`select secret_ref from connection where id = ${id}`;
      heldAtDestroy.push(row?.secret_ref);
      return destroy(handle, signal);
    };
    const { changed, replacement } = await switchKey();
    expect(changed.status).toBe('active');
    expect(heldAtDestroy.length).toBeGreaterThanOrEqual(opened.length);
    for (const held of heldAtDestroy) expect(held).toBe(before?.secret_ref);
    for (const session of opened) {
      expect(await provider.inspect(sessionHandle(session), AbortSignal.timeout(10_000))).toBe(
        'gone',
      );
      expect((await h.sessions.get(session.id))?.status).toBe('closed');
    }
    const [after] = await h.sql`select status, secret_ref from connection where id = ${id}`;
    expect(after).toMatchObject({ status: 'active', secret_ref: replacement });
    await h.sql`update connection set status = 'revoked', secret_ref = null where id = ${id}`;
    await teardown.close();
  }, 120_000);

  test('a switch whose teardown fails still completes, and says what the old key left', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const { id, provider, teardown, opened, switchKey } = await revocationSetup();
    provider.destroy = async () => {
      throw new Error('the provider did not answer');
    };
    const { changed, replacement } = await switchKey();
    expect(changed.status).toBe('active');
    for (const session of opened) {
      const row = await h.sessions.get(session.id);
      expect(row?.status).toBe('lost');
      expect(row?.lastError).toContain(
        'had its key replaced before this sandbox could be destroyed',
      );
      expect(row?.lastError).toContain('the provider did not answer');
    }
    const [after] = await h.sql`select secret_ref from connection where id = ${id}`;
    expect(after?.secret_ref).toBe(replacement);
    await h.sql`update connection set status = 'revoked', secret_ref = null where id = ${id}`;
    await teardown.close();
  }, 120_000);
  test('a workspace resume that races a revocation waits for it and is refused, and nothing hangs', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const { id, provider, revoke } = await revocationSetup();
    const agentId = recordId('agent');
    await h.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
      values (${agentId}, ${h.spaceId}, 'Agent', 'helper', 'blue', 'plain', 'black', 'calm', 'help')`;
    const job = await h.jobs.create({ space_id: h.spaceId, title: 'Race', objective: 'Race' });
    const spec = sessionSpec(PROJECT, h.spaceId, id);
    const workspace = {
      connectionId: id,
      spaceId: h.spaceId,
      jobId: job.id,
      attemptId: null,
      agentId,
      persistence: 'pause' as const,
      concurrency: { perConnection: 8, installation: 8 },
    };
    const opened = await h.sessions.openWorkspace(
      workspace,
      provider,
      spec,
      AbortSignal.timeout(30_000),
    );
    await h.sessions.suspendWorkspace(opened.id, provider, AbortSignal.timeout(30_000));
    // The revocation's teardown is held inside its first provider call, with
    // the connection row locked for update, while a resume begins.
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const destroy = provider.destroy.bind(provider);
    let calls = 0;
    provider.destroy = async (handle, signal) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return destroy(handle, signal);
    };
    const revoking = revoke().then(
      (changed) => changed.status,
      (error: unknown) => `revoke failed: ${String(error)}`,
    );
    await inside;
    const resuming = h.sessions
      .openWorkspace(workspace, provider, spec, AbortSignal.timeout(60_000))
      .then(
        () => 'resumed',
        (error: unknown) =>
          error instanceof SandboxRefusal ? error.code : `resume failed: ${String(error)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    release();
    const outcome = await Promise.race([
      Promise.all([revoking, resuming]),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 20_000)),
    ]);
    expect(outcome).toEqual(['revoked', 'connection_inactive']);
    expect(await provider.inspect(sessionHandle(opened), AbortSignal.timeout(10_000))).toBe('gone');
  }, 120_000);
  test('a key switch reaches the provider the connection already serves', async () => {
    if (!h) throw new Error('Postgres unavailable');
    await h.sql`update sandbox_session set status = 'closed', closed_at = now()
      where space_id = ${h.spaceId} and status not in ('closed', 'lost')`;
    const created = await h.install(body());
    expect(created.status).toBe(201);
    const id = connectionResponse.parse(created.json).connection.id;
    // Built when the connection was installed, and never rebuilt since.
    const served = h.served.get(id)?.provider;
    if (!served) throw new Error('the connection serves no provider');
    const rotated = 'e2b_rotated_key_not_a_credential_000000';
    const replacement = await h.secrets.put(h.spaceId, JSON.stringify({ api_key: rotated }));
    await h.sql`update connection set secret_ref = ${replacement} where id = ${id}`;
    h.sentKeys.length = 0;
    await served
      .inspect(
        { providerSandboxId: 'sbx_probe_after_switch', imageDigest: null, region: null },
        AbortSignal.timeout(10_000),
      )
      .catch(() => {});
    expect(h.sentKeys.length).toBeGreaterThan(0);
    expect(h.sentKeys.every((key) => key === rotated)).toBe(true);
    // Revoked, the connection lends no key at all.
    await h.sql`update connection set status = 'revoked', secret_ref = null where id = ${id}`;
    h.sentKeys.length = 0;
    const refused = await served
      .inspect(
        { providerSandboxId: 'sbx_probe_after_revoke', imageDigest: null, region: null },
        AbortSignal.timeout(10_000),
      )
      .catch((error: unknown) => String(error));
    expect(String(refused)).toContain('no longer holds a provider key');
    expect(h.sentKeys).toEqual([]);
  }, 120_000);
  test('a switch to a secret that is not a key the provider accepts is refused before anything ends', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const { id, provider, teardown, opened } = await revocationSetup();
    const [before] = await h.sql`select secret_ref from connection where id = ${id}`;
    // The check asks the documented-API stand-in, which accepts one key only.
    const checking = sandboxTeardownProviders({
      sql: h.sql,
      secrets: h.secrets,
      project: PROJECT,
      ...(h.sandboxFetch ? { fetch: h.sandboxFetch } : {}),
    });
    const policy = new PolicyService(h.jobs, undefined, {
      checkKeyChange: sandboxKeyCheck(checking),
      beforeKeyChange: sandboxKeyChange({
        sessions: h.sessions,
        providerFor: teardown.providerFor,
        log: () => {},
      }),
    });
    const password = 'CorrectHorseBatteryStaple2026';
    for (const sealed of [
      password,
      JSON.stringify({ api_key: 'e2b_rejected_key_000000000000000' }),
    ]) {
      const secretRef = await h.secrets.put(h.spaceId, sealed);
      const [row] = await h.sql`select generation from connection where id = ${id}`;
      const refused = await policy
        .changeConnection(id, {
          kind: 'switch',
          secret_ref: secretRef,
          expected_generation: Number(row?.generation),
        })
        .then(
          () => 'switched',
          (error: unknown) => error,
        );
      expect(refused).toMatchObject({ code: 'invalid_credential' });
      expect(String((refused as Error).message).includes(password)).toBe(false);
    }
    // Nothing was torn down, and the connection kept its key.
    for (const session of opened) {
      expect((await h.sessions.get(session.id))?.status).toBe('ready');
      expect(await provider.inspect(sessionHandle(session), AbortSignal.timeout(10_000))).toBe(
        'running',
      );
    }
    const [after] = await h.sql`select status, secret_ref from connection where id = ${id}`;
    expect(after).toMatchObject({ status: 'active', secret_ref: before?.secret_ref });
    await h.sql`update connection set status = 'revoked', secret_ref = null where id = ${id}`;
    await checking.close();
    await teardown.close();
  }, 120_000);
});
