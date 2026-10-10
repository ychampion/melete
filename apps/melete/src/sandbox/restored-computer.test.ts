/**
 * An installation restored onto a new machine gets its agents' computers back
 * as their two volumes only: the volumes are put back from the backup, the
 * containers are not. Such a computer is stopped, not gone. Reconciliation
 * keeps it and its volumes, the next opening makes its container again on
 * them, and only an explicit removal, or a computer whose session row is gone,
 * takes the volumes.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { DOCKER_SANDBOX_DEFAULTS, DockerSandboxHost } from './adapters/docker.ts';
import { SandboxEgressGuard } from './adapters/docker-egress.ts';
import { FakeDocker } from './adapters/docker-fixtures.ts';
import { reconcileSandboxes } from './reconcile.ts';
import { seedSessionScope, sessionSpec } from './session-fixtures.ts';
import { SandboxSessions } from './sessions.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const signal = () => AbortSignal.timeout(10_000);
const PROJECT = 'restore-test';

beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
  if (handle) await handle.sql`delete from sandbox_control`;
});
afterAll(async () => handle?.close());

withDb('a computer restored without its container', () => {
  const setup = async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const sql = handle.sql;
    const scope = await seedSessionScope(sql);
    await sql`update connection set status = 'active' where id = ${scope.connectionId}`;
    const engine = new FakeDocker();
    engine.images.add('base');
    const guard = new SandboxEgressGuard();
    guard.listen = async () => 0;
    const host = new DockerSandboxHost(
      { socket: '/var/run/docker.sock', project: PROJECT, ...DOCKER_SANDBOX_DEFAULTS },
      engine,
      { guard },
    );
    // Ids minted long ago, as a restored row's are: the margin that spares a
    // session still being created is not what keeps anything here.
    let minted = 0;
    const sessions = new SandboxSessions(sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 86_400,
      ids: () => {
        minted += 1;
        return `sbx_${String(minted).padStart(26, '0')}`;
      },
    });
    const open = async () =>
      sessions.openWorkspace(
        {
          connectionId: scope.connectionId,
          spaceId: scope.spaceId,
          jobId: scope.jobId,
          attemptId: await scope.attempt(),
          agentId: scope.agentId,
          persistence: 'pause',
        },
        host,
        sessionSpec(PROJECT, scope.spaceId, scope.connectionId),
        signal(),
      );
    const reconcile = () =>
      reconcileSandboxes({
        sql,
        provider: host,
        project: PROJECT,
        connectionId: scope.connectionId,
        signal: signal(),
      });
    /** What a new machine has after the restore: the volumes, and no container or network. */
    const restoreOntoNewMachine = () => {
      engine.containers.clear();
      engine.networks.clear();
    };
    const volumesOf = (name: string) =>
      [...engine.volumes.keys()].filter((volume) => volume.startsWith(`${name}-`)).sort();
    return {
      sql,
      scope,
      engine,
      host,
      sessions,
      open,
      reconcile,
      restoreOntoNewMachine,
      volumesOf,
    };
  };

  test('a suspended computer keeps its volumes through reconciliation and comes back on them', async () => {
    const { engine, host, sessions, open, reconcile, restoreOntoNewMachine, volumesOf } =
      await setup();
    const first = await open();
    const name = first.providerSandboxId;
    // Suspended as its attempt's end suspends it.
    await sessions.suspendWorkspace(first.id, host, signal());
    const suspended = await sessions.get(first.id);
    expect(suspended?.status).toBe('paused');
    const volumes = structuredClone([...engine.volumes]);
    expect(volumesOf(name)).toEqual([`${name}-home`, `${name}-work`]);

    restoreOntoNewMachine();
    // The service's startup reconciliation, and the next one.
    for (let pass = 0; pass < 2; pass += 1) {
      const report = await reconcile();
      expect(report).toEqual({ destroyed: [], lost: [] });
    }
    expect((await sessions.get(first.id))?.status).toBe('paused');
    expect([...engine.volumes]).toEqual(volumes);

    // The agent's next turn makes its container again on the same volumes.
    const resumed = await open();
    expect(resumed).toMatchObject({ status: 'ready', resumed: true, providerSandboxId: name });
    const container = engine.containers.get(name);
    if (!container) throw new Error('the computer was not made again');
    expect(container.running).toBe(true);
    expect((container.body as { HostConfig: { Mounts: unknown } }).HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: `${name}-work`, Target: '/work' },
      { Type: 'volume', Source: `${name}-home`, Target: '/home/agent' },
    ]);
    expect([...engine.volumes]).toEqual(volumes);
  });

  test('a computer in use when the backup was taken is suspended on its volumes, not lost', async () => {
    const { sql, engine, host, sessions, open, reconcile, restoreOntoNewMachine, volumesOf } =
      await setup();
    const held = await open();
    const name = held.providerSandboxId;
    expect(held.status).toBe('ready');
    restoreOntoNewMachine();
    // The attempt that held it did not survive the move.
    await sql`update attempt set ended_at = now() where id = ${held.attemptId}`;
    expect(await reconcile()).toEqual({ destroyed: [], lost: [] });
    expect((await sessions.get(held.id))?.status).toBe('ready');
    expect(volumesOf(name)).toEqual([`${name}-home`, `${name}-work`]);
    // The sweep suspends it, as it does any workspace whose attempt is gone.
    await sessions.sweep(() => host, signal());
    expect((await sessions.get(held.id))?.status).toBe('paused');
    expect(await reconcile()).toEqual({ destroyed: [], lost: [] });
    const resumed = await open();
    expect(resumed).toMatchObject({ status: 'ready', resumed: true, providerSandboxId: name });
    expect(engine.containers.get(name)?.running).toBe(true);
    expect(volumesOf(name)).toEqual([`${name}-home`, `${name}-work`]);
  });

  test('removing the space still removes a restored computer and its volumes', async () => {
    const { engine, host, sessions, open, restoreOntoNewMachine, volumesOf, scope } = await setup();
    const first = await open();
    const name = first.providerSandboxId;
    await sessions.suspendWorkspace(first.id, host, signal());
    restoreOntoNewMachine();
    // Asked before the space goes: the provider still holds this computer.
    expect((await sessions.listWorkspacesForSpace(scope.spaceId, () => host)).sessions).toEqual([
      first.id,
    ]);
    await sessions.destroyWorkspacesForSpace(scope.spaceId, () => host, signal());
    expect(volumesOf(name)).toEqual([]);
    expect(engine.containers.has(name)).toBe(false);
    expect((await sessions.listWorkspacesForSpace(scope.spaceId, () => host)).sessions).toEqual([]);
  });

  test('destroying a computer removes its volumes, with or without its container', async () => {
    const { engine, host, sessions, open, restoreOntoNewMachine, volumesOf } = await setup();
    const running = await open();
    await sessions.destroyWorkspace(running.id, host, signal());
    expect((await sessions.get(running.id))?.status).toBe('closed');
    expect(volumesOf(running.providerSandboxId)).toEqual([]);

    const restored = await open();
    await sessions.suspendWorkspace(restored.id, host, signal());
    restoreOntoNewMachine();
    await sessions.destroyWorkspace(restored.id, host, signal());
    expect((await sessions.get(restored.id))?.status).toBe('closed');
    expect(volumesOf(restored.providerSandboxId)).toEqual([]);
    expect(engine.volumes.size).toBe(0);
  });

  test('volumes whose session row is gone are still removed', async () => {
    const { sql, engine, host, sessions, open, reconcile, restoreOntoNewMachine, volumesOf } =
      await setup();
    const first = await open();
    const name = first.providerSandboxId;
    await sessions.suspendWorkspace(first.id, host, signal());
    restoreOntoNewMachine();
    await sql`delete from sandbox_session where id = ${first.id}`;
    expect(await reconcile()).toEqual({ destroyed: [name], lost: [] });
    expect(volumesOf(name)).toEqual([]);
    expect(engine.volumes.size).toBe(0);
  });
});
