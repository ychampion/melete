import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { recordId } from '../broker/records.ts';
import { FakeSandboxProvider } from './fake.ts';
import { sandboxLabels } from './manifest.ts';
import { reconcileSandboxes, sessionMintedAt } from './reconcile.ts';
import { seedSessionScope, sessionSpec } from './session-fixtures.ts';
import { SandboxSessions, sessionHandle } from './sessions.ts';
import type { SandboxProvider } from './types.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const signal = () => AbortSignal.timeout(10_000);
/** A session id minted long ago, so no reconciliation presumes it is still opening. */
const oldSession = (n: number) => `sbx_${String(n).padStart(26, '0')}`;

beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
});
afterAll(async () => handle?.close());

test('a session id carries the time it was minted', () => {
  const before = Date.now();
  const minted = sessionMintedAt(recordId('sbx'));
  expect(minted).toBeGreaterThanOrEqual(before - 1);
  expect(minted).toBeLessThanOrEqual(Date.now());
  expect(sessionMintedAt(oldSession(7))).toBe(0);
  expect(sessionMintedAt('sbx_ORPHAN')).toBeNull();
});

withDb('sandbox reconciliation', () => {
  const setup = async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const scope = await seedSessionScope(handle.sql);
    const provider = new FakeSandboxProvider();
    const sessions = new SandboxSessions(handle.sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 86_400,
    });
    const open = async (project = 'install-a') =>
      sessions.open(
        {
          connectionId: scope.connectionId,
          spaceId: scope.spaceId,
          jobId: scope.jobId,
          attemptId: await scope.attempt(),
          agentId: null,
        },
        provider,
        sessionSpec(project, scope.spaceId),
        signal(),
      );
    const sandbox = async (labels: Record<string, string>) =>
      (
        await provider.create(
          { ...sessionSpec('unused', scope.spaceId)('sbx_UNUSED'), labels },
          signal(),
        )
      ).providerSandboxId;
    return { sql: handle.sql, scope, provider, sessions, open, sandbox };
  };

  test('a workspace suspended as a snapshot is not asked about, and is never marked lost', async () => {
    const { sql, scope, provider, sessions } = await setup();
    const workspace = await sessions.openWorkspace(
      {
        connectionId: scope.connectionId,
        spaceId: scope.spaceId,
        jobId: scope.jobId,
        attemptId: await scope.attempt(),
        agentId: scope.agentId,
        persistence: 'snapshot',
      },
      provider,
      sessionSpec('install-a', scope.spaceId),
      signal(),
    );
    const suspended = await sessions.suspendWorkspace(workspace.id, provider, signal());
    expect(suspended.status).toBe('paused');
    // Its sandbox was stopped when it was suspended; only the snapshot remains.
    expect(await provider.inspect(sessionHandle(workspace), signal())).toBe('gone');
    const report = await reconcileSandboxes({
      sql,
      provider,
      project: 'install-a',
      signal: signal(),
    });
    expect(report).toEqual({ destroyed: [], lost: [] });
    expect((await sessions.get(workspace.id))?.status).toBe('paused');
    expect(provider.engine.snapshots.has(suspended.resumeRef ?? '')).toBe(true);
  });

  test('a labelled orphan is destroyed and a foreign sandbox is left alone', async () => {
    const { sql, scope, provider, open, sandbox } = await setup();
    const owned = (session: string) =>
      sandboxLabels({ project: 'install-a', space: scope.spaceId, session });
    const live = await open();
    // A session opened long before this reconciliation still owns its sandbox.
    const established = await sandbox(owned(oldSession(6)));
    await sql`insert into sandbox_session (id, connection_id, space_id, adapter, provider_sandbox_id,
        image_ref, egress_policy, persistence, status, lease_expires_at)
      values (${oldSession(6)}, ${scope.connectionId}, ${scope.spaceId}, 'fake', ${established},
        'base', '{"kind":"deny_all"}'::jsonb, 'ephemeral', 'ready', now() + interval '5 minutes')`;
    const orphan = await sandbox(owned(oldSession(1)));
    // The session ended but its sandbox outlived it.
    const outlived = await sandbox(owned(oldSession(2)));
    await sql`insert into sandbox_session (id, connection_id, space_id, adapter, provider_sandbox_id,
        image_ref, egress_policy, persistence, status, lease_expires_at, closed_at)
      values (${oldSession(2)}, ${scope.connectionId}, ${scope.spaceId}, 'fake', ${outlived}, 'base',
        '{"kind":"deny_all"}'::jsonb, 'ephemeral', 'closed', now(), now())`;
    // A session still opening owns its sandbox by label, before its row knows the id.
    const opening = await sandbox(owned(oldSession(3)));
    await sql`insert into sandbox_session (id, connection_id, space_id, adapter, provider_sandbox_id,
        image_ref, egress_policy, persistence, status, lease_expires_at)
      values (${oldSession(3)}, ${scope.connectionId}, ${scope.spaceId}, 'fake',
        ${`pending:${oldSession(3)}`}, 'base', '{"kind":"deny_all"}'::jsonb, 'ephemeral',
        'opening', now() + interval '5 minutes')`;
    // A session minted after the table is read may be creating its sandbox now.
    const minting = await sandbox(owned(recordId('sbx')));
    const otherInstallation = await sandbox(
      sandboxLabels({ project: 'install-b', space: 'sp_OTHER', session: oldSession(4) }),
    );
    const unlabelled = await sandbox({});
    const withoutOwner = await sandbox({
      'melete.project': 'install-a',
      'melete.session': oldSession(5),
    });
    const report = await reconcileSandboxes({
      sql,
      provider,
      project: 'install-a',
      signal: signal(),
    });
    expect(report.destroyed.sort()).toEqual([orphan, outlived].sort());
    expect(report.lost).toEqual([]);
    for (const kept of [
      live.providerSandboxId,
      established,
      opening,
      minting,
      otherInstallation,
      unlabelled,
      withoutOwner,
    ])
      expect(
        await provider.inspect(
          { providerSandboxId: kept, imageDigest: null, region: null },
          signal(),
        ),
      ).toBe('running');
    for (const gone of [orphan, outlived])
      expect(
        await provider.inspect(
          { providerSandboxId: gone, imageDigest: null, region: null },
          signal(),
        ),
      ).toBe('gone');
  });

  test('a session whose sandbox vanished is marked lost', async () => {
    const { sql, provider, sessions, open } = await setup();
    const vanished = await open();
    const present = await open();
    const unanswered = await open();
    provider.vanish(vanished.providerSandboxId);
    provider.vanish(unanswered.providerSandboxId);
    // A provider that cannot answer for one sandbox has not said it is gone.
    const flaky = Object.create(provider) as FakeSandboxProvider;
    flaky.inspect = async (target, abort) => {
      if (target.providerSandboxId === unanswered.providerSandboxId)
        throw new Error('the provider timed out');
      return provider.inspect(target, abort);
    };
    const report = await reconcileSandboxes({
      sql,
      provider: flaky as SandboxProvider,
      project: 'install-a',
      signal: signal(),
    });
    expect(report.lost).toEqual([vanished.id]);
    const lost = await sessions.get(vanished.id);
    expect(lost?.status).toBe('lost');
    expect(lost?.closedAt).not.toBeNull();
    expect(lost?.lastError).toContain('no longer has this sandbox');
    expect((await sessions.get(present.id))?.status).toBe('ready');
    expect((await sessions.get(unanswered.id))?.status).toBe('ready');
    expect(await provider.inspect(sessionHandle(present), signal())).toBe('running');
    // When the provider does answer, the unanswered session is lost too, and the
    // one already lost is not marked again.
    const again = await reconcileSandboxes({
      sql,
      provider,
      project: 'install-a',
      signal: signal(),
    });
    expect(again.lost).toEqual([unanswered.id]);
  });
});
