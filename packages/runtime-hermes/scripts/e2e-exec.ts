/**
 * The local end-to-end for code execution: a real Hermes API server from the
 * pinned tag, the real broker, the real model gateway with its fake provider,
 * the real adapter, and a real Python subprocess started inside the cell.
 *
 * The only thing that is not real is the model, and it is fake because the
 * point is the path an execution takes to the ledger, not what a language model
 * would have written.
 *
 * There is no Docker on this machine, so the runtime is a process rather than a
 * container and `/work` is a temporary directory rather than a mount. That is
 * the one difference from production and it is the reason this script proves
 * the ledger path and not the filesystem confinement: the container's read-only
 * root and single writable mount are asserted by the isolation probe, not here.
 *
 *   bun run packages/runtime-hermes/scripts/e2e-exec.ts
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttemptBundle, RuntimeEvent } from '@melete/contracts';
import { stringify } from 'yaml';
import { createArtifactRecorder } from '../../../apps/melete/src/artifact/record.ts';
import { signCapability } from '../../../apps/melete/src/broker/capability.ts';
import { createInternalServer } from '../../../apps/melete/src/broker/internal-server.ts';
import { recordId } from '../../../apps/melete/src/broker/records.ts';
import { configuredConnectors } from '../../../apps/melete/src/connectors/configured.ts';
import { createScriptedProvider, fakeProvider } from '../../../apps/melete/src/gateway/index.ts';
import { seedJob } from '../../../apps/melete/test/helpers/broker.ts';
import { createPostgresFixture } from '../../../apps/melete/test/helpers/postgres.ts';
import { brokerParkedActions, HermesRuntimeAdapter } from '../src/adapter.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const HERMES_SRC = process.env.MELETE_HERMES_SRC ?? join(ROOT, '.hermes-src');
const PYTHON =
  process.env.MELETE_HERMES_PYTHON ?? join(ROOT, '.hermes-venv', 'Scripts', 'python.exe');
const CAPABILITY_KEY = 'e2e-capability-key-e2e-capability-key';
const APPROVAL_KEY = 'e2e-approval-key-e2e-approval-key-xx';
const API_KEY = 'e2e-api-server-key-0123456789abcdef';

const log = (line: string) => process.stdout.write(`${line}\n`);

/** The snippet the scripted model asks for. It writes the deliverable. */
const SNIPPET = [
  'import csv',
  "rows = [('desk', 60.0), ('chair', 40.0)]",
  "with open('out.csv', 'w', newline='') as handle:",
  '    writer = csv.writer(handle)',
  "    writer.writerow(['item', 'amount'])",
  '    for row in rows:',
  '        writer.writerow(row)',
  "    writer.writerow(['Total', sum(amount for _, amount in rows)])",
  "print('wrote out.csv')",
].join('\n');

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port ?? 0;
  if (port === 0) throw new Error('no port was allocated');
  server.stop(true);
  return port;
}

function hermesHome(brokerPort: number, token: string): string {
  const home = mkdtempSync(join(tmpdir(), 'melete-e2e-exec-home-'));
  mkdirSync(join(home, 'plugins'), { recursive: true });
  cpSync(
    join(ROOT, 'packages', 'runtime-hermes', 'melete_plugin'),
    join(home, 'plugins', 'melete'),
    {
      recursive: true,
    },
  );
  writeFileSync(
    join(home, 'config.yaml'),
    stringify({
      platform_toolsets: { api_server: ['melete'] },
      plugins: { enabled: ['melete'], allow_deprecated_imports: false },
      tools: { tool_search: { enabled: 'off' } },
      memory: { enabled: false },
      approvals: { unattended_mode: 'deny', timeout: 300 },
      provider: 'melete-gateway',
      model: 'scripted',
      providers: {
        'melete-gateway': {
          base_url: `http://127.0.0.1:${brokerPort}/providers/fake/v1`,
          key_env: 'MELETE_MODEL_KEY',
          default_model: 'scripted',
          extra_headers: { 'x-melete-capability': token },
        },
      },
      gateway: { platforms: { api_server: { max_concurrent_runs: 1 } } },
    }),
    'utf8',
  );
  return home;
}

function startRuntime(
  home: string,
  port: number,
  token: string,
  attemptId: string,
  jobId: string,
  workDir: string,
) {
  const lines: string[] = [];
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/_API_KEY$|^ANTHROPIC|^OPENAI|^GOOGLE|^GEMINI|^NOUS|^OPENROUTER/.test(key),
    ),
  );
  const child = spawn(PYTHON, ['-m', 'hermes_cli.main', 'gateway', 'run'], {
    cwd: HERMES_SRC,
    env: {
      ...clean,
      HERMES_HOME: home,
      HERMES_EXEC_ASK: '1',
      HERMES_ACCEPT_HOOKS: '1',
      API_SERVER_ENABLED: '1',
      API_SERVER_KEY: API_KEY,
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: String(port),
      MELETE_BROKER_URL: process.env.MELETE_BROKER_URL ?? '',
      MELETE_ATTEMPT_TOKEN: token,
      MELETE_ATTEMPT_ID: attemptId,
      MELETE_JOB_ID: jobId,
      // In the container this is the mount and the default is right. Here the
      // workspace is a temporary directory, so the cell is told where it is.
      MELETE_WORK_DIR: workDir,
      MELETE_MODEL_KEY: `melete-surrogate-${attemptId.replace(/[^A-Za-z0-9_-]/g, '')}`,
      PYTHONUNBUFFERED: '1',
    },
  });
  child.stdout.on('data', (d: Buffer) => lines.push(d.toString()));
  child.stderr.on('data', (d: Buffer) => lines.push(d.toString()));
  return { stop: () => child.kill('SIGTERM'), log: () => lines.join('') };
}

