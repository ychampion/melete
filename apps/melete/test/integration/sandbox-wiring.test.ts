/**
 * What the service does about sandboxes at boot, on its timer and when an
 * attempt ends, and what it refuses to build in a proxied environment.
 *
 * The E2B stand-in and the in-memory fake stand in for providers here, so
 * nothing reaches one.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ConnectorFactory } from '../../src/connectors/configured.ts';
import { readEnv } from '../../src/env.ts';
import { AUTHORING_KEY, createE2bStandin } from '../../src/sandbox/adapters/e2b-standin.ts';
import { createSandboxProvider, modalEnvironmentRefusal } from '../../src/sandbox/connection.ts';
import { FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { sandboxLabels } from '../../src/sandbox/manifest.ts';
import { seedSessionScope, sessionSpec } from '../../src/sandbox/session-fixtures.ts';
import { SandboxSessions, sessionHandle } from '../../src/sandbox/sessions.ts';
import type { SandboxProvider } from '../../src/sandbox/types.ts';
import { startSandboxes } from '../../src/sandbox/wiring.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '4c'.repeat(32);
const PROJECT = 'wiring-test';
const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const signal = () => AbortSignal.timeout(30_000);

beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
});
afterAll(async () => handle?.close(), 30_000);

const wiringFor = (
  connectionId: string,
  adapter: string,
  provider: SandboxProvider,
  sessions: SandboxSessions,
) => {
  if (!handle) throw new Error('Postgres is unavailable');
  return startSandboxes({
    sql: handle.sql,
    sessions,
    providers: () => new Map([[connectionId, { adapter, provider }]]),
    project: PROJECT,
    sweepMs: 60_000,
    log: () => {},
  });
};

test('a snapshot TTL shorter than the retention is refused at boot', () => {
  const refused = readEnv({
    NODE_ENV: 'test',
    MELETE_SANDBOX_PROJECT: PROJECT,
    MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS: '600',
    MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS: '60',
  });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error('unreachable');
  expect(refused.issues.join('\n')).toContain('MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS');
  expect(refused.issues.join('\n')).toContain('must outlast the retention period');
  // Equal is enough, and the defaults are fine.
  expect(
    readEnv({
      NODE_ENV: 'test',
      MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS: '600',
      MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS: '600',
    }).ok,
  ).toBe(true);
  expect(readEnv({ NODE_ENV: 'test' }).ok).toBe(true);
});

test('a proxy or root-certificate setting refuses the Modal adapter unless the opt-in is set', async () => {
  for (const key of ['grpc_proxy', 'https_proxy', 'http_proxy', 'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH'])
    expect(modalEnvironmentRefusal({ [key]: 'http://proxy.internal:3128' }, false)).toContain(key);
  const refusal = modalEnvironmentRefusal({ https_proxy: 'http://proxy.internal:3128' }, false);
  expect(refusal).toContain('MELETE_SANDBOX_ALLOW_PROXY_ENVIRONMENT');
  // Nothing set, or the operator saying the proxy is theirs: no refusal.
  expect(modalEnvironmentRefusal({}, false)).toBeNull();
  expect(modalEnvironmentRefusal({ https_proxy: 'http://proxy.internal:3128' }, true)).toBeNull();
  expect(modalEnvironmentRefusal({ https_proxy: '' }, false)).toBeNull();

  if (!handle) return;
  // And a connection that selects Modal is not built while that refusal stands.
  const sessions = new SandboxSessions(handle.sql, {
    leaseSeconds: 900,
    workspaceRetentionSeconds: 3_600,
  });
  const factoryWith = (modalRefusal: string | null) =>
    new ConnectorFactory({
      sql: handle.sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      masterKey: MASTER_KEY,
      sandbox: {
        sessions,
        project: PROJECT,
        e2bPlan: 'hobby',
        snapshotTtlSeconds: 2_592_000,
        maxConcurrent: 4,
        maxPerConnection: 4,
        modalRefusal,
      },
    });
  const scope = await seedSessionScope(handle.sql);
  const secretRef = await factoryWith(null).secrets.put(
    scope.spaceId,
    JSON.stringify({ api_key: 'ak-token-id:as-token-secret' }),
  );
  const row = {
    id: scope.connectionId,
    spaceId: scope.spaceId,
    provider: 'sandbox',
    secretRef,
    configuration: {
      kind: 'sandbox',
      sandbox: {
        adapter: 'modal',
        image: 'debian:bookworm-slim',
        egress: 'deny_all',
        persistence: 'ephemeral',
        lifetime_seconds: 600,
      },
    },
  };
  await expect(factoryWith(refusal).open(row)).rejects.toThrow('https_proxy');
  // With the opt-in, the same row builds its connector; nothing is sent yet.
  const opened = await factoryWith(null).open(row);
  expect(opened?.manifest.provider).toBe('sandbox');
  await opened?.close?.();
}, 60_000);

withDb('the sandbox wiring', () => {
  test('a labelled orphan is destroyed at boot and a foreign sandbox is left alone', async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const standin = createE2bStandin();
    const scope = await seedSessionScope(handle.sql);
    const sessions = new SandboxSessions(handle.sql, {
      leaseSeconds: 900,
      workspaceRetentionSeconds: 3_600,
    });
    const { provider } = createSandboxProvider(
      {
        adapter: 'e2b',
        image: 'base',
        egress: 'deny_all',
        persistence: 'ephemeral',
        lifetime_seconds: 600,
      },
      {
        credential: (use) => use({ api_key: AUTHORING_KEY }),
        project: PROJECT,
        fetch: standin.fetch,
      },
    );
    // One session this installation owns, and two sandboxes it does not: an
    // orphan of its own project, and a stranger's with no owner label.
    const live = await sessions.open(
      {
        connectionId: scope.connectionId,
        spaceId: scope.spaceId,
        jobId: scope.jobId,
        attemptId: await scope.attempt(),
        agentId: null,
      },
      provider,
      sessionSpec(PROJECT, scope.spaceId, scope.connectionId),
      signal(),
    );
    const orphan = (
      await provider.create(
        {
          ...sessionSpec(PROJECT, scope.spaceId)('sbx_ORPHANED000000000000000'),
          labels: sandboxLabels({
            project: PROJECT,
            connection: scope.connectionId,
            space: scope.spaceId,
            session: 'sbx_ORPHANED000000000000000',
          }),
        },
        signal(),
      )
    ).providerSandboxId;
    const foreign = (
      await provider.create(
        {
          ...sessionSpec('someone-else', scope.spaceId)('sbx_FOREIGN0000000000000000'),
          labels: {},
        },
        signal(),
      )
    ).providerSandboxId;
    // This installation's label, another connection's account: the two may
    // share one provider account, and this boot speaks only for its own.
    const neighbour = (
      await provider.create(
        {
          ...sessionSpec(PROJECT, 'sp_NEIGHBOUR')('sbx_NEIGHBOUR00000000000000'),
          labels: sandboxLabels({
            project: PROJECT,
            connection: 'conn_01J0NEIGHBOUR000000000000',
            space: 'sp_NEIGHBOUR',
            session: 'sbx_NEIGHBOUR00000000000000',
          }),
        },
        signal(),
      )
    ).providerSandboxId;

    const wiring = wiringFor(scope.connectionId, 'e2b', provider, sessions);
    const reports = await wiring.reconcile(signal());
    expect(reports).toEqual([
      { connectionId: scope.connectionId, adapter: 'e2b', destroyed: [orphan], lost: [] },
    ]);
    // The live session keeps its sandbox; the stranger's is untouched.
    expect(
      await provider.inspect(
        { providerSandboxId: orphan, imageDigest: null, region: null },
        signal(),
      ),
    ).toBe('gone');
    for (const kept of [foreign, neighbour])
      expect(
        await provider.inspect(
          { providerSandboxId: kept, imageDigest: null, region: null },
          signal(),
        ),
      ).toBe('running');
    expect((await sessions.get(live.id))?.status).toBe('ready');
    wiring.stop();
  }, 60_000);

  test("an attempt that ends suspends its agent's workspace", async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const scope = await seedSessionScope(handle.sql);
    const provider = new FakeSandboxProvider();
    const sessions = new SandboxSessions(handle.sql, {
      leaseSeconds: 900,
      workspaceRetentionSeconds: 3_600,
    });
    const wiring = wiringFor(scope.connectionId, 'fake', provider, sessions);
    const spec = sessionSpec(PROJECT, scope.spaceId);
    const attemptId = await scope.attempt();
    const workspace = await sessions.openWorkspace(
      {
        connectionId: scope.connectionId,
        spaceId: scope.spaceId,
        jobId: scope.jobId,
        attemptId,
        agentId: scope.agentId,
        persistence: 'pause',
      },
      provider,
      spec,
      signal(),
    );
    await wiring.settleAttempt(attemptId, signal());
    // The workspace is kept, not destroyed: paused, with what to resume from.
    const suspended = await sessions.get(workspace.id);
    expect(suspended).toMatchObject({ status: 'paused', resumeRef: workspace.providerSandboxId });
    expect(
      await provider.inspect(
        { ...workspace, providerSandboxId: workspace.providerSandboxId },
        signal(),
      ),
    ).toBe('paused');

    // An ephemeral session for the next attempt is closed instead.
    const next = await scope.attempt();
    const ephemeral = await sessions.open(
      {
        connectionId: scope.connectionId,
        spaceId: scope.spaceId,
        jobId: scope.jobId,
        attemptId: next,
        agentId: null,
      },
      provider,
      spec,
      signal(),
    );
    await wiring.settleAttempt(next, signal());
    expect((await sessions.get(ephemeral.id))?.status).toBe('closed');
    expect(
      await provider.inspect(
        { providerSandboxId: ephemeral.providerSandboxId, imageDigest: null, region: null },
        signal(),
      ),
    ).toBe('gone');
    // The same path from the runner's hook settles without the caller waiting.
    const third = await scope.attempt();
    const another = await sessions.open(
      {
        connectionId: scope.connectionId,
        spaceId: scope.spaceId,
        jobId: scope.jobId,
        attemptId: third,
        agentId: null,
      },
      provider,
      spec,
      signal(),
    );
    wiring.afterAttempt(third);
    const deadline = Date.now() + 10_000;
    while ((await sessions.get(another.id))?.status !== 'closed' && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await sessions.get(another.id))?.status).toBe('closed');
    wiring.stop();
  }, 60_000);

  test('the sweep runs on its timer and ends a lease that ran out', async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const scope = await seedSessionScope(handle.sql);
    const provider = new FakeSandboxProvider();
    const sessions = new SandboxSessions(handle.sql, {
      leaseSeconds: 900,
      workspaceRetentionSeconds: 3_600,
    });
    const expired = await sessions.open(
      {
        connectionId: scope.connectionId,
        spaceId: scope.spaceId,
        jobId: scope.jobId,
        attemptId: await scope.attempt(),
        agentId: null,
      },
      provider,
      sessionSpec(PROJECT, scope.spaceId),
      signal(),
    );
    await handle.sql`update sandbox_session set lease_expires_at = now() - interval '1 second'
      where id = ${expired.id}`;
    const wiring = startSandboxes({
      sql: handle.sql,
      sessions,
      providers: () => new Map([[scope.connectionId, { adapter: 'fake', provider }]]),
      project: PROJECT,
      sweepMs: 30_000,
      log: () => {},
    });
    expect(await wiring.sweep(signal())).toEqual([expired.id]);
    expect((await sessions.get(expired.id))?.status).toBe('closed');
    wiring.stop();
  }, 60_000);

  test("a session is never handed to another adapter's provider", async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const scope = await seedSessionScope(handle.sql);
    const provider = new FakeSandboxProvider();
    const sessions = new SandboxSessions(handle.sql, {
      leaseSeconds: 900,
      workspaceRetentionSeconds: 3_600,
    });
    const attemptId = await scope.attempt();
    const opened = await sessions.open(
      {
        connectionId: scope.connectionId,
        spaceId: scope.spaceId,
        jobId: scope.jobId,
        attemptId,
        agentId: null,
      },
      provider,
      sessionSpec(PROJECT, scope.spaceId),
      signal(),
    );
    await handle.sql`update sandbox_session set lease_expires_at = now() - interval '1 second'
      where id = ${opened.id}`;
    // The connection now holds another adapter. The provider object is the
    // same fake, so a destroy sent through it would succeed and show here.
    const wiring = wiringFor(scope.connectionId, 'e2b', provider, sessions);
    expect(await wiring.sweep(signal())).toEqual([]);
    await wiring.settleAttempt(attemptId, signal());
    expect(await provider.inspect(sessionHandle(opened), signal())).toBe('running');
    const row = await sessions.get(opened.id);
    expect(row?.status).toBe('ready');
    expect(row?.lastError).toContain(
      `now holds the e2b adapter, and this session's sandbox was created by ${opened.adapter}`,
    );
    wiring.stop();
  }, 60_000);
});
