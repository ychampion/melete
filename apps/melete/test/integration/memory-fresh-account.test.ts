/**
 * A fresh account's first use of memory is its setup questions, before any job
 * has run in its space. Saving, reading, changing and forgetting an answer must
 * work from that first moment, through the service's own memory start path.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryItemList, memoryItemResponse } from '@melete/contracts';
import { session } from '../../src/db/auth-schema.ts';
import { openDatabase } from '../../src/db/client.ts';
import { owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startServiceMemory } from '../../src/memory/start.ts';
import { createTestDatabase } from './postgres.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 4) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-fresh-memory-'));
const memory =
  db && handle ? await startServiceMemory(handle.sql, db.boss, join(root, 'spaces')) : null;
afterAll(async () => {
  await memory?.stop();
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
  await rm(root, { recursive: true, force: true });
}, 30000);
const withDb = db && handle && memory ? describe : describe.skip;

withDb('memory on a fresh account', () => {
  test('setup answers save, list, change and forget before any job has run', async () => {
    if (!handle || !memory) return;
    const ownerId = newId('own');
    const spaceId = newId('sp');
    const token = randomBytes(32).toString('base64url');
    await handle.db.insert(owner).values({ id: ownerId, email: 'fresh@example.test' });
    await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
    await handle.db
      .insert(space)
      .values([{ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` }]);
    await handle.db.insert(session).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      ownerId,
      spaceId,
      expiresAt: new Date(Date.now() + 600000),
    });
    // Nothing has touched this space's memory: no job, no memory row.
    const [before] =
      await handle.sql`select count(*)::int as n from memory_spaces where space_id = ${spaceId}`;
    expect(before?.n).toBe(0);
    const app = createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      sql: handle.sql,
      memory,
      checkDatabase: async () => 'ok',
    });
    const call = (path: string, method = 'GET', body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          Cookie: `melete_session=${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    const created = await call('/memory/items', 'POST', {
      key: 'pref.home.city',
      value: 'Lisbon',
      statement: 'Where are you based? Lisbon.',
    });
    const createdBody = await created.text();
    expect([created.status, createdBody.includes('"item"')]).toEqual([200, true]);
    const item = memoryItemResponse.parse(JSON.parse(createdBody)).item;
    expect(item.value).toBe('Lisbon');

    const listed = memoryItemList.parse(await (await call('/memory/items')).json());
    expect(listed.items.map((entry) => entry.value)).toEqual(['Lisbon']);

    const edited = await call(`/memory/items/${item.id}`, 'PATCH', {
      value: 'Porto',
      version: item.version,
    });
    expect(edited.status).toBe(200);
    const relisted = memoryItemList.parse(await (await call('/memory/items')).json());
    expect(relisted.items.map((entry) => entry.value)).toEqual(['Porto']);

    const forgotten = await call(`/memory/items/${item.id}`, 'DELETE');
    expect(forgotten.status).toBe(200);
    const after = memoryItemList.parse(await (await call('/memory/items')).json());
    expect(after.items).toEqual([]);
  });
});
