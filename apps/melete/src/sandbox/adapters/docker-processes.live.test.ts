/**
 * Background processes in a real Docker sandbox, through the whole service
 * path: the process tools on the sandbox connection, the session table, the
 * process table, `melete-proc` in the sandbox image, and the service's own
 * handling of an attempt's end, which keeps a computer with live processes
 * running and hands it to the next attempt.
 *
 * Runs only with `MELETE_SANDBOX_LIVE=docker`, an engine, the image built from
 * `deploy/Dockerfile.sandbox` and a Postgres in `DATABASE_URL`; the CI
 * `docker-sandbox` job has all four.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Action, canonicalizePayload, PROCESS_LIMITS } from '@melete/contracts';
import { createSandboxExecConnector } from '../../connectors/sandbox-exec.ts';
import type { ConnectorContext } from '../../connectors/types.ts';
import { serviceContainerId } from '../docker-default.ts';
import { sandboxLabels } from '../manifest.ts';
import { SandboxProcesses } from '../processes.ts';
import { seedSessionScope } from '../session-fixtures.ts';
import { SandboxSessions } from '../sessions.ts';
import type { SandboxProvider } from '../types.ts';
import { startSandboxes } from '../wiring.ts';
import { DOCKER_SANDBOX_DEFAULTS, DockerSandboxHost, DockerSandboxSocket } from './docker.ts';

const live = process.env.MELETE_SANDBOX_LIVE === 'docker' && Boolean(process.env.DATABASE_URL);
const socket = process.env.MELETE_DOCKER_SOCKET ?? '/var/run/docker.sock';
const image = process.env.MELETE_SANDBOX_DOCKER_IMAGE ?? 'melete-sandbox:local';
const PROJECT = `liveproc${Date.now().toString(36)}`;
/** How long the long process runs: longer than one attempt, as a test suite would. */
const RUN_SECONDS = Number(process.env.MELETE_PROCESS_LIVE_SECONDS ?? 180);

