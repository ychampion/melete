/**
 * The local end-to-end: a real Hermes API server from the pinned tag, the real
 * broker, the real model gateway with its fake provider, and the real adapter.
 *
 * Nothing here is a mock except the model itself, and the model is fake because
 * the point is the path an effect takes, not what a language model says.
 *
 * There is no Docker on this machine, so the runtime is a process rather than a
 * container. That is the one difference from production, and it is the reason
 * the egress assertions in `conformance/scenarios/06-egress.test.ts` are
 * `test.todo`: a process on loopback has a route out that a container on the
 * internal network does not.
 *
 *   bun run packages/runtime-hermes/scripts/e2e.ts
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttemptBundle, RuntimeEvent } from '@melete/contracts';
import { stringify } from 'yaml';
import { signCapability } from '../../../apps/melete/src/broker/capability.ts';
import { createInternalServer } from '../../../apps/melete/src/broker/internal-server.ts';
import { recordId } from '../../../apps/melete/src/broker/records.ts';
import { configuredConnectors } from '../../../apps/melete/src/connectors/configured.ts';
import { fakeProvider } from '../../../apps/melete/src/gateway/index.ts';
import { seedJob } from '../../../apps/melete/test/helpers/broker.ts';
import { createPostgresFixture } from '../../../apps/melete/test/helpers/postgres.ts';
import { brokerParkedActions, HermesRuntimeAdapter } from '../src/adapter.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const HERMES_SRC = join(ROOT, '.hermes-src');
const PYTHON = join(ROOT, '.hermes-venv', 'Scripts', 'python.exe');
const CAPABILITY_KEY = 'e2e-capability-key-e2e-capability-key';
const APPROVAL_KEY = 'e2e-approval-key-e2e-approval-key-xx';
const API_KEY = 'e2e-api-server-key-0123456789abcdef';

const log = (line: string) => process.stdout.write(`${line}\n`);

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port ?? 0;
  if (port === 0) throw new Error('no port was allocated');
  server.stop(true);
  return port;
}

/** A HERMES_HOME with the thin config and the plugin, built fresh each run. */
function hermesHome(brokerPort: number, apiPort: number, token: string): string {
  const home = mkdtempSync(join(tmpdir(), 'melete-e2e-home-'));
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
      // The gateway's budget adapter allows only the provider/model recorded on
      // the attempt row, so these have to be the seeded pair, not a nice name.
      model: 'scripted',
      providers: {
        'melete-gateway': {
          base_url: `http://127.0.0.1:${brokerPort}/providers/fake/v1`,
          key_env: 'MELETE_MODEL_KEY',
          default_model: 'scripted',
          // The gateway meters per attempt, so every model request has to carry
          // the capability as well as the surrogate. The container is one
          // attempt, so a static header is the right shape; the image's
          // entrypoint writes it from MELETE_ATTEMPT_TOKEN at boot.
          extra_headers: { 'x-melete-capability': token },
        },
      },
      gateway: { platforms: { api_server: { max_concurrent_runs: 1 } } },
    }),
    'utf8',
  );
  void apiPort;
  return home;
}

type Runtime = { stop: () => void; log: () => string };

