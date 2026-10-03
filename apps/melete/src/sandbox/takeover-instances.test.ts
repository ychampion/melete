/**
 * A computer a person took over, as two service instances on one database see
 * it. Each instance here has its own connection pool and its own services, as
 * two processes would; all they share is Postgres.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { type DatabaseHandle, openDatabase } from '../db/client.ts';
import { FakeSandboxProvider } from './fake.ts';
import type { SandboxRefusal } from './manifest.ts';
import { seedSessionScope, sessionSpec } from './session-fixtures.ts';
import { SandboxSessions } from './sessions.ts';
import { startSandboxes } from './wiring.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const signal = () => AbortSignal.timeout(10_000);
const pools: DatabaseHandle[] = [];
/** Another process's pool on the same database. */
const instance = () => {
  if (!handle) throw new Error('Postgres is unavailable');
  const pool = openDatabase(handle.url);
  pools.push(pool);
  return pool;
};

beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
  // The fake provider names its sandboxes the same way in every test.
  if (handle) await handle.sql`delete from sandbox_control`;
});
afterAll(async () => {
  for (const pool of pools) await pool.close();
  await handle?.close();
});

withDb('a computer taken over, across service instances', () => {
  const sessionsOn = (pool: DatabaseHandle) =>
    new SandboxSessions(pool.sql, { leaseSeconds: 3_600, workspaceRetentionSeconds: 86_400 });

  const setup = async () => {
    const first = instance();
    const second = instance();
    const scope = await seedSessionScope(first.sql);
    await first.sql`update connection set status = 'active' where id = ${scope.connectionId}`;
    const provider = new FakeSandboxProvider();
    const spec = sessionSpec('takeover-test', scope.spaceId, scope.connectionId);
    const open = (sessions: SandboxSessions, attemptId: string) =>
      sessions.openWorkspace(
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
    const one = sessionsOn(first);
    const two = sessionsOn(second);
    const attemptId = await scope.attempt();
    const held = await open(one, attemptId);
    // Taking over passes control to the person and ends the agent's attempt.
    const took = await one.controls.change(held.providerSandboxId, 'human', { from: 0 });
    expect(took).toEqual({ control: 'human', epoch: 1 });
    await first.sql`update attempt set outcome = 'fenced', ended_at = now(),
      lease_expires_at = null, lease_status = 'ended' where id = ${attemptId}`;
    return { first, second, scope, provider, open, one, two, held, attemptId };
  };

  test('another instance leaves a computer taken over on the first with the person, and a restart keeps it theirs', async () => {
    const { second, scope, provider, open, two, held, attemptId } = await setup();
    // The second instance's settlement and orphan sweep pass it by.
    const wiring = startSandboxes({
      sql: second.sql,
      sessions: two,
      providers: () =>
        new Map([[scope.connectionId, { adapter: provider.capabilities.adapter, provider }]]),
      project: 'takeover-test',
      sweepMs: 60_000,
    });
    await wiring.settleAttempt(attemptId, signal());
    expect(await two.expireOrphaned()).toEqual([]);
    expect([
      ...(await second.sql`select status, lease_expires_at > now() as leased
      from sandbox_session where id = ${held.id}`),
    ]).toEqual([{ status: 'ready', leased: true }]);
    // The first instance restarts: a fresh process still finds it held.
    const restarted = sessionsOn(instance());
    expect(await restarted.heldByPerson(held.providerSandboxId)).toBe(true);
    const refused = await open(restarted, await scope.attempt()).catch((error: unknown) => error);
    expect((refused as SandboxRefusal).code).toBe('workspace_busy');
    expect(provider.calls.pause).toBe(0);
    // Handed back on the second instance, the orphan sweep anywhere settles it.
    expect(await two.controls.change(held.providerSandboxId, 'agent', { from: 1 })).toEqual({
      control: 'agent',
      epoch: 2,
    });
    expect(await restarted.expireOrphaned()).toEqual([held.id]);
  });

  test("keep-awake on another instance keeps a person's computer running, and suspends it once handed back", async () => {
    const { first, two, one, held, provider } = await setup();
    // Its attempt ended with background processes still running in it.
    await first.sql`update sandbox_session set held_by = 'processes', attempt_id = null,
      lease_expires_at = now() + interval '1 second' where id = ${held.id}`;
    const providerFor = () => provider;
    expect(await two.keepAwake(providerFor, signal())).toEqual([]);
    expect([
      ...(await first.sql`select status, lease_expires_at > now() + interval '1 minute' as kept
      from sandbox_session where id = ${held.id}`),
    ]).toEqual([{ status: 'ready', kept: true }]);
    expect(provider.calls.pause).toBe(0);
    // A person's computer is awake for the idle stop on every instance too.
    expect([...(await two.awakeSandboxes(provider.capabilities.adapter))]).toContain(
      held.providerSandboxId,
    );
    await one.controls.change(held.providerSandboxId, 'agent');
    expect(await two.keepAwake(providerFor, signal())).toEqual([held.id]);
  });

  test('of two instances taking the same computer over at once, exactly one does', async () => {
    const { one, two, held } = await setup();
    await one.controls.change(held.providerSandboxId, 'agent');
    const current = await two.controls.state(held.providerSandboxId);
    const results = await Promise.all([
      one.controls.change(held.providerSandboxId, 'human', { from: current.epoch }),
      two.controls.change(held.providerSandboxId, 'human', { from: current.epoch }),
    ]);
    expect(results.filter(Boolean)).toEqual([{ control: 'human', epoch: current.epoch + 1 }]);
    expect(await one.controls.state(held.providerSandboxId)).toEqual({
      control: 'human',
      epoch: current.epoch + 1,
    });
  });

  test('a lease sweep on another instance leaves a computer a person holds running', async () => {
    const { first, two, held, provider } = await setup();
    const providerFor = () => provider;
    // No attempt renews it now: its lease runs out while the person drives it.
    await first.sql`update sandbox_session set lease_expires_at = now() - interval '1 second'
      where id = ${held.id}`;
    await two.sweep(providerFor, signal());
    expect((await two.get(held.id))?.status).toBe('ready');
    expect(provider.calls.pause + provider.calls.destroy).toBe(0);
    // Handed back, the next sweep settles it as any expired workspace.
    await two.controls.change(held.providerSandboxId, 'agent');
    await two.sweep(providerFor, signal());
    expect((await two.get(held.id))?.status).toBe('paused');
  });

  test('a takeover read before the computer went to another attempt is refused, and one made first keeps it from that attempt', async () => {
    const { first, scope, open, one, two, held } = await setup();
    // Its attempt ended with background processes running in it.
    await first.sql`update sandbox_session set held_by = 'processes', attempt_id = null
      where id = ${held.id}`;
    await one.controls.change(held.providerSandboxId, 'agent');
    const read = await one.controls.state(held.providerSandboxId);
    // Another instance hands the computer to the next attempt meanwhile.
    const adopted = await open(two, await scope.attempt());
    expect(adopted.providerSandboxId).toBe(held.providerSandboxId);
    expect(
      await one.controls.change(held.providerSandboxId, 'human', { from: read.epoch }),
    ).toBeNull();
    // The other way round: taken over first, the computer is not handed on.
    await first.sql`update sandbox_session set held_by = 'processes', attempt_id = null
      where id = ${adopted.id}`;
    const now = await one.controls.state(held.providerSandboxId);
    expect(
      await one.controls.change(held.providerSandboxId, 'human', { from: now.epoch }),
    ).not.toBeNull();
    const refused = await open(two, await scope.attempt()).catch((error: unknown) => error);
    expect((refused as SandboxRefusal).code).toBe('workspace_busy');
  });

  test('a computer held with no live view open for thirty minutes is handed back by the sweep', async () => {
    const { first, two, held, provider } = await setup();
    const providerFor = () => provider;
    await two.sweep(providerFor, signal());
    expect((await two.controls.state(held.providerSandboxId)).control).toBe('human');
    await first.sql`update sandbox_control set seen_at = now() - interval '31 minutes',
      changed_at = now() - interval '31 minutes'
      where provider_sandbox_id = ${held.providerSandboxId}`;
    // A view that is open records the person as watching, and keeps it theirs.
    await two.controls.seen(held.providerSandboxId);
    await two.sweep(providerFor, signal());
    expect((await two.controls.state(held.providerSandboxId)).control).toBe('human');
    await first.sql`update sandbox_control set seen_at = now() - interval '31 minutes'
      where provider_sandbox_id = ${held.providerSandboxId}`;
    await two.sweep(providerFor, signal());
    expect(await two.controls.state(held.providerSandboxId)).toEqual({
      control: 'agent',
      epoch: 2,
    });
  });

  test('settling acts only if no person holds the computer at that moment', async () => {
    const { two, held, provider } = await setup();
    // Read as the agent's before the takeover; the statement that acts checks again.
    const closed = await two.close(held.id, provider, signal(), { unlessHeldByPerson: true });
    expect(closed.status).toBe('ready');
    const suspended = await two
      .suspendWorkspace(held.id, provider, signal())
      .catch((error: unknown) => error);
    expect((suspended as SandboxRefusal).code).toBe('workspace_busy');
    expect(provider.calls.pause + provider.calls.destroy).toBe(0);
  });
});
