/**
 * The process tools on the sandbox connection, against the in-memory fake
 * provider, a real session and process table, and an in-memory stand-in for
 * the helper inside the computer. The helper itself is tested in
 * `sandbox/process-helper.test.ts`; here the question is what the service
 * records, refuses and ends.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Action, canonicalizePayload, type SandboxConnectionConfig } from '@melete/contracts';
import { testDatabase } from '../../test/helpers/database.ts';
import type { EgressAttribution } from '../egress/tokens.ts';
import { awakeAllowanceNote } from '../experience/events.ts';
import { PostgresComputerControls } from '../sandbox/computer-control.ts';
import { FakeSandboxEngine, FakeSandboxProvider } from '../sandbox/fake.ts';
import { FakeComputers } from '../sandbox/process-fixtures.ts';
import { ProcessHelperLost } from '../sandbox/process-helper.ts';
import { END_REASONS, type ProcessLimits, SandboxProcesses } from '../sandbox/processes.ts';
import { seedSessionScope, sessionSpec } from '../sandbox/session-fixtures.ts';
import { SandboxSessions, secondsByDay } from '../sandbox/sessions.ts';
import type { SandboxCapabilities, SandboxProvider } from '../sandbox/types.ts';
import { startSandboxes } from '../sandbox/wiring.ts';
import { createSandboxExecConnector, sandboxDispatchBudgetMs } from './sandbox-exec.ts';
import { CommandYields, commandYields } from './sandbox-yield.ts';
import type { ConnectorContext } from './types.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const encode = (value: string) => new TextEncoder().encode(value);

const LIMITS: ProcessLimits = {
  maxPerComputer: 4,
  maxPerSpace: 8,
  defaultTtlMinutes: 120,
  maxTtlMinutes: 720,
  outputMaxBytes: 8 * 1024 * 1024,
  awakeSecondsPerDay: 6 * 3600,
};

const config: SandboxConnectionConfig = {
  adapter: 'e2b',
  image: 'base',
  egress: 'deny_all',
  persistence: 'pause',
  lifetime_seconds: 600,
};

let workRoot = '';
beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
  workRoot = await mkdtemp(path.join(tmpdir(), 'melete-sandbox-process-'));
});
afterAll(async () => {
  await handle?.close();
}, 30_000);

test('awake time is split at each UTC midnight', () => {
  const midnight = Date.parse('2026-10-02T00:00:00Z');
  expect([...secondsByDay(midnight - 90_000, midnight + 30_000)]).toEqual([
    ['2026-10-01', 90],
    ['2026-10-02', 30],
  ]);
  expect([...secondsByDay(midnight, midnight)]).toEqual([]);
  expect([...secondsByDay(midnight - 86_400_000 - 1000, midnight + 1000)]).toEqual([
    ['2026-09-30', 1],
    ['2026-10-01', 86_400],
    ['2026-10-02', 1],
  ]);
});

test('the notice for a stopped allowance says how much and when, in plain words', () => {
  expect(
    awakeAllowanceNote({ allowance_seconds: 21_600, stopped_at: '2026-10-02T14:02:31.000Z' }),
  ).toBe(
    "Your computer's awake time for today is used up (6 of 6 hours). Processes stopped at 14:02 UTC.",
  );
  expect(awakeAllowanceNote({})).toBe(
    "Your computer's awake time for today is used up. Processes stopped.",
  );
});

test('a process action may take its wait, the wait for the computer and the session margin', () => {
  const read = sandboxDispatchBudgetMs({
    kind: 'process.read',
    canonical_payload: { step: 1, process_id: 'prc_X', wait_seconds: 30 },
  } as never);
  const list = sandboxDispatchBudgetMs({
    kind: 'process.list',
    canonical_payload: { step: 1 },
  } as never);
  expect(read - list).toBe(0);
  expect(read).toBeGreaterThan(30_000 + 60_000);
});

withDb('background processes in the agent computer', () => {
  const db = () => {
    if (!handle) throw new Error('Postgres is unavailable');
    return handle.sql;
  };
  const setup = async (
    over: {
      limits?: Partial<ProcessLimits>;
      persistence?: SandboxConnectionConfig['persistence'];
      engine?: FakeSandboxEngine;
      computers?: FakeComputers;
      capabilities?: Partial<SandboxCapabilities>;
      /** Processes run their commands for real, in the fake provider's shell. */
      runCommands?: boolean;
      /** A connection with no background processes, where every command runs as it always did. */
      noProcesses?: boolean;
      egress?: SandboxConnectionConfig['egress'];
    } = {},
  ) => {
    if (!handle) throw new Error('Postgres is unavailable');
    const scope = await seedSessionScope(handle.sql);
    await handle.sql`update connection set provider = 'sandbox',
        scopes = '["terminal.run","process.start"]'::jsonb
      where id = ${scope.connectionId}`;
    await handle.sql`update job set agent_id = ${scope.agentId} where id = ${scope.jobId}`;
    const provider = new FakeSandboxProvider({
      ...(over.engine ? { engine: over.engine } : {}),
      ...(over.capabilities ? { capabilities: over.capabilities } : {}),
    });
    const sessions = new SandboxSessions(handle.sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 3_600,
    });
    const computers =
      over.computers ?? new FakeComputers(over.runCommands ? { run: provider } : {});
    const processes = new SandboxProcesses(handle.sql, {
      limits: { ...LIMITS, ...over.limits },
      computerFor: (provider, target) => computers.computerFor(provider, target),
      log: () => {},
    });
    const connector = createSandboxExecConnector({
      sessions,
      provider,
      config: {
        ...config,
        ...(over.persistence ? { persistence: over.persistence } : {}),
        ...(over.egress ? { egress: over.egress } : {}),
      },
      connectionId: scope.connectionId,
      spaceId: scope.spaceId,
      project: 'sandbox-process-test',
      workRoot,
      sql: handle.sql,
      ...(over.noProcesses ? {} : { processes }),
      workspaceWaitMs: 0,
    });
    /** Another job of the same agent, as a later conversation would be. */
    const job = async (agentId: string | null = scope.agentId, title = 'Later job') => {
      const id = `job_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      await handle.sql`insert into job (id, space_id, title, objective, agent_id)
        values (${id}, ${scope.spaceId}, ${title}, 'Run', ${agentId})`;
      await mkdir(path.join(workRoot, id), { recursive: true });
      return id;
    };
    const attempt = async (jobId: string) => {
      const id = `att_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      await handle.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${id}, ${jobId},
          (select coalesce(max(epoch), 0) + 1 from attempt where job_id = ${jobId}),
          'fake', 'fake', 'scripted')`;
      return id;
    };
    await mkdir(path.join(workRoot, scope.jobId), { recursive: true });
    const firstAttempt = await scope.attempt();
    let step = 0;
    const run = async (
      kind: string,
      payload: Record<string, unknown>,
      on: { jobId: string; attemptId: string } = { jobId: scope.jobId, attemptId: firstAttempt },
    ) => {
      step += 1;
      const id = `act_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      const canonical = canonicalizePayload({ step, ...payload });
      await handle.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key)
        values (${id}, ${on.jobId}, ${on.attemptId}, ${scope.connectionId}, ${kind},
          'write_reversible', ${canonical.json}::jsonb, ${canonical.hash}, ${id})`;
      const action: Action = {
        id,
        job_id: on.jobId,
        attempt_id: on.attemptId,
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
      };
      const ctx: ConnectorContext = {
        job_id: on.jobId,
        space_id: scope.spaceId,
        idempotency_key: id,
        constraints: {
          deliverable: { kind: 'none' },
          allowed_domains: [],
          public_compartment: false,
        },
      };
      return { action, ctx, result: await connector.execute(action, ctx) };
    };
    type Ran = Awaited<ReturnType<typeof run>>;
    const detail = (ran: Ran | Ran['result']) => {
      const result = 'result' in ran ? ran.result : ran;
      if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
      return result.receipt.detail as Record<string, unknown>;
    };
    /** The first attempt ends: its workspace is suspended, so a later job may take the computer. */
    const endFirst = async (attemptId: string = firstAttempt) => {
      const [row] = await db()`select id from sandbox_session
        where attempt_id = ${attemptId} and status = 'ready'`;
      if (row)
        await sessions.suspendWorkspace(String(row.id), provider, AbortSignal.timeout(10_000));
    };
    const providers = () =>
      new Map([[scope.connectionId, { adapter: 'fake', provider: provider as SandboxProvider }]]);
    return {
      scope,
      provider,
      sessions,
      processes,
      computers,
      connector,
      firstAttempt,
      job,
      attempt,
      run,
      detail,
      endFirst,
      providers,
    };
  };

  test('a process started in one attempt is read and stopped from a later job of the same agent', async () => {
    const { run, detail, job, attempt, sessions, provider, computers, firstAttempt } =
      await setup();
    const started = detail(await run('process.start', { command: 'npm test', name: 'tests' }));
    const id = String(started.process_id);
    expect(started).toMatchObject({
      state: 'running',
      name: 'tests',
      first_output: 'started npm test\n',
    });
    // The attempt ends; its workspace is suspended, and the process runs on.
    const [row] = await db()`select session_id from sandbox_process where id = ${id}`;
    await sessions.suspendWorkspace(String(row?.session_id), provider, AbortSignal.timeout(10_000));
    expect(firstAttempt).toBeTruthy();

    const later = await job();
    const on = { jobId: later, attemptId: await attempt(later) };
    const sandbox = [...computers.processes.keys()][0] as string;
    computers.print(sandbox, id, 'all 12 suites passed\n');
    const listed = detail(await run('process.list', {}, on));
    expect(listed.processes).toEqual([
      expect.objectContaining({
        process_id: id,
        state: 'running',
        last_line: 'all 12 suites passed',
      }),
    ]);
    const read = detail(await run('process.read', { process_id: id, cursor: 0 }, on));
    expect(read.output).toBe('started npm test\nall 12 suites passed\n');
    const stopped = detail(await run('process.stop', { process_id: id }, on));
    expect(stopped).toMatchObject({
      state: 'stopped',
      exit_code: 143,
      ended_because: 'it was stopped',
    });
    expect(computers.get(sandbox, id)?.state).toBe('exited');
  }, 60_000);

  test('starting the same command twice starts two processes', async () => {
    const { run, detail, computers } = await setup();
    const first = detail(await run('process.start', { command: 'npm run dev', port: 5173 }));
    const second = detail(await run('process.start', { command: 'npm run dev', port: 5173 }));
    expect(first.process_id).not.toBe(second.process_id);
    expect(computers.all().map((each) => each.command)).toEqual(['npm run dev', 'npm run dev']);
    const rows = await db()`select state, port from sandbox_process order by created_at`;
    expect(rows.map((row) => [row.state, row.port])).toEqual([
      ['running', 5173],
      ['running', 5173],
    ]);
  }, 60_000);

  test('a start dispatched again is the same process, and nothing new runs', async () => {
    const { run, detail, connector, computers, scope } = await setup();
    const { action, result } = await run('process.start', { command: 'sleep 600' });
    const first = detail(result);
    const ctx: ConnectorContext = {
      job_id: action.job_id,
      space_id: scope.spaceId,
      idempotency_key: action.id,
      constraints: {
        deliverable: { kind: 'none' },
        allowed_domains: [],
        public_compartment: false,
      },
    };
    const again = await connector.execute(action, ctx);
    expect(detail(again).process_id).toBe(first.process_id);
    expect(computers.all()).toHaveLength(1);
    // A verify after a lost answer reads the row, never starts anything.
    const verdict = await connector.verify(action, ctx);
    expect(verdict.decision).toBe('succeeded');
  }, 60_000);

  test('each read of process output is kept in the job workspace with its digest', async () => {
    const { run, detail, computers, scope } = await setup();
    const id = String(detail(await run('process.start', { command: 'make' })).process_id);
    const sandbox = [...computers.processes.keys()][0] as string;
    computers.print(sandbox, id, 'compiling\n');
    const read = detail(await run('process.read', { process_id: id, cursor: 0 }));
    const bytes = encode('started make\ncompiling\n');
    expect(read).toMatchObject({
      cursor: 0,
      next_cursor: bytes.byteLength,
      output_bytes: bytes.byteLength,
      output_digest: digest(bytes),
      output_path: `.melete/proc/${id}/0-${bytes.byteLength}.out`,
      digest_verified: true,
    });
    const kept = await readFile(path.join(workRoot, scope.jobId, String(read.output_path)));
    expect(digest(kept)).toBe(digest(bytes));
    // A read past the end, with nothing new, keeps nothing.
    const empty = detail(await run('process.read', { process_id: id, cursor: bytes.byteLength }));
    expect(empty).toMatchObject({ output_bytes: 0, output_path: null });
  }, 60_000);

  test('a fifth process on one computer is refused, and an expired one is stopped and recorded', async () => {
    const { run, detail, processes, providers, computers } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 4; index++)
      ids.push(
        String(detail(await run('process.start', { command: `worker ${index}` })).process_id),
      );
    const fifth = await run('process.start', { command: 'worker 4' });
    expect(fifth.result).toMatchObject({ outcome: 'failed', retryable: false });
    expect(fifth.result.outcome === 'failed' && fifth.result.reason).toContain(
      'already running 4 processes',
    );
    expect(computers.all()).toHaveLength(4);

    await db()`update sandbox_process set expires_at = now() - interval '1 second'
      where id = ${ids[0] as string}`;
    const swept = await processes.sweep(providers, AbortSignal.timeout(10_000));
    expect(swept.ended).toEqual([ids[0] as string]);
    const [expired] = await db()`select state, end_reason, exit_code, ended_at
      from sandbox_process where id = ${ids[0] as string}`;
    expect(expired).toMatchObject({
      state: 'expired',
      end_reason: 'its time limit passed',
      exit_code: 143,
    });
    expect(expired?.ended_at).not.toBeNull();
    expect(computers.all().find((each) => each.id === ids[0])?.state).toBe('exited');
    // Its place is free again.
    expect((await run('process.start', { command: 'worker 4' })).result.outcome).toBe('succeeded');
  }, 60_000);

  test('a space runs at most its own cap of processes across its computers', async () => {
    const { run, detail, job, attempt, scope } = await setup({ limits: { maxPerSpace: 2 } });
    detail(await run('process.start', { command: 'one' }));
    // Another agent in the same space, with its own computer.
    const other = `agent_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
    await db()`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
      values (${other}, ${scope.spaceId}, 'Other', 'helper', 'blue', 'plain', 'black', 'calm', 'help')`;
    const theirs = await job(other);
    const on = { jobId: theirs, attemptId: await attempt(theirs) };
    detail(await run('process.start', { command: 'two' }, on));
    const third = await run('process.start', { command: 'three' }, on);
    expect(third.result.outcome === 'failed' && third.result.reason).toContain(
      'This space is already running 2 processes',
    );
  }, 60_000);

  test('a computer restart marks its running processes lost', async () => {
    const { run, detail, computers } = await setup();
    const id = String(detail(await run('process.start', { command: 'serve' })).process_id);
    computers.restart([...computers.processes.keys()][0] as string);
    const listed = detail(await run('process.list', {}));
    expect(listed.processes).toEqual([
      expect.objectContaining({
        process_id: id,
        state: 'lost',
        ended_because: 'the computer restarted, which ends every process in it',
      }),
    ]);
    expect(listed.running).toBe(0);
  }, 60_000);

  test("a member's personal job cannot list or stop a room computer's processes", async () => {
    // Until rooms exist, the boundary is the computer: another agent's job,
    // in the same space, neither sees nor reaches this agent's processes.
    const { run, detail, job, attempt, scope, computers } = await setup();
    const id = String(detail(await run('process.start', { command: 'serve' })).process_id);
    const other = `agent_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
    await db()`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
      values (${other}, ${scope.spaceId}, 'Other', 'helper', 'blue', 'plain', 'black', 'calm', 'help')`;
    const theirs = await job(other);
    const on = { jobId: theirs, attemptId: await attempt(theirs) };
    expect(detail(await run('process.list', {}, on)).processes).toEqual([]);
    const stop = await run('process.stop', { process_id: id }, on);
    expect(stop.result).toMatchObject({
      outcome: 'failed',
      reason: 'There is no process with that id in this computer',
    });
    expect(computers.all()[0]?.state).toBe('running');
  }, 60_000);

  test("a job in another person's space names none of this computer's processes, and reaches none", async () => {
    // Two people, each with a personal space, an agent and a computer of their own, on one engine.
    const engine = new FakeSandboxEngine();
    const mine = await setup({ engine });
    const theirs = await setup({ engine });
    for (const [each, label] of [
      [mine, 'mine'],
      [theirs, 'theirs'],
    ] as const) {
      const person = `prn_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      await db()`insert into principal (id, email) values (${person}, ${`${label}-${person}@example.test`})`;
      await db()`update space set kind = 'personal', owner_principal_id = ${person}
        where id = ${each.scope.spaceId}`;
      await db()`update job set principal_id = ${person} where id = ${each.scope.jobId}`;
    }
    const id = String(
      mine.detail(await mine.run('process.start', { command: 'serve', ttl_minutes: 5 })).process_id,
    );
    expect(theirs.detail(await theirs.run('process.list', {})).processes).toEqual([]);
    for (const [kind, payload] of [
      ['process.read', { process_id: id, cursor: 0 }],
      ['process.write', { process_id: id, text: 'hello' }],
      ['process.signal', { process_id: id, signal: 'SIGTERM' }],
      ['process.wait', { process_id: id, until: 'exit', timeout_seconds: 1 }],
      ['process.wait', { process_id: id, until: 'exit', later: true }],
      ['process.extend', { process_id: id, ttl_minutes: 600 }],
      ['process.stop', { process_id: id }],
    ] as const) {
      const ran = await theirs.run(kind, payload);
      expect([kind, ran.result]).toEqual([
        kind,
        expect.objectContaining({
          outcome: 'failed',
          reason: 'There is no process with that id in this computer',
        }),
      ]);
    }
    // Their attempt opened no computer of mine, nor any at all, and mine runs on untouched.
    expect(theirs.computers.all()).toEqual([]);
    expect(mine.computers.all()).toHaveLength(1);
    expect(mine.computers.all()[0]?.state).toBe('running');
    expect(mine.computers.all()[0]?.input ?? '').toBe('');
    const [row] = await db()`select state, expires_at, coalesce(started_at, created_at) as began
      from sandbox_process where id = ${id}`;
    expect(row?.state).toBe('running');
    expect(
      new Date(row?.expires_at).getTime() - new Date(row?.began).getTime(),
    ).toBeLessThanOrEqual(5 * 60_000 + 1000);
    // Their own agent's computer is still theirs to use.
    expect(
      theirs.detail(await theirs.run('process.start', { command: 'theirs' })).process_id,
    ).toMatch(/^prc_/);
    expect(theirs.computers.all()).toHaveLength(1);
  }, 60_000);

  test("another person's job that started a process is not named in the list", async () => {
    const { run, detail, job, attempt, scope, endFirst } = await setup();
    const mine = String(detail(await run('process.start', { command: 'mine' })).process_id);
    await endFirst();
    const principal = `prn_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
    await db()`insert into principal (id, email) values (${principal}, ${`${principal}@example.test`})`;
    const theirs = await job(scope.agentId, 'Their private plan');
    await db()`update job set principal_id = ${principal} where id = ${theirs}`;
    const on = { jobId: theirs, attemptId: await attempt(theirs) };
    const listed = detail(await run('process.list', {}, on)).processes as Record<string, unknown>[];
    expect(listed.find((each) => each.process_id === mine)?.started_by ?? null).toBeNull();
    await endFirst(on.attemptId);
    const back = { jobId: scope.jobId, attemptId: await attempt(scope.jobId) };
    const own = detail(await run('process.list', {}, back)).processes as Record<string, unknown>[];
    expect(own.find((each) => each.process_id === mine)?.started_by).toBe('Job');
  }, 60_000);

  test('a job with no agent, or a computer made fresh each time, cannot start a process', async () => {
    const plain = await setup();
    await db()`update job set agent_id = null where id = ${plain.scope.jobId}`;
    const agentless = await plain.run('process.start', { command: 'serve' });
    expect(agentless.result.outcome === 'failed' && agentless.result.reason).toContain(
      'this job has no agent',
    );
    const fresh = await setup({ persistence: 'ephemeral' });
    const ephemeral = await fresh.run('process.start', { command: 'serve' });
    expect(ephemeral.result.outcome === 'failed' && ephemeral.result.reason).toContain(
      'made fresh for each attempt',
    );
    expect(plain.computers.all()).toEqual([]);
    expect(fresh.computers.all()).toEqual([]);
  }, 60_000);

  test('the sweep stops a process whose job was cancelled, and not one whose job completed', async () => {
    const { run, detail, processes, providers, job, attempt, endFirst } = await setup();
    const cancelled = String(detail(await run('process.start', { command: 'a' })).process_id);
    await endFirst();
    const later = await job();
    const on = { jobId: later, attemptId: await attempt(later) };
    const completed = String(detail(await run('process.start', { command: 'b' }, on)).process_id);
    await db()`update job set state = 'cancelled' where id = (select job_id from sandbox_process where id = ${cancelled})`;
    await db()`update job set state = 'completed' where id = ${later}`;
    await processes.sweep(providers, AbortSignal.timeout(10_000));
    const rows = await db()`select id, state, end_reason from sandbox_process`;
    const state = new Map(rows.map((row) => [row.id, [row.state, row.end_reason]]));
    expect(state.get(cancelled)).toEqual([
      'stopped',
      'the job that started it was cancelled or deleted',
    ]);
    expect(state.get(completed)).toEqual(['running', null]);
  }, 60_000);

  /**
   * One conversation, three turns on one computer: the first left a server
   * running and finished, a person took the computer over during the second,
   * and the third launched a browser and was stopped, as Stop ends a turn.
   */
  const threeTurns = async () => {
    const s = await setup();
    const finished = String(
      s.detail(await s.run('process.start', { command: 'serve' })).process_id,
    );
    await db()`update attempt set outcome = 'completed', ended_at = now(),
      lease_expires_at = null, lease_status = 'ended' where id = ${s.firstAttempt}`;
    await s.endFirst();
    const second = { jobId: s.scope.jobId, attemptId: await s.attempt(s.scope.jobId) };
    const takenOver = String(
      s.detail(await s.run('process.start', { command: 'watch' }, second)).process_id,
    );
    await db()`update attempt set outcome = 'fenced', ended_at = now(),
      outcome_detail = '{"kind":"computer_control","reason":"human_control"}'::jsonb,
      lease_expires_at = null, lease_status = 'ended' where id = ${second.attemptId}`;
    await s.endFirst(second.attemptId);
    const third = { jobId: s.scope.jobId, attemptId: await s.attempt(s.scope.jobId) };
    const browser = String(
      s.detail(
        await s.run('process.start', { command: 'chromium --remote-debugging-port=9222' }, third),
      ).process_id,
    );
    await db()`update attempt set outcome = 'fenced', ended_at = now(),
      outcome_detail = '{"kind":"cancelled"}'::jsonb,
      lease_expires_at = null, lease_status = 'ended' where id = ${third.attemptId}`;
    const states = async () => {
      const rows = await db()`select id, state, end_reason from sandbox_process`;
      return new Map(rows.map((row) => [String(row.id), [row.state, row.end_reason]]));
    };
    const inComputer = (id: string) => s.computers.all().find((each) => each.id === id)?.state;
    return { s, finished, takenOver, browser, states, inComputer };
  };

  test('stopping a turn ends, at once, the processes that turn started, and only those', async () => {
    const { s, finished, takenOver, browser, states, inComputer } = await threeTurns();
    const ended = await wiringFor(s).endStopped(s.scope.jobId, AbortSignal.timeout(10_000));
    expect(ended).toEqual([browser]);
    const state = await states();
    expect(state.get(browser)).toEqual(['stopped', END_REASONS.turn]);
    expect(state.get(finished)).toEqual(['running', null]);
    expect(state.get(takenOver)).toEqual(['running', null]);
    // Stopped in the computer itself, not only on its record.
    expect(inComputer(browser)).toBe('exited');
    expect(inComputer(finished)).toBe('running');
    // Nothing is left for a second stop.
    expect(await wiringFor(s).endStopped(s.scope.jobId, AbortSignal.timeout(10_000))).toEqual([]);
  }, 60_000);

  test('stopping a turn that waits on the person ends what any of its steps started', async () => {
    const s = await setup();
    const turn = async (id: string, status: string) =>
      db()`insert into experience_turn (id, job_id, agent_id, submission_id, text, status)
        values (${id}, ${s.scope.jobId}, ${s.scope.agentId}, ${`sub_${id}`}, 'Go', ${status})`;
    // An earlier turn left a server running and finished.
    await turn('turn_done', 'done');
    await db()`update attempt set turn_id = 'turn_done' where id = ${s.firstAttempt}`;
    const finished = String(
      s.detail(await s.run('process.start', { command: 'serve' })).process_id,
    );
    await db()`update attempt set outcome = 'completed', ended_at = now(),
      lease_expires_at = null, lease_status = 'ended' where id = ${s.firstAttempt}`;
    await s.endFirst();
    // The next turn launched a browser, then asked the person and waited: no
    // step of it was running when Stop was pressed.
    await turn('turn_waiting', 'running');
    const asking = { jobId: s.scope.jobId, attemptId: await s.attempt(s.scope.jobId) };
    await db()`update attempt set turn_id = 'turn_waiting' where id = ${asking.attemptId}`;
    const browser = String(
      s.detail(
        await s.run('process.start', { command: 'chromium --remote-debugging-port=9222' }, asking),
      ).process_id,
    );
    await db()`update attempt set outcome = 'waiting_for_approval', ended_at = now(),
      lease_expires_at = null, lease_status = 'ended' where id = ${asking.attemptId}`;
    await db()`update experience_turn set status = 'stopped', finished_at = now()
      where id = 'turn_waiting'`;
    expect(await wiringFor(s).endStopped(s.scope.jobId, AbortSignal.timeout(10_000))).toEqual([
      browser,
    ]);
    const rows = await db()`select id, state from sandbox_process`;
    const state = new Map(rows.map((row) => [String(row.id), String(row.state)]));
    expect(state.get(browser)).toBe('stopped');
    expect(state.get(finished)).toBe('running');
  }, 60_000);

  test('the sweep ends a process a stopped turn started, should the stop have missed it', async () => {
    const { s, finished, takenOver, browser, states, inComputer } = await threeTurns();
    await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
    const state = await states();
    expect(state.get(browser)).toEqual(['stopped', END_REASONS.turn]);
    expect(state.get(finished)).toEqual(['running', null]);
    expect(state.get(takenOver)).toEqual(['running', null]);
    expect(inComputer(browser)).toBe('exited');
  }, 60_000);

  test("revoking the computer's connection closes its processes' rows", async () => {
    const { run, detail, processes, providers, scope } = await setup();
    const id = String(detail(await run('process.start', { command: 'serve' })).process_id);
    await db()`update connection set status = 'revoked' where id = ${scope.connectionId}`;
    await processes.sweep(providers, AbortSignal.timeout(10_000));
    const [row] = await db()`select state, end_reason from sandbox_process where id = ${id}`;
    expect(row).toMatchObject({
      state: 'stopped',
      end_reason: "the computer's connection was revoked or removed",
    });
  }, 60_000);

  test('text written to a process reaches it, and a later time limit is held to the longest', async () => {
    const { run, detail, computers } = await setup();
    const id = String(
      detail(await run('process.start', { command: 'cat', ttl_minutes: 5 })).process_id,
    );
    // Admitted text is trimmed, so the line end is added after it.
    const written = detail(await run('process.write', { process_id: id, text: 'hello' }));
    expect(written).toMatchObject({ written_bytes: 6, complete: true });
    detail(await run('process.write', { process_id: id, text: 'no end', newline: false }));
    expect(computers.all()[0]?.input).toBe('hello\nno end');
    const extended = detail(await run('process.extend', { process_id: id, ttl_minutes: 720 }));
    const [row] = await db()`select expires_at, coalesce(started_at, created_at) as began
      from sandbox_process where id = ${id}`;
    const span = new Date(row?.expires_at).getTime() - new Date(row?.began).getTime();
    expect(span).toBeLessThanOrEqual(720 * 60_000 + 1000);
    expect(span).toBeGreaterThan(700 * 60_000);
    expect(extended.expires_at).toBe(new Date(row?.expires_at).toISOString());
  }, 60_000);

  test('a malformed start opens no computer', async () => {
    const { run, provider, computers } = await setup();
    const bad = await run('process.start', { command: 'x', cwd: '../../etc' });
    expect(bad.result).toMatchObject({ outcome: 'failed', retryable: false });
    expect(provider.calls.create).toBe(0);
    expect(computers.calls).toEqual([]);
  }, 60_000);

  test('a copy of a process read before it was stopped never reopens it', async () => {
    const { run, detail, processes, computers } = await setup();
    const id = String(detail(await run('process.start', { command: 'serve' })).process_id);
    // The sweep reads the row while it runs, and asks the computer.
    const stale = await processes.get(id);
    const sandbox = [...computers.processes.keys()][0] as string;
    const facts = await computers
      .computerFor(null as never, { providerSandboxId: sandbox, imageDigest: null, region: null })
      .status([id], AbortSignal.timeout(5_000));
    // Meanwhile a stop closes it.
    detail(await run('process.stop', { process_id: id }));
    if (!stale || !facts.processes[0]) throw new Error('expected a row and facts');
    const after = await processes.apply(
      stale,
      { ...facts.processes[0], state: 'running' },
      facts.boot,
    );
    expect(after).toMatchObject({ state: 'stopped', endReason: 'it was stopped' });
    expect(after.endedAt).not.toBeNull();
    const [row] =
      await db()`select state, end_reason, ended_at from sandbox_process where id = ${id}`;
    expect(row).toMatchObject({ state: 'stopped', end_reason: 'it was stopped' });
    expect(row?.ended_at).not.toBeNull();
  }, 60_000);

  test('a start whose action is still being sent is not taken for lost, however long it takes', async () => {
    const { run, detail, processes, scope, computers, firstAttempt } = await setup();
    detail(await run('process.start', { command: 'first' }));
    // A second start, admitted long ago, whose directory the computer has not made yet.
    const action = `act_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
    await db()`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, idempotency_key, status)
      values (${action}, ${scope.jobId}, ${firstAttempt}, ${scope.connectionId}, 'process.start',
        'write_reversible', '{}'::jsonb, 'hash', ${action}, 'dispatched')`;
    const id = 'prc_SLOWSTART0001';
    await db()`insert into sandbox_process (id, space_id, agent_id, connection_id, action_id,
        command_redacted, command_digest, cwd, name, state, expires_at, created_at)
      values (${id}, ${scope.spaceId}, ${scope.agentId}, ${scope.connectionId}, ${action},
        'slow', 'd', '.', 'slow', 'starting', now() + interval '1 hour', now() - interval '10 minutes')`;
    const sandbox = [...computers.processes.keys()][0] as string;
    const computer = computers.computerFor(null as never, {
      providerSandboxId: sandbox,
      imageDigest: null,
      region: null,
    });
    await processes.reconcile(scope.spaceId, scope.agentId, computer, AbortSignal.timeout(5_000));
    expect((await processes.get(id))?.state).toBe('starting');
    // Once its dispatch has settled, a start that never reached the computer is lost.
    await db()`update action set status = 'failed' where id = ${action}`;
    await processes.reconcile(scope.spaceId, scope.agentId, computer, AbortSignal.timeout(5_000));
    expect((await processes.get(id))?.state).toBe('lost');
  }, 60_000);

  test('a signal to a process that has ended is refused, and nothing is sent', async () => {
    const { run, detail, computers } = await setup();
    const id = String(detail(await run('process.start', { command: 'serve' })).process_id);
    detail(await run('process.stop', { process_id: id }));
    const before = computers.calls.length;
    const signalled = await run('process.signal', { process_id: id, signal: 'TERM' });
    expect(signalled.result).toMatchObject({ outcome: 'failed', retryable: false });
    expect(computers.calls.slice(before).filter((call) => call.startsWith('signal'))).toEqual([]);
  }, 60_000);

  test('a computer that does not answer still has its expired processes closed, without waiting on it', async () => {
    const { run, detail, processes, providers, computers } = await setup();
    const id = String(detail(await run('process.start', { command: 'serve' })).process_id);
    await db()`update sandbox_process set expires_at = now() - interval '1 second' where id = ${id}`;
    const answering = computers.computerFor;
    computers.computerFor = (provider, handle) => ({
      ...answering(provider, handle),
      status: async () => {
        throw new ProcessHelperLost('the computer took too long to answer');
      },
      // A computer that did not answer would keep a stop waiting for its whole budget.
      stop: (_id, _grace, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('no answer'))),
        ),
    });
    const began = Date.now();
    const swept = await processes.sweep(providers, AbortSignal.timeout(10_000));
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(swept.ended).toEqual([id]);
    expect((await processes.get(id))?.state).toBe('expired');
  }, 60_000);

  /** The service's own handling of attempts that end, as the boot wiring does it. */
  const wiringFor = (s: Awaited<ReturnType<typeof setup>>) =>
    startSandboxes({
      sql: db(),
      sessions: s.sessions,
      providers: s.providers,
      project: 'sandbox-process-test',
      sweepMs: 60_000,
      processes: s.processes,
      log: () => {},
    });
  const sessionRows = (agentId: string) =>
    db()`select id, status, attempt_id, held_by, provider_sandbox_id,
        lease_expires_at > now() as leased
      from sandbox_session where agent_id = ${agentId} order by opened_at, id`;

  test('a computer with a live process is neither suspended at attempt end nor idle-stopped', async () => {
    const s = await setup();
    const kept: number[] = [];
    (s.provider as SandboxProvider).keepAlive = async (_handle, seconds) => {
      kept.push(seconds);
    };
    const id = String(
      s.detail(await s.run('process.start', { command: 'npm run dev', port: 5173 })).process_id,
    );
    const wiring = wiringFor(s);
    await wiring.settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    const [held] = await sessionRows(s.scope.agentId);
    expect(held).toMatchObject({ status: 'ready', attempt_id: null, held_by: 'processes' });
    expect(s.provider.calls.pause).toBe(0);
    // A provider that ends sandboxes on its own timer is asked to keep this one.
    expect(kept).toEqual([600]);
    const sandbox = String(held?.provider_sandbox_id);
    // The idle clock is told it is in use, from the records, with nobody running commands in it.
    expect([...(await s.sessions.awakeSandboxes('fake'))]).toEqual([sandbox]);

    // Its lease runs out; the sweep keeps it for the process instead of suspending it.
    await db()`update sandbox_session set lease_expires_at = now() - interval '1 second'
      where held_by = 'processes'`;
    await wiring.sweep(AbortSignal.timeout(10_000));
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'ready', held_by: 'processes', leased: true }),
    ]);
    expect(s.provider.calls.pause).toBe(0);
    expect(kept).toEqual([600, 600]);
    // The job that opened the session is removed; another job's process still holds it.
    const other = await s.job();
    await db()`update sandbox_process set job_id = ${other} where id = ${id}`;
    await db()`update sandbox_session set job_id = null where held_by = 'processes'`;
    await wiring.sweep(AbortSignal.timeout(10_000));
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'ready', held_by: 'processes' }),
    ]);
    expect(s.provider.calls.pause).toBe(0);

    // Once the process has ended, the next pass suspends the computer.
    const process = s.computers.get(sandbox, id);
    if (process) Object.assign(process, { state: 'exited', exitCode: 0 });
    await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
    expect((await s.processes.get(id))?.state).toBe('exited');
    await wiring.sweep(AbortSignal.timeout(10_000));
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'paused', held_by: null }),
    ]);
    expect(s.provider.calls.pause).toBe(1);
    expect([...(await s.sessions.awakeSandboxes('fake'))]).toEqual([]);
  }, 60_000);

  test('the next attempt adopts a computer its processes kept awake', async () => {
    const s = await setup();
    const id = String(s.detail(await s.run('process.start', { command: 'npm test' })).process_id);
    await wiringFor(s).settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    const [held] = await sessionRows(s.scope.agentId);
    const later = await s.job();
    const on = { jobId: later, attemptId: await s.attempt(later) };
    const sandbox = String(held?.provider_sandbox_id);
    s.computers.print(sandbox, id, 'still going\n');
    const listed = s.detail(await s.run('process.list', {}, on));
    expect(listed.processes).toEqual([
      expect.objectContaining({ process_id: id, state: 'running', last_line: 'still going' }),
    ]);
    // The same running sandbox, on a new row for this attempt; nothing was resumed or made.
    const rows = await sessionRows(s.scope.agentId);
    expect([...rows]).toEqual([
      expect.objectContaining({ id: held?.id, status: 'closed', held_by: null }),
      expect.objectContaining({
        status: 'ready',
        attempt_id: on.attemptId,
        held_by: 'attempt',
        provider_sandbox_id: sandbox,
      }),
    ]);
    expect(s.provider.calls).toMatchObject({ create: 1, pause: 0, resume: 0 });
    expect(s.computers.get(sandbox, id)?.state).toBe('running');
    // And when this attempt ends, its processes hold the computer again.
    await wiringFor(s).settleAttempt(on.attemptId, AbortSignal.timeout(10_000));
    expect((await sessionRows(s.scope.agentId)).at(-1)).toMatchObject({
      status: 'ready',
      attempt_id: null,
      held_by: 'processes',
    });
  }, 60_000);

  test('a computer held by processes counts toward the concurrency limit', async () => {
    const s = await setup();
    await s.run('process.start', { command: 'serve' });
    await wiringFor(s).settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    const one = { perConnection: 1, installation: 1 };
    const specFor = sessionSpec('sandbox-process-test', s.scope.spaceId, s.scope.connectionId);
    const other = await s.job(null, 'No agent');
    const refused = await s.sessions
      .open(
        {
          connectionId: s.scope.connectionId,
          spaceId: s.scope.spaceId,
          jobId: other,
          attemptId: await s.attempt(other),
          agentId: null,
          concurrency: one,
        },
        s.provider,
        specFor,
        AbortSignal.timeout(10_000),
      )
      .catch((error: unknown) => error);
    expect(String(refused)).toContain(
      'every computer this installation runs is in use right now (1)',
    );
    // Taking the held computer over starts nothing new, so it fits.
    const later = await s.job();
    const taken = await s.sessions.openWorkspace(
      {
        connectionId: s.scope.connectionId,
        spaceId: s.scope.spaceId,
        jobId: later,
        attemptId: await s.attempt(later),
        agentId: s.scope.agentId,
        persistence: 'pause',
        concurrency: one,
      },
      s.provider,
      specFor,
      AbortSignal.timeout(10_000),
    );
    expect(taken).toMatchObject({ status: 'ready', heldBy: 'attempt', resumed: true });
    expect(s.provider.calls.create).toBe(1);
  }, 60_000);

  test("when the day's awake allowance is used, processes stop with a notice and new starts are refused", async () => {
    const s = await setup({ limits: { awakeSecondsPerDay: 2 } });
    const id = String(s.detail(await s.run('process.start', { command: 'serve' })).process_id);
    // While its attempt holds the computer, the allowance is not touched.
    expect(await s.processes.awakeSecondsToday(s.scope.spaceId)).toBe(0);
    await wiringFor(s).settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    // The process has held the computer for five seconds since.
    await db()`update sandbox_session set opened_at = opened_at - interval '5 seconds'
      where held_by = 'processes'`;
    expect(await s.processes.awakeSecondsToday(s.scope.spaceId)).toBeGreaterThanOrEqual(5);
    const later = await s.job();
    const on = { jobId: later, attemptId: await s.attempt(later) };
    const refused = await s.run('process.start', { command: 'another' }, on);
    expect(refused.result.outcome === 'failed' && refused.result.reason).toContain(
      'awake time for today is used up',
    );
    // Taking the computer over metered the held time into the day.
    const [day] = await db()`select seconds from sandbox_awake_day
      where space_id = ${s.scope.spaceId}`;
    expect(Number(day?.seconds)).toBeGreaterThanOrEqual(5);
    await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
    const [row] = await db()`select state, end_reason from sandbox_process where id = ${id}`;
    expect(row).toMatchObject({ state: 'stopped', end_reason: END_REASONS.allowance });
    expect(s.computers.all()[0]?.state).toBe('exited');
    // The conversation that started it is told, once.
    const notices = await db()`select payload from event
      where job_id = ${s.scope.jobId} and payload->>'kind' = 'processes_stopped'`;
    expect(notices.map((notice) => notice.payload)).toEqual([
      expect.objectContaining({
        reason: 'awake_allowance_used',
        allowance_seconds: 2,
        processes: [{ process_id: id, name: 'serve' }],
      }),
    ]);
    await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
    expect(
      await db()`select 1 from event
        where job_id = ${s.scope.jobId} and payload->>'kind' = 'processes_stopped'`,
    ).toHaveLength(1);
  }, 60_000);

  test('with no daily allowance set, awake time is counted but nothing is stopped or refused', async () => {
    const s = await setup({ limits: { awakeSecondsPerDay: undefined } });
    const id = String(s.detail(await s.run('process.start', { command: 'serve' })).process_id);
    await wiringFor(s).settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    await db()`update sandbox_session set opened_at = opened_at - interval '5 seconds'
      where held_by = 'processes'`;
    expect(await s.processes.awakeSecondsToday(s.scope.spaceId)).toBeGreaterThanOrEqual(5);
    const later = await s.job();
    const on = { jobId: later, attemptId: await s.attempt(later) };
    const started = await s.run('process.start', { command: 'another' }, on);
    expect(started.result.outcome).not.toBe('failed');
    const [day] = await db()`select seconds from sandbox_awake_day
      where space_id = ${s.scope.spaceId}`;
    expect(Number(day?.seconds)).toBeGreaterThanOrEqual(5);
    await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
    const [row] = await db()`select state from sandbox_process where id = ${id}`;
    expect(row?.state).toBe('running');
    expect(
      await db()`select 1 from event
        where job_id = ${s.scope.jobId} and payload->>'kind' = 'processes_stopped'`,
    ).toHaveLength(0);
  }, 60_000);

  test('where a computer cannot be kept running, its processes stop when the attempt ends, and the start says so', async () => {
    const s = await setup({ capabilities: { keepAwake: false } });
    const started = s.detail(await s.run('process.start', { command: 'serve' }));
    expect(started.keeps_running_after_this_turn).toBe(false);
    expect(String(started.note)).toContain('background processes stop when this turn ends');
    await wiringFor(s).settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    const row = await s.processes.get(String(started.process_id));
    expect(row).toMatchObject({ state: 'stopped', endReason: END_REASONS.suspended });
    expect(s.computers.all()[0]?.state).toBe('exited');
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'paused', held_by: null }),
    ]);
  }, 60_000);

  test('a computer found stopped while its processes held it has their records closed', async () => {
    const s = await setup();
    const id = String(s.detail(await s.run('process.start', { command: 'serve' })).process_id);
    await wiringFor(s).settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    const [held] = await sessionRows(s.scope.agentId);
    // Stopped outside the service: its lifetime ran out, or its host restarted.
    const sandbox = s.provider.engine.get(String(held?.provider_sandbox_id));
    if (sandbox) sandbox.state = 'paused';
    await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
    expect(await s.processes.get(id)).toMatchObject({
      state: 'lost',
      endReason: END_REASONS.computer_stopped,
    });
    // With nothing left in it, the computer is no longer held.
    await wiringFor(s).sweep(AbortSignal.timeout(10_000));
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'paused', held_by: null }),
    ]);
  }, 60_000);

  test('an attempt that ended without settling its computer leaves it held by its processes', async () => {
    const s = await setup();
    const id = String(s.detail(await s.run('process.start', { command: 'serve' })).process_id);
    // The service stopped as the attempt ended: nothing settled its computer.
    await db()`update attempt set ended_at = now() where id = ${s.firstAttempt}`;
    await wiringFor(s).sweep(AbortSignal.timeout(10_000));
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'ready', attempt_id: null, held_by: 'processes' }),
    ]);
    expect(s.provider.calls.pause).toBe(0);
    expect((await s.processes.get(id))?.state).toBe('running');
  }, 60_000);

  test('a suspend that ends processes closes their records, even when nothing stopped them first', async () => {
    const s = await setup({ capabilities: { keepAwake: false } });
    const id = String(s.detail(await s.run('process.start', { command: 'serve' })).process_id);
    await db()`update attempt set ended_at = now() where id = ${s.firstAttempt}`;
    // The sweep suspends the computer, which on this provider ends what ran in it.
    await wiringFor(s).sweep(AbortSignal.timeout(10_000));
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'paused' }),
    ]);
    await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
    expect(await s.processes.get(id)).toMatchObject({
      state: 'lost',
      endReason: END_REASONS.suspended,
    });
  }, 60_000);

  test('a computer being suspended for its ended processes is never handed to another attempt', async () => {
    const s = await setup();
    const id = String(s.detail(await s.run('process.start', { command: 'serve' })).process_id);
    const wiring = wiringFor(s);
    await wiring.settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    const [held] = await sessionRows(s.scope.agentId);
    const sandbox = String(held?.provider_sandbox_id);
    const process = s.computers.get(sandbox, id);
    if (process) Object.assign(process, { state: 'exited', exitCode: 0 });
    await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
    // The provider's pause is held open, so another attempt asks while it runs.
    const pause = s.provider.pause.bind(s.provider);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const pausing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    (s.provider as SandboxProvider).pause = async (handle, signal) => {
      entered();
      await gate;
      return pause(handle, signal);
    };
    const sweeping = wiring.sweep(AbortSignal.timeout(20_000));
    await pausing;
    const later = await s.job();
    const on = { jobId: later, attemptId: await s.attempt(later) };
    const asked = await s.run('process.list', {}, on);
    release();
    await sweeping;
    expect(asked.result.outcome).toBe('failed');
    // One row, suspended; no attempt holds a computer that was paused under it.
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'paused', held_by: null, attempt_id: null }),
    ]);
  }, 60_000);

  test('a computer a person took over is neither handed to another attempt nor suspended under them', async () => {
    const s = await setup();
    const id = String(s.detail(await s.run('process.start', { command: 'serve' })).process_id);
    const wiring = wiringFor(s);
    await wiring.settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    const [held] = await sessionRows(s.scope.agentId);
    const sandbox = String(held?.provider_sandbox_id);
    await new PostgresComputerControls(db()).change(sandbox, 'human');
    try {
      const later = await s.job();
      const on = { jobId: later, attemptId: await s.attempt(later) };
      const asked = await s.run('process.list', {}, on);
      expect(asked.result.outcome).toBe('failed');
      // Its process ends while the person drives it: it stays theirs.
      const process = s.computers.get(sandbox, id);
      if (process) Object.assign(process, { state: 'exited', exitCode: 0 });
      await s.processes.sweep(s.providers, AbortSignal.timeout(10_000));
      await db()`update sandbox_session set lease_expires_at = now() - interval '1 second'
        where held_by = 'processes'`;
      await wiring.sweep(AbortSignal.timeout(10_000));
      expect([...(await sessionRows(s.scope.agentId))]).toEqual([
        expect.objectContaining({
          id: held?.id,
          status: 'ready',
          held_by: 'processes',
          leased: true,
        }),
      ]);
      expect(s.provider.calls.pause).toBe(0);
    } finally {
      await db()`delete from sandbox_control where provider_sandbox_id = ${sandbox}`;
    }
    // Handed back, it is suspended as usual.
    await wiring.sweep(AbortSignal.timeout(10_000));
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'paused', held_by: null }),
    ]);
  }, 60_000);

  test('a held computer the provider lost is recorded lost, and uses no more awake time or place', async () => {
    const s = await setup();
    await s.run('process.start', { command: 'serve' });
    const wiring = wiringFor(s);
    await wiring.settleAttempt(s.firstAttempt, AbortSignal.timeout(10_000));
    const [held] = await sessionRows(s.scope.agentId);
    s.provider.engine.sandboxes.delete(String(held?.provider_sandbox_id));
    await wiring.sweep(AbortSignal.timeout(10_000));
    expect([...(await sessionRows(s.scope.agentId))]).toEqual([
      expect.objectContaining({ status: 'lost' }),
    ]);
    const before = await s.processes.awakeSecondsToday(s.scope.spaceId);
    await db()`update sandbox_session set opened_at = opened_at - interval '600 seconds'
      where agent_id = ${s.scope.agentId}`;
    await wiring.sweep(AbortSignal.timeout(10_000));
    expect(await s.processes.awakeSecondsToday(s.scope.spaceId)).toBeLessThan(before + 1);
  }, 60_000);
  describe('a terminal command that gives way', () => {
    const rows = (agentId: string) =>
      db()`select id, state, action_id from sandbox_process where agent_id = ${agentId}`;
    const starts = (computers: FakeComputers) =>
      computers.calls.filter((call) => call.startsWith('start')).length;

    test('a command that ends in time gives the receipt it always gave, and leaves no process', async () => {
      const plain = await setup({ noProcesses: true });
      const before = plain.detail(
        await plain.run('terminal.run', { command: 'echo hello; echo there' }),
      );
      // The same command where the computer keeps processes: run through one, waited for.
      await db()`truncate space cascade`;
      const s = await setup({ runCommands: true });
      const after = s.detail(await s.run('terminal.run', { command: 'echo hello; echo there' }));
      expect(starts(s.computers)).toBe(1);
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      for (const key of [
        'output',
        'exit_code',
        'signal',
        'timed_out',
        'stopped_by',
        'truncated',
        'output_bytes',
        'output_digest',
        'digest_verified',
      ])
        expect(after[key]).toEqual(before[key]);
      expect(after).toMatchObject({ output: 'hello\nthere\n', exit_code: 0, stopped_by: 'exit' });
      expect(after.moved_to_background).toBeUndefined();
      expect(await rows(s.scope.agentId)).toHaveLength(0);
    }, 60_000);

    test('a command still running at its wait moves to the background, with its output so far', async () => {
      const s = await setup({ runCommands: true });
      const { result } = await s.run('terminal.run', {
        command: 'echo begun; sleep 30; echo done',
        yield_after_ms: 1_000,
      });
      const moved = s.detail(result);
      const id = String(moved.process_id);
      expect(moved).toMatchObject({
        exit_code: null,
        timed_out: false,
        moved_to_background: {
          process_id: id,
          why: 'still_running',
          output_so_far: 'begun',
        },
        watch: { on: 'exit', wait_with: `process:${id}` },
        keeps_running_after_this_turn: true,
      });
      expect(
        Number((moved.moved_to_background as { elapsed_ms: number }).elapsed_ms),
      ).toBeGreaterThanOrEqual(1_000);
      expect(String(moved.next_step)).toContain('Do not run it again');
      expect([...(await rows(s.scope.agentId))]).toEqual([
        expect.objectContaining({ id, state: 'running' }),
      ]);
    }, 60_000);

    test('the same action dispatched again reads its process back and starts nothing', async () => {
      const s = await setup({ runCommands: true });
      const first = await s.run('terminal.run', {
        command: 'echo once >> runs.txt; sleep 30',
        yield_after_ms: 1_000,
      });
      const id = String(s.detail(first.result).process_id);
      const again = await s.connector.execute(first.action, first.ctx);
      expect(s.detail(again)).toMatchObject({
        process_id: id,
        moved_to_background: { process_id: id, why: 'still_running' },
      });
      // A verify reads the same process, and starts nothing either.
      const verified = await s.connector.verify?.(first.action, first.ctx);
      expect(verified).toMatchObject({ decision: 'succeeded' });
      expect(starts(s.computers)).toBe(1);
      expect(await rows(s.scope.agentId)).toHaveLength(1);
      const sandbox = [...s.computers.processes.keys()][0] as string;
      expect(
        new TextDecoder().decode(
          s.provider.engine.get(sandbox)?.fs.readFile('/work/runs.txt') ?? new Uint8Array(0),
        ),
      ).toBe('once\n');
    }, 60_000);

    test('the person speaking moves a running command to the background at once', async () => {
      const s = await setup({ runCommands: true });
      const yields = commandYields;
      const running = s.run('terminal.run', { command: 'echo working; sleep 60' });
      // Wait until the command is running as a process, then the person speaks.
      const by = Date.now() + 20_000;
      while (!(await rows(s.scope.agentId)).length && Date.now() < by) await Bun.sleep(20);
      await Bun.sleep(200);
      const spoke = Date.now();
      expect(yields.promote(s.firstAttempt)).toBe(1);
      const moved = s.detail((await running).result);
      expect(Date.now() - spoke).toBeLessThan(5_000);
      expect(moved).toMatchObject({
        moved_to_background: { why: 'person_spoke', output_so_far: 'working' },
      });
      expect(String(moved.next_step)).toContain('because the person sent a message');
      // Nothing is left waiting for that attempt.
      expect(yields.promote(s.firstAttempt)).toBe(0);
    }, 60_000);

    test('where suspending the computer ends its processes, only the person moves a command', async () => {
      const s = await setup({ runCommands: true, capabilities: { keepAwake: false } });
      const waited = s.detail(
        await s.run('terminal.run', { command: 'sleep 2; echo late', yield_after_ms: 1_000 }),
      );
      expect(waited).toMatchObject({ output: 'late\n', exit_code: 0 });
      expect(waited.moved_to_background).toBeUndefined();
      const running = s.run('terminal.run', { command: 'echo on; sleep 60' });
      const by = Date.now() + 20_000;
      while (!(await rows(s.scope.agentId)).length && Date.now() < by) await Bun.sleep(20);
      await Bun.sleep(200);
      expect(commandYields.promote(s.firstAttempt)).toBe(1);
      expect(s.detail((await running).result)).toMatchObject({
        moved_to_background: { why: 'person_spoke' },
        keeps_running_after_this_turn: false,
      });
    }, 60_000);

    test('a command past its timeout is stopped, and its receipt says the timeout stopped it', async () => {
      const s = await setup({ runCommands: true });
      const stopped = s.detail(
        await s.run('terminal.run', {
          command: 'echo start; sleep 30',
          timeout_ms: 1_500,
          yield_after_ms: 10_000,
        }),
      );
      expect(stopped).toMatchObject({ timed_out: true, stopped_by: 'timeout' });
      expect(stopped.moved_to_background).toBeUndefined();
      expect(await rows(s.scope.agentId)).toHaveLength(0);
    }, 60_000);

    /** A guard that names each command: tokens minted, and when each was settled. */
    const attribution = (provider: FakeSandboxProvider) => {
      const tokens: { actionId: string | null; deadlineAt: number; settledAt: number | null }[] =
        [];
      Object.assign(provider, {
        attributeCommand: (_handle: unknown, given: EgressAttribution) => {
          const token = {
            actionId: given.actionId,
            deadlineAt: given.deadlineAt ?? 0,
            settledAt: null as number | null,
          };
          tokens.push(token);
          return {
            env: {
              HTTPS_PROXY: 'http://cmd:t@egress:3128',
              https_proxy: 'http://cmd:t@egress:3128',
              HTTP_PROXY: 'http://cmd:t@egress:3128',
              http_proxy: 'http://cmd:t@egress:3128',
            },
            settle: () => {
              token.settledAt ??= Date.now();
              return [
                { host: 'github.com', tunnels: 1, refused: 0, bytes_up: 512, bytes_down: 4096 },
              ];
            },
          };
        },
      });
      return tokens;
    };
    const sandboxOf = (s: { computers: FakeComputers }) =>
      [...s.computers.processes.keys()][0] as string;

    test('a moved command keeps its egress token until its process ends, then settles it', async () => {
      const s = await setup({ runCommands: true, egress: 'open' });
      const tokens = attribution(s.provider);
      const moved = s.detail(
        await s.run('terminal.run', {
          command: 'echo begun; sleep 3; echo done',
          yield_after_ms: 1_000,
        }),
      );
      const id = String(moved.process_id);
      expect(moved.moved_to_background).toBeDefined();
      // Still running: its connected-account traffic still goes as this command.
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.settledAt).toBeNull();
      // Held as long as the process may run, not the five minutes of a held step.
      expect(tokens[0]?.deadlineAt ?? 0).toBeGreaterThan(Date.now() + 60 * 60_000);
      // The process ends; the next look at the computer closes its row and settles the token.
      const by = Date.now() + 20_000;
      while (s.computers.get(sandboxOf(s), id)?.state === 'running' && Date.now() < by)
        await Bun.sleep(50);
      await s.processes.reconcile(
        s.scope.spaceId,
        s.scope.agentId,
        s.computers.computerFor(s.provider, {
          providerSandboxId: sandboxOf(s),
          imageDigest: null,
          region: null,
        }),
        AbortSignal.timeout(10_000),
      );
      expect(tokens[0]?.settledAt).not.toBeNull();
      // Where it went is kept for the wake that tells of its end.
      expect(s.processes.egressSeen(id)).toEqual([
        expect.objectContaining({ host: 'github.com', bytes_up: 512 }),
      ]);
      // A command that ends in its step settles its own token as before.
      const quick = s.detail(await s.run('terminal.run', { command: 'echo quick' }));
      expect(quick.moved_to_background).toBeUndefined();
      expect(tokens[1]?.settledAt).not.toBeNull();
    }, 60_000);

    test('a command that cannot move holds the turn and its receipt says why', async () => {
      const s = await setup({ runCommands: true, limits: { maxPerComputer: 1 } });
      s.detail(await s.run('process.start', { command: 'sleep 60', name: 'server' }));
      const held = s.detail(await s.run('terminal.run', { command: 'echo held' }));
      expect(held).toMatchObject({ output: 'held\n', exit_code: 0 });
      expect(String(held.background_unavailable)).toStartWith('computer_full: ');
      // One that could move says nothing of the kind.
      await db()`truncate space cascade`;
      const free = await setup({ runCommands: true });
      const plain = free.detail(await free.run('terminal.run', { command: 'echo free' }));
      expect(plain.background_unavailable).toBeUndefined();
    }, 60_000);

    test('a computer whose processes cannot be counted starts nothing, and says so', async () => {
      const s = await setup({ runCommands: true });
      s.detail(await s.run('process.start', { command: 'sleep 60', name: 'server' }));
      const real = s.computers.computerFor.bind(s.computers);
      s.computers.computerFor = (provider, target) => ({
        ...real(provider, target),
        status: async () => {
          throw new Error('the connection to the database was reset');
        },
      });
      const { result } = await s.run('terminal.run', { command: 'echo once >> ran.txt' });
      expect(result).toMatchObject({ outcome: 'failed', retryable: true });
      expect(JSON.stringify(result)).toContain('could not be counted, so nothing was started');
      expect(s.computers.calls.filter((call) => call.startsWith('start'))).toHaveLength(1);
    }, 60_000);

    test('the same command proposed again while it runs is read back, not started again', async () => {
      const s = await setup({ runCommands: true });
      const command = 'echo once >> runs.txt; sleep 30';
      const first = s.detail(await s.run('terminal.run', { command, yield_after_ms: 1_000 }));
      const id = String(first.process_id);
      const again = s.detail(await s.run('terminal.run', { command, yield_after_ms: 1_000 }));
      expect(again).toMatchObject({
        process_id: id,
        moved_to_background: { process_id: id, already_running: true },
        watch: { on: 'exit', wait_with: `process:${id}` },
      });
      expect(String(again.next_step)).toContain('so it was not started again');
      expect(starts(s.computers)).toBe(1);
      const sandbox = sandboxOf(s);
      expect(
        new TextDecoder().decode(
          s.provider.engine.get(sandbox)?.fs.readFile('/work/runs.txt') ?? new Uint8Array(0),
        ),
      ).toBe('once\n');
      // Another command still starts.
      s.detail(await s.run('terminal.run', { command: 'echo other' }));
      expect(starts(s.computers)).toBe(2);
    }, 60_000);

    test("a moved command keeps the timeout its caller asked for as its process's limit", async () => {
      const s = await setup();
      const asked = s.detail(
        await s.run('terminal.run', {
          command: 'npm test',
          timeout_ms: 240_000,
          yield_after_ms: 1_000,
        }),
      );
      const [limited] = await db()`select expires_at from sandbox_process
        where id = ${String(asked.process_id)}`;
      const left = new Date(String(limited?.expires_at)).getTime() - Date.now();
      expect(left).toBeGreaterThan(200_000);
      expect(left).toBeLessThanOrEqual(240_000);
      expect(asked.stops_at).toBe(new Date(String(limited?.expires_at)).toISOString());
      expect(String(asked.next_step)).toContain(`It is stopped at ${String(asked.stops_at)}`);
      // None asked for: a process's default limit.
      const unasked = s.detail(
        await s.run('terminal.run', { command: 'npm run build', yield_after_ms: 1_000 }),
      );
      const [open] = await db()`select expires_at from sandbox_process
        where id = ${String(unasked.process_id)}`;
      expect(new Date(String(open?.expires_at)).getTime() - Date.now()).toBeGreaterThan(
        110 * 60_000,
      );
    }, 60_000);

    test('a command found ended at the moment it would move is settled, not moved', async () => {
      const s = await setup({ runCommands: true });
      // The computer reports the command running until the test says otherwise:
      // the last look before a move is what tells.
      let truthful = false;
      const real = s.computers.computerFor.bind(s.computers);
      s.computers.computerFor = (provider, target) => {
        const computer = real(provider, target);
        return {
          ...computer,
          status: async (ids, signal) => {
            const answer = await computer.status(ids, signal);
            return truthful
              ? answer
              : {
                  ...answer,
                  processes: answer.processes.map((facts) => ({
                    ...facts,
                    state: 'running' as const,
                    exit_code: null,
                  })),
                };
          },
        };
      };
      const running = s.run('terminal.run', {
        command: 'echo begun; sleep 2; echo done',
        yield_after_ms: 20_000,
      });
      const by = Date.now() + 20_000;
      while (!(await rows(s.scope.agentId)).length && Date.now() < by) await Bun.sleep(20);
      await Bun.sleep(4_000);
      truthful = true;
      expect(commandYields.promote(s.firstAttempt)).toBe(1);
      const settled = s.detail((await running).result);
      expect(settled.moved_to_background).toBeUndefined();
      expect(settled).toMatchObject({ output: 'begun\ndone\n', exit_code: 0 });
    }, 60_000);

    test('a move whose exit watch is refused promises no wake', async () => {
      const s = await setup({ limits: { maxPerComputer: 8 } });
      for (const name of ['a', 'b', 'c', 'd'])
        s.detail(
          await s.run('process.start', { command: `serve ${name}`, name, notify: { on: 'exit' } }),
        );
      const moved = s.detail(
        await s.run('terminal.run', { command: 'npm test', yield_after_ms: 1_000 }),
      );
      expect(moved.watch).toBeNull();
      expect(String(moved.watch_refused)).toContain('already watches 4 processes');
      const next = String(moved.next_step);
      expect(next).toContain('Nothing will wake this conversation when it ends');
      expect(next).toContain('process.wait');
      expect(next).not.toContain('this conversation is woken when it ends');
    }, 60_000);

    test('a start that never reached the computer is not read back as moved', async () => {
      const s = await setup();
      const first = await s.run('terminal.run', { command: 'npm test', yield_after_ms: 1_000 });
      const id = String(s.detail(first.result).process_id);
      // As if the service had stopped after the row was written and before the start was sent.
      await db()`update sandbox_process set state = 'starting', started_at = null where id = ${id}`;
      s.computers.processes.get(sandboxOf(s))?.delete(id);
      const verified = await s.connector.verify?.(first.action, first.ctx);
      expect(verified?.decision).not.toBe('succeeded');
      expect(JSON.stringify(verified)).not.toContain('moved_to_background');
      const [row] = await db()`select state, end_reason from sandbox_process where id = ${id}`;
      expect(row).toMatchObject({ state: 'lost', end_reason: END_REASONS.vanished });
    }, 60_000);

    test('a command asks the computer only about the processes it has rows for', async () => {
      const s = await setup({ runCommands: true });
      for (let index = 0; index < 3; index += 1)
        s.detail(await s.run('terminal.run', { command: `echo ${index}` }));
      // Each command ended in its step and left no row, so nothing asked for every process.
      expect(s.computers.calls.filter((call) => call.startsWith('status all'))).toHaveLength(0);
    }, 60_000);

    test('a registry moves only the commands of the attempt the person spoke in', () => {
      const yields = new CommandYields();
      const moved: string[] = [];
      const release = yields.hold('att_a', () => moved.push('a'));
      yields.hold('att_b', () => moved.push('b'));
      expect(yields.promote('att_a')).toBe(1);
      expect(moved).toEqual(['a']);
      release();
      expect(yields.promote('att_a')).toBe(0);
    });
  });
});
