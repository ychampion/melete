/**
 * Owners and admins, against Postgres.
 *
 * - A room's owner can make someone in it an owner, who then runs the room as
 *   its maker does, or make an owner a member again. The room always keeps an
 *   owner, its maker always stays one, and what is the maker's (the room
 *   itself, a connection kept for them) stays theirs.
 * - The account that set Melete up can make another person's account an
 *   admin, who provisions accounts and chooses the model. Nobody else grants
 *   admin, and nobody changes the setup owner.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountAdminResponse,
  accountList,
  accountRemovalPreview,
  modelSettingsResponse,
  roomDetail,
  roomMembershipResponse,
} from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { ownedSpaces } from '../../src/account/export.ts';
import { AccountRemovalService } from '../../src/account/removal.ts';
import { recordId } from '../../src/broker/records.ts';
import { loadEnv } from '../../src/env.ts';
import { removeJobs } from '../../src/experience/removal.ts';
import { createApp } from '../../src/index.ts';
import { JobService } from '../../src/jobs/service.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import { PrincipalService } from '../../src/principals/service.ts';
import { SpaceRemovalService } from '../../src/spaces/removal.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-room-owners-'));
const spacesRoot = join(root, 'spaces');
const workRoot = join(root, 'work');
await mkdir(spacesRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });
afterAll(async () => {
  await handle?.close();
  await rm(root, { recursive: true, force: true });
}, 30_000);
const withDb = handle ? describe : describe.skip;
const password = 'a-long-test-password';

type Person = { id: string; cookie: string };

async function harness() {
  if (!handle) throw new Error('Postgres unavailable');
  const { db, sql } = handle;
  const journal = new FileRestrictionJournal(join(root, 'journal.jsonl'));
  await journal.initializeNew();
  const jobs = new JobService(db, {} as PgBoss);
  const removals = new SpaceRemovalService({
    db,
    sql,
    jobs,
    journal,
    roots: { spacesRoot, workRoot },
    leaseMs: 5_000,
    blobs: new LocalBlobStore(join(root, 'blobs')),
  });
  const accounts = new AccountRemovalService({
    sql,
    spaces: removals,
    principals: new PrincipalService(db, spacesRoot, jobs),
    log: () => {},
    removeChats: (ids) => removeJobs({ jobs, sql }, ids),
  });
  const app = createApp({
    db,
    sql,
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_SPACES_DIR: spacesRoot,
      MELETE_WORK_DIR: workRoot,
      MELETE_PREVIEW_MULTIPLAYER: 'true',
    }),
    checkDatabase: async () => 'ok',
    jobs,
    removals,
    accountRemovals: accounts,
  });
  const call = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const cookieOf = (response: Response) => {
    const value = response.headers.get('set-cookie')?.split(';')[0];
    if (!value) throw new Error(`no session (${response.status})`);
    return value;
  };
  const setup = await call('', '/setup', 'POST', { email: 'alice@example.test', password });
  const [ownerRow] = await sql<{ id: string }[]>`select id from owner limit 1`;
  if (!ownerRow) throw new Error('no setup owner');
  const alice: Person = { id: ownerRow.id, cookie: cookieOf(setup) };
  /** An account the setup owner makes, signed in. */
  const person = async (email: string): Promise<Person> => {
    const made = await call(alice.cookie, '/principals', 'POST', { email, password });
    expect(made.status).toBe(201);
    const { principal } = (await made.json()) as { principal: { id: string } };
    return {
      id: principal.id,
      cookie: cookieOf(await call('', '/login', 'POST', { email, password })),
    };
  };
  return { app, call, sql, alice, person };
}

const h = handle ? await harness() : null;