if (!live) {
  test.skip('docker process checks need MELETE_SANDBOX_LIVE=docker, an engine and DATABASE_URL', () => {});
} else {
  const { testDatabase } = await import('../../../test/helpers/database.ts');
  const database = await testDatabase();
  if (!database) throw new Error('DATABASE_URL is set but no database opened');
  const sql = database.sql;
  const api = new DockerSandboxSocket(socket);
  const selfId = serviceContainerId({ MELETE_RUNTIME_ADAPTER: 'docker' });
  const host = new DockerSandboxHost(
    {
      socket,
      project: PROJECT,
      ...DOCKER_SANDBOX_DEFAULTS,
      memoryMb: 1024,
      pids: 256,
      diskMb: 256,
      egressPort: 18_792,
      ...(selfId ? { selfId } : {}),
    },
    api,
  );
  // Only what the runner can offer: no egress.
  const provider = Object.create(host) as DockerSandboxHost;
  Object.defineProperty(provider, 'capabilities', {
    value: { ...host.capabilities, egress: ['deny_all'] },
  });

  const scope = await seedSessionScope(sql);
  await sql`update connection set provider = 'sandbox' where id = ${scope.connectionId}`;
  await sql`update job set agent_id = ${scope.agentId} where id = ${scope.jobId}`;
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-docker-processes-'));
  const sessions = new SandboxSessions(sql, {
    leaseSeconds: 600,
    workspaceRetentionSeconds: 3_600,
  });
  const processes = new SandboxProcesses(sql, {
    limits: {
      maxPerComputer: PROCESS_LIMITS.max_per_computer,
      maxPerSpace: PROCESS_LIMITS.max_per_space,
      defaultTtlMinutes: PROCESS_LIMITS.default_ttl_minutes,
      maxTtlMinutes: PROCESS_LIMITS.max_ttl_minutes,
      outputMaxBytes: 64 * 1024,
      awakeSecondsPerDay: PROCESS_LIMITS.awake_seconds_per_day,
    },
  });
  const connector = createSandboxExecConnector({
    sessions,
    provider: provider as SandboxProvider,
    config: {
      adapter: 'docker',
      image,
      egress: 'deny_all',
      persistence: 'pause',
      lifetime_seconds: 3_600,
    },
    connectionId: scope.connectionId,
    spaceId: scope.spaceId,
    project: PROJECT,
    workRoot,
    sql,
    processes,
  });
  const providers = () =>
    new Map([[scope.connectionId, { adapter: 'docker', provider: provider as SandboxProvider }]]);
  /** What the service does when an attempt ends, and on its sweep. */
  const wiring = startSandboxes({
    sql,
    sessions,
    providers,
    project: PROJECT,
    sweepMs: 60_000,
    processes,
    log: (line) => process.stdout.write(`${line}\n`),
  });

  /** A job of the agent and one attempt of it, as one conversation turn would be. */
  const turn = async (jobId?: string) => {
    const job = jobId ?? `job_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
    if (!jobId)
      await sql`insert into job (id, space_id, title, objective, agent_id)
        values (${job}, ${scope.spaceId}, 'Later', 'Run', ${scope.agentId})`;
    await mkdir(path.join(workRoot, job), { recursive: true });
    const attempt = `att_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${attempt}, ${job}, 1, 'fake', 'fake', 'scripted')`;
    let step = 0;
    const run = async (kind: string, payload: Record<string, unknown>) => {
      step += 1;
      const id = `act_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      const canonical = canonicalizePayload({ step, ...payload });
      await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key)
        values (${id}, ${job}, ${attempt}, ${scope.connectionId}, ${kind}, 'write_reversible',
          ${canonical.json}::jsonb, ${canonical.hash}, ${id})`;
      const action = {
        id,
        job_id: job,
        attempt_id: attempt,
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
        job_id: job,
        space_id: scope.spaceId,
        idempotency_key: id,
        constraints: {
          deliverable: { kind: 'none' },
          allowed_domains: [],
          public_compartment: false,
        },
      };
      const result = await connector.execute(action, ctx);
      if (result.outcome !== 'succeeded') throw new Error(`${kind}: ${JSON.stringify(result)}`);
      return result.receipt.detail as Record<string, unknown>;
    };
    /** The attempt ends, and the service settles its computer. */
    const end = () => wiring.settleAttempt(attempt, AbortSignal.timeout(120_000));
    return { run, end, attempt };
  };
  /** The agent's live session rows, oldest first. */
  const computerRows = () => sql`select id, status, attempt_id, held_by, provider_sandbox_id
    from sandbox_session where space_id = ${scope.spaceId} and agent_id = ${scope.agentId}
      and status in ('ready', 'paused') order by opened_at`;

  afterAll(async () => {
    const left = await host.reconcile(PROJECT, new Set(), AbortSignal.timeout(120_000), null);
    if (left.length) process.stdout.write(`docker processes: removed ${left.join(', ')}\n`);
    await host.guard.close();
    await database.close();
  }, 180_000);

  describe('docker sandbox live: background processes', () => {
    test(
      `a ${RUN_SECONDS}-second process started in one attempt is read and finishes in a later one`,
      async () => {
        const first = await turn(scope.jobId);
        const started = await first.run('process.start', {
          name: 'long task',
          command: `for i in $(seq 1 ${RUN_SECONDS}); do echo "tick $i"; sleep 1; done; echo finished`,
        });
        process.stdout.write(`docker processes, started: ${JSON.stringify(started)}\n`);
        expect(started.state).toBe('running');
        expect(String(started.first_output)).toContain('tick 1');
        const id = String(started.process_id);
        await first.end();
        // The process holds the computer: running, with no attempt, not suspended.
        expect([...(await computerRows())]).toEqual([
          expect.objectContaining({ status: 'ready', attempt_id: null, held_by: 'processes' }),
        ]);

        // A minute later another conversation with the same agent finds it running.
        await Bun.sleep(60_000);
        const second = await turn();
        const listed = await second.run('process.list', {});
        expect(listed.processes).toEqual([
          expect.objectContaining({ process_id: id, state: 'running' }),
        ]);
        const tail = await second.run('process.read', { process_id: id, max_bytes: 200 });
        process.stdout.write(`docker processes, a minute in: ${JSON.stringify(tail.output)}\n`);
        expect(String(tail.output)).toMatch(/tick \d+/);
        expect(tail.digest_verified).toBe(true);
        await second.end();

        // A third turn waits for the end with long reads.
        const third = await turn();
        let cursor = Number(tail.next_cursor);
        let state = 'running';
        let read: Record<string, unknown> = {};
        const deadline = Date.now() + (RUN_SECONDS + 120) * 1000;
        while (state === 'running' && Date.now() < deadline) {
          read = await third.run('process.read', {
            process_id: id,
            cursor,
            wait_seconds: 30,
            max_bytes: 65_536,
          });
          cursor = Number(read.next_cursor);
          state = String(read.state);
        }
        process.stdout.write(`docker processes, at the end: ${JSON.stringify(read)}\n`);
        // The read that saw it end may come before the row is closed; the list settles it.
        const done = (await third.run('process.list', {})).processes as Record<string, unknown>[];
        expect(done.find((each) => each.process_id === id)).toMatchObject({
          state: 'exited',
          exit_code: 0,
          last_line: 'finished',
        });
        await third.end();
        // Nothing runs in it any more, so the attempt's end suspended it.
        expect([...(await computerRows())]).toEqual([
          expect.objectContaining({ status: 'paused', held_by: null }),
        ]);
      },
      (RUN_SECONDS + 600) * 1000,
    );

    test('a stopped server records its signal, and a restart of the computer loses what ran', async () => {
      const { run, end } = await turn();
      const server = await run('process.start', {
        command: 'exec python3 -m http.server 8000 --bind 127.0.0.1',
        port: 8000,
      });
      const sleeper = await run('process.start', { command: 'sleep 3600' });
      const stopped = await run('process.stop', { process_id: server.process_id });
      expect(stopped).toMatchObject({ state: 'stopped', exit_code: 143 });
      // The container restarts under the agent: every process in it ends.
      const [session] = await sql`select provider_sandbox_id from sandbox_session
        where space_id = ${scope.spaceId} and agent_id = ${scope.agentId} and status = 'ready'`;
      await api.request('POST', `/containers/${String(session?.provider_sandbox_id)}/restart?t=1`);
      const listed = (await run('process.list', {})).processes as Record<string, unknown>[];
      expect(listed.find((each) => each.process_id === sleeper.process_id)).toMatchObject({
        state: 'lost',
      });
      await end();
      // Nothing is left to sweep.
      expect((await processes.sweep(providers, AbortSignal.timeout(60_000))).ended).toEqual([]);
    }, 300_000);

    test('a computer with a live process is neither suspended at attempt end nor idle-stopped', async () => {
      const signal = () => AbortSignal.timeout(120_000);
      const { run, end } = await turn();
      const server = await run('process.start', { command: 'exec sleep 900', name: 'server' });
      await end();
      const [held] = await computerRows();
      expect(held).toMatchObject({ status: 'ready', attempt_id: null, held_by: 'processes' });
      const kept = String(held?.provider_sandbox_id);
      // The idle stop as the service runs it, with a short idle period, asking the
      // process records which containers are in use.
      const reaper = new DockerSandboxHost(
        {
          socket,
          project: PROJECT,
          ...DOCKER_SANDBOX_DEFAULTS,
          idleSeconds: 15,
          egressPort: 18_793,
          awake: () => sessions.awakeSandboxes('docker'),
        },
        api,
      );
      // Beside it, a computer of this installation with nothing running in it.
      const quiet = await reaper.create(
        {
          image,
          egress: { kind: 'deny_all' },
          region: null,
          lifetimeSeconds: 3_600,
          idleSeconds: null,
          workdir: '/work',
          labels: sandboxLabels({
            project: PROJECT,
            space: scope.spaceId,
            session: `sbx_quiet${Date.now().toString(36)}`,
          }),
          env: {},
        },
        signal(),
      );
      expect(await reaper.reap(signal())).toEqual([]);
      await Bun.sleep(20_000);
      // Nobody ran a command in either for longer than the idle period.
      const stopped = await reaper.reap(signal());
      process.stdout.write(`docker processes, idle stop: ${JSON.stringify(stopped)}\n`);
      expect(stopped).toEqual([quiet.providerSandboxId]);
      expect(await provider.running({ ...quiet, providerSandboxId: kept }, signal())).toBe(true);

      // The next attempt takes it over, with the process still running in it.
      const next = await turn();
      const listed = await next.run('process.list', {});
      // The earlier cases' ended processes are listed after it.
      const running = (listed.processes as Record<string, unknown>[]).filter(
        (each) => each.state === 'running',
      );
      expect(running).toEqual([
        expect.objectContaining({ process_id: server.process_id, state: 'running' }),
      ]);
      expect([...(await computerRows())]).toEqual([
        expect.objectContaining({
          attempt_id: next.attempt,
          held_by: 'attempt',
          provider_sandbox_id: kept,
        }),
      ]);
      // Once nothing runs in it, its attempt's end suspends it and the idle stop may take it.
      await next.run('process.stop', { process_id: server.process_id });
      await next.end();
      expect([...(await computerRows())]).toEqual([
        expect.objectContaining({ status: 'paused', held_by: null }),
      ]);
      await Bun.sleep(20_000);
      expect(await reaper.reap(signal())).toEqual([kept]);
      await reaper.destroy(quiet, signal());
    }, 300_000);
  });
}
