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
import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';
import { ownedSpaces } from '../../src/account/export.ts';
import { AccountRemovalService } from '../../src/account/removal.ts';
import { ServiceError } from '../../src/api/errors.ts';
import { mountTriggers } from '../../src/api/triggers.ts';
import { recordId } from '../../src/broker/records.ts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { SecretAccess } from '../../src/connectors/secrets.ts';
import { loadEnv } from '../../src/env.ts';
import { removeJobs } from '../../src/experience/removal.ts';
import { createApp } from '../../src/index.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { JobService } from '../../src/jobs/service.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import { principalContext, spaceStanding } from '../../src/principals/authority.ts';
import { PrincipalService } from '../../src/principals/service.ts';
import { selectedSpace } from '../../src/principals/session-space.ts';
import { mountSms } from '../../src/sms/routes.ts';
import { SpaceRemovalService } from '../../src/spaces/removal.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-room-owners-'));
const spacesRoot = join(root, 'spaces');
const workRoot = join(root, 'work');
await mkdir(spacesRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });
const registry = new ConnectorRegistry();
/** Every request made of Twilio. None should be: nothing here installs a number. */
const twilioCalls: string[] = [];
const MASTER_KEY = '7c'.repeat(32);
afterAll(async () => {
  await registry.close();
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
  useConnectorFactory(
    registry,
    new ConnectorFactory({
      sql,
      workRoot,
      spacesRoot,
      masterKey: MASTER_KEY,
      twilio: {
        fetch: async (input) => {
          twilioCalls.push(String(input));
          return new Response('', { status: 401 });
        },
      },
    }),
  );
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
      MELETE_MASTER_KEY: MASTER_KEY,
    }),
    checkDatabase: async () => 'ok',
    jobs,
    removals,
    accountRemovals: accounts,
    registry,
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
  return { app, call, db, sql, jobs, alice, person };
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

  test('outside the room’s own routes, an owner the maker added works there as a member does', async () => {
    const { alice, person, db, sql } = world();
    const kim = await person('kim@example.test');
    const roomId = await makeRoom(alice, 'Workshop');
    await ok(add(alice, roomId, kim, 'owner'), 201);
    const selection = async (who: Person) =>
      selectedSpace(db, who.id, {
        spaceId: roomId,
        generation: (await generationOf(roomId, who.id)).generation,
      });

    // A session in the room: the owner's surfaces there (home, tasks, every
    // conversation) are the maker's alone.
    expect((await selection(alice))?.role).toBe('owner');
    expect((await selection(kim))?.role).toBe('member');

    // The skills a run is handed: a private one is the maker's.
    expect(await spaceStanding(sql, roomId, alice.id)).toEqual({ role: 'owner', owns: true });
    expect(await spaceStanding(sql, roomId, kim.id)).toEqual({ role: 'owner', owns: false });

    // A number kept for the maker: only they read its texts. One that serves
    // the room, any owner reads.
    const texts = new Hono();
    texts.onError((error, c) =>
      error instanceof ServiceError
        ? c.json({ error: { code: error.code } }, error.status)
        : c.json({ error: { code: 'internal' } }, 500),
    );
    texts.use(async (c, next) => {
      c.set('owner' as never, { id: c.req.header('x-as') } as never);
      await next();
    });
    mountSms(texts, { db, sql, secrets: {} as SecretAccess });
    const read = (who: Person, id: string) =>
      texts.request(`/connections/${id}/texts`, { headers: { 'x-as': who.id } });
    const number = async (sharedUse: 'owner' | 'room') => {
      const id = recordId('conn');
      await sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
        values (${id}, ${roomId}, 'twilio', 'Phone', '[]'::jsonb, ${sharedUse})`;
      return id;
    };
    const kept = await number('owner');
    const shared = await number('room');
    await ok(read(alice, kept));
    await refused(read(kim, kept), 403, 'scope_denied');
    await ok(read(kim, shared));
  });

  test('a connection kept for the maker is theirs to open, test and change, by its id too', async () => {
    const { alice, person, call, sql, jobs } = world();
    const lee = await person('lee@example.test');
    const roomId = await makeRoom(alice, 'Archive');
    await ok(add(alice, roomId, lee, 'owner'), 201);
    const connectionIn = async (sharedUse: 'owner' | 'room') => {
      const id = recordId('conn');
      await sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
        values (${id}, ${roomId}, 'notes', 'Notes', '[]'::jsonb, ${sharedUse})`;
      return id;
    };
    const kept = await connectionIn('owner');
    const shared = await connectionIn('room');
    const [{ generation } = { generation: 0 }] = await sql<{ generation: number }[]>`
      select generation from connection where id = ${kept}`;

    // The maker opens it; the owner they added does not, whatever the route.
    await ok(call(alice.cookie, `/connections/${kept}`));
    await refused(call(lee.cookie, `/connections/${kept}`), 403, 'scope_denied');
    await refused(call(lee.cookie, `/connections/${kept}/health`, 'POST'), 403, 'scope_denied');
    await refused(
      call(lee.cookie, `/connections/${kept}/lifecycle`, 'POST', {
        kind: 'revoke',
        expected_generation: generation,
      }),
      403,
      'scope_denied',
    );
    // Asked of the service directly, as other callers do, the answer is the same.
    const asked = principalContext.run(lee.id, () =>
      new PolicyService(jobs).changeConnection(kept, {
        kind: 'revoke',
        expected_generation: generation,
      }),
    );
    expect(
      await asked.then(
        () => 'changed',
        (error: ServiceError) => error.code,
      ),
    ).toBe('scope_denied');
    const [after] = await sql`select status from connection where id = ${kept}`;
    expect(after?.status).not.toBe('revoked');

    // A connection that serves the room is any owner's to open.
    await ok(call(lee.cookie, `/connections/${shared}`));

    // Events from a connection are delivered into its feed only by someone who manages it.
    const events = new Hono();
    events.onError((error, c) =>
      error instanceof ServiceError
        ? c.json({ error: { code: error.code } }, error.status)
        : c.json({ error: { code: 'internal' } }, 500),
    );
    events.use(async (c, next) => {
      c.set('owner' as never, { id: c.req.header('x-as') } as never);
      await next();
    });
    const delivered = { seq: 1, duplicate: false };
    mountTriggers(events, { deliver: async () => delivered } as never, world().db);
    const deliver = (who: Person, connectionId: string) =>
      events.request('/internal/events/deliver', {
        method: 'POST',
        headers: { 'x-as': who.id, 'content-type': 'application/json' },
        body: JSON.stringify({
          connection_id: connectionId,
          event_name: 'note.added',
          cursor: '1',
          dedup_key: `${who.id}-${connectionId}`,
          payload: {},
        }),
      });
    await refused(deliver(lee, kept), 403, 'scope_denied');
    expect(await ok<typeof delivered>(deliver(alice, kept), 202)).toEqual(delivered);
    expect(await ok<typeof delivered>(deliver(lee, shared), 202)).toEqual(delivered);
  });

  test('only the maker adds a texting number to a room, since texts to it speak as the maker', async () => {
    const { alice, person, call, sql } = world();
    const max = await person('max@example.test');
    const roomId = await makeRoom(alice, 'Phones');
    await ok(add(alice, roomId, max, 'owner'), 201);
    await refused(
      call(max.cookie, '/connections', 'POST', {
        space_id: roomId,
        provider: 'twilio',
        label: 'My phone',
        credentials: {
          account_sid: `AC${'5a'.repeat(16)}`,
          auth_token: 'b7'.repeat(16),
          from_number: '+15550002222',
        },
        sms: { allowed_numbers: ['+15557650000'] },
      }),
      403,
      'scope_denied',
    );
    // Refused before anything in the request is acted on.
    expect(twilioCalls).toEqual([]);
    expect(
      await sql`select 1 from connection where space_id = ${roomId} and provider = 'twilio'`,
    ).toHaveLength(0);
  });

  test('adding an owner again without a role leaves them an owner', async () => {
    const { alice, person, call } = world();
    const nia = await person('nia@example.test');
    const roomId = await makeRoom(alice, 'Library');
    await ok(add(alice, roomId, nia, 'owner'), 201);
    const before = await generationOf(roomId, nia.id);
    expect(roomMembershipResponse.parse(await ok(add(alice, roomId, nia), 201)).member.role).toBe(
      'owner',
    );
    await ok(
      call(alice.cookie, `/spaces/${roomId}/memberships`, 'POST', { principal_id: nia.id }),
      201,
    );
    expect(await generationOf(roomId, nia.id)).toEqual(before);
    // Someone new, added without a role, is a member.
    const ola = await person('ola@example.test');
    expect(roomMembershipResponse.parse(await ok(add(alice, roomId, ola), 201)).member.role).toBe(
      'member',
    );
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
