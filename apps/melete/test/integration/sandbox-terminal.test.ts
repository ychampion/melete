/**
 * The engine's sandbox terminal, end to end without the engine: the plugin's
 * `SandboxTerminal` in a real Python process, talking HTTP to the real broker,
 * which admits each command, dispatches it through the `terminal.run`
 * connector into the in-memory sandbox provider and records the receipt in
 * Postgres. Nothing here reaches a provider or runs a command locally.
 *
 * The engine's own factory and terminal tool are driven against the same
 * backend by `packages/runtime-hermes/tests/test_engine_surface.py`.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SandboxConnectionConfig } from '@melete/contracts';
import { attemptEngineFeatures } from '@melete/runtime-hermes';
import { signCapability } from '../../src/broker/capability.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createExecConnector } from '../../src/connectors/exec.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createSandboxExecConnector } from '../../src/connectors/sandbox-exec.ts';
import { resolvePython } from '../../src/runtime/python.ts';
import { FakeSandboxEngine, FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { SandboxSessions } from '../../src/sandbox/sessions.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const db = await testDatabase();
const databaseTest = db ? test : test.skip;
afterAll(async () => {
  await db?.close();
}, 15_000);

/**
 * One engine for every test in this file: sandbox ids are unique per adapter
 * in the session table, and a fresh engine would number from one again.
 */
const engine = new FakeSandboxEngine();
const CAPABILITY_KEY = 'test-terminal-capability-key-00000000';
const config: SandboxConnectionConfig = {
  adapter: 'e2b',
  image: 'base',
  egress: 'deny_all',
  persistence: 'ephemeral',
  lifetime_seconds: 600,
};

/** What the engine's terminal would pass to `execute()` for one command. */
type Command = { command: string; cwd?: string; timeout?: number };
type Result = { output: string; returncode: number };

const SCRIPT = [
  'import json, os, sys',
  "sys.path.insert(0, os.environ['PLUGIN_ROOT'])",
  'from melete_plugin.broker import BrokerClient',
  'from melete_plugin.terminal_backend import SandboxTerminal',
  "terminal = SandboxTerminal(BrokerClient(), os.environ['CONNECTION'])",
  "commands = json.loads(os.environ['COMMANDS'])",
  "print(json.dumps([terminal.run(c['command'], c.get('cwd', '/work'), c.get('timeout')) for c in commands]))",
].join('\n');

