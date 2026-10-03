/**
 * A background process wakes the job waiting on it, on a real Docker engine:
 * the process tools, `melete-proc` in the sandbox image, the service's own
 * handling of the attempt's end (which keeps the computer running for the
 * process), the process monitor on its own timer, and the job and trigger
 * tables.
 *
 * The job waits on `process:<id>` and the process prints its line twenty
 * seconds later. Between the wait and the wake no attempt is made, which is
 * to say no model is called: every attempt is a row, and only the one that
 * started the process exists until the line arrives.
 *
 * Runs only with `MELETE_SANDBOX_LIVE=docker`, an engine, the image built from
 * `deploy/Dockerfile.sandbox` and a Postgres in `DATABASE_URL`; the CI
 * `docker-sandbox` job has all four.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Action,
  type CapabilityClaims,
  canonicalizePayload,
  PROCESS_LIMITS,
  type WaitSpec,
} from '@melete/contracts';
import { requestRuntimeWait } from '../../broker/runtime-wait.ts';
import { createSandboxExecConnector } from '../../connectors/sandbox-exec.ts';
import type { ConnectorContext } from '../../connectors/types.ts';
import { startQueue } from '../../jobs/queue.ts';
import { AttemptRunner } from '../../jobs/runner.ts';
import { JobService } from '../../jobs/service.ts';
import { TriggerService } from '../../jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../runtime/stub.ts';
import { serviceContainerId } from '../docker-default.ts';
import { ProcessMonitor } from '../process-monitor.ts';
import { SandboxProcesses } from '../processes.ts';
import { seedSessionScope } from '../session-fixtures.ts';
import { SandboxSessions } from '../sessions.ts';
import type { SandboxProvider } from '../types.ts';
import { startSandboxes } from '../wiring.ts';
import { DOCKER_SANDBOX_DEFAULTS, DockerSandboxHost, DockerSandboxSocket } from './docker.ts';

const live = process.env.MELETE_SANDBOX_LIVE === 'docker' && Boolean(process.env.DATABASE_URL);
const socket = process.env.MELETE_DOCKER_SOCKET ?? '/var/run/docker.sock';
const image = process.env.MELETE_SANDBOX_DOCKER_IMAGE ?? 'melete-sandbox:local';
const PROJECT = `livewake${Date.now().toString(36)}`;

if (!live) {
  test.skip('docker process wakes need MELETE_SANDBOX_LIVE=docker, an engine and DATABASE_URL', () => {});
} else {
  const { testDatabase } = await import('../../../test/helpers/database.ts');
  const database = await testDatabase();
  if (!database) throw new Error('DATABASE_URL is set but no database opened');
  const sql = database.sql;
  const queue = await startQueue(database.url);
  const jobs = new JobService(database.db, queue.boss);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'docker-process-wakes-signing-key-32b',
  });
  const triggers = new TriggerService(jobs, runner);
  const selfId = serviceContainerId({ MELETE_RUNTIME_ADAPTER: 'docker' });
  const host = new DockerSandboxHost(
    {
      socket,
      project: PROJECT,
      ...DOCKER_SANDBOX_DEFAULTS,
      memoryMb: 1024,
      pids: 256,
      diskMb: 256,
      egressPort: 18_794,
      ...(selfId ? { selfId } : {}),
    },
    new DockerSandboxSocket(socket),
  );
  const provider = Object.create(host) as DockerSandboxHost;
  Object.defineProperty(provider, 'capabilities', {
    value: { ...host.capabilities, egress: ['deny_all'] },
  });

  const scope = await seedSessionScope(sql);
  await sql`update connection set provider = 'sandbox',
      scopes = '["terminal.run","process.start","process.list","process.read","process.wait"]'::jsonb
    where id = ${scope.connectionId}`;
  await sql`update agent set colour = '#336699', surface = 'rounded', eye_colour = '#111111'
    where id = ${scope.agentId}`;
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-docker-wakes-'));
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
  const wiring = startSandboxes({
    sql,
    sessions,
    providers,
    project: PROJECT,
    sweepMs: 60_000,
    processes,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  // The monitor as the service runs it: on its own timer, every five seconds on Docker.
  const monitor = new ProcessMonitor({
    sql,
    processes,
    providers,
    wakes: triggers,
    log: (line) => process.stdout.write(`${line}\n`),
  }).start();

  let step = 0;
  const run = async (claims: CapabilityClaims, kind: string, payload: Record<string, unknown>) => {
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
    await sql`update action set status = ${result.outcome === 'succeeded' ? 'succeeded' : 'failed'}
      where id = ${id}`;
    if (result.outcome !== 'succeeded') throw new Error(`${kind}: ${JSON.stringify(result)}`);
    return result.receipt.detail as Record<string, unknown>;
  };
  const attempts = async (jobId: string) =>
    Number((await sql`select count(*)::int as n from attempt where job_id = ${jobId}`)[0]?.n);

  afterAll(async () => {
    monitor.stop();
    const left = await host.reconcile(PROJECT, new Set(), AbortSignal.timeout(120_000), null);
    if (left.length) process.stdout.write(`docker process wakes: removed ${left.join(', ')}\n`);
    await host.guard.close();
    await queue.stop();
    await database.close();
  }, 180_000);

  describe('docker sandbox live: process wakes', () => {
    test('a line printed twenty seconds later wakes the waiting job, with no attempt in between', async () => {
      const created = await jobs.create({
        space_id: scope.spaceId,
        title: 'Run the slow check',
        objective: 'Run the slow check and tell me when it is ready',
      });
      await sql`update job set agent_id = ${scope.agentId} where id = ${created.id}`;
      await mkdir(path.join(workRoot, created.id), { recursive: true });
      const row = await jobs.get(created.id);
      const first = await runner.claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'created',
      });
      if (!first) throw new Error('Expected an admitted attempt');
      const started = await run(first.claims, 'process.start', {
        name: 'slow check',
        command: 'sleep 20; echo READY',
        notify: { on: 'output', pattern: '^READY$' },
      });
      process.stdout.write(`docker process wakes, started: ${JSON.stringify(started)}\n`);
      const id = String(started.process_id);
      expect(started.watch).toMatchObject({ on: 'output', wait_with: `process:${id}` });
      const asked = await requestRuntimeWait(
        sql,
        { ...first.claims, scopes: [...first.claims.scopes, 'job.wait'] },
        { kind: 'event', event_name: `process:${id}` },
      );
      const waiting = await runner.commitOutcome(first.claims, {
        kind: 'waiting_for_event_or_time',
        wait: asked.wait as WaitSpec,
      });
      expect(waiting.state).toBe('waiting_for_event_or_time');
      // The attempt is over; the service keeps the computer running for the process.
      await wiring.settleAttempt(first.claims.attempt_id, AbortSignal.timeout(120_000));
      const waitedFrom = Date.now();

      let state = waiting.state;
      while (state === 'waiting_for_event_or_time' && Date.now() - waitedFrom < 120_000) {
        await Bun.sleep(1_000);
        state = (await jobs.get(row.id)).state;
        // Nothing is spent while it waits.
        expect(await attempts(row.id)).toBe(1);
      }
      const waited = Math.round((Date.now() - waitedFrom) / 1000);
      process.stdout.write(`docker process wakes: woken after ${waited} s, state ${state}\n`);
      expect(state).toBe('queued');
      expect(waited).toBeGreaterThanOrEqual(10);
      const wakes = await sql`select payload from event where job_id = ${row.id}
        and payload->>'kind' = 'trigger_event'`;
      expect(wakes).toHaveLength(1);
      const next = await runner.claim({
        job_id: row.id,
        expected_epoch: (await jobs.get(row.id)).leaseEpoch,
        expected_version: (await jobs.get(row.id)).stateVersion,
        reason: 'event',
      });
      if (!next) throw new Error('Expected the woken attempt');
      expect(next.bundle.inputs.trigger_events).toEqual([
        expect.objectContaining({
          event_name: 'process.output',
          payload: expect.objectContaining({ process_id: id, line: 'READY' }),
        }),
      ]);
      expect(await attempts(row.id)).toBe(2);
      // The woken attempt reads the computer its process kept running.
      const listed = (await run(next.claims, 'process.list', {})).processes as Record<
        string,
        unknown
      >[];
      expect(listed.find((each) => each.process_id === id)).toMatchObject({
        state: 'exited',
        exit_code: 0,
        last_line: 'READY',
      });
      await wiring.settleAttempt(next.claims.attempt_id, AbortSignal.timeout(120_000));
    }, 300_000);
  });
}
