/**
 * Guests. An owner invites someone by email; the link works once and names
 * only the room. A guest reads and posts in the rooms they were invited to,
 * never answers a permission, has no people list and no work of their own,
 * and leaves when the invite's time is up, through the same path as a
 * removal. Nobody in a room is labelled with their email, so a guest never
 * reads one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  type CapabilityClaims,
  type ConnectorManifest,
  type DispatchResult,
  inviteView,
  roomDetail,
  roomInviteCreated,
  roomInviteList,
  roomList,
  roomMessageResponse,
  roomThreadView,
} from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { loadEnv } from '../../src/env.ts';
import { type AppDeps, createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { mcpServerAddresses, OAuthStore } from '../../src/mcp-server/oauth.ts';
import { PrincipalService } from '../../src/principals/service.ts';
import { ensurePersonalSpace } from '../../src/principals/session-space.ts';
import { roomHandle } from '../../src/rooms/transcript.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-room-guests-'));
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'room-guests-signing-key-32-bytes!!',
      liveConnectionScopes: true,
    })
  : null;
const broker = handle ? new BrokerService({ sql: handle.sql, connectors: registry }) : null;
const PUBLIC_URL = 'https://melete.example';
const app =
  handle && jobs && runner && broker
    ? createApp({
        env: loadEnv({
          NODE_ENV: 'test',
          MELETE_SPACES_DIR: directory,
          MELETE_PUBLIC_URL: PUBLIC_URL,
        }),
        db: handle.db,
        sql: handle.sql,
        jobs,
        runner,
        broker,
        registry,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';

function database() {
  if (!handle || !queue || !app || !jobs || !runner || !broker)
    throw new Error('Postgres unavailable');
  return { ...handle, app, jobs, runner, broker };
}
function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}
async function send(cookie: string, path: string, method = 'GET', body?: unknown) {
  return database().app.request(path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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
  expect([answered.status, text.slice(0, 200)]).toEqual([status, text.slice(0, 200)]);
  expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(code);
}
async function login(email: string) {
  return sessionCookie(
    await database().app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
}
const submission = () => `s${randomBytes(8).toString('hex')}`;

type Person = { id: string; cookie: string };
let alice: Person;
let bob: Person;
let carol: Person;

/**
 * Every route the service serves when every part of it is set up, read the way
 * the published API document is checked: each dependency is a stand-in that is
 * never called.
 */