function world() {
  if (!h) throw new Error('Postgres unavailable');
  return h;
}
async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answered = await response;
  const text = await answered.text();
  expect([answered.status, text.slice(0, 300)]).toEqual([status, text.slice(0, 300)]);
  return JSON.parse(text) as T;
}
async function refused(response: Response | Promise<Response>, status: number, code: string) {
  const answered = await response;
  const text = await answered.text();
  expect([answered.status, text.slice(0, 300)]).toEqual([status, text.slice(0, 300)]);
  expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(code);
}
async function makeRoom(maker: Person, name: string) {
  const made = roomDetail.parse(
    await ok(world().call(maker.cookie, '/rooms', 'POST', { name }), 201),
  );
  return made.room.id;
}
async function add(by: Person, roomId: string, who: Person, role?: 'owner' | 'member') {
  return world().call(by.cookie, `/rooms/${roomId}/members`, 'POST', {
    principal_id: who.id,
    ...(role ? { role } : {}),
  });
}
async function setRole(by: Person, roomId: string, who: string, role: 'owner' | 'member') {
  return world().call(by.cookie, `/rooms/${roomId}/members/${who}`, 'PATCH', { role });
}
async function generationOf(roomId: string, principalId: string) {
  const [row] = await world().sql<{ generation: number; role: string }[]>`select generation, role
    from space_membership where space_id = ${roomId} and principal_id = ${principalId}`;
  if (!row) throw new Error('no membership');
  return row;
}

