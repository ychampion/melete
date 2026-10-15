/**
 * "Forget and don't learn again" over the API: a request that leaves out how
 * far the block reaches blocks anything about the belief's subject, as every
 * client that does not offer the choice gets; "detail" asks for just that
 * detail, and anything else is refused.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { beliefBlockList, beliefList, experienceResult } from '@melete/contracts';
import { session } from '../../src/db/auth-schema.ts';
import { owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import type { RestrictionJournal, RestrictionRecord } from '../../src/memory/restore.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const forgotten: RestrictionRecord[] = [];
const journal: RestrictionJournal = {
  read: async () => forgotten,
  append: async (record) => {
    forgotten.push(record);
  },
};
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      sql: handle.sql,
      memory: { sql: handle.sql, journal },
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'blocks@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values([{ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` }]);
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
  await provisionMemorySpace(handle.sql, ownerId, spaceId);
  await handle.sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
}
const withDb = handle ? describe : describe.skip;

const KEY = 'test-master-key-0123456789abcdef0123456789abcdef';
let before: string | undefined;
beforeEach(() => {
  before = process.env.MELETE_MASTER_KEY;
  process.env.MELETE_MASTER_KEY = KEY;
});
afterEach(() => {
  if (before === undefined) delete process.env.MELETE_MASTER_KEY;
  else process.env.MELETE_MASTER_KEY = before;
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
async function request(path: string, method = 'GET', body?: string) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  });
}
async function remember(key: string, value: string, statement: string) {
  const response = await request(
    '/memory/items',
    'POST',
    JSON.stringify({ key, value, statement }),
  );
  expect(response.status).toBe(200);
  const beliefs = experienceResult(beliefList).parse(
    await (await request('/memory/beliefs')).json(),
  );
  if (!('beliefs' in beliefs)) throw new Error('beliefs are not connected');
  return required(beliefs.beliefs.find((belief) => belief.value === value));
}

withDb('how far a block reaches, over the API', () => {
  afterAll(async () => {
    await handle?.close();
  }, 30000);

  test('left out, a block reaches anything about the subject; "detail" reaches just the detail', async () => {
    const city = await remember('pref.home.city', 'Lisbon', 'Where are you based? Lisbon.');
    expect(city.topic).toBe('Home: city');
    const bare = await request(`/memory/beliefs/${city.id}/block`, 'POST');
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual({ status: 'ok', scope: 'topic' });

    const names = await remember(
      'pref.people.names',
      'Alex and Priya',
      'Who should I know by name? Alex and Priya.',
    );
    const asked = await request(
      `/memory/beliefs/${names.id}/block`,
      'POST',
      JSON.stringify({ scope: 'detail' }),
    );
    expect(await asked.json()).toEqual({ status: 'ok', scope: 'detail' });

    const blocks = experienceResult(beliefBlockList).parse(
      await (await request('/memory/blocks')).json(),
    );
    if (!('blocks' in blocks)) throw new Error('blocks are not connected');
    expect(blocks.blocks.map((block) => [block.label, block.scope]).sort()).toEqual([
      ['Anything about Home: city', 'topic'],
      ['People: names, the detail you forgot', 'detail'],
    ]);

    const focus = await remember(
      'pref.focus.this-month',
      'A launch at work',
      'What eats your week right now? A launch at work.',
    );
    for (const body of [JSON.stringify({ scope: 'everything' }), JSON.stringify({ also: 1 }), '{'])
      expect((await request(`/memory/beliefs/${focus.id}/block`, 'POST', body)).status).toBe(400);
    // An empty object is the default too.
    expect(await (await request(`/memory/beliefs/${focus.id}/block`, 'POST', '{}')).json()).toEqual(
      { status: 'ok', scope: 'topic' },
    );
  });
});