function everyRoute(): Array<{ method: string; path: string }> {
  const stub = new Proxy({}, { get: () => () => undefined }) as never;
  const deps: AppDeps = {
    env: loadEnv({ MELETE_PUBLIC_URL: PUBLIC_URL }),
    checkDatabase: async () => 'ok',
    db: stub,
    sql: stub,
    registry: stub,
    jobs: stub,
    triggers: stub,
    approvals: stub,
    events: stub,
    proposer: stub,
    evaluator: stub,
    browserSessions: stub,
    sandboxComputers: stub,
    sandboxPreviews: stub,
    memory: stub,
    removals: stub,
    broker: stub,
  };
  const seen = new Set<string>();
  return createApp(deps)
    .routes.filter((route) => route.method !== 'ALL')
    .filter((route) => {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((route) => ({ method: route.method, path: route.path }));
}

/**
 * What a guest's sign-in reaches, by design: their rooms, their own account and
 * linked chat accounts, signing out and changing their password, a room's
 * files, and watching a room's computer. Everything else is refused before it
 * runs.
 */
const GUEST_ROUTES = [
  /^(GET|POST|PUT|PATCH|DELETE) \/rooms(\/.*)?$/,
  /^(GET|PATCH) \/me$/,
  /^GET \/me\/linked-accounts$/,
  /^DELETE \/me\/linked-accounts\/:[A-Za-z_]+\/:[A-Za-z_]+$/,
  /^POST \/(signout|account\/password)$/,
  /^GET \/artifacts\/:id\/content$/,
  /^POST \/sandbox\/sessions\/:id\/live(\/close)?$/,
  /^GET \/sandbox\/sessions\/:id\/live\/frames$/,
];
/**
 * Routes that read no sign-in at all, so a guest's is never used there: setup
 * and sign-in, invites, the MCP server's public routes, a paired computer's own
 * routes, and an app's or a preview's files, each authorised by its own token.
 */
const SIGNED_OUT_ROUTES = [
  /^GET \/(health|health\/detail|setup)$/,
  /^POST \/(setup|login|password-reset|password-reset\/consume)$/,
  /^POST \/signin\/[a-z-]+(\/consume)?$/,
  /^POST \/invites\/(view|accept)$/,
  /^GET \/oauth\/client-metadata\.json$/,
  /^GET \/\.well-known\//,
  /^(GET|POST|DELETE) \/mcp(\/.*)?$/,
  /^(GET|POST) \/oauth\/(authorize|token|register|revoke)$/,
  /^(GET|POST|PUT|DELETE) \/device\//,
  /^GET \/(apps\/view|previews)\//,
];

async function makeRoom(name: string) {
  const made = roomDetail.parse(await ok(send(alice.cookie, '/rooms', 'POST', { name }), 201));
  await ok(
    send(alice.cookie, `/rooms/${made.room.id}/members`, 'POST', { principal_id: bob.id }),
    201,
  );
  return made.room.id;
}
function tokenOf(path: string): string {
  const token = new URLSearchParams(path.split('?')[1] ?? '').get('token');
  if (!token) throw new Error(`No token in ${path}`);
  return token;
}
async function invite(roomId: string, email: string, days?: number) {
  return roomInviteCreated.parse(
    await ok(
      send(alice.cookie, `/rooms/${roomId}/invites`, 'POST', {
        email,
        ...(days ? { expires_in_days: days } : {}),
      }),
      201,
    ),
  );
}
async function accept(token: string, extra: Record<string, unknown> = {}, cookie = '') {
  return send(cookie, '/invites/accept', 'POST', { token, ...extra });
}
/** A new guest, invited into a room and signed in from the link. */
async function guestIn(roomId: string, email: string, days?: number): Promise<Person> {
  const made = await invite(roomId, email, days);
  const accepted = await accept(tokenOf(made.path), { password, display_name: undefined });
  const cookie = sessionCookie(accepted);
  const body = (await accepted.json()) as { room_id: string };
  expect(body.room_id).toBe(roomId);
  const me = await ok<{ owner: { id: string; kind: string } }>(send(cookie, '/me'));
  expect(me.owner.kind).toBe('guest');
  return { id: me.owner.id, cookie };
}
async function claim(jobId: string) {
  const { sql, runner } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  const claimed = await runner.claim({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
  if (!claimed) throw new Error(`Request ${jobId} could not be claimed`);
  return claimed;
}
async function roomGeneration(roomId: string) {
  const [row] = await database().sql`select generation from space_membership
    where space_id = ${roomId} and role = 'agent'`;
  return Number(row?.generation);
}
/** Read a live stream until it ends, or give up after `ms`. */
async function readUntilClosed(response: Response, ms: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No stream');
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => 'timeout' as const),
    ]);
    if (next === 'timeout') break;
    if (next.done) return true;
  }
  await reader.cancel();
  return false;
}

