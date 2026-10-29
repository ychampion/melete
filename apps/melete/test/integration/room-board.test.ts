/**
 * A room's board: dated items its agent and its people keep, each shown only
 * to the people it is for. Owners see everything; a member sees what is for
 * everyone and what is assigned to them; a guest sees what is for everyone.
 * The same rule holds for the room's list, its live stream and the page of
 * every room a person is in. People claim, complete and answer; an answer is
 * the person's own message to the agent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BoardItem,
  boardAnswerResponse,
  boardItemResponse,
  boardList,
  type CapabilityClaims,
  type JsonObject,
  roomDetail,
  roomInviteCreated,
  roomMessageResponse,
  roomThreadView,
} from '@melete/contracts';
import { requestPersonQuestion } from '../../src/broker/ask-person.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { boardManifest } from '../../src/connectors/board.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { PushService } from '../../src/push/service.ts';
import { boardAnswersFor } from '../../src/rooms/board.ts';
import { RoomCalendarShareService } from '../../src/rooms/calendar-shares.ts';
import { roomHandle } from '../../src/rooms/transcript.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-room-board-'));
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'room-board-signing-key-32-bytes!!!',
      liveConnectionScopes: true,
    })
  : null;
const broker = handle ? new BrokerService({ sql: handle.sql, connectors: registry }) : null;
const app =
  handle && jobs && runner && broker
    ? createApp({
        env: loadEnv({
          MELETE_PREVIEW_MULTIPLAYER: 'true',
          NODE_ENV: 'test',
          MELETE_SPACES_DIR: directory,
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
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answered = await response;
  const text = await answered.text();
  expect([answered.status, text.slice(0, 300)]).toEqual([status, text.slice(0, 300)]);
  return JSON.parse(text) as T;
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
type World = { alice: Person; bob: Person; carol: Person; erin: Person };
let world: World;

/** A room Alice owns, with Bob and Carol as members and a guest invited in. */
async function makeRoom(name: string) {
  const made = roomDetail.parse(
    await ok(send(world.alice.cookie, '/rooms', 'POST', { name }), 201),
  );
  const roomId = made.room.id;
  for (const member of [world.bob, world.carol])
    await ok(
      send(world.alice.cookie, `/rooms/${roomId}/members`, 'POST', { principal_id: member.id }),
      201,
    );
  return roomId;
}
/** A guest, invited into the room and signed in from the link. */
async function guestIn(roomId: string, email: string): Promise<Person> {
  const made = roomInviteCreated.parse(
    await ok(send(world.alice.cookie, `/rooms/${roomId}/invites`, 'POST', { email }), 201),
  );
  const token = new URLSearchParams(made.path.split('?')[1] ?? '').get('token') ?? '';
  const accepted = await send('', '/invites/accept', 'POST', { token, password });
  const cookie = sessionCookie(accepted);
  const me = await ok<{ owner: { id: string; kind: string } }>(send(cookie, '/me'));
  expect(me.owner.kind).toBe('guest');
  return { id: me.owner.id, cookie };
}
async function boardConnection(spaceId: string) {
  const [row] = await database().sql`select id from connection
    where space_id = ${spaceId} and provider = 'board' and status = 'active'`;
  if (!row) throw new Error(`No board connection in ${spaceId}`);
  return String(row.id);
}
async function claimJob(jobId: string) {
  const { sql, runner } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  const claimed = await runner.claim({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
  if (!claimed) throw new Error(`Request ${jobId} could not be claimed`);
  return claimed.claims as CapabilityClaims;
}
/** Claim a request's attempt as the runner does: its capability, and what its agent is handed. */
async function claimWithBundle(jobId: string) {
  const { sql, runner } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  const claimed = await runner.claim({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
  if (!claimed) throw new Error(`Request ${jobId} could not be claimed`);
  return { claims: claimed.claims as CapabilityClaims, bundle: claimed.bundle };
}
/** A calendar in the person's own space that takes new events, as a CalDAV calendar does. */
async function personalCalendar(person: Person) {
  const { sql } = database();
  const [own] = await sql`select id from space
    where kind = 'personal' and owner_principal_id = ${person.id}`;
  const id = `con_0${randomBytes(13).toString('hex').toUpperCase().slice(0, 25)}`;
  await sql`insert into connection (id, space_id, provider, label, scopes, configuration)
    values (${id}, ${own?.id}, 'caldav', 'Personal calendar',
      ${JSON.stringify(calendarManifest.tools.map((entry) => entry.name))}::jsonb,
      '{"kind":"caldav"}'::jsonb)`;
  return id;
}
/** A request of the room's agent, asked by `person`, holding a live capability. */
async function request(person: Person, roomId: string, text = '@Melete keep the board') {
  const opened = roomMessageResponse.parse(
    await ok(
      send(person.cookie, `/rooms/${roomId}/threads`, 'POST', {
        text,
        submission_id: submission(),
      }),
      201,
    ),
  );
  const jobId = opened.request_job_id ?? '';
  return { claims: await claimJob(jobId), threadId: opened.thread.id, jobId };
}
/** Run one board tool as the room's agent; the item id it made, or the refusal. */
async function tool(
  claims: CapabilityClaims,
  roomId: string,
  kind: string,
  payload: Record<string, unknown>,
) {
  const { broker, sql } = database();
  const proposed = await broker
    .propose(claims, {
      connection_id: await boardConnection(roomId),
      kind,
      payload: payload as JsonObject,
    })
    .catch((error: unknown) => ({ refused: (error as Error).message }));
  if ('refused' in proposed) return { refused: proposed.refused, item: null, status: 'refused' };
  expect(proposed.requires_approval).toBe(false);
  const [row] = await sql`select status, receipt from action where id = ${proposed.action_id}`;
  return {
    refused: null,
    status: String(row?.status),
    item: (row?.receipt?.detail?.item_id as string | undefined) ?? null,
    detail: (row?.receipt?.detail ?? {}) as Record<string, unknown>,
  };
}
async function listOf(person: Person, roomId: string) {
  return boardList.parse(await ok(send(person.cookie, `/rooms/${roomId}/board`))).items;
}
async function across(person: Person, query = '') {
  return boardList.parse(await ok(send(person.cookie, `/board${query}`))).items;
}
/** Read a live stream for `ms`, or until it ends. */
async function readFor(response: Response, ms: number, until?: (text: string) => boolean) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No stream');
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => 'timeout' as const),
    ]);
    if (next === 'timeout') break;
    if (next.done) return { text, closed: true };
    text += new TextDecoder().decode(next.value);
    if (until?.(text)) break;
  }
  await reader.cancel();
  return { text, closed: false };
}
function openStream(person: Person, roomId: string) {
  return database().app.request(`/rooms/${roomId}/board/events`, {
    headers: { Cookie: person.cookie, Accept: 'text/event-stream' },
  });
}
const titles = (items: BoardItem[]) => items.map((item) => item.title).sort();