async function waitForApi(port: number, deadlineMs = 120_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/capabilities`, {
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      if (response.ok) return Date.now() - started;
    } catch {
      // not listening yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`the API server did not answer within ${deadlineMs}ms`);
}

async function main() {
  const db = await createPostgresFixture();
  if (!db) throw new Error('no database: set DATABASE_URL or install embedded-postgres');

  const brokerPort = await freePort();
  const apiPort = await freePort();
  const scopes = ['exec.run', 'exec.python', 'files.read', 'files.write', 'files.list'];
  // The gateway's estimator counts one token per UTF-8 byte of the request, so
  // the cap has to clear the whole assembled body, not just the reply.
  const { claims } = await seedJob(db.sql, {
    scopes,
    provider: 'files',
    budget: { max_output_tokens: 200_000 },
  });
  const execConnection = recordId('conn');
  await db.sql`insert into connection (id, space_id, provider, label, scopes)
    values (${execConnection}, ${claims.space_id}, 'exec', 'Cell', ${JSON.stringify(scopes)}::jsonb)`;
  const token = signCapability(claims, CAPABILITY_KEY);

  const workRoot = mkdtempSync(join(tmpdir(), 'melete-e2e-exec-work-'));
  const spacesRoot = mkdtempSync(join(tmpdir(), 'melete-e2e-exec-spaces-'));
  const workspace = join(workRoot, claims.job_id);
  mkdirSync(workspace, { recursive: true });

  const registry = await configuredConnectors({
    sql: db.sql,
    workRoot,
    spacesRoot,
    connections: [],
  });

  const internal = createInternalServer({
    sql: db.sql,
    connectors: registry,
    capabilityKey: CAPABILITY_KEY,
    approvalKey: APPROVAL_KEY,
    providers: [fakeProvider],
    defaultProvider: 'fake',
    // One turn that runs the snippet, one that reports. Nothing else is scripted.
    fake: createScriptedProvider([
      { tool: { name: 'exec.python', arguments: { code: SNIPPET }, id: 'call_exec_1' } },
      { text: 'The snippet ran and out.csv is in the workspace.' },
    ]),
  });
  await new Promise<void>((resolve) => internal.server.listen(brokerPort, '127.0.0.1', resolve));
  log(`broker + gateway on 127.0.0.1:${brokerPort}`);
  process.env.MELETE_BROKER_URL = `http://127.0.0.1:${brokerPort}`;
  void createArtifactRecorder;

  const bundle: AttemptBundle = {
    attempt: {
      id: claims.attempt_id,
      job_id: claims.job_id,
      epoch: claims.epoch,
      revision: claims.revision,
      token,
    },
    job: {
      title: 'Produce the expense table',
      objective: 'Run a snippet that writes out.csv, then report.',
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
      deliverable: {},
    },
    inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
    transcript: [],
    tools: [],
    skills: [],
    knowledge: [],
    workspace: { mount: '/work', files: [] },
    budget: { max_turns: 4, max_output_tokens: 2000, max_wall_ms: 120_000, max_actions: 4 },
    model: { provider: 'fake', model: 'scripted', fallback: null },
  };

  const events: RuntimeEvent[] = [];
  const sink = { emit: async (event: RuntimeEvent) => void events.push(event) };
  const adapter = new HermesRuntimeAdapter({
    baseUrl: `http://127.0.0.1:${apiPort}`,
    token: API_KEY,
    parkedActions: brokerParkedActions({
      brokerUrl: `http://127.0.0.1:${brokerPort}`,
      serviceKey: APPROVAL_KEY,
      spaceId: claims.space_id,
    }),
  });

  const home = hermesHome(brokerPort, token);
  const runtime = startRuntime(home, apiPort, token, claims.attempt_id, claims.job_id, workspace);
  try {
    log(`cold start: ${await waitForApi(apiPort)} ms`);
    const outcome = await adapter.start(bundle, sink, new AbortController().signal);
    log(`outcome: ${JSON.stringify(outcome)}`);
    log(`events: ${events.map((e) => e.type).join(', ')}`);

    const actions = await db.sql`select id, kind, status, effect_class, receipt from action
      where job_id = ${claims.job_id} order by created_at`;
    log(`actions: ${JSON.stringify(actions.map(({ receipt: _r, ...rest }) => rest))}`);
    const execution = actions.find((row) => row.kind === 'exec.python');
    if (!execution) throw new Error('the ledger has no execution');
    log(`ledger receipt: ${JSON.stringify(execution.receipt?.detail)}`);
    if (execution.status !== 'succeeded')
      throw new Error(`the execution is ${execution.status}, not succeeded`);
    if (execution.effect_class !== 'write_reversible')
      throw new Error(`the execution is ${execution.effect_class}, not write_reversible`);

    const approvals = await db.sql`select count(*)::int as n from approval
      where action_id = ${execution.id}`;
    log(`approvals asked for the execution: ${approvals[0]?.n}`);
    if (approvals[0]?.n !== 0) throw new Error('an execution should not have parked for approval');

    const produced = readFileSync(join(workspace, 'out.csv'), 'utf8');
    log(`out.csv:\n${produced}`);
    if (!produced.includes('Total,100.0')) throw new Error('out.csv does not carry the total');
    log('PASS: the snippet ran in the cell and the ledger records it without approval');
  } finally {
    runtime.stop();
    writeFileSync(join(home, 'runtime.log'), runtime.log(), 'utf8');
    log(`runtime log: ${join(home, 'runtime.log')}`);
    await new Promise<void>((resolve) => internal.server.close(() => resolve()));
    await db.close();
  }
}

await main();
