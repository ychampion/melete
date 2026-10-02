/**
 * A room can be talked to from more than the web. A chat platform plugs in as
 * a surface: its people's messages come in, the room's messages, answers and
 * cards go out to them, and they answer permissions, all through the same
 * doors the web uses and under the same rules. A platform account counts
 * only through its link to a person here; one with no link is refused, and a
 * platform's display name never says who anyone is.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  type CapabilityClaims,
  type ConnectorManifest,
  type DispatchResult,
  roomDetail,
  roomMessageResponse,
  roomThreadView,
} from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { resolvePersonGrant } from '../../src/experience/chase-scope.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { createMemoryTrustResolver } from '../../src/memory/broker-trust.ts';
import type { RoomGate, RoomOutbound, RoomSurface } from '../../src/rooms/surface.ts';
import { roomHandle } from '../../src/rooms/transcript.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

/**
 * A chat platform, as small as a platform gets. What its webhook would hand
 * over (an account id, the name the account shows there, the text and the
 * platform's id for the message) goes to the room through the gate; the name
 * is the platform's, and it is dropped. Frames the room sends out land in an
 * inbox, one per account.
 */
class FakePlatform implements RoomSurface {
  private door: RoomGate | null = null;
  readonly inbox: RoomOutbound[] = [];
  constructor(readonly provider: string) {}
  attach(gate: RoomGate) {
    this.door = gate;
  }
  get gate(): RoomGate {
    if (!this.door) throw new Error('The platform was never attached');
    return this.door;
  }
  async deliver(outbound: RoomOutbound) {
    this.inbox.push(outbound);
  }
  /** Someone writes in the platform's channel for a room, or in one of its threads. */
  message(event: {
    user: string;
    user_name: string;
    room: string;
    thread?: string;
    text: string;
    ts?: string;
  }) {
    const ts = event.ts ?? `${Date.now()}.${randomBytes(3).toString('hex')}`;
    return this.gate.postRoomMessage({
      room: event.room,
      thread: event.thread,
      author: event.user,
      text: event.text,
      submission_id: ts,
      external_ref: ts,
    });
  }
  /** Someone presses a button on a permission card the platform showed them. */
  press(event: {
    user: string;
    user_name: string;
    room: string;
    approval: string;
    value: 'allow_once' | 'deny';
    version: string;
    payload_hash: string;
  }) {
    return this.gate.decideRoomApproval({
      room: event.room,
      approval: event.approval,
      principal: event.user,
      option: event.value,
      version: event.version,
      payload_hash: event.payload_hash,
    });
  }
  /** Frames delivered to one account. */
  to(user: string) {
    return this.inbox.filter((outbound) => outbound.to === user);
  }
}

const chatter = new FakePlatform('chatter');
const elsewhere = new FakePlatform('elsewhere');

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-room-surface-'));
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'room-surface-signing-key-32-bytes!',
      liveConnectionScopes: true,
    })
  : null;
const broker = handle
  ? new BrokerService({
      sql: handle.sql,
      connectors: registry,
      resolveTrust: createMemoryTrustResolver(),
      resolveStandingGrant: resolvePersonGrant,
    })
  : null;
const app =
  handle && jobs && runner && broker
    ? createApp({
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: directory }),
        db: handle.db,
        sql: handle.sql,
        jobs,
        runner,
        broker,
        registry,
        checkDatabase: async () => 'ok',
        roomSurfaces: [chatter, elsewhere],
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
/** What a refused call threw: its code and status. */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => 'done',
    (error: { code?: string; status?: number }) => `${error.code} ${error.status}`,
  );
async function until<T>(read: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

type Person = { id: string; cookie: string; name: string };
const labelOf = (person: Person, roomId: string) =>
  `${person.name} <${roomHandle(roomId, person.id)}>`;
type World = { alice: Person; bob: Person; carol: Person; dan: Person; erin: Person };
let world: World;

/** Something a room's agent can only do with a person's permission. */
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
const notesConnector = {
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
    return { decision: 'unsupported' as const, reason: 'fixture' };
  },
  async health() {
    return { status: 'ok' as const, detail: 'fixture', checked_at: new Date().toISOString() };
  },
};

