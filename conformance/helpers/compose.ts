/** Explicit, destructive-test opt-in for an operator-owned disposable Compose stack. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JobBudget } from '@melete/contracts';
import postgres from 'postgres';
import { newId } from '../../apps/melete/src/ids.ts';
import { parseEnvFile } from '../../deploy/scripts/provider-settings.ts';

export const composeEnabled = process.env.MELETE_CONFORMANCE_COMPOSE === '1';
/** Scenario 9 needs a Docker engine and the socket, and runs inside a container of its own. */
export const dockerEnabled = process.env.MELETE_CONFORMANCE_DOCKER === '1';
export const repositoryRoot = resolve(import.meta.dir, '../..');
export const composeFile = resolve(repositoryRoot, 'deploy/docker-compose.yml');
export const apiBase = process.env.MELETE_CONFORMANCE_API ?? 'http://127.0.0.1:3101/api';

export function requireCompose() {
  if (!composeEnabled) throw new Error('Set MELETE_CONFORMANCE_COMPOSE=1 for a disposable stack.');
}

export async function docker(...args: string[]): Promise<string> {
  requireCompose();
  const process = Bun.spawn(['docker', ...args], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => process.kill(), 180_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Docker check exited ${code}: ${stderr.slice(-4000)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

export const compose = (...args: string[]) => docker('compose', '-f', composeFile, ...args);
export const serviceId = async (name: string) => {
  const id = (await compose('ps', '-q', name)).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Compose service ${name} is not running`);
  return id;
};

export async function composeEnv(): Promise<Record<string, string>> {
  return parseEnvFile(await readFile(resolve(repositoryRoot, 'deploy/.env'), 'utf8'));
}

/** Host tests use the unpublished database's Linux bridge IP, never a host port. */
export async function databaseUrl(): Promise<string> {
  const env = await composeEnv();
  if (!env.DATABASE_URL) throw new Error('deploy/.env has no DATABASE_URL');
  const inspect = JSON.parse(await docker('inspect', await serviceId('postgres')))[0] as {
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  };
  const ip = Object.values(inspect.NetworkSettings.Networks)[0]?.IPAddress;
  if (!ip) throw new Error('Compose Postgres has no network address');
  const url = new URL(env.DATABASE_URL);
  url.hostname = ip;
  return url.toString();
}

export async function sql(): Promise<postgres.Sql> {
  return postgres(await databaseUrl(), { max: 4, prepare: false, idle_timeout: 5 });
}

let cookie: Promise<string> | undefined;
async function ownerCookie(): Promise<string> {
  requireCompose();
  const statePath =
    process.env.MELETE_CONFORMANCE_STATE_FILE ??
    join(
      tmpdir(),
      `melete-compose-${createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 16)}.json`,
    );
  let credentials: { email: string; password: string };
  let createdCredentials = false;
  try {
    credentials = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    credentials = {
      email: 'compose-conformance@example.test',
      password: randomBytes(32).toString('hex'),
    };
    await writeFile(statePath, JSON.stringify(credentials), { flag: 'wx', mode: 0o600 });
    createdCredentials = true;
  }
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
    redirect: 'error' as const,
  };
  let response = await fetch(`${apiBase}/setup`, init);
  if (response.status === 409) {
    if (createdCredentials)
      throw new Error(
        `Compose already has an owner, but its saved conformance credentials were missing at ${statePath}. ` +
          'Restore the original credentials file or point MELETE_CONFORMANCE_STATE_FILE to it; ' +
          'a newly generated file cannot authenticate the existing owner.',
      );
    response = await fetch(`${apiBase}/login`, init);
    if (response.status === 401)
      throw new Error(
        `Compose owner login rejected the saved credentials at ${statePath}. ` +
          'The temporary file may have been lost and recreated, or may belong to a different stack. ' +
          'Restore the original file or point MELETE_CONFORMANCE_STATE_FILE to the matching saved credentials.',
      );
  }
  if (!response.ok) throw new Error(`Compose owner authentication answered ${response.status}`);
  const token = response.headers.get('set-cookie')?.split(';')[0];
  if (!token?.startsWith('melete_session=')) throw new Error('Owner setup returned no session');
  return token;
}

/** Send through the real web proxy, preserving the deployed session authentication. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  requireCompose();
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Use an API-relative path');
  cookie ??= ownerCookie();
  const headers = new Headers(init.headers);
  headers.set('cookie', await cookie);
  if (init.body) headers.set('content-type', 'application/json');
  return fetch(`${apiBase}${path}`, { ...init, headers, redirect: 'error' });
}

export async function ownerSpace(): Promise<string> {
  const response = await api('/spaces');
  if (!response.ok) throw new Error(`Space list answered ${response.status}`);
  const body = (await response.json()) as { spaces: { id: string; name: string }[] };
  const space = body.spaces.find((space) => space.name === 'Personal');
  if (!space) throw new Error('The conformance owner has no Personal space');
  return space.id;
}

export async function waitFor<T>(
  predicate: () => Promise<T | false | null | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs} ms`);
}

export async function waitForStack(): Promise<void> {
  await waitFor(
    async () => {
      const ids = (await compose('ps', '-q')).trim().split('\n');
      if (ids.length !== 4) return false;
      const containers = JSON.parse(await docker('inspect', ...ids)) as {
        State: { Health?: { Status: string } };
      }[];
      return containers.every((container) => container.State.Health?.Status === 'healthy');
    },
    180_000,
    'all four Compose services to become healthy',
  );
}

export async function ensureTestConnection(): Promise<{ spaceId: string; connectionId: string }> {
  const env = await composeEnv();
  if (env.MELETE_ENABLE_TEST_CONNECTOR !== 'true' || env.MELETE_ENABLE_FAKE_PROVIDER !== 'true')
    throw new Error(
      'The compose flow requires the explicitly enabled fake provider and test connector',
    );
  const spaceId = await ownerSpace();
  const db = await sql();
  let connectionId: string;
  let inserted = false;
  try {
    const [existing] =
      await db`select id from connection where space_id = ${spaceId} and provider = 'test' and status = 'active' order by id limit 1`;
    connectionId = existing?.id ?? newId('conn');
    if (!existing) {
      await db`insert into connection (id, space_id, provider, label, scopes)
        values (${connectionId}, ${spaceId}, 'test', 'Compose conformance destination', '["test.send","test.read"]'::jsonb)`;
      inserted = true;
    }
  } finally {
    await db.end();
  }
  // Connector registrations are a startup snapshot of configured connections.
  if (inserted) {
    await compose('restart', 'melete');
    await waitForStack();
  }
  return { spaceId, connectionId };
}

export type StackJob = {
  id: string;
  state: string;
  lease_epoch: number;
  revision: number;
  [key: string]: unknown;
};
export async function job(jobId: string): Promise<StackJob> {
  const response = await api(`/jobs/${jobId}`);
  if (!response.ok) throw new Error(`Job read answered ${response.status}`);
  return ((await response.json()) as { job: StackJob }).job;
}

/**
 * The budget every stack job is submitted with. Output is a ceiling across the
 * whole job; each model request sets aside only its own output cap from the
 * model's context window, so this ceiling does not narrow any request's input.
 * The scripted model has no catalog entry and gets the 128,000-token fallback
 * window.
 */
export const STACK_JOB_BUDGET: Partial<JobBudget> = {
  max_attempts: 4,
  max_turns: 4,
  max_wall_ms: 180_000,
  max_actions: 2,
  max_output_tokens: 64_000,
};

export async function createStackJob(options: { title?: string; objective?: string } = {}) {
  const { spaceId, connectionId } = await ensureTestConnection();
  const response = await api('/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      space_id: spaceId,
      title: options.title ?? 'Compose vertical slice',
      objective: options.objective ?? 'Send the scripted test message once and report its receipt.',
      budget: STACK_JOB_BUDGET,
    }),
  });
  const body = (await response.json()) as { job?: StackJob; error?: { code: string } };
  if (!response.ok || !body.job)
    throw new Error(`Job submission answered ${response.status}: ${body.error?.code ?? 'no job'}`);
  return { jobId: body.job.id, spaceId, connectionId };
}

