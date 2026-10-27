/** Personal calendar consent is owned by its member and ends with that membership. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roomCalendarShareSettings, roomDetail } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { resolveRoomCalendarShare } from '../../src/rooms/calendar-shares.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-calendar-shares-'));
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'room-calendar-shares-signing-key-32-bytes!',
      liveConnectionScopes: true,
    })
  : null;
const broker = handle ? new BrokerService({ sql: handle.sql, connectors: registry }) : null;
const deps =
  handle && jobs && runner && broker
    ? {
        db: handle.db,
        sql: handle.sql,
        jobs,
        runner,
        broker,
        registry,
        checkDatabase: async () => 'ok' as const,
      }
    : null;
const app = deps
  ? createApp({
      ...deps,
      env: loadEnv({
        MELETE_PREVIEW_MULTIPLAYER: 'true',
        NODE_ENV: 'test',
        MELETE_SPACES_DIR: directory,
      }),
    })
  : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';

function database() {
  if (!handle || !app || !deps) throw new Error('Postgres unavailable');
  return { ...handle, app, deps };
}

function sessionCookie(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!cookie) throw new Error(`Expected session (${response.status})`);
  return cookie;
}

async function send(cookie: string, path: string, method = 'GET', body?: unknown) {
  return database().app.request(path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function ok(response: Promise<Response> | Response, status = 200) {
  const answered = await response;
  const body = await answered.text();
  expect([answered.status, body.slice(0, 300)]).toEqual([status, body.slice(0, 300)]);
  return JSON.parse(body);
}

type Person = { id: string; cookie: string; space: string };
let owner: Person;
let member: Person;
let outsider: Person;

async function personalSpace(id: string) {
  const [row] = await database().sql`select id from space where kind = 'personal'
    and coalesce(owner_principal_id, (select id from owner limit 1)) = ${id}`;
  if (!row) throw new Error('Personal space missing');
  return String(row.id);
}

async function makeRoom() {
  const detail = roomDetail.parse(
    await ok(send(owner.cookie, '/rooms', 'POST', { name: 'Calendar room' }), 201),
  );
  await ok(
    send(owner.cookie, `/rooms/${detail.room.id}/members`, 'POST', { principal_id: member.id }),
    201,
  );
  return detail.room.id;
}

async function calendar(
  spaceId: string,
  kind = 'caldav',
  scopes = calendarManifest.tools.map((tool) => tool.name),
) {
  const id = recordId('conn');
  await database().sql`insert into connection (id, space_id, provider, label, scopes, configuration)
    values (${id}, ${spaceId}, 'caldav', 'My calendar', ${JSON.stringify(scopes)}::jsonb,
      ${JSON.stringify({ kind })}::jsonb)`;
  return id;
}

const path = (roomId: string) => `/rooms/${roomId}/calendar-shares`;
const share = (roomId: string, connectionId: string, mode = 'freebusy') =>
  send(member.cookie, path(roomId), 'PUT', { connection_id: connectionId, mode });

withDb('room calendar shares', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  beforeAll(async () => {
    const setup = await database().app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password }),
    });
    const cookie = sessionCookie(setup);
    const body = await ok(setup, 201);
    owner = { id: body.owner.id, cookie, space: await personalSpace(body.owner.id) };
    const people: Person[] = [];
    for (const name of ['member', 'outsider']) {
      const made = await ok(
        send(cookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      );
      const login = await database().app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${name}@example.test`, password }),
      });
      people.push({
        id: made.principal.id,
        cookie: sessionCookie(login),
        space: await personalSpace(made.principal.id),
      });
    }
    const [second, third] = people;
    if (!second || !third) throw new Error('People missing');
    member = second;
    outsider = third;
  }, 60_000);

  test('settings expose only my personal calendars and my own current consent', async () => {
    const room = await makeRoom();
    const mine = await calendar(member.space);
    const theirs = await calendar(owner.space);
    const roomCalendar = await calendar(room);
    const feed = await calendar(member.space, 'ics', ['calendar.freebusy', 'calendar.list']);
    await database().sql`insert into connection (id, space_id, provider, label, scopes)
      values (${recordId('conn')}, ${member.space}, 'imap', 'Mail', '["mail.list"]'::jsonb)`;
    const initial = roomCalendarShareSettings.parse(await ok(send(member.cookie, path(room))));
    expect(initial.share).toBeNull();
    expect(initial.connections.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([mine, feed]),
    );
    expect(initial.connections.map((entry) => entry.id)).not.toContain(theirs);
    expect(initial.connections.map((entry) => entry.id)).not.toContain(roomCalendar);
    expect(initial.connections.find((entry) => entry.id === feed)?.can_add).toBe(false);
    expect(initial.connections.find((entry) => entry.id === mine)?.can_add).toBe(true);
    await ok(share(room, mine));
    expect(
      roomCalendarShareSettings.parse(await ok(send(member.cookie, path(room)))).share
        ?.connection_id,
    ).toBe(mine);
    expect(
      roomCalendarShareSettings.parse(await ok(send(owner.cookie, path(room)))).share,
    ).toBeNull();
  });

  test('sharing refuses another member calendar and connections in the room itself', async () => {
    const room = await makeRoom();
    await ok(share(room, await calendar(owner.space)), 403);
    await ok(share(room, await calendar(room)), 403);
    await expect(resolveRoomCalendarShare(database().sql, room, member.id)).rejects.toMatchObject({
      code: 'scope_denied',
    });
  });

  test('sharing and reading settings refuse a room I am not in', async () => {
    const room = await makeRoom();
    const own = await calendar(outsider.space);
    await ok(
      send(outsider.cookie, path(room), 'PUT', { connection_id: own, mode: 'freebusy' }),
      403,
    );
    await ok(send(outsider.cookie, path(room)), 403);
    await ok(send(outsider.cookie, path(room), 'DELETE'), 403);
  });

  test('a guest cannot share a calendar or gain write permission', async () => {
    const room = await makeRoom();
    await database().sql`insert into space_membership (space_id, principal_id, role)
      values (${room}, ${outsider.id}, 'guest')`;
    const settings = roomCalendarShareSettings.parse(await ok(send(outsider.cookie, path(room))));
    expect(settings).toEqual({ share: null, connections: [] });
    await ok(
      send(outsider.cookie, path(room), 'PUT', {
        connection_id: await calendar(outsider.space),
        mode: 'freebusy_add',
      }),
      403,
    );
  });

  test('an unshared calendar is unreachable and freebusy consent cannot add events', async () => {
    const room = await makeRoom();
    const own = await calendar(member.space);
    await expect(resolveRoomCalendarShare(database().sql, room, member.id)).rejects.toMatchObject({
      code: 'scope_denied',
    });
    await ok(share(room, own));
    expect((await resolveRoomCalendarShare(database().sql, room, member.id)).connection.id).toBe(
      own,
    );
    await expect(
      resolveRoomCalendarShare(database().sql, room, member.id, true),
    ).rejects.toMatchObject({ code: 'scope_denied' });
    await ok(share(room, own, 'freebusy_add'));
    expect(
      (await resolveRoomCalendarShare(database().sql, room, member.id, true)).connection.id,
    ).toBe(own);
  });

  test('read-only calendar feeds cannot grant event additions even with forged scopes', async () => {
    const room = await makeRoom();
    const feed = await calendar(member.space, 'ics');
    await ok(share(room, feed));
    await ok(share(room, feed, 'freebusy_add'), 403);
    await expect(
      resolveRoomCalendarShare(database().sql, room, member.id, true),
    ).rejects.toMatchObject({ code: 'scope_denied' });
  });

  test('the broker resolves current calendar consent on its own transaction connection', async () => {
    const room = await makeRoom();
    const own = await calendar(member.space);
    await ok(share(room, own, 'freebusy_add'));
    await database().sql.begin(async (tx) => {
      const shared = await resolveRoomCalendarShare(tx, room, member.id, true);
      expect(shared.connection.id).toBe(own);
      expect(shared.share.createdAt).toBeInstanceOf(Date);
      await tx`update room_calendar_share set revoked_at = now()
        where space_id = ${room} and principal_id = ${member.id}`;
      await expect(resolveRoomCalendarShare(tx, room, member.id, true)).rejects.toMatchObject({
        code: 'scope_denied',
      });
    });
  });

  test('revoking stops the next read and renewed consent has a new binding', async () => {
    const room = await makeRoom();
    const own = await calendar(member.space);
    await ok(share(room, own, 'freebusy_add'));
    const first = await resolveRoomCalendarShare(database().sql, room, member.id);
    await ok(send(member.cookie, path(room), 'DELETE'));
    await expect(resolveRoomCalendarShare(database().sql, room, member.id)).rejects.toMatchObject({
      code: 'scope_denied',
    });
    await ok(share(room, own, 'freebusy_add'));
    const second = await resolveRoomCalendarShare(database().sql, room, member.id);
    expect(second.share.createdAt.getTime()).toBeGreaterThan(first.share.createdAt.getTime());
  });

  test('leaving stops the next read and rejoining does not restore old consent', async () => {
    const room = await makeRoom();
    const own = await calendar(member.space);
    await ok(share(room, own));
    await resolveRoomCalendarShare(database().sql, room, member.id);
    await ok(send(member.cookie, `/rooms/${room}/members/${member.id}`, 'DELETE'));
    await expect(resolveRoomCalendarShare(database().sql, room, member.id)).rejects.toMatchObject({
      code: 'scope_denied',
    });
    await ok(
      send(owner.cookie, `/rooms/${room}/members`, 'POST', { principal_id: member.id }),
      201,
    );
    await expect(resolveRoomCalendarShare(database().sql, room, member.id)).rejects.toMatchObject({
      code: 'scope_denied',
    });
    expect(
      roomCalendarShareSettings.parse(await ok(send(member.cookie, path(room)))).share,
    ).toBeNull();
    await ok(share(room, own));
    await resolveRoomCalendarShare(database().sql, room, member.id);
  });

  test('a disabled connection or removed personal space stops reads immediately', async () => {
    const room = await makeRoom();
    const own = await calendar(member.space);
    await ok(share(room, own));
    await database().sql`update connection set status = 'revoked' where id = ${own}`;
    await expect(resolveRoomCalendarShare(database().sql, room, member.id)).rejects.toMatchObject({
      code: 'scope_denied',
    });
    await database().sql`update connection set status = 'active' where id = ${own}`;
    await database().sql`update space set removed_at = now() where id = ${member.space}`;
    try {
      await expect(resolveRoomCalendarShare(database().sql, room, member.id)).rejects.toMatchObject(
        { code: 'scope_denied' },
      );
    } finally {
      await database().sql`update space set removed_at = null where id = ${member.space}`;
    }
  });

  test('calendar share routes are absent when multiplayer is switched off', async () => {
    const room = await makeRoom();
    const disabled = createApp({
      ...database().deps,
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: directory }),
    });
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await disabled.request(path(room), {
        method,
        headers: { Cookie: member.cookie, 'Content-Type': 'application/json' },
        ...(method === 'PUT'
          ? { body: JSON.stringify({ connection_id: recordId('conn'), mode: 'freebusy' }) }
          : {}),
      });
      expect(response.status).toBe(404);
    }
  });
});
