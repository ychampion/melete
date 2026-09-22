import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { FakeSandboxProvider } from './fake.ts';
import { SandboxRefusal } from './manifest.ts';
import { runCommand } from './marker.ts';
import { reconcileSandboxes } from './reconcile.ts';
import { seedSessionScope, sessionSpec } from './session-fixtures.ts';
import {
  NOT_STARTED,
  SandboxSessions,
  sessionHandle,
  type WorkspacePersistence,
} from './sessions.ts';
import { type WorkspaceSubject, workspaceConformance } from './workspace-conformance.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const signal = () => AbortSignal.timeout(10_000);

beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
});
afterAll(async () => handle?.close());

withDb('sandbox sessions', () => {
  const setup = async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const scope = await seedSessionScope(handle.sql);
    const provider = new FakeSandboxProvider();
    const sessions = new SandboxSessions(handle.sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 86_400,
    });
    const spec = sessionSpec('sessions-test', scope.spaceId);
    const base = {
      connectionId: scope.connectionId,
      spaceId: scope.spaceId,
      jobId: scope.jobId,
      agentId: null,
    };
    return { sql: handle.sql, scope, provider, sessions, spec, base };
  };
  const refusalCode = (error: unknown) =>
    error instanceof SandboxRefusal ? error.code : `not a refusal: ${String(error)}`;
  // Under bun test, `expect(...).rejects` can wait on a promise without
  // servicing the database socket it needs, so outcomes are settled first.
  const settled = (query: PromiseLike<unknown>) =>
    Promise.resolve(query).then(
      () => 'succeeded',
      (error: unknown) => String(error),
    );

  test('one live session per attempt', async () => {
    const { sql, scope, provider, sessions, spec, base } = await setup();
    const attemptId = await scope.attempt();
    const first = await sessions.open({ ...base, attemptId }, provider, spec, signal());
    expect(first.status).toBe('ready');
    expect(first.providerSandboxId).toStartWith('fake-sbx-');
    const second = await sessions
      .open({ ...base, attemptId }, provider, spec, signal())
      .catch((error: unknown) => error);
    expect(refusalCode(second)).toBe('session_exists');
    expect(provider.calls.create).toBe(1);
    // The index itself holds, not only the service's check.
    const direct = await settled(
      sql`insert into sandbox_session (id, connection_id, space_id, attempt_id, adapter,
          provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
        values ('sbx_DIRECT', ${scope.connectionId}, ${scope.spaceId}, ${attemptId}, 'fake',
          'pending:sbx_DIRECT', 'base', '{"kind":"deny_all"}'::jsonb, 'ephemeral', 'opening', now())`,
    );
    expect(direct).toContain('sandbox_session_attempt_idx');
    await sessions.close(first.id, provider, signal());
    const after = await sessions.open({ ...base, attemptId }, provider, spec, signal());
    expect(after.status).toBe('ready');
  });

  test('one live workspace per space and agent', async () => {
    const { sql, scope, provider, sessions, spec, base } = await setup();
    const workspace = { ...base, agentId: scope.agentId, persistence: 'pause' as const };
    const first = await sessions.open(
      { ...workspace, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    const second = await sessions
      .open({ ...workspace, attemptId: await scope.attempt() }, provider, spec, signal())
      .catch((error: unknown) => error);
    expect(refusalCode(second)).toBe('workspace_exists');
    expect(provider.calls.create).toBe(1);
    const direct = await settled(
      sql`insert into sandbox_session (id, connection_id, space_id, agent_id, adapter,
          provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
        values ('sbx_DIRECT', ${scope.connectionId}, ${scope.spaceId}, ${scope.agentId}, 'fake',
          'direct', 'base', '{"kind":"deny_all"}'::jsonb, 'pause', 'ready', now())`,
    );
    expect(direct).toContain('sandbox_workspace_idx');
    await sessions.close(first.id, provider, signal());
    const reopened = await sessions.open(
      { ...workspace, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    expect(reopened.status).toBe('ready');
  });

  test('an expired lease is swept', async () => {
    const { sql, scope, provider, sessions, spec, base } = await setup();
    const expired = await sessions.open(
      { ...base, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    const current = await sessions.open(
      { ...base, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    await sql`update sandbox_session set lease_expires_at = now() - interval '1 second'
      where id = ${expired.id}`;
    expect(await sessions.sweep(() => provider, signal())).toEqual([expired.id]);
    const swept = await sessions.get(expired.id);
    expect(swept?.status).toBe('closed');
    expect(Number.isFinite(swept?.closedAt?.getTime())).toBe(true);
    expect(await provider.inspect(sessionHandle(expired), signal())).toBe('gone');
    expect((await sessions.get(current.id))?.status).toBe('ready');
    expect(await provider.inspect(sessionHandle(current), signal())).toBe('running');
    // A renewal keeps a lease from being swept.
    await sql`update sandbox_session set lease_expires_at = now() - interval '1 second'
      where id = ${current.id}`;
    expect((await sessions.renew(current.id))?.status).toBe('ready');
    expect(await sessions.sweep(() => provider, signal())).toEqual([]);
  });

  test('a missing provider leaves every session as it was, and reconciliation keeps the workspace', async () => {
    const { sql, scope, provider, sessions, base } = await setup();
    // Labelled with its connection, so reconciliation could destroy it if it
    // were ever mistaken for an orphan.
    const spec = sessionSpec('sessions-test', scope.spaceId, scope.connectionId);
    const ephemeral = await sessions.open(
      { ...base, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    const workspace = await sessions.open(
      { ...base, agentId: scope.agentId, persistence: 'pause', attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    await sql`update sandbox_session set lease_expires_at = now() - interval '1 second'
      where id in ${sql([ephemeral.id, workspace.id])}`;
    // The connection stands, but this process built no provider for it: a
    // connector that failed at boot. Nothing is given up, however many sweeps.
    const none = () => undefined;
    for (const _ of [1, 2]) expect(await sessions.sweep(none, signal())).toEqual([]);
    for (const opened of [ephemeral, workspace]) {
      const row = await sessions.get(opened.id);
      expect([opened.id, row?.status]).toEqual([opened.id, 'ready']);
      expect(row?.lastError).toContain('left as it is until one is');
      expect(await provider.inspect(sessionHandle(opened), signal())).toBe('running');
    }
    // A boot with the provider back reconciles before it sweeps: the workspace
    // is live, not an orphan, and its sandbox survives.
    const reconciled = await reconcileSandboxes({
      sql,
      provider,
      project: 'sessions-test',
      connectionId: scope.connectionId,
      signal: signal(),
    });
    expect(reconciled).toEqual({ destroyed: [], lost: [] });
    // Then the sweep settles both through the provider: the ephemeral session
    // closes, and the workspace is suspended with its files kept.
    expect(await sessions.sweep(() => provider, signal())).toEqual([ephemeral.id]);
    expect(await provider.inspect(sessionHandle(ephemeral), signal())).toBe('gone');
    expect((await sessions.get(workspace.id))?.status).toBe('paused');
    expect(await provider.inspect(sessionHandle(workspace), signal())).toBe('paused');
  });

  test('a session whose connection was revoked or now holds another adapter is lost once', async () => {
    const { sql, scope, provider, sessions, spec, base } = await setup();
    const open = async (agentId: string | null) =>
      sessions.open(
        {
          ...base,
          agentId,
          ...(agentId ? { persistence: 'pause' as const } : {}),
          attemptId: await scope.attempt(),
        },
        provider,
        spec,
        signal(),
      );
    const expire = (id: string) =>
      sql`update sandbox_session set lease_expires_at = now() - interval '1 second' where id = ${id}`;
    const rows = async () => [
      ...(await sql`select id, status, last_error, closed_at, seconds_charged
        from sandbox_session order by id`),
    ];
    const none = () => undefined;

    // Another adapter now: this sandbox can never be reached through it.
    const moved = await open(null);
    await expire(moved.id);
    await sql`update connection set configuration = ${JSON.stringify({ kind: 'sandbox', sandbox: { adapter: 'modal' } })}::jsonb
      where id = ${scope.connectionId}`;
    expect(await sessions.sweep(none, signal())).toEqual([]);
    const movedRow = await sessions.get(moved.id);
    expect(movedRow?.status).toBe('lost');
    expect(movedRow?.lastError).toContain('now holds the modal adapter');

    // Revoked: its workspace included, recorded once.
    await sql`update connection set configuration = '{}'::jsonb where id = ${scope.connectionId}`;
    const workspace = await open(scope.agentId);
    await expire(workspace.id);
    await sql`update connection set status = 'revoked' where id = ${scope.connectionId}`;
    expect(await sessions.sweep(none, signal())).toEqual([]);
    const revoked = await sessions.get(workspace.id);
    expect(revoked?.status).toBe('lost');
    expect(revoked?.lastError).toContain('its connection was revoked');
    const recorded = await rows();
    expect(await sessions.sweep(none, signal())).toEqual([]);
    expect(await rows()).toEqual(recorded);
  });

  test('a session whose job was removed cannot renew, and the next sweep ends it', async () => {
    const { sql, scope, provider, sessions, spec, base } = await setup();
    const opened = await sessions.open(
      { ...base, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    await sql`delete from job where id = ${scope.jobId}`;
    const orphaned = await sessions.get(opened.id);
    expect(orphaned).toMatchObject({ status: 'ready', jobId: null, attemptId: null });
    // Most of its lease is left, and nothing may extend it now.
    expect(orphaned?.leaseExpiresAt.getTime() ?? 0).toBeGreaterThan(Date.now());
    expect(await sessions.renew(opened.id)).toBeNull();
    expect(await sessions.sweep(() => provider, signal())).toEqual([opened.id]);
    expect((await sessions.get(opened.id))?.status).toBe('closed');
    expect(await provider.inspect(sessionHandle(opened), signal())).toBe('gone');
  });

  test('metering records seconds with no cap configured', async () => {
    const { sql, scope, provider, sessions, spec, base } = await setup();
    const opened = await sessions.open(
      { ...base, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    expect(opened.secondsCharged).toBeNull();
    await sql`update sandbox_session set opened_at = opened_at - interval '10 days'
      where id = ${opened.id}`;
    const renewed = await sessions.renew(opened.id);
    expect(renewed?.secondsCharged).toBeGreaterThanOrEqual(864_000);
    // Ten days used and no cap given: another session still opens.
    const another = await sessions.open(
      { ...base, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    expect(another.status).toBe('ready');
    const closed = await sessions.close(opened.id, provider, signal());
    expect(closed.status).toBe('closed');
    expect(closed.secondsCharged).toBeGreaterThanOrEqual(864_000);
    expect(await sessions.usedSeconds(scope.jobId)).toBeGreaterThanOrEqual(864_000);
  });

  test('a configured cap refuses to open a session and never stops a running command', async () => {
    const { sql, scope, provider, sessions, spec, base } = await setup();
    const running = await sessions.open(
      { ...base, attemptId: await scope.attempt(), maxSandboxSeconds: 60 },
      provider,
      spec,
      signal(),
    );
    const command = runCommand({
      provider,
      handle: sessionHandle(running),
      request: {
        marker: 'act_01J0CAPTEST0000000000000',
        argv: ['sh', '-c', 'sleep 0.5; printf finished'],
        timeoutMs: 10_000,
        dispatch: 'first',
      },
      workRoot: '.',
      jobId: scope.jobId,
      signal: signal(),
    });
    await sql`update sandbox_session set opened_at = opened_at - interval '120 seconds'
      where id = ${running.id}`;
    const refused = await sessions
      .open(
        { ...base, attemptId: await scope.attempt(), maxSandboxSeconds: 60 },
        provider,
        spec,
        signal(),
      )
      .catch((error: unknown) => error);
    expect(refusalCode(refused)).toBe('sandbox_time_exhausted');
    expect(provider.calls.create).toBe(1);
    // Over the cap, the running session renews and its command finishes.
    expect((await sessions.renew(running.id))?.status).toBe('ready');
    const result = await command;
    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded')
      expect(new TextDecoder().decode(result.record.preview)).toBe('finished');
    expect(await provider.inspect(sessionHandle(running), signal())).toBe('running');
    expect((await sessions.get(running.id))?.status).toBe('ready');
    // The same job without a cap is not refused.
    const uncapped = await sessions.open(
      { ...base, attemptId: await scope.attempt(), maxSandboxSeconds: null },
      provider,
      spec,
      signal(),
    );
    expect(uncapped.status).toBe('ready');
  });

  test('a sandbox the provider would not create leaves a closed session', async () => {
    const { scope, sessions, spec, base } = await setup();
    const failing = new FakeSandboxProvider();
    failing.create = async () => {
      throw new Error('the provider has no capacity');
    };
    const attemptId = await scope.attempt();
    expect(await settled(sessions.open({ ...base, attemptId }, failing, spec, signal()))).toContain(
      'no capacity',
    );
    if (!handle) throw new Error('Postgres is unavailable');
    const [row] = await handle.sql`select status, last_error from sandbox_session
      where attempt_id = ${attemptId}`;
    expect(row).toMatchObject({ status: 'closed', last_error: 'the provider has no capacity' });
  });

  test('a second dispatch of the same action is told to reattach', async () => {
    const { scope, provider, sessions, spec, base } = await setup();
    const attemptId = await scope.attempt();
    const session = await sessions.open({ ...base, attemptId }, provider, spec, signal());
    const actionId = await scope.action(attemptId);
    expect(await sessions.beginCommand(session.id, actionId, actionId)).toBe('first');
    expect(await sessions.beginCommand(session.id, actionId, actionId)).toBe('again');
    expect(await settled(sessions.beginCommand(session.id, actionId, 'act_OTHER'))).toContain(
      'different sandbox',
    );
  });

  test('only a dispatch the provider refused to start may be sent as a first run again', async () => {
    const { scope, provider, sessions, spec, base } = await setup();
    const attemptId = await scope.attempt();
    const session = await sessions.open({ ...base, attemptId }, provider, spec, signal());
    const actionId = await scope.action(attemptId);
    expect(await sessions.beginCommand(session.id, actionId, actionId)).toBe('first');
    await sessions.settleCommand(actionId, {
      outcome: NOT_STARTED,
      exitCode: null,
      reattached: false,
    });
    expect(await sessions.beginCommand(session.id, actionId, actionId)).toBe('first');
    for (const outcome of ['unknown', 'succeeded', 'failed']) {
      await sessions.settleCommand(actionId, { outcome, exitCode: null, reattached: false });
      expect(await sessions.beginCommand(session.id, actionId, actionId)).toBe('again');
    }
  });

  test('a workspace is not resumed under a different egress policy', async () => {
    const { scope, provider, sessions, base } = await setup();
    const workspace = {
      ...base,
      agentId: scope.agentId,
      persistence: 'pause' as const,
      attemptId: await scope.attempt(),
    };
    const denied = sessionSpec('sessions-test', scope.spaceId);
    const opened = await sessions.openWorkspace(workspace, provider, denied, signal());
    await sessions.suspendWorkspace(opened.id, provider, signal());
    const open = (session: string) => ({ ...denied(session), egress: { kind: 'open' } as const });
    const refused = await sessions
      .openWorkspace({ ...workspace, attemptId: await scope.attempt() }, provider, open, signal())
      .catch((error: unknown) => error);
    expect(refusalCode(refused)).toBe('workspace_incompatible');
    // The workspace is still there, under the policy it was created with.
    const resumed = await sessions.openWorkspace(
      { ...workspace, attemptId: await scope.attempt() },
      provider,
      denied,
      signal(),
    );
    expect(resumed).toMatchObject({ status: 'ready', resumed: true });
    expect(resumed.egressPolicy).toEqual({ kind: 'deny_all' });
  });

  test('a snapshot left behind by a failed deletion is still destroyed with its space', async () => {
    const { scope, provider, sessions, spec, base } = await setup();
    const workspace = { ...base, agentId: scope.agentId, persistence: 'snapshot' as const };
    const first = await sessions.openWorkspace(
      { ...workspace, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    const leaked = (await sessions.suspendWorkspace(first.id, provider, signal())).resumeRef ?? '';
    const second = await sessions.openWorkspace(
      { ...workspace, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    // The superseded snapshot's deletion fails once, so it outlives its row.
    const deleteSnapshot = provider.deleteSnapshot.bind(provider);
    provider.deleteSnapshot = async () => {
      provider.deleteSnapshot = deleteSnapshot;
      throw new Error('the provider could not delete the snapshot');
    };
    const again = await sessions.suspendWorkspace(second.id, provider, signal());
    expect(again.lastError).toContain('left to expire');
    expect(provider.engine.snapshots.has(leaked)).toBe(true);
    const destroyed = await sessions.destroyWorkspacesForSpace(
      scope.spaceId,
      () => provider,
      signal(),
    );
    expect(destroyed.snapshotsDeleted.sort()).toEqual([leaked, again.resumeRef ?? ''].sort());
    expect(provider.engine.snapshots.size).toBe(0);
  });

  test('a workspace whose attempt stopped renewing its lease is suspended, not destroyed', async () => {
    const { sql, scope, provider, sessions, spec, base } = await setup();
    const workspace = {
      ...base,
      agentId: scope.agentId,
      persistence: 'pause' as const,
      attemptId: await scope.attempt(),
    };
    const opened = await sessions.openWorkspace(workspace, provider, spec, signal());
    await sql`update sandbox_session set lease_expires_at = now() - interval '1 second'
      where id = ${opened.id}`;
    expect(await sessions.sweep(() => provider, signal())).toEqual([]);
    const suspended = await sessions.get(opened.id);
    expect(suspended?.status).toBe('paused');
    expect(suspended?.resumeRef).toBe(opened.providerSandboxId);
    expect(await provider.inspect(sessionHandle(opened), signal())).toBe('paused');
    const resumed = await sessions.openWorkspace(
      { ...workspace, attemptId: await scope.attempt() },
      provider,
      spec,
      signal(),
    );
    expect(resumed.resumed).toBe(true);
  });
});

/** The fake, suspending the way a provider does, and refusing once when told to. */
const fakeWorkspace =
  (persistence: WorkspacePersistence) => async (): Promise<WorkspaceSubject> => {
    const provider = new FakeSandboxProvider();
    let failNext = false;
    const refuseOnce = () => {
      if (!failNext) return;
      failNext = false;
      throw new Error('the provider is busy and did not suspend; the sandbox keeps running');
    };
    const pause = provider.pause.bind(provider);
    const snapshot = provider.snapshot.bind(provider);
    provider.pause = async (target, s) => {
      refuseOnce();
      return pause(target, s);
    };
    provider.snapshot = async (target, s) => {
      refuseOnce();
      return snapshot(target, s);
    };
    return {
      provider,
      persistence,
      failNextSuspend: () => {
        failNext = true;
      },
      snapshotHeld: async (ref) => provider.engine.snapshots.has(ref),
      replayed: false,
      close: async () => {},
    };
  };

workspaceConformance('fake, paused', { sql: handle?.sql ?? null, open: fakeWorkspace('pause') });
workspaceConformance('fake, snapshotted', {
  sql: handle?.sql ?? null,
  open: fakeWorkspace('snapshot'),
});