export async function waitForJob(jobId: string, state: string, timeoutMs = 180_000) {
  return waitFor(
    async () => {
      const current = await job(jobId);
      if (current.state === state) return current;
      if (['failed', 'cancelled', 'completed'].includes(current.state))
        throw new Error(`Job ${jobId} reached ${current.state} while waiting for ${state}`);
      return false;
    },
    timeoutMs,
    `job ${jobId} to reach ${state}`,
  );
}

export async function createApprovalJob(options: { title?: string; objective?: string } = {}) {
  const created = await createStackJob(options);
  await waitForJob(created.jobId, 'waiting_for_approval');
  return created;
}

export async function approveJob(jobId: string) {
  const response = await api('/approvals');
  if (!response.ok) throw new Error(`Approval list answered ${response.status}`);
  const body = (await response.json()) as {
    approvals: { job_id: string; approval_id: string; payload_hash: string }[];
  };
  const approvals = body.approvals.filter((approval) => approval.job_id === jobId);
  if (approvals.length !== 1)
    throw new Error(`Expected one approval, received ${approvals.length}`);
  const approval = approvals[0];
  const decision = await api(`/approvals/${approval?.approval_id}`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved', payload_hash: approval?.payload_hash }),
  });
  if (!decision.ok) throw new Error(`Approval decision answered ${decision.status}`);
  await waitForJob(jobId, 'completed');
}
