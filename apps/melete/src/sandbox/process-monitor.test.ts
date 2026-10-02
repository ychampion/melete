/**
 * Waking a job from its background process: the process monitor, watches made
 * from a job's own tool call, `process:<id>` waits and `process.wait`, against
 * the real job, trigger and process tables, the fake provider and an
 * in-memory stand-in for the helper inside the computer.
 *
 * The assertion that matters most is the quiet one: a process that prints
 * nothing a watch wants adds no attempt, so no model call.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Action,
  type CapabilityClaims,
  canonicalizePayload,
  connectorManifest,
  type SandboxConnectionConfig,
  type WaitSpec,
} from '@melete/contracts';
import { testDatabase } from '../../test/helpers/database.ts';
import { requestRuntimeWait } from '../broker/runtime-wait.ts';
import {
  createSandboxExecConnector,
  sandboxExecManifest,
  sandboxTerminalManifest,
} from '../connectors/sandbox-exec.ts';
import type { ConnectorContext } from '../connectors/types.ts';
import { type AttemptWake, QUEUES, startQueue } from '../jobs/queue.ts';
import { AttemptRunner } from '../jobs/runner.ts';
import { type JobRow, JobService } from '../jobs/service.ts';
import { TriggerService } from '../jobs/triggers.ts';
import { StubRuntimeAdapter } from '../runtime/stub.ts';
import { FakeSandboxProvider } from './fake.ts';
import { FakeComputers } from './process-fixtures.ts';
import { ProcessMonitor } from './process-monitor.ts';
import { SandboxProcesses } from './processes.ts';
import { seedSessionScope } from './session-fixtures.ts';
import { SandboxSessions } from './sessions.ts';
import type { SandboxProvider } from './types.ts';
import { startSandboxes } from './wiring.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'process-wakes-signing-key-32-bytes!!';

const config: SandboxConnectionConfig = {
  adapter: 'e2b',
  image: 'base',
  egress: 'deny_all',
  persistence: 'pause',
  lifetime_seconds: 600,
};

afterAll(async () => {
  await queue?.stop();
  await handle?.close();
}, 30_000);

test('the sandbox tools, process.wait among them, are still a manifest the service accepts', () => {
  for (const manifest of [sandboxTerminalManifest, sandboxExecManifest])
    expect(connectorManifest.safeParse(manifest).success).toBe(true);
  const wait = sandboxTerminalManifest.tools.find((tool) => tool.name === 'process.wait');
  expect(wait?.effect_class).toBe('read');
});

withDb('waking a job from its background process', () => {
  beforeEach(async () => {
    if (!handle || !queue) return;
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await handle.sql`truncate "owner", "space", event_retention cascade`;
  });

  const setup = async () => {
    if (!handle || !jobs) throw new Error('Postgres is unavailable');
    const sql = handle.sql;
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const triggers = new TriggerService(jobs, runner);
    const scope = await seedSessionScope(sql);
    await sql`update connection set provider = 'sandbox',
        scopes = '["terminal.run","process.start","process.wait"]'::jsonb
      where id = ${scope.connectionId}`;
    // An agent a conversation's attempt can speak as.
    await sql`update agent set colour = '#336699', surface = 'rounded', eye_colour = '#111111'
      where id = ${scope.agentId}`;
    const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-process-wakes-'));
    const provider = new FakeSandboxProvider();
    const sessions = new SandboxSessions(sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 3_600,
    });
    const computers = new FakeComputers();
    const processes = new SandboxProcesses(sql, {
      limits: {
        maxPerComputer: 8,
        maxPerSpace: 8,
        defaultTtlMinutes: 120,
        maxTtlMinutes: 720,
        outputMaxBytes: 8 * 1024 * 1024,
        awakeSecondsPerDay: 6 * 3600,
      },
      computerFor: (each, target) => computers.computerFor(each, target),
      log: () => {},
    });
    const connector = createSandboxExecConnector({
      sessions,
      provider,
      config,
      connectionId: scope.connectionId,
      spaceId: scope.spaceId,
      project: 'process-wakes-test',
      workRoot,
      sql,
      processes,
      workspaceWaitMs: 0,
    });
    const providers = () =>
      new Map([[scope.connectionId, { adapter: 'fake', provider: provider as SandboxProvider }]]);
    let clock = Date.now();
    const monitor = new ProcessMonitor({
      sql,
      processes,
      providers,
      wakes: triggers,
      dockerMs: 0,
      remoteMs: 0,
      now: () => new Date(clock),
      log: () => {},
    });
    const later = (seconds: number) => {
      clock += seconds * 1000;
    };
    const pass = () => monitor.pass(AbortSignal.timeout(20_000));
    const wiring = startSandboxes({
      sql,
      sessions,
      providers,
      project: 'process-wakes-test',
      sweepMs: 60_000,
      processes,
      log: () => {},
    });

    /** A job of the agent, as a conversation would hold it. */
    const conversation = async (title = 'Run the tests') => {
      const row = await jobs.create({ space_id: scope.spaceId, title, objective: title });
      await sql`update job set agent_id = ${scope.agentId} where id = ${row.id}`;
      await mkdir(path.join(workRoot, row.id), { recursive: true });
      return jobs.get(row.id);
    };
    const wake = (row: JobRow): AttemptWake => ({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'event',
    });
    const claim = async (row: JobRow) => {
      const claimed = await runner.claim(wake(await jobs.get(row.id)));
      if (!claimed) throw new Error('Expected an admitted attempt');
      return claimed;
    };
    let step = 0;
    /** One process tool call in an attempt, as the broker dispatches it. */
    const run = async (
      claims: CapabilityClaims,
      kind: string,
      payload: Record<string, unknown>,
    ) => {
      step += 1;
      const id = `act_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      const canonical = canonicalizePayload({ step, ...payload });
      await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key)
        values (${id}, ${claims.job_id}, ${claims.attempt_id}, ${scope.connectionId}, ${kind},
          'write_reversible', ${canonical.json}::jsonb, ${canonical.hash}, ${id})`;
      const action = {
        id,
        job_id: claims.job_id,
        attempt_id: claims.attempt_id,
        connection_id: scope.connectionId,
        kind,
        effect_class: 'write_reversible',
        canonical_payload: canonical.canonical,
        payload_hash: canonical.hash,
        intent_key: null,
        status: 'dispatched',
        authorization_ref: null,
        budget_reservation: null,
        idempotency_key: id,
        dispatched_at: new Date().toISOString(),
        receipt: null,
        resolved_at: null,
        reconciliation: null,
        repair_trace: [],
        repair_counters: {},
        repair_disposition: null,
        retry_after_at: null,
        created_at: new Date().toISOString(),
      } as Action;
      const ctx: ConnectorContext = {
        job_id: claims.job_id,
        space_id: scope.spaceId,
        idempotency_key: id,
        constraints: {
          deliverable: { kind: 'none' },
          allowed_domains: [],
          public_compartment: false,
        },
      };
      const result = await connector.execute(action, ctx);
      // Settled as the broker would, so a later wait is not refused for a pending action.
      await sql`update action set status = ${result.outcome === 'succeeded' ? 'succeeded' : 'failed'}
        where id = ${id}`;
      return result;
    };
    const detail = (result: Awaited<ReturnType<typeof run>>) => {
      if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
      return result.receipt.detail as Record<string, unknown>;
    };
    /** The attempt ends its turn waiting on `process:<id>`, resolved by the broker. */
    const waitOn = async (claims: CapabilityClaims, processId: string) => {
      const asked = await requestRuntimeWait(
        sql,
        { ...claims, scopes: [...claims.scopes, 'job.wait'] },
        { kind: 'event', event_name: `process:${processId}` },
      );
      return runner.commitOutcome(claims, {
        kind: 'waiting_for_event_or_time',
        wait: asked.wait as WaitSpec,
      });
    };
    const sandboxOf = async () => {
      const [row] = await sql`select provider_sandbox_id from sandbox_session
        where agent_id = ${scope.agentId} order by opened_at desc limit 1`;
      return String(row?.provider_sandbox_id);
    };
    const attempts = async (jobId: string) =>
      Number((await sql`select count(*)::int as n from attempt where job_id = ${jobId}`)[0]?.n);
    const wakes = (jobId: string) =>
      sql`select payload from event where job_id = ${jobId} and payload->>'kind' = 'trigger_event'
        order by seq`;
    const watchesOf = (jobId: string) =>
      sql`select id, enabled from trigger where job_id = ${jobId} order by id`;
    const job = (id: string) => jobs.get(id);
    return {
      sql,
      job,
      scope,
      provider,
      sessions,
      processes,
      computers,
      triggers,
      runner,
      wiring,
      conversation,
      claim,
      run,
      detail,
      waitOn,
      pass,
      later,
      sandboxOf,
      attempts,
      wakes,
      watchesOf,
    };
  };

  test('a process exit wakes the waiting job with its exit code and last lines', async () => {
    const s = await setup();
    const row = await s.conversation();
    const first = await s.claim(row);
    const started = s.detail(
      await s.run(first.claims, 'process.start', { command: 'npm test', notify: { on: 'exit' } }),
    );
    const id = String(started.process_id);
    expect(started.watch).toMatchObject({ on: 'exit', wait_with: `process:${id}` });
    const waiting = await s.waitOn(first.claims, id);
    expect(waiting.state).toBe('waiting_for_event_or_time');

    // Running and printing: nothing it was asked about, so nothing wakes.
    const sandbox = await s.sandboxOf();
    s.computers.print(sandbox, id, 'suite 1 of 12\n');
    await s.pass();
    expect((await s.job(row.id)).state).toBe('waiting_for_event_or_time');

    s.computers.print(sandbox, id, '3 failed, 9 passed\n');
    s.computers.exit(sandbox, id, 1);
    await s.pass();
    expect((await s.job(row.id)).state).toBe('queued');
    expect(await s.wakes(row.id)).toHaveLength(1);
    const next = await s.claim(row);
    expect(next.bundle.inputs.trigger_events).toEqual([
      expect.objectContaining({
        event_name: 'process.exited',
        payload: expect.objectContaining({
          process_id: id,
          state: 'exited',
          exit_code: 1,
          tail: expect.stringContaining('3 failed, 9 passed'),
        }),
      }),
    ]);
    // One attempt to start it, one to answer: none in between.
    expect(await s.attempts(row.id)).toBe(2);
  }, 60_000);

  test('a quiet process wakes nothing, and a matching line wakes the job once a minute at most', async () => {
    const s = await setup();
    const row = await s.conversation('Watch the deploy logs');
    const first = await s.claim(row);
    const id = String(
      s.detail(
        await s.run(first.claims, 'process.start', {
          command: 'tail -f deploy.log',
          notify: { on: 'output', pattern: 'ERROR' },
        }),
      ).process_id,
    );
    await s.waitOn(first.claims, id);
    const sandbox = await s.sandboxOf();
    for (let index = 0; index < 20; index++) {
      s.computers.print(sandbox, id, `INFO step ${index} ok\n`);
      await s.pass();
      s.later(30);
    }
    // Twenty quiet passes: no delivery, no wake, no attempt.
    expect(
      await s.sql`select seq from event where payload->>'kind' = 'connector_event'
        and payload->'payload'->>'process_id' = ${id}`,
    ).toHaveLength(0);
    expect((await s.job(row.id)).state).toBe('waiting_for_event_or_time');
    expect(await s.attempts(row.id)).toBe(1);

    s.computers.print(sandbox, id, 'INFO still fine\nERROR disk full on node 2\n');
    await s.pass();
    expect((await s.job(row.id)).state).toBe('queued');
    const second = await s.claim(row);
    expect(second.bundle.inputs.trigger_events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ line: 'ERROR disk full on node 2' }),
      }),
    ]);
    await s.waitOn(second.claims, id);

    // Another match within the minute is held back, then covered by one wake.
    s.computers.print(sandbox, id, 'ERROR disk full on node 3\nERROR disk full on node 4\n');
    await s.pass();
    s.later(30);
    await s.pass();
    expect((await s.job(row.id)).state).toBe('waiting_for_event_or_time');
    s.later(31);
    await s.pass();
    expect((await s.job(row.id)).state).toBe('queued');
    const third = await s.claim(row);
    expect(third.bundle.inputs.trigger_events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ line: 'ERROR disk full on node 3' }),
      }),
    ]);
    await s.waitOn(third.claims, id);
    s.later(120);
    await s.pass();
    // Node 4's line was covered by that wake: nothing new, nothing more.
    expect((await s.job(row.id)).state).toBe('waiting_for_event_or_time');
    expect(await s.attempts(row.id)).toBe(3);
  }, 60_000);

  test('a listening port is reported once', async () => {
    const s = await setup();
    const row = await s.conversation('Start the dev server');
    const first = await s.claim(row);
    const id = String(
      s.detail(
        await s.run(first.claims, 'process.start', {
          command: 'npm run dev',
          port: 5173,
          notify: { on: 'listening' },
        }),
      ).process_id,
    );
    await s.waitOn(first.claims, id);
    const sandbox = await s.sandboxOf();
    await s.pass();
    expect((await s.job(row.id)).state).toBe('waiting_for_event_or_time');
    // Another port is not the one it declared.
    s.computers.listen(sandbox, id, 24678);
    await s.pass();
    expect((await s.job(row.id)).state).toBe('waiting_for_event_or_time');
    s.computers.listen(sandbox, id, 5173);
    await s.pass();
    expect((await s.job(row.id)).state).toBe('queued');
    const second = await s.claim(row);
    expect(second.bundle.inputs.trigger_events).toEqual([
      expect.objectContaining({
        event_name: 'process.listening',
        payload: expect.objectContaining({ process_id: id, port: 5173 }),
      }),
    ]);
    await s.waitOn(second.claims, id);
    s.later(300);
    await s.pass();
    await s.pass();
    expect((await s.job(row.id)).state).toBe('waiting_for_event_or_time');
    expect(
      await s.sql`select seq from event where payload->>'kind' = 'connector_event'
        and payload->>'event_name' = 'process.listening'`,
    ).toHaveLength(1);
  }, 60_000);

  test('a process trigger disappears when its process ends', async () => {
    const s = await setup();
    const row = await s.conversation();
    const first = await s.claim(row);
    const exitWatched = String(
      s.detail(
        await s.run(first.claims, 'process.start', { command: 'make', notify: { on: 'exit' } }),
      ).process_id,
    );
    const lineWatched = String(
      s.detail(
        await s.run(first.claims, 'process.start', {
          command: 'serve',
          notify: { on: 'output', pattern: 'READY' },
        }),
      ).process_id,
    );
    expect(await s.watchesOf(row.id)).toHaveLength(2);
    const sandbox = await s.sandboxOf();

    // It ends while the attempt that watches it still runs: the watch stays,
    // so the wait the attempt then asks for fires at once.
    s.computers.exit(sandbox, exitWatched, 0);
    await s.pass();
    expect(await s.watchesOf(row.id)).toHaveLength(2);
    const waited = await s.waitOn(first.claims, exitWatched);
    expect(waited.state).toBe('queued');
    await s.pass();
    expect(await s.watchesOf(row.id)).toHaveLength(1);

    // A line it waits for never comes: the job is woken with how it ended.
    const second = await s.claim(row);
    await s.waitOn(second.claims, lineWatched);
    s.computers.print(sandbox, lineWatched, 'listening failed: address in use\n');
    s.computers.exit(sandbox, lineWatched, 1);
    await s.pass();
    expect((await s.job(row.id)).state).toBe('queued');
    const third = await s.claim(row);
    expect(third.bundle.inputs.trigger_events).toEqual([
      expect.objectContaining({
        kind: 'operation_event',
        event_name: 'process.ended',
        payload: expect.objectContaining({ process_id: lineWatched, exit_code: 1 }),
      }),
    ]);
    expect(await s.watchesOf(row.id)).toHaveLength(0);
    // Waiting on it now is refused in plain words, rather than waiting forever.
    expect(
      await requestRuntimeWait(
        s.sql,
        { ...third.claims, scopes: [...third.claims.scopes, 'job.wait'] },
        { kind: 'event', event_name: `process:${lineWatched}` },
      ).catch((error: Error) => error.message),
    ).toContain('already ended');
  }, 60_000);

  test('a job watches at most four processes at once, and the same watch twice is one watch', async () => {
    const s = await setup();
    const row = await s.conversation();
    const first = await s.claim(row);
    const ids: string[] = [];
    for (let index = 0; index < 5; index++)
      ids.push(
        String(
          s.detail(await s.run(first.claims, 'process.start', { command: `job ${index}` }))
            .process_id,
        ),
      );
    for (const id of ids.slice(0, 4))
      s.detail(
        await s.run(first.claims, 'process.wait', { process_id: id, until: 'exit', later: true }),
      );
    const again = s.detail(
      await s.run(first.claims, 'process.wait', { process_id: ids[0], until: 'exit', later: true }),
    );
    expect(await s.watchesOf(row.id)).toHaveLength(4);
    expect((again.watch as { trigger_id: string }).trigger_id).toBe(
      String((await s.watchesOf(row.id))[0]?.id),
    );
    const fifth = await s.run(first.claims, 'process.wait', {
      process_id: ids[4],
      until: 'exit',
      later: true,
    });
    expect(fifth).toMatchObject({ outcome: 'failed' });
    expect(JSON.stringify(fifth)).toContain('already watches 4 processes');
    // A watch on a process that has ended makes nothing to wait for.
    const sandbox = await s.sandboxOf();
    s.computers.exit(sandbox, String(ids[4]), 0);
    await s.run(first.claims, 'process.list', {});
    const ended = await s.run(first.claims, 'process.wait', {
      process_id: ids[4],
      until: 'exit',
      later: true,
    });
    expect(JSON.stringify(ended)).toContain('has ended');
  }, 60_000);

  test('process.wait returns when the line appears, or says plainly that it has not yet', async () => {
    const s = await setup();
    const row = await s.conversation();
    const first = await s.claim(row);
    const id = String(
      s.detail(await s.run(first.claims, 'process.start', { command: 'serve' })).process_id,
    );
    const sandbox = await s.sandboxOf();
    s.computers.print(sandbox, id, 'compiling\nREADY on :5173\n');
    const ready = s.detail(
      await s.run(first.claims, 'process.wait', {
        process_id: id,
        until: 'pattern',
        pattern: 'READY',
        timeout_seconds: 5,
      }),
    );
    expect(ready).toMatchObject({ met: true, line: 'READY on :5173', state: 'running' });
    const notYet = s.detail(
      await s.run(first.claims, 'process.wait', {
        process_id: id,
        until: 'exit',
        timeout_seconds: 1,
      }),
    );
    expect(notYet).toMatchObject({ met: false, state: 'running' });
    expect(String(notYet.note)).toContain('later');
    s.computers.exit(sandbox, id, 0);
    expect(
      s.detail(
        await s.run(first.claims, 'process.wait', {
          process_id: id,
          until: 'exit',
          timeout_seconds: 5,
        }),
      ),
    ).toMatchObject({ met: true, state: 'exited', exit_code: 0 });
    // Nothing is waited for longer than the limit allows.
    const tooLong = await s.run(first.claims, 'process.wait', {
      process_id: id,
      until: 'exit',
      timeout_seconds: 101,
    });
    expect(tooLong).toMatchObject({ outcome: 'failed' });
  }, 60_000);

  test('a wake on a process exit never reaches or adopts a computer while it is being suspended', async () => {
    const s = await setup();
    const row = await s.conversation();
    const first = await s.claim(row);
    const id = String(
      s.detail(
        await s.run(first.claims, 'process.start', { command: 'npm test', notify: { on: 'exit' } }),
      ).process_id,
    );
    await s.waitOn(first.claims, id);
    // The attempt ended; its computer is held for the process.
    await s.wiring.settleAttempt(first.claims.attempt_id, AbortSignal.timeout(10_000));
    const sandbox = await s.sandboxOf();
    s.computers.print(sandbox, id, 'all passed\n');
    s.computers.exit(sandbox, id, 0);
    // The service records the end, and the keep-awake pass starts suspending
    // the computer; the provider's pause is held open meanwhile.
    await s.processes.sweep(
      () =>
        new Map([
          [s.scope.connectionId, { adapter: 'fake', provider: s.provider as SandboxProvider }],
        ]),
      AbortSignal.timeout(10_000),
    );
    const pause = s.provider.pause.bind(s.provider);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const pausing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    (s.provider as SandboxProvider).pause = async (target, signal) => {
      entered();
      await gate;
      return pause(target, signal);
    };
    const sweeping = s.wiring.sweep(AbortSignal.timeout(20_000));
    await pausing;
    const calls = s.computers.calls.length;
    await s.pass();
    // Woken, without the monitor asking the computer anything while it pauses.
    expect((await s.job(row.id)).state).toBe('queued');
    expect(s.computers.calls.slice(calls)).toEqual([]);
    const woken = await s.claim(row);
    expect(woken.bundle.inputs.trigger_events).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ exit_code: 0 }) }),
    ]);
    // The woken attempt is told the computer is busy; it is not handed it.
    const early = await s.run(woken.claims, 'process.read', { process_id: id, cursor: 0 });
    expect(early).toMatchObject({ outcome: 'failed' });
    release();
    await sweeping;
    const rows = await s.sql`select status, attempt_id from sandbox_session
      where agent_id = ${s.scope.agentId} and status in ('ready', 'paused')`;
    expect([...rows]).toEqual([expect.objectContaining({ status: 'paused', attempt_id: null })]);
    // Once suspended, the woken attempt resumes the computer the ordinary way.
    const read = s.detail(await s.run(woken.claims, 'process.read', { process_id: id, cursor: 0 }));
    expect(String(read.output)).toContain('all passed');
    expect(s.provider.calls.resume).toBe(1);
  }, 60_000);
});