withDb('room owners', () => {
  test('an owner makes someone an owner, who then runs the room as its maker does', async () => {
    const { alice, person, call } = world();
    const bob = await person('bob@example.test');
    const carol = await person('carol@example.test');
    const roomId = await makeRoom(alice, 'Launch');

    // Added straight in as an owner.
    const added = roomMembershipResponse.parse(await ok(add(alice, roomId, bob, 'owner'), 201));
    expect(added.member).toMatchObject({ principal_id: bob.id, role: 'owner', made_room: false });
    const seen = roomDetail.parse(await ok(call(bob.cookie, `/rooms/${roomId}`)));
    expect(seen.room.my_role).toBe('owner');
    expect(seen.members.find((member) => member.principal_id === alice.id)).toMatchObject({
      role: 'owner',
      made_room: true,
    });

    // The new owner adds people as the maker does; a plain member changes nobody's role.
    expect(roomMembershipResponse.parse(await ok(add(bob, roomId, carol), 201)).member.role).toBe(
      'member',
    );
    await refused(setRole(carol, roomId, bob.id, 'member'), 403, 'scope_denied');
    await refused(setRole(carol, roomId, carol.id, 'owner'), 403, 'scope_denied');

    // Each change of role moves that person's membership generation on, and nobody else's.
    const before = await generationOf(roomId, carol.id);
    const aliceBefore = await generationOf(roomId, alice.id);
    const promoted = roomMembershipResponse.parse(
      await ok(setRole(bob, roomId, carol.id, 'owner')),
    );
    expect(promoted.member.role).toBe('owner');
    expect(await generationOf(roomId, carol.id)).toEqual({
      role: 'owner',
      generation: before.generation + 1,
    });
    expect(await generationOf(roomId, alice.id)).toEqual(aliceBefore);
    // Asking for the role someone already has changes nothing.
    await ok(setRole(bob, roomId, carol.id, 'owner'));
    expect((await generationOf(roomId, carol.id)).generation).toBe(before.generation + 1);
    await ok(setRole(carol, roomId, carol.id, 'member'));
    expect(await generationOf(roomId, carol.id)).toEqual({
      role: 'member',
      generation: before.generation + 2,
    });
    // Adding someone already in the room with the other role changes it.
    expect(
      roomMembershipResponse.parse(await ok(add(bob, roomId, carol, 'owner'), 201)).member.role,
    ).toBe('owner');

    // The maker stays an owner: nobody makes them a member, they cannot step
    // down themselves, and no other owner removes them.
    await refused(setRole(bob, roomId, alice.id, 'member'), 409, 'room_maker');
    await refused(setRole(alice, roomId, alice.id, 'member'), 409, 'room_maker');
    await refused(
      call(bob.cookie, `/rooms/${roomId}/members/${alice.id}`, 'DELETE'),
      403,
      'scope_denied',
    );

    // Owners other than the maker can be removed, and can leave.
    await ok(call(bob.cookie, `/rooms/${roomId}/members/${carol.id}`, 'DELETE'));
    await ok(call(bob.cookie, `/rooms/${roomId}/members/${bob.id}`, 'DELETE'));
    // Someone who comes back gets the role they are given now.
    expect(
      roomMembershipResponse.parse(await ok(add(alice, roomId, carol, 'owner'), 201)).member.role,
    ).toBe('owner');
    expect(roomMembershipResponse.parse(await ok(add(alice, roomId, bob), 201)).member.role).toBe(
      'member',
    );
  });

  test('a room keeps an owner: its last one cannot become a member', async () => {
    const { alice, person, sql } = world();
    const dan = await person('dan@example.test');
    const roomId = await makeRoom(alice, 'Garden');
    await ok(add(alice, roomId, dan, 'owner'), 201);
    // A room whose maker no longer holds it as an owner, as older records can have.
    await sql`update space_membership set role = 'member'
      where space_id = ${roomId} and principal_id = ${alice.id}`;
    await refused(setRole(dan, roomId, dan.id, 'member'), 409, 'last_owner');
    expect((await generationOf(roomId, dan.id)).role).toBe('owner');
  });

  test('what is the maker’s stays theirs: the room itself and a connection kept for them', async () => {
    const { alice, person, call, sql } = world();
    const erin = await person('erin@example.test');
    const roomId = await makeRoom(alice, 'Studio');
    await ok(add(alice, roomId, erin, 'owner'), 201);

    // Another owner does not remove the room for everyone.
    await refused(
      call(erin.cookie, `/spaces/${roomId}`, 'DELETE', { confirm_name: 'Studio' }),
      403,
      'scope_denied',
    );
    expect(await sql`select 1 from space where id = ${roomId} and removed_at is null`).toHaveLength(
      1,
    );

    // A connection kept for the maker serves only their work, so only they see or share it.
    const kept = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
      values (${kept}, ${roomId}, 'notes', 'Alice’s notes', '[]'::jsonb, 'owner')`;
    const listed = async (who: Person) =>
      (
        await ok<{ connections: Array<{ id: string }> }>(
          call(who.cookie, `/rooms/${roomId}/connections`),
        )
      ).connections.map((row) => row.id);
    expect(await listed(alice)).toContain(kept);
    expect(await listed(erin)).not.toContain(kept);
    await refused(
      call(erin.cookie, `/rooms/${roomId}/connections/${kept}`, 'PUT', { shared_use: 'room' }),
      403,
      'scope_denied',
    );

    // The room is not one the other owner's account owns: deleting their
    // account leaves it, and their export does not carry it.
    expect((await ownedSpaces(sql, erin.id)).map((space) => space.id)).not.toContain(roomId);
    expect((await ownedSpaces(sql, alice.id)).map((space) => space.id)).toContain(roomId);
    const preview = accountRemovalPreview.parse(
      (await ok<{ preview: unknown }>(call(erin.cookie, '/account/removal/preview'))).preview,
    );
    expect(preview.rooms_left.map((room) => room.id)).toContain(roomId);
    expect(preview.spaces.map((space) => space.id)).not.toContain(roomId);
  });
});

withDb('admins', () => {
  test('the setup owner makes an admin, who adds accounts and chooses the model', async () => {
    const { alice, person, call, sql } = world();
    const fran = await person('fran@example.test');
    const gil = await person('gil@example.test');

    // Before: an ordinary account does none of it.
    await refused(
      call(gil.cookie, '/principals', 'POST', { email: 'hana@example.test', password }),
      403,
      'scope_denied',
    );
    expect((await call(gil.cookie, '/principals')).status).toBe(403);
    await refused(
      call(gil.cookie, `/principals/${fran.id}`, 'PATCH', { admin: true }),
      403,
      'scope_denied',
    );
    await refused(
      call(gil.cookie, '/model-settings/default', 'PUT', { provider: 'openai', model: 'any' }),
      403,
      'owner_required',
    );

    const made = accountAdminResponse.parse(
      await ok(call(alice.cookie, `/principals/${fran.id}`, 'PATCH', { admin: true })),
    );
    expect(made.account).toEqual({ id: fran.id, admin: true });

    // An admin provisions an account and sees the list, with who is an admin.
    await ok(
      call(fran.cookie, '/principals', 'POST', { email: 'hana@example.test', password }),
      201,
    );
    const listed = accountList.parse(await ok(call(fran.cookie, '/principals')));
    const of = (id: string) => listed.accounts.find((account) => account.id === id);
    expect(of(alice.id)).toMatchObject({ setup_owner: true, admin: true });
    expect(of(fran.id)).toMatchObject({ setup_owner: false, admin: true });
    expect(of(gil.id)).toMatchObject({ admin: false });
    expect(listed.accounts.some((account) => account.email === 'hana@example.test')).toBe(true);

    // An admin gets past the model's owner check, and is told they may edit it.
    const chose = await call(fran.cookie, '/model-settings/default', 'PUT', {
      provider: 'openai',
      model: 'any',
    });
    expect(chose.status).not.toBe(403);
    await chose.text();
    expect(
      modelSettingsResponse.parse(await ok(call(fran.cookie, '/model-settings'))).can_edit,
    ).toBe(true);
    expect(
      modelSettingsResponse.parse(await ok(call(gil.cookie, '/model-settings'))).can_edit,
    ).toBe(false);
    // The secondary model stays the setup owner's own.
    await refused(
      call(fran.cookie, '/model-settings/secondary', 'PUT', { provider: 'openai', model: 'any' }),
      403,
      'owner_required',
    );

    // An admin grants nobody admin, and cannot change the setup owner.
    await refused(
      call(fran.cookie, `/principals/${gil.id}`, 'PATCH', { admin: true }),
      403,
      'scope_denied',
    );
    await refused(
      call(fran.cookie, `/principals/${alice.id}`, 'PATCH', { admin: false }),
      403,
      'scope_denied',
    );
    // Nor does an admin delete accounts; that stays with the setup owner.
    expect(
      (
        await call(fran.cookie, `/principals/${gil.id}`, 'DELETE', {
          confirm_email: 'gil@example.test',
        })
      ).status,
    ).toBe(404);
    // The setup owner is always an admin.
    await refused(
      call(alice.cookie, `/principals/${alice.id}`, 'PATCH', { admin: false }),
      409,
      'setup_owner',
    );

    // Only a person's account that can sign in is made an admin.
    const roomId = await makeRoom(alice, 'Kitchen');
    const [agent] = await sql<{ principal_id: string }[]>`select principal_id
      from space_membership where space_id = ${roomId} and role = 'agent'`;
    await refused(
      call(alice.cookie, `/principals/${agent?.principal_id}`, 'PATCH', { admin: true }),
      404,
      'not_found',
    );
    await sql`update principal set disabled_at = now() where id = ${gil.id}`;
    await refused(
      call(alice.cookie, `/principals/${gil.id}`, 'PATCH', { admin: true }),
      404,
      'not_found',
    );

    // Taken away, it stops at once.
    expect(
      accountAdminResponse.parse(
        await ok(call(alice.cookie, `/principals/${fran.id}`, 'PATCH', { admin: false })),
      ).account.admin,
    ).toBe(false);
    await refused(
      call(fran.cookie, '/principals', 'POST', { email: 'ivo@example.test', password }),
      403,
      'scope_denied',
    );
    expect((await call(fran.cookie, '/principals')).status).toBe(403);
  });

  test('an admin whose account is disabled administers nothing', async () => {
    const { alice, person, call, sql } = world();
    const jo = await person('jo@example.test');
    await ok(call(alice.cookie, `/principals/${jo.id}`, 'PATCH', { admin: true }));
    await sql`update principal set disabled_at = now() where id = ${jo.id}`;
    const listed = accountList.parse(await ok(call(alice.cookie, '/principals')));
    expect(listed.accounts.find((account) => account.id === jo.id)?.admin).toBe(false);
  });
});
