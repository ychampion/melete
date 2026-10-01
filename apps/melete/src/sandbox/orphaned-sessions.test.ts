/**
 * A workspace is held only while the attempt that opened it is alive. A
 * service that stops in the middle of a command leaves an attempt that ended,
 * or stopped heartbeating, and its session still `ready`; the agent's computer
 * must be usable again at once, not when that session's lease runs out.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { ComputerControls } from './computer-control.ts';
import { FakeSandboxProvider } from './fake.ts';
import { SandboxRefusal } from './manifest.ts';
import { seedSessionScope, sessionSpec } from './session-fixtures.ts';
import { SandboxSessions } from './sessions.ts';
import { startSandboxes } from './wiring.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const signal = () => AbortSignal.timeout(10_000);

beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
});
afterAll(async () => handle?.close());

withDb('a workspace whose attempt is gone', () => {
  const setup = async (controls = new ComputerControls()) => {
    if (!handle) throw new Error('Postgres is unavailable');
    const sql = handle.sql;
    const scope = await seedSessionScope(sql);
    const provider = new FakeSandboxProvider();
    // A long lease: nothing here may rely on it running out.
    const sessions = new SandboxSessions(sql, {
      leaseSeconds: 3_600,
      workspaceRetentionSeconds: 86_400,
      controls,
    });
    const spec = sessionSpec('orphaned-test', scope.spaceId, scope.connectionId);
    const open = (attemptId: string) =>
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
    const providerFor = () => provider;
    await sql`update connection set status = 'active' where id = ${scope.connectionId}`;
    return { sql, scope, provider, sessions, open, providerFor };
  };
  const refusal = async (pending: Promise<unknown>) => {
    try {
      await pending;
      return null;
    } catch (error) {
      return error instanceof SandboxRefusal ? error.code : String(error);
    }
  };

  test('the next sweep suspends a workspace whose attempt ended, and the next attempt resumes it', async () => {
    const { sql, scope, sessions, open, providerFor } = await setup();
    const first = await scope.attempt();
    const held = await open(first);
    expect(held.status).toBe('ready');
    // The service stopped mid-command: the attempt ended, its session did not.
    await sql`update attempt set ended_at = now() where id = ${first}`;
    await sessions.sweep(providerFor, signal());
    expect((await sessions.get(held.id))?.status).toBe('paused');
    const next = await open(await scope.attempt());
    expect(next).toMatchObject({ status: 'ready', resumed: true });
  });

  test('an attempt that stopped heartbeating gives up the workspace when the next one asks', async () => {
    const { sql, scope, sessions, open, provider } = await setup();
    const first = await scope.attempt();
    const held = await open(first);
    await sql`update attempt set lease_expires_at = now() - interval '1 minute' where id = ${first}`;
    const second = await scope.attempt();
    expect(await refusal(open(second))).toBe('workspace_busy');
    expect(
      await sessions.releaseOrphanedWorkspace(
        { spaceId: scope.spaceId, agentId: scope.agentId },
        { connectionId: scope.connectionId, provider },
        signal(),
      ),
    ).toBe(true);
    expect((await sessions.get(held.id))?.status).toBe('paused');
    expect(await open(second)).toMatchObject({ status: 'ready', resumed: true });
  });

  test('a live attempt keeps its workspace, and the holder is named', async () => {
    const { sql, scope, sessions, open, provider, providerFor } = await setup();
    await sql`update job set title = 'Research the heat pumps' where id = ${scope.jobId}`;
    const first = await scope.attempt();
    await sql`update attempt set lease_expires_at = now() + interval '1 minute' where id = ${first}`;
    const held = await open(first);
    await sessions.sweep(providerFor, signal());
    expect(
      await sessions.releaseOrphanedWorkspace(
        { spaceId: scope.spaceId, agentId: scope.agentId },
        { connectionId: scope.connectionId, provider },
        signal(),
      ),
    ).toBe(false);
    expect((await sessions.get(held.id))?.status).toBe('ready');
    expect(await refusal(open(await scope.attempt()))).toBe('workspace_busy');
    expect(await sessions.workspaceHolder(scope.spaceId, scope.agentId)).toMatchObject({
      sessionId: held.id,
      attemptId: first,
      title: 'Research the heat pumps',
    });
  });

  test('a computer a person took over stays theirs until they hand it back', async () => {
    const controls = new ComputerControls();
    const { sql, scope, provider, sessions, open, providerFor } = await setup(controls);
    const first = await scope.attempt();
    const held = await open(first);
    // Taking over passes control to the person and ends the agent's attempt.
    controls.change(held.providerSandboxId, 'human');
    await sql`update attempt set outcome = 'fenced', ended_at = now(), lease_expires_at = null,
      lease_status = 'ended' where id = ${first}`;
    const wiring = startSandboxes({
      sql,
      sessions,
      providers: () =>
        new Map([[scope.connectionId, { adapter: provider.capabilities.adapter, provider }]]),
      project: 'orphaned-test',
      sweepMs: 60_000,
    });
    // The attempt's end, the timed sweep and another attempt asking for the
    // computer all leave it with the person.
    await wiring.settleAttempt(first, signal());
    await sessions.sweep(providerFor, signal());
    expect(
      await sessions.releaseOrphanedWorkspace(
        { spaceId: scope.spaceId, agentId: scope.agentId },
        { connectionId: scope.connectionId, provider },
        signal(),
      ),
    ).toBe(false);
    expect((await sessions.get(held.id))?.status).toBe('ready');
    expect(await refusal(open(await scope.attempt()))).toBe('workspace_busy');
    // Handed back, with no attempt left holding it: the next sweep suspends
    // it, and the next attempt resumes it.
    controls.change(held.providerSandboxId, 'agent');
    await sessions.sweep(providerFor, signal());
    expect((await sessions.get(held.id))?.status).toBe('paused');
    expect(await open(await scope.attempt())).toMatchObject({ status: 'ready', resumed: true });
  });
});
