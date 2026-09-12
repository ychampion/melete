import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabase } from '../../test/helpers/database.ts';
import { snapshotMemory } from '../../test/integration/lifecycle-fixtures.ts';
import { loadEnv } from '../env.ts';
import { newId } from '../ids.ts';
import { createApp } from '../index.ts';
import { startQueue } from '../jobs/queue.ts';
import { startDeploymentMemory } from './bootstrap.ts';
import { listClaims } from './claims.ts';
import { ingest } from './evidence.ts';
import { forgetMemory } from './forget.ts';
import { recall } from './recall.ts';
import { NO_GATEWAY_ATTEMPT_LIMIT, runExtractionWork } from './service.ts';
import { buildViews } from './views.ts';
import { repairQueue } from './work.ts';

const parent = await testDatabase();
afterAll(async () => parent?.close());
const withDb = parent ? describe : describe.skip;

async function fixture(workers = false) {
  const handle = await testDatabase();
  if (!handle) throw new Error('Postgres unavailable');
  const queue = await startQueue(handle.url);
  const directory = await mkdtemp(join(tmpdir(), 'melete-w6-memory-'));
  const options = {
    sql: handle.sql,
    boss: queue.boss,
    restrictionsDir: directory,
    workers,
  };
  const memory = await startDeploymentMemory(options);
  const app = createApp({
    env: loadEnv({ NODE_ENV: 'test' }),
    db: handle.db,
    memory: memory.routes,
    checkDatabase: async () => 'ok',
  });
  return {
    ...handle,
    boss: queue.boss,
    options,
    memory,
    app,
    directory,
    journalPath: join(directory, 'restrictions.jsonl'),
    async setup() {
      const setup = await app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'w6@example.test', password: 'fixture-password' }),
      });
      expect(setup.status).toBe(201);
      const cookie = setup.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error('Setup omitted the session');
      const spaces = await app.request('/spaces', { headers: { cookie } });
      const { spaces: rows } = (await spaces.json()) as { spaces: { id: string }[] };
      const spaceId = rows[0]?.id;
      if (!spaceId) throw new Error('Setup omitted the space');
      const headers = { cookie, 'x-melete-space': spaceId };
      const scope = await memory.routes.resolveScope?.(
        new Request('http://localhost/memory/claims', { headers }),
      );
      if (!scope) throw new Error('Session did not resolve its memory space');
      return { cookie, spaceId, headers, scope };
    },
    async close() {
      await memory.close();
      await queue.stop();
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const observation = (identity: string, slug: string, email: string) => ({
  stream: 'w6-contact',
  source_identity: identity,
  source_version: '1',
  source_type: 'observation',
  event_at: '2026-09-11T00:00:00Z',
  text: JSON.stringify({ kind: 'contact', slug, email }),
});

withDb('deployment memory startup', () => {
  test('setup provisions memory through its persisted session and cannot invent a space', async () => {
    const f = await fixture();
    try {
      expect(await readFile(f.journalPath, 'utf8')).toBe('melete-memory-restrictions-v1\n');
      expect((await stat(f.journalPath)).mode & 0o777).toBe(0o600);
      const owner = await f.setup();
      const [provisioned] = await f.sql`select owner_id, restore_ready from memory_spaces
        where space_id = ${owner.spaceId}`;
      expect(provisioned).toEqual({ owner_id: owner.scope.ownerId, restore_ready: true });
      expect((await f.app.request('/memory/claims', { headers: owner.headers })).status).toBe(200);
      expect((await f.app.request('/memory/claims')).status).toBe(401);
      const inventedId = newId('sp');
      expect(
        (
          await f.app.request('/memory/claims', {
            headers: { ...owner.headers, 'x-melete-space': inventedId },
          })
        ).status,
      ).toBe(401);
      expect(
        await f.sql`select space_id from memory_spaces where space_id = ${inventedId}`,
      ).toHaveLength(0);

      // Selecting a real catalog space created after startup provisions that
      // space only; a gated existing space must never be silently reopened.
      const secondId = newId('sp');
      await f.sql`insert into space (id, name, git_path) values (${secondId}, 'Second', '/unused')`;
      expect(
        (
          await f.app.request('/memory/claims', {
            headers: { ...owner.headers, 'x-melete-space': secondId },
          })
        ).status,
      ).toBe(200);
      expect(
        (await f.app.request('/memory/claims', { headers: { cookie: owner.cookie } })).status,
      ).toBe(401);
      await f.sql`update memory_spaces set restore_ready = false where space_id = ${owner.spaceId}`;
      const gated = await f.app.request('/memory/recall', {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'contact' }),
      });
      expect(((await gated.json()) as { coverage: { reason: string } }).coverage.reason).toBe(
        'restore_pending',
      );
      await f.sql`update session set expires_at = '2000-01-01'`;
      expect((await f.app.request('/memory/claims', { headers: owner.headers })).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  test('missing or corrupt retained journal fails startup and leaves memory closed', async () => {
    const f = await fixture();
    try {
      const owner = await f.setup();
      await unlink(f.journalPath);
      await expect(startDeploymentMemory(f.options)).rejects.toThrow('restriction_journal_missing');
      await expect(stat(f.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await recall(f.sql, owner.scope, { query: 'contact' })).coverage.reason).toBe(
        'restore_pending',
      );
      await writeFile(f.journalPath, 'damaged journal\n');
      await expect(startDeploymentMemory(f.options)).rejects.toThrow('restriction_journal_invalid');
      expect((await recall(f.sql, owner.scope, { query: 'contact' })).coverage.reason).toBe(
        'restore_pending',
      );
    } finally {
      await f.close();
    }
  });

  test('an old database snapshot replays forgetting before startup returns while preserving unrelated memory', async () => {
    const f = await fixture();
    try {
      const owner = await f.setup();
      for (const slug of ['clinic', 'dentist']) {
        const source = await ingest(
          f.sql,
          owner.scope,
          observation(slug, slug, `${slug}@example.test`),
        );
        const [work] =
          await f.sql`select id from memory_work where source_id = ${source.source.source_id}`;
        await runExtractionWork(
          { sql: f.sql, boss: f.boss, journal: f.memory.routes.journal },
          String(work?.id),
        );
      }
      await buildViews(f.sql, owner.scope);
      const claims = (await listClaims(f.sql, owner.scope)).claims;
      const clinic = claims.find((claim) => claim.current.content === 'clinic@example.test');
      if (!clinic) throw new Error('Positive memory fixture missing');
      expect((await recall(f.sql, owner.scope, { query: 'clinic' })).items).toHaveLength(1);
      const restore = await snapshotMemory(f);
      await forgetMemory(f.sql, owner.scope, { claim_id: clinic.id }, f.memory.routes.journal);
      expect((await recall(f.sql, owner.scope, { query: 'clinic' })).items).toHaveLength(0);
      await restore();
      const restarted = await startDeploymentMemory(f.options);
      try {
        expect((await recall(f.sql, owner.scope, { query: 'clinic' })).items).toHaveLength(0);
        const retained = await recall(f.sql, owner.scope, { query: 'dentist' });
        expect(retained.items.map((item) => item.content)).toEqual(['dentist@example.test']);
        const [restriction] = await f.sql`select count(*)::int as count from memory_suppressions
          where space_id = ${owner.spaceId}`;
        expect(restriction?.count).toBeGreaterThan(0);
      } finally {
        await restarted.close();
      }
    } finally {
      await f.close();
    }
  });

  test('a deployment with no extraction model still processes structured observations through the queue', async () => {
    const f = await fixture(true);
    try {
      const owner = await f.setup();
      const accepted = await f.app.request('/memory/sources', {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify(observation('clinic', 'clinic', 'clinic@example.test')),
      });
      expect(accepted.status).toBe(201);
      await repairQueue(f.sql, f.boss);
      const deadline = Date.now() + 7000;
      let content: string | undefined;
      while (Date.now() < deadline) {
        const result = await recall(f.sql, owner.scope, { query: 'clinic' });
        content = result.items[0]?.content;
        if (content) break;
        await Bun.sleep(50);
      }
      expect(content).toBe('clinic@example.test');
      const [work] =
        await f.sql`select calls, status from memory_work where space_id = ${owner.spaceId}`;
      expect(work).toEqual({ calls: 0, status: 'done' });
    } finally {
      await f.close();
    }
  }, 15000);

  test('unstructured extraction without a gateway stops at its durable attempt cap', async () => {
    const f = await fixture();
    try {
      const owner = await f.setup();
      const accepted = await ingest(f.sql, owner.scope, {
        stream: 'no-gateway',
        source_identity: 'message-1',
        source_version: '1',
        source_type: 'message',
        event_at: '2026-09-12T00:00:00Z',
        text: 'Please remember that I prefer the window seat.',
      });
      const [work] = await f.sql`select id from memory_work
        where source_id = ${accepted.source.source_id}`;
      if (!work) throw new Error('The extraction fixture did not create work');
      const options = { sql: f.sql, boss: f.boss, journal: f.memory.routes.journal };
      for (let attempt = 1; attempt <= NO_GATEWAY_ATTEMPT_LIMIT; attempt++) {
        await runExtractionWork(options, work.id);
        const [state] =
          await f.sql`select status, fence, error_code from memory_work where id = ${work.id}`;
        expect(state).toEqual({
          status: attempt === NO_GATEWAY_ATTEMPT_LIMIT ? 'rejected' : 'pending',
          fence: attempt,
          error_code: 'no_extraction_gateway',
        });
      }
      expect(await repairQueue(f.sql, f.boss)).toBe(0);
      await runExtractionWork(options, work.id); // A duplicate delivery cannot revive it.
      const [terminal] =
        await f.sql`select status, fence, calls, lease_until from memory_work where id = ${work.id}`;
      expect(terminal).toEqual({
        status: 'rejected',
        fence: NO_GATEWAY_ATTEMPT_LIMIT,
        calls: 0,
        lease_until: null,
      });
      const [outbox] =
        await f.sql`select completed_at from memory_outbox where kind = 'extract' and target_id = ${work.id}`;
      expect(outbox?.completed_at).not.toBeNull();
      const [stream] =
        await f.sql`select consumed_sequence from memory_streams where space_id = ${owner.spaceId} and stream = 'no-gateway'`;
      expect(stream?.consumed_sequence).toBe(1);
    } finally {
      await f.close();
    }
  });
});