function startRuntime(
  home: string,
  port: number,
  token: string,
  attemptId: string,
  jobId: string,
): Runtime {
  const lines: string[] = [];
  // The container inherits none of the operator's provider keys; this process
  // would, and a stray GOOGLE_API_KEY silently wins the provider race.
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
      // Required, not optional: gateway/config_env.py:_api_server returns early
      // without a usable key and the platform is never enabled at all.
      API_SERVER_KEY: API_KEY,
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: String(port),
      MELETE_BROKER_URL: process.env.MELETE_BROKER_URL ?? '',
      MELETE_ATTEMPT_TOKEN: token,
      MELETE_ATTEMPT_ID: attemptId,
      MELETE_JOB_ID: jobId,
      // The surrogate is a LABEL, not the capability: the gateway matches
      // /^melete-surrogate-[A-Za-z0-9_-]+$/, and a JWT's dots fail it.
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
  const { claims, connectionId } = await seedJob(db.sql, { scopes: ['test.send', 'test.read'] });
  const token = signCapability(claims, CAPABILITY_KEY);

  const registry = await configuredConnectors({
    sql: db.sql,
    workRoot: mkdtempSync(join(tmpdir(), 'melete-e2e-work-')),
    spacesRoot: mkdtempSync(join(tmpdir(), 'melete-e2e-spaces-')),
    connections: [],
    enableTestConnector: true,
  });

  const internal = createInternalServer({
    sql: db.sql,
    connectors: registry,
    capabilityKey: CAPABILITY_KEY,
    approvalKey: APPROVAL_KEY,
    providers: [fakeProvider],
    defaultProvider: 'fake',
  });
  await new Promise<void>((resolve) => internal.server.listen(brokerPort, '127.0.0.1', resolve));
  log(`broker + gateway on 127.0.0.1:${brokerPort}`);
  process.env.MELETE_BROKER_URL = `http://127.0.0.1:${brokerPort}`;

  const home = hermesHome(brokerPort, apiPort, token);
  log(`HERMES_HOME=${home}`);

  const bundle: AttemptBundle = {
    attempt: {
      id: claims.attempt_id,
      job_id: claims.job_id,
      epoch: claims.epoch,
      revision: claims.revision,
      token,
    },
    job: {
      title: 'Send the scripted message',
      objective: 'Send one test message and report the receipt.',
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
      deliverable: {},
    },
    inputs: { new_user_messages: [], approval_results: [], trigger_events: [] },
    transcript: [],
    tools: [],
    skills: [],
    knowledge: [],
    workspace: { mount: '/work', files: [] },
    budget: { max_turns: 4, max_output_tokens: 2000, max_wall_ms: 120_000, max_actions: 2 },
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

  const runtime = startRuntime(home, apiPort, token, claims.attempt_id, claims.job_id);
  try {
    const coldStartMs = await waitForApi(apiPort);
    log(`cold start: ${coldStartMs} ms`);

    const capabilities = await adapter.capabilities();
    log(`capabilities: ${JSON.stringify(capabilities)}`);

    const outcome = await adapter.start(bundle, sink, new AbortController().signal);
    log(`outcome: ${JSON.stringify(outcome)}`);
    log(`events: ${events.map((e) => e.type).join(', ')}`);

    const actions = await db.sql`select id, kind, status, effect_class, payload_hash from action
      where attempt_id = ${claims.attempt_id} order by created_at`;
    log(`actions: ${JSON.stringify(actions.map((a) => ({ ...a, payload_hash: undefined })))}`);
    log(`connection: ${connectionId}`);

    if (outcome.kind !== 'waiting_for_approval') throw new Error('expected the job to park');
    const parked = actions[0];
    if (!parked) throw new Error('no action on the ledger');

    // --- the owner decides, through the broker's own internal route ----------
    const decision = await fetch(`http://127.0.0.1:${brokerPort}/actions/${parked.id}/approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${APPROVAL_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload_hash: parked.payload_hash }),
    });
    log(`approval: ${decision.status} ${await decision.text()}`);

    // --- the next wake is a NEW attempt on the SAME job ----------------------
    // A new attempt id, because the idempotency key is the attempt and replaying
    // the old one would hand back the finished run instead of starting work. The
    // session key stays the job id, so Hermes continues the same session.
    // One attempt per epoch, so the next wake takes the lease forward. The job
    // row moves with it or the broker fences the new attempt as stale.
    await db.sql`update job set lease_epoch = 2, state = 'running' where id = ${claims.job_id}`;
    const second =
      await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${recordId('att')}, ${claims.job_id}, 2, 'hermes', 'fake', 'scripted') returning id`;
    const secondId = String(second[0]?.id);
    const secondClaims = { ...claims, attempt_id: secondId, epoch: 2 };
    const secondToken = signCapability(secondClaims, CAPABILITY_KEY);

    runtime.stop();
    await Bun.sleep(2000);
    const runtime2 = startRuntime(
      hermesHome(brokerPort, apiPort, secondToken),
      apiPort,
      secondToken,
      secondId,
      claims.job_id,
    );
    try {
      log(`second cold start: ${await waitForApi(apiPort)} ms`);
      const resumed: RuntimeEvent[] = [];
      const outcome2 = await adapter.start(
        {
          ...bundle,
          attempt: { ...bundle.attempt, id: secondId, token: secondToken, epoch: 2 },
          inputs: {
            ...bundle.inputs,
            approval_results: [{ action_id: String(parked.id), decision: 'approved', note: null }],
          },
        },
        { emit: async (event: RuntimeEvent) => void resumed.push(event) },
        new AbortController().signal,
      );
      log(`second outcome: ${JSON.stringify(outcome2)}`);
      log(`second events: ${resumed.map((e) => e.type).join(', ')}`);
      const settled = await db.sql`select id, status, receipt is not null as has_receipt
        from action where job_id = ${claims.job_id} order by created_at`;
      log(`actions after approval: ${JSON.stringify(settled)}`);
    } finally {
      runtime2.stop();
    }
  } finally {
    runtime.stop();
    writeFileSync(join(home, 'runtime.log'), runtime.log(), 'utf8');
    log(`runtime log: ${join(home, 'runtime.log')}`);
    await new Promise<void>((resolve) => internal.server.close(() => resolve()));
    await db.close();
  }
}

await main();
