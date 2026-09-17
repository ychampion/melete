/**
 * Memory answers per space, but a repair brief names one job: what a correction
 * changed for that job's results, including the value before and after. Inside
 * a shared space a job stays private to its principal, so its briefs do too,
 * whichever member asks and whatever the claim's audience was.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimHandleOf } from '@melete/contracts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { DEFAULT_BUDGET } from '../../src/jobs/service.ts';
import { startDeploymentMemory } from '../../src/memory/bootstrap.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const restrictions = await mkdtemp(join(tmpdir(), 'melete-brief-scope-'));
const memory =
  handle && queue
    ? await startDeploymentMemory({
        sql: handle.sql,
        boss: queue.boss,
        restrictionsDir: restrictions,
        workers: false,
      })
    : null;
const app =
  handle && memory
    ? createApp({
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: restrictions }),
        db: handle.db,
        memory: memory.routes,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';

function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}

async function send(cookie: string, path: string, method = 'GET', body?: unknown) {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

withDb('repair briefs follow the job, not only the space', () => {
  afterAll(async () => {
    await memory?.close();
    await queue?.stop();
    await handle?.close();
    await rm(restrictions, { recursive: true, force: true });
  }, 30_000);

  test('a member reads the briefs of their own jobs and never those of another principal', async () => {
    if (!app || !handle) throw new Error('Postgres unavailable');
    const { sql } = handle;
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password }),
    });
    expect(setup.status).toBe(201);
    const ownerCookie = sessionCookie(setup);
    const ownerId = ((await setup.json()) as { owner: { id: string } }).owner.id;
    const provisioned = await send(ownerCookie, '/principals', 'POST', {
      email: 'member@example.test',
      password,
    });
    expect(provisioned.status).toBe(201);
    const memberId = ((await provisioned.json()) as { principal: { id: string } }).principal.id;
    const memberCookie = sessionCookie(
      await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'member@example.test', password }),
      }),
    );
    const shared = await send(ownerCookie, '/spaces/shared', 'POST', { name: 'Household' });
    expect(shared.status).toBe(201);
    const spaceId = ((await shared.json()) as { space: { id: string } }).space.id;
    expect(
      (
        await send(ownerCookie, `/spaces/${spaceId}/memberships`, 'POST', {
          principal_id: memberId,
        })
      ).status,
    ).toBe(201);

    const job = async (principalId: string, title: string) => {
      const id = newId('job');
      await sql`insert into job (id, space_id, principal_id, title, objective, kind, budget)
        values (${id}, ${spaceId}, ${principalId}, ${title}, ${title}, 'chat', ${JSON.stringify(DEFAULT_BUDGET)}::jsonb)`;
      return id;
    };
    const ownersJob = await job(ownerId, 'Owner errand');
    const membersJob = await job(memberId, 'Member errand');

    // Reading through the route provisions the shared space's memory, as first use does.
    const read = (cookie: string, path: string) =>
      app.request(path, { headers: { Cookie: cookie, 'x-melete-space': spaceId } });
    expect((await read(ownerCookie, '/memory/claims')).status).toBe(200);
    const brief = async (jobId: string, before: string, after: string) => {
      const changed = claimHandleOf(newId('k'), 1);
      await sql`insert into memory_repair_briefs (id, space_id, job_id, key, changed_handle,
          replacement_handle, old_value, new_value, affected)
        values (${`rb_${createHash('sha256').update(`${jobId}:${changed}`).digest('hex')}`},
          ${spaceId}, ${jobId}, null, ${changed}, null, ${before}, ${after}, '[]'::jsonb)`;
    };
    await brief(ownersJob, 'OWNER_PRIVATE_BEFORE', 'OWNER_PRIVATE_AFTER');
    await brief(membersJob, 'MEMBER_BEFORE', 'MEMBER_AFTER');

    const briefs = (cookie: string, jobId: string) =>
      read(cookie, `/memory/jobs/${jobId}/repair-briefs`);
    const foreign = await briefs(memberCookie, ownersJob);
    const foreignText = await foreign.text();
    expect(foreignText).not.toContain('OWNER_PRIVATE');
    expect(foreign.status).toBe(404);
    const reverse = await briefs(ownerCookie, membersJob);
    expect(await reverse.text()).not.toContain('MEMBER_');
    expect(reverse.status).toBe(404);

    const own = await briefs(memberCookie, membersJob);
    expect(own.status).toBe(200);
    expect(await own.text()).toContain('MEMBER_AFTER');
    const owners = await briefs(ownerCookie, ownersJob);
    expect(owners.status).toBe(200);
    expect(await owners.text()).toContain('OWNER_PRIVATE_AFTER');
  }, 60_000);
});
