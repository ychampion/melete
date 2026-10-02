/**
 * Previews, output and stopping against a real database: who may open a
 * preview of a server in an agent's computer, and how every change to that
 * ends it on its next request. The computer is a server on this machine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { testDatabase } from '../../test/helpers/database.ts';
import { ServiceError } from '../api/errors.ts';
import { recordId } from '../broker/records.ts';
import { isolated } from '../viewer/headers.ts';
import { mountSandboxPreviews, SandboxPreviews, sqlPreviewAccess } from './preview.ts';
import { PREVIEW_PREFIX } from './preview-path.ts';
import type { ProcessComputer } from './process-helper.ts';
import { SandboxProcesses } from './processes.ts';
import { seedSessionScope } from './session-fixtures.ts';
import type { SandboxProvider } from './types.ts';

const database = await testDatabase();
afterAll(async () => database?.close(), 30_000);
const withDb = database ? describe : describe.skip;

let server: ReturnType<typeof Bun.serve>;
const seen: string[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      seen.push(new URL(request.url).pathname);
      return new Response('<!doctype html><title>Dev</title>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
});
afterAll(() => server?.stop(true));

const LIMITS = {
  maxPerComputer: 4,
  maxPerSpace: 8,
  defaultTtlMinutes: 120,
  maxTtlMinutes: 720,
  outputMaxBytes: 8 * 1024 * 1024,
  awakeSecondsPerDay: 6 * 3600,
};

async function scene() {
  if (!database) throw new Error('Postgres unavailable');
  const { sql } = database;
  const person = async () => {
    const id = recordId('own');
    await sql`insert into principal (id, email) values (${id}, ${`${id}@example.test`})`;
    return id;
  };
  const [installation] = await sql`select id from owner limit 1`;
  if (!installation) {
    const id = recordId('own');
    await sql`insert into owner (id, email) values (${id}, ${`${id}@example.test`})`;
    await sql`insert into principal (id, email) values (${id}, ${`${id}@example.test`})`;
  }
  const ownerId = String((await sql`select id from owner limit 1`)[0]?.id);
  const alice = await person();
  const bo = await person();
  const scope = await seedSessionScope(sql);
  await sql`update space set kind = 'shared', owner_principal_id = ${alice} where id = ${scope.spaceId}`;
  for (const [who, role] of [
    [alice, 'owner'],
    [bo, 'member'],
  ] as const)
    await sql`insert into space_membership (principal_id, space_id, role)
      values (${who}, ${scope.spaceId}, ${role})`;
  await sql`update job set principal_id = ${alice}, state = 'running' where id = ${scope.jobId}`;
  const attemptId = await scope.attempt();
  const sandbox = `melete-sbx-test-${recordId('sbx').toLowerCase()}`;
  await sql`insert into sandbox_session (id, connection_id, space_id, job_id, attempt_id, agent_id,
      adapter, provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
    values (${recordId('sbx')}, ${scope.connectionId}, ${scope.spaceId}, ${scope.jobId}, ${attemptId},
      ${scope.agentId}, 'docker', ${sandbox}, 'melete-sandbox:local', '{"kind":"open"}'::jsonb,
      'pause', 'ready', now() + interval '1 hour')`;
  const processId = recordId('prc');
  await sql`insert into sandbox_process (id, space_id, agent_id, connection_id, job_id,
      command_redacted, command_digest, cwd, name, port, state, expires_at, last_line)
    values (${processId}, ${scope.spaceId}, ${scope.agentId}, ${scope.connectionId}, ${scope.jobId},
      'npm run dev', 'd', '/work', 'dev server', ${server.port ?? 0}, 'running',
      now() + interval '1 hour', 'ready in 300 ms')`;

  const stopped: string[] = [];
  const computer = {
    status: async () => ({
      boot: 'b',
      missing: [],
      processes: [{ id: processId, ports: [server.port ?? 0] }],
    }),
    read: async () => ({ data: new TextEncoder().encode('VITE ready\n  Local: http://0.0.0.0\n') }),
    stop: async (id: string) => {
      stopped.push(id);
      return { boot: 'b', process: { id, state: 'exited', exit_code: 143, cursor: 0 } };
    },
  } as unknown as ProcessComputer;
  const provider = {
    capabilities: { ports: 'authenticated' },
    previewAddress: async (handle: { providerSandboxId: string }, port: number) =>
      handle.providerSandboxId === sandbox ? { host: '127.0.0.1', port } : null,
  } as unknown as SandboxProvider;
  const processes = new SandboxProcesses(sql, { limits: LIMITS, computerFor: () => computer });
  const previews = new SandboxPreviews(
    sqlPreviewAccess(sql, () => new Map([[scope.connectionId, { adapter: 'docker', provider }]])),
    { processes, computerFor: () => computer },
  );

  // Each person signs in with a browser session of their own.
  const digests = new Map<string, string>();
  for (const who of [alice, bo]) {
    const digest = createHash('sha256').update(randomBytes(32)).digest('hex');
    await sql`insert into session (token_hash, principal_id, owner_id, expires_at)
      values (${digest}, ${who}, ${ownerId}, now() + interval '30 days')`;
    digests.set(who, digest);
  }

  const app = new Hono();
  app.use(`${PREVIEW_PREFIX}*`, isolated);
  app.use(async (c, next) => {
    const as = c.req.header('x-test-as');
    if (as) {
      c.set('owner' as never, { id: as } as never);
      c.set('sessionDigest' as never, digests.get(as) as never);
    }
    await next();
  });
  mountSandboxPreviews(app as never, previews);
  app.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ code: error.code, message: error.message }, error.status)
      : c.json({ code: 'internal', message: error.message }, 500),
  );
  const open = (who: string) =>
    app.request(`/sandbox/processes/${processId}/previews`, {
      method: 'POST',
      headers: { 'x-test-as': who },
    });
  const load = (path: string) => app.request(path, { headers: { 'sec-fetch-dest': 'iframe' } });
  return { sql, scope, alice, bo, processId, app, open, load, stopped, digests };
}

withDb('a preview of a server in an agent computer', () => {
  test('only the person whose job started a running server can open its preview', async () => {
    const { open, load, alice, bo } = await scene();
    const theirs = await open(bo);
    expect(theirs.status).toBe(404);
    const opened = await open(alice);
    expect(opened.status).toBe(200);
    const { path } = (await opened.json()) as { path: string };
    seen.length = 0;
    const page = await load(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Dev</title>');
    expect(seen).toEqual(['/']);
  }, 60_000);

  test('a preview link stops working when its process stops or the viewer loses access', async () => {
    const { sql, scope, open, load, alice, processId, digests } = await scene();
    const { path } = (await (await open(alice)).json()) as { path: string };
    const still = async () => (await load(path)).status;
    expect(await still()).toBe(200);

    await sql`update sandbox_process set state = 'stopped' where id = ${processId}`;
    expect(await still()).toBe(404);
    await sql`update sandbox_process set state = 'running' where id = ${processId}`;
    expect(await still()).toBe(200);

    await sql`update space_membership set revoked_at = now()
      where space_id = ${scope.spaceId} and principal_id = ${alice}`;
    expect(await still()).toBe(404);
    await sql`update space_membership set revoked_at = null
      where space_id = ${scope.spaceId} and principal_id = ${alice}`;
    expect(await still()).toBe(200);

    await sql`update connection set status = 'revoked' where id = ${scope.connectionId}`;
    expect(await still()).toBe(404);
    await sql`update connection set status = 'active' where id = ${scope.connectionId}`;
    expect(await still()).toBe(200);

    await sql`update space set removed_at = now() where id = ${scope.spaceId}`;
    expect(await still()).toBe(404);
    await sql`update space set removed_at = null where id = ${scope.spaceId}`;
    expect(await still()).toBe(200);

    // The computer is no longer running: no ready workspace for its agent.
    await sql`update sandbox_session set status = 'paused' where space_id = ${scope.spaceId}`;
    expect(await still()).toBe(404);
    await sql`update sandbox_session set status = 'ready' where space_id = ${scope.spaceId}`;
    expect(await still()).toBe(200);

    await sql`delete from session where token_hash = ${digests.get(alice) ?? ''}`;
    const ended = await load(path);
    expect(ended.status).toBe(404);
    expect(((await ended.json()) as { message: string }).message).toContain('signed out');
  }, 60_000);

  test('the person whose job started a process can read its output and stop it, and another cannot', async () => {
    const { app, sql, processId, alice, bo, stopped } = await scene();
    const read = (who: string) =>
      app.request(`/sandbox/processes/${processId}/output`, { headers: { 'x-test-as': who } });
    expect((await read(bo)).status).toBe(404);
    const output = (await (await read(alice)).json()) as { text: string; state: string };
    expect(output).toMatchObject({ state: 'running' });
    expect(output.text).toContain('VITE ready');

    const stop = (who: string) =>
      app.request(`/sandbox/processes/${processId}/stop`, {
        method: 'POST',
        headers: { 'x-test-as': who },
      });
    expect((await stop(bo)).status).toBe(404);
    expect(stopped).toEqual([]);
    const done = (await (await stop(alice)).json()) as { state: string };
    expect(done.state).toBe('stopped');
    expect(stopped).toEqual([processId]);
    const [row] = await sql`select state, end_reason from sandbox_process where id = ${processId}`;
    expect(row).toMatchObject({
      state: 'stopped',
      end_reason: 'the person stopped it from the computer view',
    });
  }, 60_000);
});