withDb('room board', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  // Alice set the installation up and makes the rooms. Bob and Carol are
  // members of them; Erin is in none of Alice's rooms.
  beforeAll(async () => {
    const { app } = database();
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password }),
    });
    expect(setup.status).toBe(201);
    const aliceCookie = sessionCookie(setup);
    const aliceId = ((await setup.json()) as { owner: { id: string } }).owner.id;
    const people: Person[] = [];
    for (const name of ['bob', 'carol', 'erin']) {
      const made = await ok<{ principal: { id: string } }>(
        send(aliceCookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      );
      people.push({ id: made.principal.id, cookie: await login(`${name}@example.test`) });
    }
    const [bob, carol, erin] = people;
    if (!bob || !carol || !erin) throw new Error('People were not made');
    world = { alice: { id: aliceId, cookie: aliceCookie }, bob, carol, erin };
    for (const [person, name] of [
      [world.alice, 'Alice'],
      [world.bob, 'Bob'],
      [world.carol, 'Carol'],
      [world.erin, 'Erin'],
    ] as const)
      await ok(send(person.cookie, '/me', 'PATCH', { display_name: name }));
  }, 60_000);

  test('each person sees only what their place allows, in the list, the stream and every room page', async () => {
    const roomId = await makeRoom('Home');
    const guest = await guestIn(roomId, 'gil@guest.example');
    const { claims } = await request(world.alice, roomId);
    // Bob is named by the code the room gives him, as the agent reads it.
    const bobCode = roomHandle(roomId, world.bob.id);
    for (const [title, visibility] of [
      ['Dentist for everyone', 'everyone'],
      ['Owners budget talk', 'owners'],
      ['Bob private pickup', 'assignee'],
    ] as const) {
      const made = await tool(claims, roomId, 'board.add', {
        kind: 'event',
        title,
        starts_at: '2026-11-02T15:00:00Z',
        assignee: bobCode,
        visibility,
      });
      expect([made.status, made.refused]).toEqual(['succeeded', null]);
    }
    const all = ['Bob private pickup', 'Dentist for everyone', 'Owners budget talk'];
    const expected: [string, Person, string[]][] = [
      ['owner', world.alice, all],
      ['member-assignee', world.bob, ['Bob private pickup', 'Dentist for everyone']],
      ['member-other', world.carol, ['Dentist for everyone']],
      ['guest', guest, ['Dentist for everyone']],
    ];
    for (const [who, person, wanted] of expected) {
      // The room's own list.
      const listed = await listOf(person, roomId);
      expect([who, titles(listed)]).toEqual([who, wanted]);
      // The assignee is shown with the room's label, never an email.
      expect(listed.every((item) => item.assignee?.principal_id === world.bob.id)).toBe(true);
      // The stream, as a page and live.
      const page = await ok<{ frames: { item: BoardItem }[] }>(
        send(person.cookie, `/rooms/${roomId}/board/events?after=0`),
      );
      expect([who, page.frames.map((frame) => frame.item.title).sort()]).toEqual([who, wanted]);
      const live = await openStream(person, roomId);
      expect(live.status).toBe(200);
      const read = await readFor(live, 1500, (text) =>
        wanted.every((title) => text.includes(title)),
      );
      for (const title of all)
        expect([who, title, read.text.includes(title)]).toEqual([
          who,
          title,
          wanted.includes(title),
        ]);
      // Every room the person is in, on one page.
      const everywhere = (await across(person)).filter((item) => item.room_id === roomId);
      expect([who, titles(everywhere)]).toEqual([who, wanted]);
    }
    // Only the open items assigned to the reader are theirs to see waiting.
    expect(titles(await across(world.bob, '?mine=1'))).toEqual([
      'Bob private pickup',
      'Dentist for everyone',
    ]);
    expect(await across(world.carol, '?mine=1')).toEqual([]);
    // A guest reads the board but changes nothing on it.
    const [everyone] = await listOf(guest, roomId);
    expect(everyone?.can).toEqual({ claim: false, done: false, answer: false });
    const refused = await send(
      guest.cookie,
      `/rooms/${roomId}/board/${everyone?.id}/claim`,
      'POST',
    );
    expect(refused.status).toBe(403);
    // Nobody outside the room reads anything of it.
    expect((await send(world.erin.cookie, `/rooms/${roomId}/board`)).status).toBe(404);
    expect((await send(world.erin.cookie, `/rooms/${roomId}/board/events`)).status).toBe(404);
  }, 90_000);

  test('a room I am not in contributes nothing to my page', async () => {
    const roomId = await makeRoom('Errands');
    const { claims } = await request(world.alice, roomId);
    await tool(claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Errands for everyone',
      due_at: '2026-11-03T12:00:00Z',
    });
    // Erin's own room, with Alice in it but nobody else from Errands.
    const erins = roomDetail.parse(
      await ok(send(world.erin.cookie, '/rooms', 'POST', { name: 'Erin only' }), 201),
    );
    await ok(
      send(world.erin.cookie, `/rooms/${erins.room.id}/members`, 'POST', {
        principal_id: world.alice.id,
      }),
      201,
    );
    const erinsWork = await request(world.erin, erins.room.id);
    await tool(erinsWork.claims, erins.room.id, 'board.add', {
      kind: 'task',
      title: 'Erin room task',
      due_at: '2026-11-03T12:00:00Z',
    });
    const erinSees = await across(world.erin);
    expect(erinSees.map((item) => item.room_id)).not.toContain(roomId);
    expect(titles(erinSees)).toContain('Erin room task');
    const carolSees = await across(world.carol);
    expect(carolSees.map((item) => item.room_id)).not.toContain(erins.room.id);
    expect(titles(carolSees)).toContain('Errands for everyone');
    // Alice is in both and sees both.
    const aliceSees = titles(await across(world.alice));
    expect(aliceSees).toEqual(expect.arrayContaining(['Erin room task', 'Errands for everyone']));
    // A window keeps only what is dated inside it.
    const outside = await across(world.alice, '?from=2026-12-01T00:00:00Z&to=2026-12-08T00:00:00Z');
    expect(outside).toEqual([]);
  }, 60_000);

  test('the agent assigns only people in the room who are not guests', async () => {
    const roomId = await makeRoom('Chores');
    const guest = await guestIn(roomId, 'hal@guest.example');
    const { claims } = await request(world.alice, roomId);
    for (const outsider of [world.erin.id, guest.id, roomHandle(roomId, world.erin.id), 'nobody'])
      expect(
        (
          await tool(claims, roomId, 'board.add', {
            kind: 'task',
            title: 'Take out the bins',
            assignee: outsider,
          })
        ).status,
      ).toBe('refused');
    expect(
      (await tool(claims, roomId, 'board.ask', { assignee: world.erin.id, title: 'Can you?' }))
        .status,
    ).toBe('refused');
    expect(await listOf(world.alice, roomId)).toEqual([]);
    // Someone in the room, by id or code, is fine.
    const made = await tool(claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Take out the bins',
      assignee: world.carol.id,
    });
    expect(made.status).toBe('succeeded');
    // A guest's request reads the board and changes nothing.
    const asked = await request(guest, roomId, '@Melete what is on the board');
    expect((await tool(asked.claims, roomId, 'board.list', {})).status).toBe('succeeded');
    expect(
      (await tool(asked.claims, roomId, 'board.add', { kind: 'task', title: 'Guest task' })).status,
    ).toBe('refused');
  }, 60_000);

  test('a person named as the board lists them, or by the name they chose, is assigned', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Errand rota');
    const { claims } = await request(world.alice, roomId);
    const handle = roomHandle(roomId, world.bob.id);
    for (const named of [`Bob <${handle}>`, 'bob', `<${handle}>`]) {
      const asked = await tool(claims, roomId, 'board.ask', { assignee: named, title: 'Can you?' });
      expect(asked.status).toBe('succeeded');
      const [row] =
        await sql`select assignee_principal_id from room_board_item where id = ${asked.item}`;
      expect(row?.assignee_principal_id).toBe(world.bob.id);
    }
    // Erin is not in this room, whatever she is called.
    expect(
      (await tool(claims, roomId, 'board.ask', { assignee: 'Erin', title: 'Can you?' })).status,
    ).toBe('refused');
    // Two people with one name are told apart only by their code.
    await sql`update principal set display_name = 'Bob' where id = ${world.carol.id}`;
    try {
      const same = await tool(claims, roomId, 'board.ask', { assignee: 'Bob', title: 'Can you?' });
      expect(same.refused).toContain('assign them by the code in angle brackets');
      expect(
        (
          await tool(claims, roomId, 'board.ask', {
            assignee: `Bob <${handle}>`,
            title: 'Can you?',
          })
        ).status,
      ).toBe('succeeded');
    } finally {
      await sql`update principal set display_name = 'Carol' where id = ${world.carol.id}`;
    }
  }, 60_000);

  test('a claim race has one winner, and the claim reaches another open stream', async () => {
    const roomId = await makeRoom('Rota');
    const { claims } = await request(world.alice, roomId);
    const made = await tool(claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Walk the dog',
      due_at: '2026-11-04T08:00:00Z',
    });
    const itemId = made.item ?? '';
    // Alice watches the board while Bob and Carol both claim the task at once.
    const watch = await openStream(world.alice, roomId);
    expect(watch.status).toBe(200);
    const [bobs, carols] = await Promise.all([
      send(world.bob.cookie, `/rooms/${roomId}/board/${itemId}/claim`, 'POST'),
      send(world.carol.cookie, `/rooms/${roomId}/board/${itemId}/claim`, 'POST'),
    ]);
    const statuses = [bobs.status, carols.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = bobs.status === 200 ? world.bob : world.carol;
    const loser = (bobs.status === 409 ? bobs : carols).clone();
    expect(((await loser.json()) as { error: { code: string } }).error.code).toBe(
      'already_claimed',
    );
    // A claim after the fact is refused the same way.
    const late = await send(
      winner === world.bob ? world.carol.cookie : world.bob.cookie,
      `/rooms/${roomId}/board/${itemId}/claim`,
      'POST',
    );
    expect(late.status).toBe(409);
    const live = await readFor(watch, 2000, (text) => text.includes('"state":"claimed"'));
    expect(live.text).toContain('"state":"claimed"');
    expect(live.text).toContain(winner.id);
    // The winner completes it, and everyone reads it done.
    const done = boardItemResponse.parse(
      await ok(send(winner.cookie, `/rooms/${roomId}/board/${itemId}/done`, 'POST')),
    );
    expect(done.item.state).toBe('done');
    const [seen] = await listOf(world.carol, roomId);
    expect(seen?.state).toBe('done');
  }, 60_000);

  test('a question is answered only by the person it asks, as their own message to the agent', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Pickups');
    const asking = await request(world.alice, roomId, '@Melete who can do Friday pickup?');
    const asked = await tool(asking.claims, roomId, 'board.ask', {
      assignee: roomHandle(roomId, world.bob.id),
      title: 'Can you do Friday pickup at 2:30?',
      choices: ['Yes', 'No'],
      visibility: 'everyone',
    });
    expect(asked.status).toBe('succeeded');
    const itemId = asked.item ?? '';
    await database().runner.commitOutcome(asking.claims, {
      kind: 'completed',
      summary: 'I asked Bob on the board.',
      evidence: [],
    });
    // Everyone sees the question; only Bob may answer it.
    const [carolsView] = await listOf(world.carol, roomId);
    expect(carolsView?.can.answer).toBe(false);
    for (const other of [world.carol, world.alice]) {
      const refused = await send(other.cookie, `/rooms/${roomId}/board/${itemId}/answer`, 'POST', {
        answer: 'Yes',
      });
      expect(refused.status).toBe(403);
    }
    const [bobsView] = await listOf(world.bob, roomId);
    expect(bobsView?.can.answer).toBe(true);
    const answered = boardAnswerResponse.parse(
      await ok(
        send(world.bob.cookie, `/rooms/${roomId}/board/${itemId}/answer`, 'POST', {
          answer: 'Yes, I will do it',
        }),
      ),
    );
    expect(answered.item.state).toBe('answered');
    expect(answered.item.answer).toBe('Yes, I will do it');
    // The answer is Bob's own message, in the thread the question was asked in.
    expect(answered.thread_id).toBe(asking.threadId);
    const thread = roomThreadView.parse(
      await ok(send(world.carol.cookie, `/rooms/${roomId}/threads/${asking.threadId}`)),
    );
    const message = thread.messages.find((entry) => entry.id === answered.message_id);
    expect(message?.author.principal_id).toBe(world.bob.id);
    expect(message?.text).toContain('Yes, I will do it');
    // It starts a new request of Bob's.
    expect(answered.request_job_id).not.toBeNull();
    expect(answered.request_job_id).not.toBe(asking.jobId);
    const [job] = await sql`select requested_by_principal_id, audience from job
      where id = ${answered.request_job_id}`;
    expect(job).toMatchObject({ requested_by_principal_id: world.bob.id, audience: 'room' });
    // Answering again with the same words changes nothing; other words are refused.
    const again = boardAnswerResponse.parse(
      await ok(
        send(world.bob.cookie, `/rooms/${roomId}/board/${itemId}/answer`, 'POST', {
          answer: 'Yes, I will do it',
        }),
      ),
    );
    expect(again.message_id).toBe(answered.message_id);
    const changed = await send(
      world.bob.cookie,
      `/rooms/${roomId}/board/${itemId}/answer`,
      'POST',
      {
        answer: 'No',
      },
    );
    expect(changed.status).toBe(409);
  }, 60_000);

  test('a question for one person keeps its words off the room thread', async () => {
    const roomId = await makeRoom('Quiet');
    const asking = await request(world.alice, roomId);
    const asked = await tool(asking.claims, roomId, 'board.ask', {
      assignee: world.bob.id,
      title: 'Secret gift idea for Carol?',
    });
    await database().runner.commitOutcome(asking.claims, {
      kind: 'completed',
      summary: 'Asked.',
      evidence: [],
    });
    // Carol cannot see it, so it is not there for her to answer.
    expect(
      (
        await send(world.carol.cookie, `/rooms/${roomId}/board/${asked.item}/answer`, 'POST', {
          answer: 'x',
        })
      ).status,
    ).toBe(404);
    const answered = boardAnswerResponse.parse(
      await ok(
        send(world.bob.cookie, `/rooms/${roomId}/board/${asked.item}/answer`, 'POST', {
          answer: 'A scarf',
        }),
      ),
    );
    const thread = roomThreadView.parse(
      await ok(send(world.carol.cookie, `/rooms/${roomId}/threads/${answered.thread_id}`)),
    );
    expect(JSON.stringify(thread.messages)).not.toContain('Secret gift');
  }, 60_000);

  test('a removed member’s stream closes, and their items read as unassigned', async () => {
    const roomId = await makeRoom('Leaving');
    const { claims } = await request(world.alice, roomId);
    const mine = await tool(claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Carol only task',
      assignee: world.carol.id,
      visibility: 'assignee',
    });
    const claimed = await tool(claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Shared task',
    });
    await ok(send(world.carol.cookie, `/rooms/${roomId}/board/${claimed.item}/claim`, 'POST'));
    const stream = await openStream(world.carol, roomId);
    expect(stream.status).toBe(200);
    const reading = readFor(stream, 10_000);
    await Bun.sleep(300);
    await ok(send(world.alice.cookie, `/rooms/${roomId}/members/${world.carol.id}`, 'DELETE'));
    const read = await reading;
    expect(read.closed).toBe(true);
    expect(read.text).toContain('Carol only task');
    // She reads nothing more of the board.
    expect((await send(world.carol.cookie, `/rooms/${roomId}/board`)).status).toBe(404);
    expect((await across(world.carol)).filter((item) => item.room_id === roomId)).toEqual([]);
    // What was hers reads as nobody's, and her claim no longer holds.
    const left = await listOf(world.alice, roomId);
    const hers = left.find((item) => item.id === mine.item);
    expect(hers?.assignee).toBeNull();
    const shared = left.find((item) => item.id === claimed.item);
    expect([shared?.state, shared?.claimed_by]).toEqual(['open', null]);
    // Bob can take it on now.
    const taken = boardItemResponse.parse(
      await ok(send(world.bob.cookie, `/rooms/${roomId}/board/${claimed.item}/claim`, 'POST')),
    );
    expect(taken.item.claimed_by?.principal_id).toBe(world.bob.id);
  }, 60_000);

  test('the agent reads and changes the board as the person it works for may see it', async () => {
    const roomId = await makeRoom('Week');
    const owner = await request(world.alice, roomId);
    const hidden = await tool(owner.claims, roomId, 'board.add', {
      kind: 'event',
      title: 'Owners only plan',
      visibility: 'owners',
    });
    await tool(owner.claims, roomId, 'board.note', {
      assignee: world.carol.id,
      title: 'Carol note',
    });
    const forBob = await tool(owner.claims, roomId, 'board.note', {
      assignee: world.bob.id,
      title: 'Bob note',
    });
    // A note is always for its person alone.
    const [note] = (await listOf(world.alice, roomId)).filter((item) => item.id === forBob.item);
    expect(note?.visibility).toBe('assignee');
    const bobs = await request(world.bob, roomId, '@Melete what is on my board?');
    const listed = await tool(bobs.claims, roomId, 'board.list', {});
    const words = JSON.stringify(listed.detail);
    expect(words).toContain('Bob note');
    expect(words).not.toContain('Carol note');
    expect(words).not.toContain('Owners only plan');
    // It cannot change what Bob may not see.
    const changed = await tool(bobs.claims, roomId, 'board.update', {
      item_id: hidden.item,
      title: 'Leaked',
    });
    expect(changed.status).not.toBe('succeeded');
    const [kept] = (await listOf(world.alice, roomId)).filter((item) => item.id === hidden.item);
    expect(kept?.title).toBe('Owners only plan');
  }, 60_000);
  test('a board call its tool refuses says what to call instead', async () => {
    const roomId = await makeRoom('Mix-ups');
    const asked = await request(world.alice, roomId);
    const refusal = async (kind: string, payload: Record<string, unknown>) => {
      const made = await tool(asked.claims, roomId, kind, payload);
      expect(made.status).toBe('refused');
      return made.refused ?? '';
    };
    // A note asked of the tool for events and tasks names board.note.
    expect(
      await refusal('board.add', { kind: 'note', title: 'Bring the form', assignee: world.bob.id }),
    ).toBe(
      'board.add takes kind event or task, so leave a note for one person with board.note and its assignee and title instead.',
    );
    expect(
      await refusal('board.add', {
        kind: 'question',
        title: 'Which Friday?',
        assignee: world.bob.id,
      }),
    ).toContain('board.ask');
    expect(
      await refusal('board.note', {
        assignee: world.bob.id,
        title: 'Dentist',
        starts_at: '2026-11-06T09:00',
      }),
    ).toContain('board.add');
    expect(
      await refusal('board.note', { assignee: world.bob.id, title: 'Pick one', choices: ['A'] }),
    ).toContain('board.ask');
    expect(await refusal('board.update', { item_id: 'rbi_x', state: 'answered' })).toContain(
      'open or done',
    );
    // Any other refusal names the field and what it needs, never what was sent.
    const other = await refusal('board.add', { kind: 'event' });
    expect(other).toBe('The arguments were not accepted. title: missing');
    const extra = await refusal('board.add', { kind: 'task', title: 'Rake', colour: 'red' });
    expect(extra).toBe('The arguments were not accepted. colour: not a field this tool takes');
    expect(extra).not.toContain('red');
    // The note it should have been goes up as one.
    const note = await tool(asked.claims, roomId, 'board.note', {
      assignee: world.bob.id,
      title: 'Bring the form',
    });
    expect(note.status).toBe('succeeded');
  }, 60_000);
  test('a stream already following the board sends each reader only what they may see', async () => {
    const roomId = await makeRoom('Following');
    const guest = await guestIn(roomId, 'ida@guest.example');
    const { claims } = await request(world.alice, roomId);
    await tool(claims, roomId, 'board.add', { kind: 'event', title: 'Opening item' });
    const readers: [string, Person][] = [
      ['member-assignee', world.bob],
      ['member-other', world.carol],
      ['guest', guest],
    ];
    // Each stream has sent a frame, so what follows is read from past its cursor.
    const streams = await Promise.all(
      readers.map(async ([who, person]) => {
        const live = await openStream(person, roomId);
        expect([who, live.status]).toEqual([who, 200]);
        return live;
      }),
    );
    await Bun.sleep(500);
    await tool(claims, roomId, 'board.add', {
      kind: 'event',
      title: 'Later owners plan',
      visibility: 'owners',
    });
    await tool(claims, roomId, 'board.note', { assignee: world.bob.id, title: 'Later Bob note' });
    await tool(claims, roomId, 'board.add', { kind: 'event', title: 'Later for everyone' });
    const wanted: Record<string, string[]> = {
      'member-assignee': ['Later Bob note', 'Later for everyone'],
      'member-other': ['Later for everyone'],
      guest: ['Later for everyone'],
    };
    for (const [index, [who]] of readers.entries()) {
      const stream = streams[index];
      if (!stream) throw new Error('No stream');
      const read = await readFor(stream, 4000, (text) =>
        (wanted[who] ?? []).every((title) => text.includes(title)),
      );
      expect([who, read.text.includes('Opening item')]).toEqual([who, true]);
      for (const title of ['Later owners plan', 'Later Bob note', 'Later for everyone'])
        expect([who, title, read.text.includes(title)]).toEqual([
          who,
          title,
          (wanted[who] ?? []).includes(title),
        ]);
    }
  }, 60_000);

  test('a push for one person waits to be sent, and names only what they may see', async () => {
    const { sql, db } = database();
    const roomId = await makeRoom('Pushes');
    for (const person of [world.bob, world.carol])
      await sql`insert into push_subscription (id, principal_id, endpoint, p256dh, auth)
        values (${`ps${randomBytes(6).toString('hex')}`}, ${person.id},
          ${`https://push.example.test/${randomBytes(6).toString('hex')}`}, 'key', 'auth')`;
    const { claims } = await request(world.alice, roomId);
    const note = await tool(claims, roomId, 'board.note', {
      assignee: world.bob.id,
      title: 'Bring the permission slip',
    });
    // The pass that collects decisions leaves the board's own push alone.
    const push = new PushService(db, { keys: null, subject: null, extraOrigins: [] });
    await push.collectDecisions(world.bob.id, new Date(0));
    const [waiting] = await sql`select principal_id, body, dropped_at from push_intent
      where dedup_key = ${`board:${note.item}:${world.bob.id}`}`;
    expect(waiting).toMatchObject({
      principal_id: world.bob.id,
      body: 'Bring the permission slip',
      dropped_at: null,
    });
    // A question only the owners would see is not put to a member at all.
    const hidden = await tool(claims, roomId, 'board.ask', {
      assignee: world.carol.id,
      title: 'Owners only question',
      visibility: 'owners',
    });
    expect(hidden.status).toBe('refused');
    const [told] = await sql`select count(*)::int as n from push_intent
      where principal_id = ${world.carol.id} and body = 'Owners only question'`;
    expect(told?.n).toBe(0);
    expect(titles(await listOf(world.alice, roomId))).toEqual(['Bring the permission slip']);
  }, 60_000);
  test('the agent changes the board only as the person it works for could', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Rules');
    const owner = await request(world.alice, roomId);
    const bobsTask = await tool(owner.claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Bob task',
      assignee: world.bob.id,
    });
    const openTask = await tool(owner.claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Anyone task',
    });
    const question = await tool(owner.claims, roomId, 'board.ask', {
      assignee: world.bob.id,
      title: 'Bob question',
      visibility: 'everyone',
    });
    const carols = await request(world.carol, roomId, '@Melete tidy the board');
    const succeeded = async (claims: CapabilityClaims, payload: Record<string, unknown>) =>
      (await tool(claims, roomId, 'board.update', payload)).status === 'succeeded';
    // What is someone else's stays theirs: not done, edited or given away by another member.
    expect(await succeeded(carols.claims, { item_id: bobsTask.item, state: 'done' })).toBe(false);
    expect(await succeeded(carols.claims, { item_id: bobsTask.item, title: 'Mine now' })).toBe(
      false,
    );
    expect(
      await succeeded(carols.claims, { item_id: bobsTask.item, assignee: world.carol.id }),
    ).toBe(false);
    // Nobody's task: a member takes it on, but gives it to no one else.
    expect(await succeeded(carols.claims, { item_id: openTask.item, assignee: world.bob.id })).toBe(
      false,
    );
    expect(
      await succeeded(carols.claims, { item_id: openTask.item, assignee: world.carol.id }),
    ).toBe(true);
    expect(await succeeded(carols.claims, { item_id: openTask.item, state: 'done' })).toBe(true);
    // Only an owner keeps an item for the owners, on a new item or a change.
    expect(await succeeded(carols.claims, { item_id: openTask.item, visibility: 'owners' })).toBe(
      false,
    );
    expect(
      (
        await tool(carols.claims, roomId, 'board.add', {
          kind: 'event',
          title: 'Carol hides this',
          visibility: 'owners',
        })
      ).status,
    ).not.toBe('succeeded');
    // Only an answer closes a question, whoever asks.
    for (const claims of [carols.claims, owner.claims])
      expect(await succeeded(claims, { item_id: question.item, state: 'done' })).toBe(false);
    // The person on it, and an owner, change it.
    const bobs = await request(world.bob, roomId, '@Melete I did my task');
    expect(await succeeded(bobs.claims, { item_id: bobsTask.item, state: 'done' })).toBe(true);
    expect(await succeeded(owner.claims, { item_id: bobsTask.item, state: 'open' })).toBe(true);
    const items = await listOf(world.alice, roomId);
    const by = (id: string | null) => items.find((item) => item.id === id);
    expect([by(bobsTask.item)?.title, by(bobsTask.item)?.state]).toEqual(['Bob task', 'open']);
    expect([by(openTask.item)?.assignee?.principal_id, by(openTask.item)?.visibility]).toEqual([
      world.carol.id,
      'everyone',
    ]);
    expect([by(question.item)?.state, by(question.item)?.answer]).toEqual(['open', null]);
    expect(titles(items)).not.toContain('Carol hides this');
    // Someone newly given a note is told, and a question only the owners see goes to no member.
    await sql`insert into push_subscription (id, principal_id, endpoint, p256dh, auth)
      values (${`ps${randomBytes(6).toString('hex')}`}, ${world.carol.id},
        ${`https://push.example.test/${randomBytes(6).toString('hex')}`}, 'key', 'auth')`;
    const note = await tool(owner.claims, roomId, 'board.note', {
      assignee: world.bob.id,
      title: 'Passed on note',
    });
    expect(await succeeded(owner.claims, { item_id: note.item, assignee: world.carol.id })).toBe(
      true,
    );
    const [told] = await sql`select body from push_intent
      where principal_id = ${world.carol.id} and dedup_key = ${`board:${note.item}:${world.carol.id}`}`;
    expect(told?.body).toBe('Passed on note');
    const ownersQuestion = await tool(owner.claims, roomId, 'board.ask', {
      assignee: world.alice.id,
      title: 'Owners question',
      visibility: 'owners',
    });
    expect(ownersQuestion.status).toBe('succeeded');
    expect(
      await succeeded(owner.claims, { item_id: ownersQuestion.item, assignee: world.carol.id }),
    ).toBe(false);
    const [hidden] = await sql`select count(*)::int as n from push_intent
      where principal_id = ${world.carol.id} and body = 'Owners question'`;
    expect(hidden?.n).toBe(0);
  }, 90_000);
  test('board.ask keeps a question with its person unless the agent says otherwise', async () => {
    const ask = boardManifest.tools.find((entry) => entry.name === 'board.ask');
    const properties = ask?.input_schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.visibility?.default).toBe('assignee');
    expect(String(properties.visibility?.description)).toContain('Leave this out');
    // The agent is told to keep one person's calendar out of what others can read.
    expect(ask?.description).toContain("never put anyone's calendar, free time or busy time");
    const roomId = await makeRoom('Default');
    const { claims } = await request(world.alice, roomId);
    const asked = await tool(claims, roomId, 'board.ask', {
      assignee: world.bob.id,
      title: 'Can you take Thursday?',
    });
    expect((await listOf(world.carol, roomId)).map((item) => item.id)).not.toContain(asked.item);
    // Once the request has read someone's shared calendar, a question it asks
    // stays with its person even when the agent asks for everyone.
    const { sql } = database();
    const read = `act_0${randomBytes(13).toString('hex').toUpperCase().slice(0, 25)}`;
    await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, status, idempotency_key, resolved_at)
      values (${read}, ${claims.job_id}, ${claims.attempt_id}, ${await boardConnection(roomId)},
        'room.member_freebusy', 'read', '{}'::jsonb, ${'0'.repeat(64)}, 'succeeded', ${read}, now())`;
    const open = await tool(claims, roomId, 'board.ask', {
      assignee: world.bob.id,
      title: 'Can you take Friday at 3?',
      visibility: 'everyone',
    });
    expect(open.status).toBe('succeeded');
    expect((await listOf(world.carol, roomId)).map((item) => item.id)).not.toContain(open.item);
    expect((await listOf(world.bob, roomId)).map((item) => item.id)).toContain(open.item ?? '');
  }, 60_000);

  test('an answer never repeats its question in the thread, even one everyone can read', async () => {
    const roomId = await makeRoom('Open question');
    const asking = await request(world.alice, roomId);
    const asked = await tool(asking.claims, roomId, 'board.ask', {
      assignee: world.bob.id,
      title: 'Who brings the snacks on Friday?',
      visibility: 'everyone',
    });
    await database().runner.commitOutcome(asking.claims, {
      kind: 'completed',
      summary: 'Asked.',
      evidence: [],
    });
    const answered = boardAnswerResponse.parse(
      await ok(
        send(world.bob.cookie, `/rooms/${roomId}/board/${asked.item}/answer`, 'POST', {
          answer: 'I will',
        }),
      ),
    );
    const thread = roomThreadView.parse(
      await ok(send(world.carol.cookie, `/rooms/${roomId}/threads/${answered.thread_id}`)),
    );
    const said = JSON.stringify(thread.messages);
    expect(said).toContain('I will');
    expect(said).not.toContain('snacks');
  }, 60_000);

  test("a room's request that ends on a question in words reads as answered, and takes the reply", async () => {
    const roomId = await makeRoom('Plans');
    const asked = await request(world.alice, roomId, '@Melete plan the weekend');
    await database().runner.commitOutcome(asked.claims, {
      kind: 'waiting_for_input',
      question: 'Saturday or Sunday?',
    });
    const thread = roomThreadView.parse(
      await ok(send(world.carol.cookie, `/rooms/${roomId}/threads/${asked.threadId}`)),
    );
    // Nothing in the room is waiting for a decision: the asker replies in the thread.
    expect(thread.requests.map((entry) => entry.status)).toEqual(['done']);
    const reply = roomMessageResponse.parse(
      await ok(
        send(world.alice.cookie, `/rooms/${roomId}/threads/${asked.threadId}/messages`, 'POST', {
          text: '@Melete Saturday',
          submission_id: submission(),
        }),
      ),
    );
    expect(reply.request_job_id).toBe(asked.jobId);
  }, 60_000);

  test("the room's agent is told how to ask someone else, the calendars it can read, and the board answers it gets", async () => {
    const roomId = await makeRoom('Pickups');
    const shares = new RoomCalendarShareService({ db: database().db });
    // Bob shares a calendar that takes new events; Carol shares free/busy only.
    await shares.put(roomId, world.bob.id, await personalCalendar(world.bob), 'freebusy_add');
    await shares.put(roomId, world.carol.id, await personalCalendar(world.carol), 'freebusy');
    const bob = `Bob <${roomHandle(roomId, world.bob.id)}>`;
    const carol = `Carol <${roomHandle(roomId, world.carol.id)}>`;
    const opened = roomMessageResponse.parse(
      await ok(
        send(world.alice.cookie, `/rooms/${roomId}/threads`, 'POST', {
          text: '@Melete who can do pickup on Thursday?',
          submission_id: submission(),
        }),
        201,
      ),
    );
    const asking = await claimWithBundle(opened.request_job_id ?? '');
    const objective = asking.bundle.job.objective;
    expect(objective).toContain('To ask anyone else, ask them with board.ask in this turn');
    expect(objective).toContain('reading their shared calendar with room.member_freebusy');
    expect(objective).toContain(
      `- ${bob}: free/busy, and events can be added with room.add_to_member_calendar`,
    );
    expect(objective).toContain(`- ${carol}: free/busy only`);
    const asked = await tool(asking.claims, roomId, 'board.ask', {
      assignee: world.bob.id,
      title: 'Can you do pickup on Thursday at 4?',
    });
    await database().runner.commitOutcome(asking.claims, {
      kind: 'completed',
      summary: 'I asked Bob on the board.',
      evidence: [],
    });
    const answered = boardAnswerResponse.parse(
      await ok(
        send(world.bob.cookie, `/rooms/${roomId}/board/${asked.item}/answer`, 'POST', {
          answer: 'Yes, I will do it',
        }),
      ),
    );
    // The answer's own request reads which question it answers, and that Bob's calendar takes events.
    const answering = await claimWithBundle(answered.request_job_id ?? '');
    expect(answering.bundle.job.objective).toContain(
      `- ${bob} answered your question "Can you do pickup on Thursday at 4?". Their shared calendar takes new events`,
    );
    expect(answering.bundle.job.objective).toContain(
      'offer to add it with room.add_to_member_calendar',
    );
    await database().runner.commitOutcome(answering.claims, {
      kind: 'completed',
      summary: 'Noted.',
      evidence: [],
    });
    // A share that ends is no longer listed, and another request reads no board answer.
    await shares.revoke(roomId, world.carol.id);
    const later = roomMessageResponse.parse(
      await ok(
        send(world.alice.cookie, `/rooms/${roomId}/threads`, 'POST', {
          text: '@Melete anything else?',
          submission_id: submission(),
        }),
        201,
      ),
    );
    const after = await claimWithBundle(later.request_job_id ?? '');
    expect(after.bundle.job.objective).toContain(bob);
    expect(after.bundle.job.objective).not.toContain(carol);
    expect(after.bundle.job.objective).not.toContain('answered your question');
  }, 90_000);
  test("a question the room's agent asks with ask_person goes on the board for the person who asked", async () => {
    const roomId = await makeRoom('Picnic');
    const asked = await request(world.bob, roomId, '@Melete plan the picnic');
    const put = await requestPersonQuestion(database().sql, asked.claims, {
      question: 'Saturday or Sunday for the picnic?',
      choices: ['Saturday', 'Sunday'],
    });
    expect(put.instruction).toContain('board');
    await database().runner.commitOutcome(asked.claims, {
      kind: 'completed',
      summary: 'I asked you on the board.',
      evidence: [],
    });
    // Bob, who asked, and the room's owner see it; nobody else in the room does.
    const question = (await listOf(world.bob, roomId)).find((item) => item.kind === 'question');
    expect(question).toMatchObject({
      title: 'Saturday or Sunday for the picnic?',
      state: 'open',
      visibility: 'assignee',
      choices: ['Saturday', 'Sunday'],
    });
    expect(question?.assignee?.principal_id).toBe(world.bob.id);
    expect((await listOf(world.alice, roomId)).map((item) => item.id)).toContain(
      question?.id ?? '',
    );
    expect((await listOf(world.carol, roomId)).map((item) => item.id)).not.toContain(
      question?.id ?? '',
    );
    // The request waits on nothing in the room, and the thread never shows the question.
    const thread = roomThreadView.parse(
      await ok(send(world.carol.cookie, `/rooms/${roomId}/threads/${asked.threadId}`)),
    );
    expect(thread.requests.map((entry) => entry.status)).toEqual(['done']);
    expect(JSON.stringify(thread)).not.toContain('Saturday or Sunday');
    // Bob's answer reaches his own request, in its thread.
    const answered = boardAnswerResponse.parse(
      await ok(
        send(world.bob.cookie, `/rooms/${roomId}/board/${question?.id}/answer`, 'POST', {
          answer: 'Sunday',
        }),
      ),
    );
    expect(answered.thread_id).toBe(asked.threadId);
    expect(answered.request_job_id).toBe(asked.jobId);
  }, 60_000);
  test('an event moved to another day keeps its time of day across a change of clocks', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Field trips');
    await sql`insert into experience_profile (space_id, time_zone)
      values (${roomId}, 'America/Los_Angeles')
      on conflict (space_id) do update set time_zone = excluded.time_zone`;
    const { claims } = await request(world.alice, roomId);
    // 9:00 on November 6, after the clocks went back (PST, UTC-8).
    const made = await tool(claims, roomId, 'board.add', {
      kind: 'event',
      title: 'Field trip',
      starts_at: '2026-11-06T09:00',
    });
    expect(made.status).toBe('succeeded');
    const [item] = await listOf(world.alice, roomId);
    expect(item?.starts_at).toBe('2026-11-06T17:00:00.000Z');
    // The agent reads the board, and moves the trip by giving the time it read on another day.
    const listed = (await tool(claims, roomId, 'board.list', {})).detail ?? {};
    const read = (listed.items as { id: string; starts_at: string }[]).find(
      (entry) => entry.id === made.item,
    );
    expect(listed.time_zone).toBe('America/Los_Angeles');
    expect(read?.starts_at).toBe('2026-11-06T09:00');
    const moved = await tool(claims, roomId, 'board.update', {
      item_id: made.item,
      starts_at: String(read?.starts_at).replace('2026-11-06', '2026-10-30'),
    });
    expect(moved.status).toBe('succeeded');
    // Still 9:00, now in daylight time (PDT, UTC-7).
    const [after] = await listOf(world.alice, roomId);
    expect(after?.starts_at).toBe('2026-10-30T16:00:00.000Z');
    // A time given with its own offset is taken as given.
    await tool(claims, roomId, 'board.update', {
      item_id: made.item,
      starts_at: '2026-10-30T09:30:00-07:00',
    });
    expect((await listOf(world.alice, roomId))[0]?.starts_at).toBe('2026-10-30T16:30:00.000Z');
  }, 60_000);

  test("a room with no zone of its own reads times in its asker's zone, then its maker's", async () => {
    const { sql } = database();
    const roomId = await makeRoom('No zone');
    await sql`delete from experience_profile where space_id = ${roomId}`;
    const zone = (person: Person, timeZone: string) =>
      sql`insert into experience_profile (space_id, time_zone)
        select id, ${timeZone} from space where kind = 'personal' and owner_principal_id = ${person.id}
        on conflict (space_id) do update set time_zone = excluded.time_zone`;
    const startsAt = async (itemId: string | null) =>
      (await listOf(world.alice, roomId)).find((item) => item.id === itemId)?.starts_at;
    await zone(world.bob, 'America/Los_Angeles');
    await zone(world.alice, 'America/New_York');
    try {
      // Bob asks: his own zone, 9:00 PST.
      const bobs = await request(world.bob, roomId);
      const made = await tool(bobs.claims, roomId, 'board.add', {
        kind: 'event',
        title: 'Dentist',
        starts_at: '2026-11-06T09:00',
      });
      expect(made.status).toBe('succeeded');
      expect(await startsAt(made.item)).toBe('2026-11-06T17:00:00.000Z');
      const listed = (await tool(bobs.claims, roomId, 'board.list', {})).detail ?? {};
      expect(listed.time_zone).toBe('America/Los_Angeles');
      // A date alone is that whole day, from its midnight in the same zone.
      const day = await tool(bobs.claims, roomId, 'board.add', {
        kind: 'event',
        title: 'School fair',
        starts_at: '2026-11-06',
      });
      expect(await startsAt(day.item)).toBe('2026-11-06T08:00:00.000Z');
      // Any other form is refused, never read in the server's own zone.
      for (const given of ['2026-11-06 09:00', 'next Friday', '11/06/2026 9am']) {
        const refused = await tool(bobs.claims, roomId, 'board.add', {
          kind: 'event',
          title: 'Unclear',
          starts_at: given,
        });
        expect(refused.refused ?? '').toContain("date and time in the room's time zone");
      }
      // A day or hour that does not exist is refused, never rolled into the next.
      for (const given of ['2026-11-31T09:00', '2026-11-06T25:00', '2026-02-30T09:00Z']) {
        const refused = await tool(bobs.claims, roomId, 'board.add', {
          kind: 'event',
          title: 'No such day',
          starts_at: given,
        });
        expect([given, refused.refused ?? '']).toEqual([
          given,
          expect.stringContaining('must be a real date and time'),
        ]);
      }
      const leap = await tool(bobs.claims, roomId, 'board.add', {
        kind: 'event',
        title: 'Leap day',
        starts_at: '2028-02-29T09:00',
      });
      expect(await startsAt(leap.item)).toBe('2028-02-29T17:00:00.000Z');
      await database().runner.commitOutcome(bobs.claims, {
        kind: 'completed',
        summary: 'Added.',
        evidence: [],
      });
      // Carol chose no zone: the room's maker's is used, 9:00 EST.
      const carols = await request(world.carol, roomId);
      const hers = await tool(carols.claims, roomId, 'board.add', {
        kind: 'event',
        title: 'Recital',
        starts_at: '2026-11-06T09:00',
      });
      expect(await startsAt(hers.item)).toBe('2026-11-06T14:00:00.000Z');
      await database().runner.commitOutcome(carols.claims, {
        kind: 'completed',
        summary: 'Added.',
        evidence: [],
      });
    } finally {
      await zone(world.bob, 'UTC');
      await zone(world.alice, 'UTC');
    }
  }, 60_000);

  test('a question asked with ask_person is answered by a reply in its thread, and closed when its request ends', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Errands');
    const questions = async () =>
      (await listOf(world.bob, roomId)).filter((item) => item.kind === 'question');
    // Bob replies in the thread instead of on the board: that is his answer.
    const first = await request(world.bob, roomId, '@Melete plan the errands');
    await requestPersonQuestion(sql, first.claims, { question: 'Morning or afternoon?' });
    await database().runner.commitOutcome(first.claims, {
      kind: 'completed',
      summary: 'I asked you on the board.',
      evidence: [],
    });
    const reply = roomMessageResponse.parse(
      await ok(
        send(world.bob.cookie, `/rooms/${roomId}/threads/${first.threadId}/messages`, 'POST', {
          text: '@Melete Morning',
          submission_id: submission(),
        }),
      ),
    );
    expect(reply.request_job_id).toBe(first.jobId);
    const [replied] = await questions();
    expect(replied).toMatchObject({ state: 'answered', answer: '@Melete Morning' });
    // A request that ends while its question is open lets the question go.
    const second = await request(world.bob, roomId, '@Melete and the shops?');
    await requestPersonQuestion(sql, second.claims, { question: 'Which shop first?' });
    await database().runner.commitOutcome(second.claims, {
      kind: 'completed',
      summary: 'I asked you on the board.',
      evidence: [],
    });
    expect((await questions()).find((item) => item.title === 'Which shop first?')?.state).toBe(
      'open',
    );
    await database().jobs.cancel(second.jobId);
    const closed = (await questions()).find((item) => item.title === 'Which shop first?');
    expect(closed?.state).toBe('done');
    // Answering it now posts nothing and starts nothing.
    const count = async () =>
      (
        await sql`select (select count(*) from room_message where space_id = ${roomId})::int as messages,
          (select count(*) from job where space_id = ${roomId})::int as jobs`
      )[0];
    const before = await count();
    const refused = await send(
      world.bob.cookie,
      `/rooms/${roomId}/board/${closed?.id}/answer`,
      'POST',
      { answer: 'The bakery' },
    );
    expect(refused.status).toBe(409);
    expect(await count()).toEqual(before);
  }, 60_000);

  test('a message is an answer only from the person the question asks', async () => {
    const { db, sql } = database();
    const roomId = await makeRoom('Rides');
    const asking = await request(world.alice, roomId);
    const asked = await tool(asking.claims, roomId, 'board.ask', {
      assignee: world.bob.id,
      title: 'Can you drive on Sunday?',
    });
    await database().runner.commitOutcome(asking.claims, {
      kind: 'completed',
      summary: 'Asked.',
      evidence: [],
    });
    // Carol's message carries the submission the board gives Bob's answer.
    const posed = roomMessageResponse.parse(
      await ok(
        send(world.carol.cookie, `/rooms/${roomId}/threads/${asking.threadId}/messages`, 'POST', {
          text: '@Melete Yes',
          submission_id: submission(),
        }),
      ),
    );
    const forged = createHash('sha256')
      .update(`${roomId}:${world.carol.id}:board-answer-${asked.item}`)
      .digest('hex');
    await sql`update room_message set submission_id = ${forged} where id = ${posed.message.id}`;
    expect(await boardAnswersFor(db, roomId, posed.request_job_id ?? '')).toEqual([]);
  }, 60_000);

  test('after a shared calendar is read, what the agent puts up for one person stays with them, and it is told', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Carpool');
    const { claims } = await request(world.alice, roomId);
    const read = `act_0${randomBytes(13).toString('hex').toUpperCase().slice(0, 25)}`;
    await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, status, idempotency_key, resolved_at)
      values (${read}, ${claims.job_id}, ${claims.attempt_id}, ${await boardConnection(roomId)},
        'room.member_freebusy', 'read', '{}'::jsonb, ${'0'.repeat(64)}, 'succeeded', ${read}, now())`;
    const seenBy = async (person: Person) => (await listOf(person, roomId)).map((item) => item.id);
    const added = await tool(claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Drive on Thursday',
      assignee: world.bob.id,
      visibility: 'everyone',
    });
    expect(added.status).toBe('succeeded');
    expect(String(added.detail?.note)).toContain('because this request read a shared calendar');
    expect(await seenBy(world.carol)).not.toContain(added.item);
    expect(await seenBy(world.bob)).toContain(added.item ?? '');
    // Something for nobody in particular stays for everyone.
    const shared = await tool(claims, roomId, 'board.add', { kind: 'task', title: 'Bring water' });
    expect([shared.status, shared.refused]).toEqual(['succeeded', null]);
    expect(await seenBy(world.carol)).toContain(shared.item ?? '');
    // An update that would show one person's item to everyone keeps it with them too.
    const kept = await tool(claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Pack the snacks',
      assignee: world.bob.id,
      visibility: 'assignee',
    });
    const opened = await tool(claims, roomId, 'board.update', {
      item_id: kept.item,
      visibility: 'everyone',
    });
    expect(opened.status).toBe('succeeded');
    expect(String(opened.detail?.note)).toContain('because this request read a shared calendar');
    expect(await seenBy(world.carol)).not.toContain(kept.item);
  }, 60_000);

  test('after a shared calendar is read, a retitle or a new assignee keeps an item with its person', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Rota');
    const seenBy = async (person: Person) => (await listOf(person, roomId)).map((item) => item.id);
    // Put up for everyone before the request read anyone's calendar.
    const before = await request(world.alice, roomId);
    const assigned = await tool(before.claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Drive on Monday',
      assignee: world.bob.id,
      visibility: 'everyone',
    });
    const open = await tool(before.claims, roomId, 'board.add', {
      kind: 'task',
      title: 'Drive on Tuesday',
    });
    expect(await seenBy(world.carol)).toEqual(expect.arrayContaining([assigned.item, open.item]));
    await database().runner.commitOutcome(before.claims, {
      kind: 'completed',
      summary: 'Added.',
      evidence: [],
    });
    const { claims } = await request(world.alice, roomId);
    const read = `act_0${randomBytes(13).toString('hex').toUpperCase().slice(0, 25)}`;
    await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, status, idempotency_key, resolved_at)
      values (${read}, ${claims.job_id}, ${claims.attempt_id}, ${await boardConnection(roomId)},
        'room.member_freebusy', 'read', '{}'::jsonb, ${'0'.repeat(64)}, 'succeeded', ${read}, now())`;
    // A retitle of one person's item, sending no visibility.
    const retitled = await tool(claims, roomId, 'board.update', {
      item_id: assigned.item,
      title: 'Drive on Monday at 3',
    });
    expect(retitled.status).toBe('succeeded');
    expect(String(retitled.detail?.note)).toContain('because this request read a shared calendar');
    // Assigning an item everyone sees.
    const given = await tool(claims, roomId, 'board.update', {
      item_id: open.item,
      assignee: world.bob.id,
    });
    expect(given.status).toBe('succeeded');
    const carols = await seenBy(world.carol);
    expect(carols).not.toContain(assigned.item);
    expect(carols).not.toContain(open.item);
    expect(await seenBy(world.bob)).toEqual(expect.arrayContaining([assigned.item, open.item]));
  }, 60_000);
});