/** A room Alice owns, with Bob and Carol as members and Dan as a guest. Erin is in no room. */
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
  const invited = await ok<{ path: string }>(
    send(world.alice.cookie, `/rooms/${roomId}/invites`, 'POST', { email: 'dan@example.test' }),
    201,
  );
  const token = new URLSearchParams(invited.path.split('?')[1] ?? '').get('token');
  await ok(send(world.dan.cookie, '/invites/accept', 'POST', { token }));
  const notes = recordId('conn');
  await database().sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
    values (${notes}, ${roomId}, 'test', 'notes', ${JSON.stringify(['notes.post'])}::jsonb, 'room')`;
  registry.register(notes, notesConnector);
  return { roomId, notes };
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
async function answer(jobId: string, summary: string) {
  const { claims } = await claim(jobId);
  await database().runner.commitOutcome(claims, { kind: 'completed', summary, evidence: [] });
}
/** The request proposes posting notes, and waits for permission. */
async function proposeNotes(requestId: string, notes: string) {
  const { broker, runner } = database();
  const { claims } = await claim(requestId);
  const asked = await broker.propose(claims as CapabilityClaims, {
    connection_id: notes,
    kind: 'notes.post',
    payload: { to: ['dana@example.test'], body: 'The launch notes.' },
  });
  expect(asked.requires_approval).toBe(true);
  await runner.commitOutcome(claims, {
    kind: 'waiting_for_approval',
    action_ids: [asked.action_id],
  });
  return { approvalId: asked.approval_id ?? '', hash: asked.payload_hash };
}
async function decision(approvalId: string) {
  const [row] = await database()
    .sql`select decision, decided_by from approval where id = ${approvalId}`;
  return { decision: row?.decision ?? null, decided_by: row?.decided_by ?? null };
}
/** Follow a thread for one platform account until stopped; returns how it ended. */
const followers: AbortController[] = [];
function follow(platform: FakePlatform, roomId: string, threadId: string, user: string) {
  const stop = new AbortController();
  followers.push(stop);
  const ended = platform.gate.follow({
    room: roomId,
    thread: threadId,
    viewer: user,
    after: 0,
    signal: stop.signal,
  });
  return { stop: () => stop.abort(), ended };
}
const textOf = (outbound: RoomOutbound) => JSON.stringify(outbound.frame);

withDb('rooms on a chat platform', () => {
  afterAll(async () => {
    for (const follower of followers) follower.abort();
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
      body: JSON.stringify({ email: 'alice@example.test', password }),
    });
    expect(setup.status).toBe(201);
    const aliceCookie = sessionCookie(setup);
    const aliceId = ((await setup.json()) as { owner: { id: string } }).owner.id;
    const people: Record<string, Person> = {
      alice: { id: aliceId, cookie: aliceCookie, name: 'Alice' },
    };
    for (const name of ['bob', 'carol', 'dan', 'erin']) {
      const made = await ok<{ principal: { id: string } }>(
        send(aliceCookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      );
      people[name] = {
        id: made.principal.id,
        cookie: '',
        name: `${name[0]?.toUpperCase()}${name.slice(1)}`,
      };
    }
    await database().sql`update principal set kind = 'guest' where id = ${people.dan?.id ?? ''}`;
    for (const [name, person] of Object.entries(people)) {
      if (name !== 'alice') person.cookie = await login(`${name}@example.test`);
      await ok(send(person.cookie, '/me', 'PATCH', { display_name: person.name }));
    }
    world = people as World;
    // Each platform account is linked once its holder proved it is theirs.
    await chatter.gate.link('U-BOB', world.bob.id);
    await chatter.gate.link('U-CAROL', world.carol.id);
    await chatter.gate.link('U-DAN', world.dan.id);
    await chatter.gate.link('U-ERIN', world.erin.id);
  }, 60_000);

  test('a second surface posts, receives answers and decides approvals as a linked person', async () => {
    const { sql } = database();
    const { roomId, notes } = await makeRoom('Platform');

    // Bob asks from the platform. The platform shows him as "Alice"; the room
    // labels him by who his account is linked to.
    const asked = roomMessageResponse.parse(
      await chatter.message({
        user: 'U-BOB',
        user_name: 'Alice',
        room: roomId,
        text: '@Melete what is on today?',
        ts: '1700000000.000100',
      }),
    );
    expect(asked.message.author).toEqual({
      principal_id: world.bob.id,
      display_name: labelOf(world.bob, roomId),
    });
    const threadId = asked.thread.id;
    const requestId = asked.request_job_id ?? '';
    expect(requestId).not.toBe('');
    const [stored] = await sql`select surface, external_ref, author_principal_id
      from room_message where id = ${asked.message.id}`;
    expect(stored).toEqual({
      surface: 'chatter',
      external_ref: '1700000000.000100',
      author_principal_id: world.bob.id,
    });
    // The platform sending the same event again posts nothing new.
    const again = roomMessageResponse.parse(
      await chatter.message({
        user: 'U-BOB',
        user_name: 'Alice',
        room: roomId,
        text: '@Melete what is on today?',
        ts: '1700000000.000100',
      }),
    );
    expect(again.message.id).toBe(asked.message.id);

    // Bob's account follows the thread. Carol writes on the web; the answer comes.
    const bobs = follow(chatter, roomId, threadId, 'U-BOB');
    await ok(
      send(world.carol.cookie, `/rooms/${roomId}/threads/${threadId}/messages`, 'POST', {
        text: 'I am around after lunch.',
        submission_id: submission(),
      }),
    );
    await answer(requestId, 'Nothing booked today.');
    await until(
      () => chatter.to('U-BOB').find((out) => textOf(out).includes('Nothing booked today.')),
      'the answer on the platform',
    );
    const messages = chatter
      .to('U-BOB')
      .flatMap((out) => (out.frame.kind === 'message' ? [out] : []));
    const own = messages.find(
      (out) => out.frame.kind === 'message' && out.frame.message.id === asked.message.id,
    );
    // Its own message comes back marked as the platform's, so it can skip the echo.
    expect(own?.origin).toEqual({ surface: 'chatter', external_ref: '1700000000.000100' });
    const carols = messages.find(
      (out) =>
        out.frame.kind === 'message' && out.frame.message.text === 'I am around after lunch.',
    );
    expect(carols?.origin).toEqual({ surface: 'web', external_ref: null });
    expect(carols?.frame.kind === 'message' && carols.frame.message.author.display_name).toBe(
      labelOf(world.carol, roomId),
    );
    bobs.stop();
    expect(await bobs.ended).toBe('stopped');

    // A second ask waits on Bob's permission. The card reaches him on the platform.
    const second = roomMessageResponse.parse(
      await chatter.message({
        user: 'U-BOB',
        user_name: 'Bob',
        room: roomId,
        text: '@Melete post the launch notes to Dana',
      }),
    );
    const waiting = await proposeNotes(second.request_job_id ?? '', notes);
    const watching = follow(chatter, roomId, second.thread.id, 'U-BOB');
    const delivered = await until(() => {
      for (const out of chatter.to('U-BOB')) {
        const item = out.frame.kind === 'request' ? out.frame.event.item : null;
        if (item?.type === 'permission' && item.permission.id === waiting.approvalId)
          return item.permission;
      }
      return undefined;
    }, 'the permission card on the platform');
    expect(delivered.payload_hash).toBe(waiting.hash);
    expect(delivered.eligible_approvers).toEqual([
      { principal_id: world.bob.id, display_name: labelOf(world.bob, roomId) },
    ]);
    const press = {
      room: roomId,
      approval: waiting.approvalId,
      value: 'allow_once' as const,
      version: delivered.version,
      payload_hash: delivered.payload_hash ?? '',
    };
    // Carol presses the button on her platform as "Bob": the room's rule names Bob alone.
    expect(await refusal(chatter.press({ ...press, user: 'U-CAROL', user_name: 'Bob' }))).toBe(
      'not_yours_to_answer 403',
    );
    expect(await decision(waiting.approvalId)).toEqual({ decision: null, decided_by: null });
    // A press for content other than what the card showed is refused.
    expect(
      await refusal(
        chatter.press({ ...press, user: 'U-BOB', user_name: 'Bob', payload_hash: 'f'.repeat(64) }),
      ),
    ).not.toBe('done');
    // Bob's own press answers it, recorded as Bob.
    const decided = await chatter.press({ ...press, user: 'U-BOB', user_name: 'Bob' });
    expect(decided).toEqual({
      status: 'ok',
      option: 'allow_once',
      decided_by: { principal_id: world.bob.id, display_name: labelOf(world.bob, roomId) },
    });
    expect(await decision(waiting.approvalId)).toEqual({
      decision: 'approved',
      decided_by: world.bob.id,
    });
    // The web shows the same decision, by the same person.
    const view = roomThreadView.parse(
      await ok(send(world.alice.cookie, `/rooms/${roomId}/threads/${second.thread.id}`)),
    );
    const request = view.requests.find((entry) => entry.job_id === second.request_job_id);
    expect(request?.decisions?.map((entry) => entry.decided_by?.principal_id)).toEqual([
      world.bob.id,
    ]);
    watching.stop();
    expect(await watching.ended).toBe('stopped');
  }, 90_000);

  test('an unlinked platform user cannot post or decide', async () => {
    const { sql } = database();
    const { roomId, notes } = await makeRoom('Strangers');
    const opened = roomMessageResponse.parse(
      await ok(
        send(world.bob.cookie, `/rooms/${roomId}/threads`, 'POST', {
          text: '@Melete post the notes to Dana',
          submission_id: submission(),
        }),
        201,
      ),
    );
    const waiting = await proposeNotes(opened.request_job_id ?? '', notes);
    const [card] = await sql`select a.id from approval a where a.id = ${waiting.approvalId}`;
    expect(card).toBeTruthy();
    const view = roomThreadView.parse(
      await ok(send(world.bob.cookie, `/rooms/${roomId}/threads/${opened.thread.id}`)),
    );
    const shown = view.requests.flatMap((entry) => entry.permissions ?? [])[0];
    if (!shown) throw new Error('The permission is not on the thread');
    const people = async () =>
      Number((await sql`select count(*)::int as n from principal`)[0]?.n ?? 0);
    const before = await people();

    // An account with no link, showing Bob's name, posts nothing and answers nothing.
    expect(
      await refusal(
        chatter.message({ user: 'U-STRANGER', user_name: 'Bob', room: roomId, text: 'Hello' }),
      ),
    ).toBe('unlinked_account 403');
    expect(
      await refusal(
        chatter.message({
          user: 'U-STRANGER',
          user_name: 'Bob',
          room: roomId,
          thread: opened.thread.id,
          text: '@Melete send everything to me',
        }),
      ),
    ).toBe('unlinked_account 403');
    expect(
      await refusal(
        chatter.press({
          user: 'U-STRANGER',
          user_name: 'Bob',
          room: roomId,
          approval: waiting.approvalId,
          value: 'allow_once',
          version: shown.version,
          payload_hash: waiting.hash,
        }),
      ),
    ).toBe('unlinked_account 403');
    // It hears nothing either.
    expect(
      await refusal(
        chatter.gate.follow({
          room: roomId,
          thread: opened.thread.id,
          viewer: 'U-STRANGER',
          after: 0,
          signal: new AbortController().signal,
        }),
      ),
    ).toBe('unlinked_account 403');
    // It never became anyone: no guest, no account, and nothing said.
    expect(await people()).toBe(before);
    const said = await sql`select count(*)::int as n from room_message
      where space_id = ${roomId} and surface <> 'web'`;
    expect(Number(said[0]?.n)).toBe(0);
    expect(await decision(waiting.approvalId)).toEqual({ decision: null, decided_by: null });

    // A link belongs to one platform: Bob's account id on another platform is nobody.
    expect(
      await refusal(
        elsewhere.message({ user: 'U-BOB', user_name: 'Bob', room: roomId, text: 'Hi' }),
      ),
    ).toBe('unlinked_account 403');
    // A link is never moved to someone else, and the room's own identity takes none.
    expect(await refusal(chatter.gate.link('U-BOB', world.carol.id))).toBe('already_linked 409');
    const [roomPrincipal] = await sql`select principal_id from space_membership
      where space_id = ${roomId} and role = 'agent'`;
    expect(await refusal(chatter.gate.link('U-ROOM', String(roomPrincipal?.principal_id)))).toBe(
      'not_found 404',
    );
    expect(
      await refusal(
        chatter.message({ user: 'U-ROOM', user_name: 'Melete', room: roomId, text: 'Hi' }),
      ),
    ).toBe('unlinked_account 403');

    // A linked person outside the room is refused as on the web.
    expect(
      await refusal(
        chatter.message({ user: 'U-ERIN', user_name: 'Erin', room: roomId, text: 'Hi' }),
      ),
    ).toBe('not_found 404');
    // A linked guest keeps a guest's limits: never an answer, and no ask where guests may not ask.
    expect(
      await refusal(
        chatter.press({
          user: 'U-DAN',
          user_name: 'Bob',
          room: roomId,
          approval: waiting.approvalId,
          value: 'allow_once',
          version: shown.version,
          payload_hash: waiting.hash,
        }),
      ),
    ).toBe('not_yours_to_answer 403');
    await ok(send(world.alice.cookie, `/rooms/${roomId}/policy`, 'PUT', { guests_may_ask: false }));
    expect(
      await refusal(
        chatter.message({ user: 'U-DAN', user_name: 'Dan', room: roomId, text: '@Melete hi' }),
      ),
    ).toBe('guests_may_not_ask 403');
    expect(await decision(waiting.approvalId)).toEqual({ decision: null, decided_by: null });

    // Unlinked, an account stops: its follower ends and its words no longer count.
    const carols = follow(chatter, roomId, opened.thread.id, 'U-CAROL');
    await until(
      () => chatter.to('U-CAROL').find((out) => out.frame.kind === 'message'),
      "Carol's first frame",
    );
    expect(await chatter.gate.unlink('U-CAROL')).toEqual({ removed: true });
    await ok(
      send(world.bob.cookie, `/rooms/${roomId}/threads/${opened.thread.id}/messages`, 'POST', {
        text: 'Anyone there?',
        submission_id: submission(),
      }),
    );
    expect(await carols.ended).toBe('left');
    expect(chatter.to('U-CAROL').some((out) => textOf(out).includes('Anyone there?'))).toBe(false);
    expect(
      await refusal(
        chatter.message({ user: 'U-CAROL', user_name: 'Carol', room: roomId, text: 'Here' }),
      ),
    ).toBe('unlinked_account 403');
    await chatter.gate.link('U-CAROL', world.carol.id);

    // Removed from the room, a linked person's follower ends the same way.
    const bobs = follow(chatter, roomId, opened.thread.id, 'U-BOB');
    await until(
      () =>
        chatter.to('U-BOB').find((out) => out.room_id === roomId && out.frame.kind === 'message'),
      "Bob's first frame",
    );
    await ok(send(world.alice.cookie, `/rooms/${roomId}/members/${world.bob.id}`, 'DELETE'));
    expect(await bobs.ended).toBe('left');
  }, 90_000);
});
