/**
 * A request naming a space in x-melete-space is answered for that space or
 * refused: a route that answers for the space the session is in never quietly
 * answers for it when the header names a different space the person is in.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { session } from '../../src/db/auth-schema.ts';
import { owner, space, spaceMembership } from '../../src/db/schema.ts';
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
const personal = newId('sp');
const room = newId('sp');
const theirs = newId('sp');
const ownerId = newId('own');
const otherId = newId('own');
const token = randomBytes(32).toString('base64url');
const inRoom = randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'header@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.sql`insert into principal (id, email) values (${otherId}, 'other@example.test')`;
  await handle.db.insert(space).values([
    { id: personal, name: 'Personal', gitPath: `/spaces/${personal}` },
    { id: room, name: 'Trip', kind: 'room', ownerPrincipalId: otherId, gitPath: `/spaces/${room}` },
    {
      id: theirs,
      name: 'Personal',
      ownerPrincipalId: otherId,
      gitPath: `/spaces/${theirs}`,
    },
  ]);
  await handle.db.insert(spaceMembership).values([
    { principalId: otherId, spaceId: room, role: 'owner' },
    { principalId: ownerId, spaceId: room, role: 'member' },
  ]);
  await handle.db.insert(session).values({
    tokenHash: digest(token),
    ownerId,
    spaceId: personal,
    expiresAt: new Date(Date.now() + 600000),
  });
  // The same person, signed in to the room itself.
  const [membership] = await handle.sql`select generation from space_membership
    where space_id = ${room} and principal_id = ${ownerId}`;
  await handle.sql`insert into session (token_hash, owner_id, principal_id, space_id,
      membership_generation, expires_at)
    values (${digest(inRoom)}, ${ownerId}, ${ownerId}, ${room}, ${membership?.generation},
      now() + interval '1 hour')`;
  await provisionMemorySpace(handle.sql, ownerId, personal);
  await handle.sql`update memory_spaces set restore_ready = true where space_id = ${personal}`;
}
const withDb = handle ? describe : describe.skip;

async function request(path: string, method: string, header?: string, cookie = token) {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, {
    method,
    headers: {
      Cookie: `melete_session=${cookie}`,
      ...(header ? { 'x-melete-space': header } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

async function refused(response: Response) {
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('scope_denied');
}

withDb('a space named in x-melete-space', () => {
  afterAll(async () => {
    await handle?.close();
  }, 30000);

  for (const [method, path] of [
    ['GET', '/memory/blocks'],
    ['GET', '/memory/beliefs'],
    ['POST', '/memory/beliefs/clm_missing/block'],
    ['GET', '/conversations'],
    ['GET', '/events?view=experience'],
  ] as const) {
    test(`${method} ${path}: a room the person is in is refused, not answered for their own space`, async () => {
      const own = await request(path, method);
      const named = await request(path, method, personal);
      expect(named.status).toBe(own.status);
      await refused(await request(path, method, room));
      // Another person's own space is still refused as theirs.
      expect((await request(path, method, theirs)).status).toBe(403);
    });

    test(`${method} ${path}: signed in to the room, naming the room is answered as without it`, async () => {
      const plain = await request(path, method, undefined, inRoom);
      const named = await request(path, method, room, inRoom);
      expect(named.status).toBe(plain.status);
      await refused(await request(path, method, personal, inRoom));
    });
  }
});