async function setup() {
  if (!db) throw new Error('Postgres unavailable');
  const seed = await seedJob(db.sql, {
    provider: 'sandbox',
    scopes: ['terminal.run', 'exec.run'],
  });
  const workRoot = await mkdtemp(join(tmpdir(), 'melete-terminal-'));
  await mkdir(join(workRoot, seed.claims.job_id), { recursive: true });
  // The cell's own exec connection in the same space: the one-backend rule
  // leaves it out of the catalog while the sandbox is there.
  const execConnection = recordId('conn');
  await db.sql`insert into connection (id, space_id, provider, label, scopes)
    values (${execConnection}, ${seed.claims.space_id}, 'exec', 'Cell',
      ${JSON.stringify(['exec.run'])}::jsonb)`;
  const provider = new FakeSandboxProvider({ engine });
  const connector = createSandboxExecConnector({
    sessions: new SandboxSessions(db.sql, { leaseSeconds: 300, workspaceRetentionSeconds: 3_600 }),
    provider,
    config,
    connectionId: seed.connectionId,
    spaceId: seed.claims.space_id,
    project: 'sandbox-terminal-test',
    workRoot,
    sql: db.sql,
  });
  const broker = new BrokerService({
    sql: db.sql,
    connectors: new ConnectorRegistry()
      .register(seed.connectionId, connector)
      .register(execConnection, createExecConnector({ workRoot })),
  });
  const app = createBrokerApp({
    broker,
    capabilityKey: CAPABILITY_KEY,
    approvalKey: 'test-terminal-approval-key-0000000000',
  });
  /** Set to lose the next answer after the broker has already run the command. */
  const lose = { next: false };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const answer = await app.fetch(request);
      if (lose.next && request.method === 'POST') {
        lose.next = false;
        return new Response('the connection dropped', { status: 502 });
      }
      return answer;
    },
  });
  const run = async (commands: Command[]): Promise<Result[]> => {
    const child = Bun.spawn([resolvePython(), '-c', SCRIPT], {
      env: {
        ...Bun.env,
        PLUGIN_ROOT: resolve('packages/runtime-hermes'),
        CONNECTION: seed.connectionId,
        COMMANDS: JSON.stringify(commands),
        MELETE_JOB_ID: seed.claims.job_id,
        MELETE_BROKER_URL: `http://127.0.0.1:${server.port}`,
        MELETE_ATTEMPT_TOKEN: signCapability(seed.claims, CAPABILITY_KEY),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, errors] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if ((await child.exited) !== 0) throw new Error(errors);
    return JSON.parse(output) as Result[];
  };
  const actions = async () =>
    db.sql`select id, status, canonical_payload, receipt from action
      where job_id = ${seed.claims.job_id} and kind = 'terminal.run' order by created_at`;
  return { ...seed, provider, broker, server, run, actions, lose, workRoot, sql: db.sql };
}

databaseTest(
  "a space's sandbox is the attempt's only terminal, and commands run there through the broker",
  async () => {
    const s = await setup();
    try {
      const catalog = await s.broker.catalog(s.claims);
      const names = catalog.map((tool) => tool.name);
      expect(names).toContain('terminal.run');
      expect(names).not.toContain('exec.run');
      // The launcher selects the engine's terminal from this very catalog.
      expect(attemptEngineFeatures(catalog)).toEqual({
        toolsets: ['melete', 'terminal'],
        terminalBackend: 'melete_sandbox',
      });

      const results = await s.run([
        { command: "printf 'hello from the sandbox'" },
        { command: 'mkdir -p /work/src && printf made > /work/src/made.txt' },
        { command: 'cat made.txt', cwd: '/work/src' },
        { command: 'false' },
        { command: 'printf again' },
        { command: 'printf again' },
      ]);
      expect(results.map((result) => result.returncode)).toEqual([0, 0, 0, 1, 0, 0]);
      expect(results[0]?.output).toBe('hello from the sandbox');
      expect(results[2]?.output).toBe('made');
      expect(results[5]?.output).toBe('again');

      // One broker action per command, the identical pair included, each
      // succeeded with its output on the stored receipt, and one sandbox.
      const recorded = await s.actions();
      expect(recorded).toHaveLength(6);
      expect(recorded.every((row) => row.status === 'succeeded')).toBe(true);
      expect(recorded[2]?.canonical_payload).toMatchObject({ cwd: 'src', command: 'cat made.txt' });
      expect(recorded[4]?.canonical_payload.run).not.toBe(recorded[5]?.canonical_payload.run);
      expect(recorded[0]?.receipt.detail.output).toBe('hello from the sandbox');
      expect(s.provider.calls.exec).toBe(6);
      expect(s.provider.calls.create).toBe(1);
    } finally {
      s.server.stop(true);
    }
  },
  120_000,
);

databaseTest(
  'a timeout, a large output and a binary output each come back as the broker recorded them',
  async () => {
    const s = await setup();
    try {
      const work = join(s.workRoot, s.claims.job_id);
      await Bun.write(join(work, 'big.txt'), 'x'.repeat(70_000));
      await Bun.write(join(work, 'blob.bin'), new Uint8Array([0x41, 0x00, 0xff, 0x42]));
      const [slow, big, blob] = await s.run([
        { command: 'sleep 5', timeout: 1 },
        { command: 'cat /work/big.txt' },
        { command: 'cat /work/blob.bin' },
      ]);
      expect(slow?.returncode).toBe(124);
      expect(slow?.output).toContain('[Command timed out');
      expect(big?.returncode).toBe(0);
      expect(big?.output.startsWith('x'.repeat(16_384))).toBe(true);
      expect(big?.output).toContain('[output truncated');
      expect(big?.output).toContain('.melete/exec/');
      expect(blob?.returncode).toBe(0);
      expect(blob?.output).toContain('[binary output');
      // The binary receipt reached Postgres, which refuses a NUL in JSON text.
      const recorded = await s.actions();
      expect(recorded.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(recorded[0]?.receipt.detail.timed_out).toBe(true);
      expect(recorded[2]?.receipt.detail.output_binary).toBe(true);
    } finally {
      s.server.stop(true);
    }
  },
  120_000,
);

databaseTest(
  'a lost acknowledgement is unknown to the engine and the command is never sent again',
  async () => {
    const s = await setup();
    try {
      // Lost between the broker and the cell, after the broker ran it.
      s.lose.next = true;
      const [inTransit] = await s.run([{ command: "printf 'ran once'" }]);
      expect(inTransit?.output).toStartWith('[outcome unknown]');
      expect(inTransit?.returncode).not.toBe(0);
      expect(s.provider.calls.exec).toBe(1);

      // Lost between the broker and the sandbox, after the command started.
      s.provider.loseNextAcknowledgement('after_start');
      const [inSandbox] = await s.run([{ command: 'sleep 1' }]);
      expect(inSandbox?.output).toStartWith('[outcome unknown');
      expect(inSandbox?.returncode).not.toBe(0);
      expect(s.provider.calls.exec).toBe(2);

      const recorded = await s.actions();
      expect(recorded).toHaveLength(2);
      // The broker's own record says the first ran; the cell was told only
      // that it cannot say, and sent nothing more.
      expect(recorded[0]?.status).toBe('succeeded');
      expect(recorded[1]?.status).toBe('unknown');
      const [job] = await s.sql`select state from job where id = ${s.claims.job_id}`;
      expect(job?.state).toBe('needs_reconciliation');
    } finally {
      s.server.stop(true);
    }
  },
  120_000,
);