/** Something a room's agent can only do with a person's permission: post notes to people. */
const notesManifest: ConnectorManifest = {
  name: 'notes',
  version: '0.1.0',
  provider: 'test',
  description: 'Post meeting notes to people.',
  credentials: [],
  health: false,
  tools: [
    {
      name: 'notes.post',
      description: 'Post notes to the people named.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'body'],
        properties: { to: { type: 'array', items: { type: 'string' } }, body: { type: 'string' } },
      },
      effect_class: 'write_external',
      required_scopes: ['notes.post'],
      verify: false,
      requires_approval: true,
    },
  ],
};
function notesConnector(): Connector {
  return {
    manifest: notesManifest,
    async execute(action: Action): Promise<DispatchResult> {
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          late: false,
          received_at: new Date().toISOString(),
          detail: {},
        },
      };
    },
    async verify() {
      return { decision: 'unsupported', reason: 'fixture' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
}
async function installNotes(spaceId: string, sharedUse: 'owner' | 'room', label: string) {
  const id = recordId('conn');
  await database().sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
    values (${id}, ${spaceId}, ${notesManifest.provider}, ${label},
      ${JSON.stringify(['notes.post'])}::jsonb, ${sharedUse})`;
  registry.register(id, notesConnector());
  return id;
}

withDb('room guests', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  // Alice set the installation up; Bob and Carol are people with accounts.
  beforeAll(async () => {
    const { app } = database();
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password }),
    });
    expect(setup.status).toBe(201);
    alice = {
      id: ((await setup.clone().json()) as { owner: { id: string } }).owner.id,
      cookie: sessionCookie(setup),
    };
    const people: Person[] = [];
    for (const name of ['bob', 'carol']) {
      const made = await ok<{ principal: { id: string } }>(
        send(alice.cookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      );
      people.push({ id: made.principal.id, cookie: await login(`${name}@example.test`) });
    }
    [bob, carol] = people as [Person, Person];
    for (const [person, name] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
      [carol, 'Carol'],
    ] as const)
      await ok(send(person.cookie, '/me', 'PATCH', { display_name: name }));
  }, 60_000);

  test('an invite works once, expires, and names only the room', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Launch');
    // Only an owner invites; someone outside the room finds no room at all.
    await refused(
      send(bob.cookie, `/rooms/${roomId}/invites`, 'POST', { email: 'dan@guest.example' }),
      403,
      'scope_denied',
    );
    await refused(
      send(carol.cookie, `/rooms/${roomId}/invites`, 'POST', { email: 'dan@guest.example' }),
      404,
      'not_found',
    );
    // Someone with a full account is added from People instead.
    await refused(
      send(alice.cookie, `/rooms/${roomId}/invites`, 'POST', { email: 'Carol@example.test' }),
      409,
      'person_account',
    );

    const made = await invite(roomId, 'Dan@Guest.example', 7);
    expect(made.invite).toMatchObject({ email: 'dan@guest.example', state: 'open' });
    const token = tokenOf(made.path);
    expect(made.path).toBe(`/#/invite?token=${token}`);
    expect(made.link).toBe(`${PUBLIC_URL}/#/invite?token=${token}`);
    const days = (Date.parse(made.invite.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    // Only the token's hash is kept, and nothing else of it.
    const [stored] = await sql`select token_hash from room_invite where id = ${made.invite.id}`;
    expect(stored?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    const [anywhere] = await sql`select count(*)::int as n from room_invite
      where position(${token} in row_to_json(room_invite)::text) > 0`;
    expect(anywhere?.n).toBe(0);

    // Before it is accepted, the link names the room and nothing about its people.
    const opened = await send('', '/invites/view', 'POST', { token });
    const openedText = await opened.text();
    expect(opened.status).toBe(200);
    expect(inviteView.parse(JSON.parse(openedText))).toEqual({
      room_name: 'Launch',
      expires_at: made.invite.expires_at,
      existing_account: false,
    });
    for (const secret of ['alice', 'bob', 'Alice', 'Bob', 'dan@', alice.id, bob.id])
      expect(openedText).not.toContain(secret);

    // A new account needs a password; then the link signs the guest in, once.
    await refused(accept(token), 400, 'password_required');
    const accepted = await accept(token, { password, display_name: 'Dan' });
    expect(accepted.status).toBe(200);
    const dan = { cookie: sessionCookie(accepted), id: '' };
    expect(((await accepted.json()) as { room_id: string }).room_id).toBe(roomId);
    const me = await ok<{ owner: { id: string; email: string; kind: string } }>(
      send(dan.cookie, '/me'),
    );
    expect(me.owner).toMatchObject({ email: 'dan@guest.example', kind: 'guest' });
    dan.id = me.owner.id;
    const rooms = roomList.parse(await ok(send(dan.cookie, '/rooms')));
    expect(rooms.rooms.map((room) => [room.name, room.my_role])).toEqual([['Launch', 'guest']]);
    // Used once: the same link opens nothing and accepts nothing.
    await refused(send('', '/invites/view', 'POST', { token }), 404, 'invite_unavailable');
    await refused(accept(token, { password }), 404, 'invite_unavailable');
    await refused(accept(token, {}, dan.cookie), 404, 'invite_unavailable');
    const listed = roomInviteList.parse(await ok(send(alice.cookie, `/rooms/${roomId}/invites`)));
    expect(listed.invites.map((entry) => [entry.id, entry.state])).toEqual([
      [made.invite.id, 'accepted'],
    ]);
    // The guest's place ends when the invite's time does.
    const detail = roomDetail.parse(await ok(send(alice.cookie, `/rooms/${roomId}`)));
    expect(detail.members.find((member) => member.principal_id === dan.id)?.expires_at).toBe(
      made.invite.expires_at,
    );

    // A second room's invite to the same email reaches the same account, only
    // once that guest is signed in: a link never sets an existing password.
    const second = await makeRoom('Second');
    const again = tokenOf((await invite(second, 'dan@guest.example')).path);
    expect(
      inviteView.parse(await ok(send('', '/invites/view', 'POST', { token: again })))
        .existing_account,
    ).toBe(true);
    await refused(accept(again, { password: 'another-long-password' }), 409, 'sign_in_first');
    await refused(accept(again, {}, carol.cookie), 409, 'sign_in_first');
    await ok(accept(again, {}, dan.cookie));
    expect(
      roomList.parse(await ok(send(dan.cookie, '/rooms'))).rooms.map((room) => room.name),
    ).toEqual(['Launch', 'Second']);
    // The account's password is still the one Dan chose.
    const signIn = await database().app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dan@guest.example', password }),
    });
    expect(signIn.status).toBe(200);

    // An invite past its time, or withdrawn, opens nothing.
    const late = await invite(roomId, 'eve@guest.example');
    await sql`update room_invite set expires_at = now() - interval '1 second' where id = ${late.invite.id}`;
    await refused(
      send('', '/invites/view', 'POST', { token: tokenOf(late.path) }),
      404,
      'invite_unavailable',
    );
    await refused(accept(tokenOf(late.path), { password }), 404, 'invite_unavailable');
    const taken = await invite(roomId, 'fay@guest.example');
    const withdrawn = await ok<{ invite: { state: string } }>(
      send(alice.cookie, `/rooms/${roomId}/invites/${taken.invite.id}`, 'DELETE'),
    );
    expect(withdrawn.invite.state).toBe('withdrawn');
    await refused(accept(tokenOf(taken.path), { password }), 404, 'invite_unavailable');
    await refused(
      send(alice.cookie, `/rooms/${roomId}/invites/${made.invite.id}`, 'DELETE'),
      409,
      'invite_used',
    );
    // Neither made an account.
    const [accounts] = await sql`select count(*)::int as n from principal
      where email in ('eve@guest.example', 'fay@guest.example')`;
    expect(accounts?.n).toBe(0);
  }, 90_000);

  test('a guest reads and posts only in their rooms, and cannot start personal work, list people or decide', async () => {
    const { sql, broker, runner } = database();
    const roomId = await makeRoom('Plans');
    const notes = await installNotes(roomId, 'room', 'Team notes');
    const elsewhere = await makeRoom('Elsewhere');
    const gil = await guestIn(roomId, 'gil@guest.example');
    await ok(send(gil.cookie, '/me', 'PATCH', { display_name: 'Gil' }));

    // Gil reads and posts in the room, and asks its agent: the room lets guests ask.
    const opened = roomMessageResponse.parse(
      await ok(
        send(bob.cookie, `/rooms/${roomId}/threads`, 'POST', {
          text: 'Saturday works for me.',
          submission_id: submission(),
        }),
        201,
      ),
    );
    const threadId = opened.thread.id;
    const said = roomMessageResponse.parse(
      await ok(
        send(gil.cookie, `/rooms/${roomId}/threads/${threadId}/messages`, 'POST', {
          text: '@Melete post the notes to the team',
          submission_id: submission(),
        }),
      ),
    );
    const requestId = said.request_job_id ?? '';
    const [request] = await sql`select requested_by_principal_id, principal_id from job
      where id = ${requestId}`;
    expect(request?.requested_by_principal_id).toBe(gil.id);
    const view = await send(gil.cookie, `/rooms/${roomId}/threads/${threadId}`);
    const viewText = await view.text();
    expect(view.status).toBe(200);
    expect(
      roomThreadView.parse(JSON.parse(viewText)).messages.map((message) => message.text),
    ).toEqual(['Saturday works for me.', '@Melete post the notes to the team']);
    // Nobody is labelled with an email, so a guest reads none: each person is a
    // name and the handle this room gives them.
    expect(viewText).not.toContain('example.test');
    expect(
      roomThreadView.parse(JSON.parse(viewText)).messages.map((message) => message.author),
    ).toEqual([
      { principal_id: bob.id, display_name: `Bob <${roomHandle(roomId, bob.id)}>` },
      { principal_id: gil.id, display_name: `Gil <${roomHandle(roomId, gil.id)}>` },
    ]);
    const detailText = await (await send(gil.cookie, `/rooms/${roomId}`)).text();
    expect(detailText).not.toContain('example.test');
    expect(detailText).not.toContain('guest.example');
    // Members still see each person's email beside them.
    const seenByBob = roomDetail.parse(await ok(send(bob.cookie, `/rooms/${roomId}`)));
    expect(seenByBob.members.find((member) => member.principal_id === gil.id)).toMatchObject({
      email: 'gil@guest.example',
      handle: roomHandle(roomId, gil.id),
      role: 'guest',
    });

    // A file the room's request made is the room's: Gil reads it, as everyone in the room does.
    const text = 'Notes for Saturday.\n';
    await mkdir(join(directory, roomId, 'artifacts'), { recursive: true });
    await writeFile(join(directory, roomId, 'artifacts', 'notes.md'), text);
    const artifactId = recordId('art');
    await sql`insert into artifact
      (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size)
      values (${artifactId}, ${roomId}, ${requestId}, ${requestId}, 'artifacts', 'notes.md',
        'markdown', ${createHash('sha256').update(text).digest('hex')}, 'text/markdown',
        ${Buffer.byteLength(text)})`;
    const read = await send(gil.cookie, `/artifacts/${artifactId}/content`);
    expect([read.status, await read.text()]).toEqual([200, text]);
    expect((await send(carol.cookie, `/artifacts/${artifactId}/content`)).status).toBe(404);

    // Another room is not there for Gil.
    await refused(send(gil.cookie, `/rooms/${elsewhere}`), 404, 'not_found');
    await refused(send(gil.cookie, `/rooms/${elsewhere}/threads`), 404, 'not_found');
    await refused(
      send(gil.cookie, `/rooms/${elsewhere}/threads`, 'POST', {
        text: 'Hello?',
        submission_id: submission(),
      }),
      404,
      'not_found',
    );

    // No people list, no room of their own, no personal work.
    await refused(send(gil.cookie, '/people'), 403, 'guests_use_rooms');
    await refused(send(gil.cookie, '/rooms', 'POST', { name: 'Mine' }), 403, 'scope_denied');
    await refused(
      send(gil.cookie, '/conversations', 'POST', { text: 'Do something for me' }),
      403,
      'guests_use_rooms',
    );
    await refused(
      send(gil.cookie, '/jobs', 'POST', { objective: 'Do something for me' }),
      403,
      'guests_use_rooms',
    );
    const [own] =
      await sql`select count(*)::int as n from space where owner_principal_id = ${gil.id}`;
    expect(own?.n).toBe(0);
    const [work] = await sql`select count(*)::int as n from job where principal_id = ${gil.id}`;
    expect(work?.n).toBe(0);

    // Gil's request asks a permission. Gil never answers it; the room's owners do.
    const { claims } = await claim(requestId);
    const asked = await broker.propose(claims as CapabilityClaims, {
      connection_id: notes,
      kind: 'notes.post',
      payload: { to: ['team'], body: 'The notes.' },
    });
    await runner.commitOutcome(claims, {
      kind: 'waiting_for_approval',
      action_ids: [asked.action_id],
    });
    const approvalId = asked.approval_id ?? '';
    const card = roomThreadView
      .parse(await ok(send(gil.cookie, `/rooms/${roomId}/threads/${threadId}`)))
      .requests.flatMap((entry) => entry.permissions ?? [])
      .find((entry) => entry.id === approvalId);
    if (!card) throw new Error('The permission is not on the thread');
    const body = {
      option: 'allow_once' as const,
      version: card.version,
      payload_hash: asked.payload_hash,
    };
    await refused(
      send(gil.cookie, `/rooms/${roomId}/approvals/${approvalId}`, 'POST', body),
      403,
      'not_yours_to_answer',
    );
    await refused(
      send(gil.cookie, `/approvals/${approvalId}`, 'POST', body),
      403,
      'guests_use_rooms',
    );
    const [undecided] = await sql`select decision from approval where id = ${approvalId}`;
    expect(undecided?.decision).toBeNull();
    await ok(send(alice.cookie, `/rooms/${roomId}/approvals/${approvalId}`, 'POST', body));
    const [decided] = await sql`select decided_by from approval where id = ${approvalId}`;
    expect(decided?.decided_by).toBe(alice.id);
  }, 90_000);

  test('a guest is refused every owner surface and every member-only surface', async () => {
    const roomId = await makeRoom('Owners');
    const kept = await installNotes(roomId, 'owner', 'alice.mailbox@example.test');
    const shared = await installNotes(roomId, 'room', 'Team notes');
    const hal = await guestIn(roomId, 'hal@guest.example');

    // In the room: what only its owners do.
    for (const [method, path, body] of [
      ['PUT', `/rooms/${roomId}/policy`, { guests_may_ask: true }],
      ['PUT', `/rooms/${roomId}/connections/${shared}`, { shared_use: 'owner' }],
      ['POST', `/rooms/${roomId}/members`, { principal_id: carol.id }],
      ['DELETE', `/rooms/${roomId}/members/${bob.id}`, undefined],
      ['GET', `/rooms/${roomId}/invites`, undefined],
      ['POST', `/rooms/${roomId}/invites`, { email: 'ivy@guest.example' }],
    ] as const)
      expect([method, path, (await send(hal.cookie, path, method, body)).status]).toEqual([
        method,
        path,
        403,
      ]);
    // A connection kept for the owner, and its label, stay out of a guest's sight.
    const connections = await ok<{ connections: { id: string; label: string }[] }>(
      send(hal.cookie, `/rooms/${roomId}/connections`),
    );
    const ids = connections.connections.map((entry) => entry.id);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(kept);
    expect(JSON.stringify(connections)).not.toContain('alice.mailbox');

    // Everything outside the rooms: a person's own space, the people list,
    // installation settings and every route that was never taught about guests.
    for (const [method, path] of [
      ['GET', '/home'],
      ['GET', '/profile'],
      ['GET', '/conversations'],
      ['GET', '/permissions'],
      ['PUT', '/approval-settings'],
      ['GET', '/connections'],
      ['POST', '/connections'],
      ['GET', '/memory/items'],
      ['GET', '/spaces'],
      ['POST', '/spaces/shared'],
      ['POST', `/spaces/${roomId}/memberships`],
      ['POST', '/principals'],
      ['GET', '/people'],
      ['GET', '/jobs'],
      ['GET', '/events'],
      ['GET', '/sandbox/computers'],
      ['POST', '/sandbox/sessions/ses_1/takeover'],
      ['POST', '/sandbox/sessions/ses_1/live/input'],
      ['GET', '/web/settings'],
      ['GET', '/settings/model'],
      ['GET', '/knowledge/records'],
      ['GET', '/internal/health'],
      ['GET', '/push/config'],
    ] as const)
      expect([
        method,
        path,
        (await send(hal.cookie, path, method, method === 'GET' ? undefined : {})).status,
      ]).toEqual([method, path, 403]);
    // The same requests from a person reach their routes: the refusal is the guest's.
    expect((await send(bob.cookie, '/home')).status).toBe(200);
  }, 90_000);

  test('a guest reaches only what rooms give them, on every route the service has', async () => {
    const roomId = await makeRoom('Every route');
    const gus = await guestIn(roomId, 'gus@guest.example');
    const routes = everyRoute();
    expect(routes.length).toBeGreaterThan(200);
    const named = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
    const reached: string[] = [];
    const notRefused: string[] = [];
    for (const route of routes) {
      const key = named(route);
      if (GUEST_ROUTES.some((pattern) => pattern.test(key))) {
        reached.push(key);
        continue;
      }
      if (SIGNED_OUT_ROUTES.some((pattern) => pattern.test(key))) continue;
      const path = route.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, 'x1').replace(/\*/g, 'x1');
      const response = await send(
        gus.cookie,
        path,
        route.method,
        ['GET', 'HEAD'].includes(route.method) ? undefined : {},
      );
      const text = await response.text();
      const code =
        response.status === 403
          ? (JSON.parse(text) as { error?: { code?: string } }).error?.code
          : undefined;
      if (code !== 'guests_use_rooms') notRefused.push(`${key} -> ${response.status}`);
    }
    // Every route outside the rooms design refuses a guest before it runs.
    expect(notRefused).toEqual([]);
    // And the ones a guest reaches are the rooms design's, each still served.
    expect(reached.filter((key) => !key.includes('/rooms'))).toEqual(
      expect.arrayContaining([
        'GET /me',
        'PATCH /me',
        'POST /signout',
        'POST /account/password',
        'GET /me/linked-accounts',
        'DELETE /me/linked-accounts/:provider/:externalId',
        'GET /artifacts/:id/content',
        'POST /sandbox/sessions/:id/live',
        'GET /sandbox/sessions/:id/live/frames',
      ]),
    );
    // A guest still reaches their room.
    expect((await send(gus.cookie, `/rooms/${roomId}`)).status).toBe(200);
  }, 180_000);

  test('adding a guest fences the running request, which starts again with the new roster', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Growing');
    const opened = roomMessageResponse.parse(
      await ok(
        send(alice.cookie, `/rooms/${roomId}/threads`, 'POST', {
          text: '@Melete plan the week',
          ask_agent: true,
          submission_id: submission(),
        }),
        201,
      ),
    );
    const request = opened.request_job_id ?? '';
    const before = await roomGeneration(roomId);
    const { claims } = await claim(request);
    await guestIn(roomId, 'jo@guest.example');
    expect(await roomGeneration(roomId)).toBe(before + 1);
    const [attempt] = await sql`select outcome from attempt where id = ${claims.attempt_id}`;
    expect(attempt?.outcome).toBe('fenced');
    const again = await claim(request);
    expect(again.claims.membership_generation).toBe(before + 1);
  }, 60_000);

  test('a guest connects no assistant and gets no space of their own, whatever route they take', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Assistants');
    const lee = await guestIn(roomId, 'lee@guest.example');
    const addresses = mcpServerAddresses(PUBLIC_URL);
    if (!addresses) throw new Error('Expected the assistant addresses');
    const store = new OAuthStore(sql, addresses);
    const redirect = 'http://127.0.0.1:40111/callback';
    const client = await store.register({ client_name: 'Probe', redirect_uris: [redirect] });
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    // The grant pages are public routes that read the sign-in themselves: both refuse a guest.
    const shown = await database().app.request(`/oauth/authorize?${query}`, {
      headers: { Cookie: lee.cookie },
    });
    expect(shown.status).toBe(403);
    expect(await shown.text()).toContain('cannot connect an assistant');
    const answered = await database().app.request('/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: lee.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(query), decision: 'allow' }).toString(),
    });
    expect(answered.status).toBe(403);
    const [own] =
      await sql`select count(*)::int as n from space where owner_principal_id = ${lee.id}`;
    expect(own?.n).toBe(0);
    const [grants] = await sql`select count(*)::int as n from mcp_authorization
      where principal_id = ${lee.id}`;
    expect(grants?.n).toBe(0);
    // Nothing else makes one either.
    const refusal = await ensurePersonalSpace(database().db, lee.id, directory).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal instanceof Error ? refusal.message : refusal).toBe(
      'A guest account uses only the rooms it was invited to.',
    );

    // A grant written for a guest by any other means, here for a space they are
    // not even in, is refused when it is used.
    const stray = await makeRoom('Not theirs');
    const code = await store.issueCode({
      clientId: client.client_id,
      principalId: lee.id,
      spaceId: stray,
      membershipGeneration: 0,
      resource: addresses.resource,
      scope: 'mcp',
      redirectUri: redirect,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    const pair = await store.exchangeCode({
      code,
      clientId: client.client_id,
      redirectUri: redirect,
      verifier,
    });
    const called = await database().app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${pair.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(called.status).toBe(401);
    // And ending the guest's place takes every grant they hold with it, wherever it is.
    await ok(send(alice.cookie, `/rooms/${roomId}/members/${lee.id}`, 'DELETE'));
    const [tokens] =
      await sql`select count(*)::int as n from mcp_token where principal_id = ${lee.id}`;
    expect(tokens?.n).toBe(0);
    const [left] =
      await sql`select count(*)::int as n from space where owner_principal_id = ${lee.id}`;
    expect(left?.n).toBe(0);
  }, 180_000);

  test('one guest whose place cannot be ended now never holds up the others', async () => {
    const { sql, db, jobs } = database();
    const roomId = await makeRoom('Sweep');
    const stuck = await guestIn(roomId, 'max@guest.example', 1);
    const next = await guestIn(roomId, 'nia@guest.example', 1);
    await sql`update space_membership set expires_at = now() - interval '2 seconds'
      where space_id = ${roomId} and principal_id = ${stuck.id}`;
    await sql`update space_membership set expires_at = now() - interval '1 second'
      where space_id = ${roomId} and principal_id = ${next.id}`;
    // The first in line cannot be ended: the database refuses it.
    await sql.unsafe(`create or replace function r5_refuse_end() returns trigger as $$
      begin
        if new.principal_id = '${stuck.id}' and new.revoked_at is not null then
          raise exception 'refused for this test';
        end if;
        return new;
      end $$ language plpgsql`);
    await sql.unsafe(`create trigger r5_refuse_end before update on space_membership
      for each row execute function r5_refuse_end()`);
    try {
      const principals = new PrincipalService(db, directory, jobs);
      expect(await principals.expireGuests()).toBe(1);
      const rows = await sql`select principal_id, revoked_at from space_membership
        where space_id = ${roomId} and principal_id in (${stuck.id}, ${next.id})`;
      const ended = Object.fromEntries(
        rows.map((row) => [String(row.principal_id), row.revoked_at !== null]),
      );
      expect(ended).toEqual({ [stuck.id]: false, [next.id]: true });
    } finally {
      await sql.unsafe('drop trigger r5_refuse_end on space_membership');
      await sql.unsafe('drop function r5_refuse_end()');
    }
    // Once it can be, the next sweep ends it.
    expect(await new PrincipalService(db, directory, jobs).expireGuests()).toBe(1);
  }, 180_000);

  test('an expired guest loses access and fences room work like a revocation', async () => {
    const { sql, db, jobs } = database();
    const roomId = await makeRoom('Short stay');
    const kim = await guestIn(roomId, 'kim@guest.example', 1);
    const asked = roomMessageResponse.parse(
      await ok(
        send(kim.cookie, `/rooms/${roomId}/threads`, 'POST', {
          text: '@Melete what is on today?',
          ask_agent: true,
          submission_id: submission(),
        }),
        201,
      ),
    );
    const request = asked.request_job_id ?? '';
    const { claims } = await claim(request);
    const stream = await database().app.request(
      `/rooms/${roomId}/threads/${asked.thread.id}/events`,
      { headers: { Cookie: kim.cookie, Accept: 'text/event-stream' } },
    );
    expect(stream.status).toBe(200);
    const before = await roomGeneration(roomId);

    // The time is up: from this moment Kim reads nothing, and the open stream closes.
    await sql`update space_membership set expires_at = now() - interval '1 second'
      where space_id = ${roomId} and principal_id = ${kim.id}`;
    await refused(send(kim.cookie, `/rooms/${roomId}`), 404, 'not_found');
    await refused(
      send(kim.cookie, `/rooms/${roomId}/threads/${asked.thread.id}`),
      404,
      'not_found',
    );
    expect(roomList.parse(await ok(send(kim.cookie, '/rooms'))).rooms).toEqual([]);
    expect(await readUntilClosed(stream, 5_000)).toBe(true);

    // The sweep ends the membership the way a removal does: the roster moves on,
    // the request in flight is fenced, and the request Kim asked ends with her place.
    const principals = new PrincipalService(db, directory, jobs);
    expect(await principals.expireGuests()).toBe(1);
    expect(await principals.expireGuests()).toBe(0);
    const [membership] = await sql`select revoked_at from space_membership
      where space_id = ${roomId} and principal_id = ${kim.id}`;
    expect(membership?.revoked_at).not.toBeNull();
    expect(await roomGeneration(roomId)).toBe(before + 1);
    const [attempt] = await sql`select outcome from attempt where id = ${claims.attempt_id}`;
    expect(attempt?.outcome).toBe('fenced');
    const [ended] = await sql`select state from job where id = ${request}`;
    expect(ended?.state).toBe('cancelled');
    // The room's people see Kim gone.
    const detail = roomDetail.parse(await ok(send(alice.cookie, `/rooms/${roomId}`)));
    expect(detail.members.map((member) => member.principal_id)).not.toContain(kim.id);
  }, 60_000);
});
