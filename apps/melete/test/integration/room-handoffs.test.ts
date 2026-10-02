/**
 * What crosses between a room and a person's own space, and only with that
 * person's say-so. A room's agent hands a person a task; they read it whole
 * and run it in their own space, or decline it; the room hears the result
 * only once they approve that exact text. A person's own work posts to a room,
 * or adds a file to it, only as them, with their approval, and only while they
 * are in it; it learns nothing of a room they are not in.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  type CapabilityClaims,
  type ConnectorManifest,
  type DispatchResult,
  handoffList,
  handoffResponse,
  homeResponse,
  type JsonValue,
  roomDetail,
  roomMessageResponse,
  roomThreadView,
} from '@melete/contracts';
import { createArtifactRecorder } from '../../src/artifact/record.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { loadEnv } from '../../src/env.ts';
import { resolvePersonGrant } from '../../src/experience/chase-scope.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { createMemoryTrustResolver } from '../../src/memory/broker-trust.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import { forgetMemory } from '../../src/memory/forget.ts';
import type { RestrictionRecord } from '../../src/memory/restore.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { roomHandle } from '../../src/rooms/transcript.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { sweepOperational } from '../../src/spaces/plan.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-room-handoffs-'));
const spacesRoot = join(directory, 'spaces');
const workRoot = join(directory, 'work');
await mkdir(spacesRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'room-handoffs-signing-key-32-bytes!',
      liveConnectionScopes: true,
      artifactRoots: { workRoot, spacesRoot },
    })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
const broker = handle
  ? new BrokerService({
      sql: handle.sql,
      connectors: registry,
      resolveTrust: createMemoryTrustResolver(),
      resolveStandingGrant: resolvePersonGrant,
      recordArtifact: createArtifactRecorder(undefined, { workRoot, spacesRoot }),
    })
  : null;
const app =
  handle && jobs && runner && broker && triggers
    ? createApp({
        env: loadEnv({
          NODE_ENV: 'test',
          MELETE_SPACES_DIR: spacesRoot,
          MELETE_WORK_DIR: workRoot,
        }),
        db: handle.db,
        sql: handle.sql,
        jobs,
        runner,
        broker,
        registry,
        triggers,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function database() {
  if (!handle || !queue || !app || !jobs || !runner || !broker || !triggers)
    throw new Error('Postgres unavailable');
  return { ...handle, app, jobs, runner, broker, triggers };
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

type Person = { id: string; cookie: string; name: string; space: string };
/** How a room names a person: their name and the room's handle for them. */
const labelOf = (person: Person, roomId: string) =>
  `${person.name} <${roomHandle(roomId, person.id)}>`;
type World = { alice: Person; bob: Person; carol: Person; dan: Person; erin: Person };
let world: World;

/** Something a person's own work can only do with their permission: post notes to people. */
const notesManifest: ConnectorManifest = {
  name: 'notes',
  version: '0.1.0',
  provider: 'test',
  description: 'Post notes to people.',
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
const notes: Connector = {
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

async function roomConnection(spaceId: string) {
  const [row] = await database().sql`select id from connection
    where space_id = ${spaceId} and provider = 'room' and status = 'active'`;
  if (!row) throw new Error(`No room connection in ${spaceId}`);
  return String(row.id);
}
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
async function claim(jobId: string) {
  const { sql, runner } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  const claimed = await runner.claim({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
  if (!claimed) throw new Error(`Job ${jobId} could not be claimed`);
  return claimed.claims as CapabilityClaims;
}
async function receiptOf(actionId: string) {
  const [row] = await database().sql`select status, receipt from action where id = ${actionId}`;
  return {
    status: String(row?.status),
    detail: (row?.receipt?.detail ?? {}) as Record<string, unknown>,
  };
}
async function jobState(jobId: string) {
  const [row] = await database().sql`select state from job where id = ${jobId}`;
  return String(row?.state);
}
async function threadOf(person: Person, roomId: string, threadId: string) {
  return roomThreadView.parse(
    await ok(send(person.cookie, `/rooms/${roomId}/threads/${threadId}`)),
  );
}
/** What a handoff's row still holds of its result. */
async function resultHeld(handoffId: string) {
  const [row] = await database()
    .sql`select result_text, result_hash from room_handoff where id = ${handoffId}`;
  return { text: row?.result_text ?? null, hash: row?.result_hash ?? null };
}
/** Every handoff row whose stored result still carries these words. */
async function textAnywhere(words: string) {
  return [
    ...(await database().sql`select id from room_handoff where result_text like ${`%${words}%`}`),
  ];
}

/** What the room's request heard from a handoff, if anything. */
async function heard(jobId: string) {
  const rows = await database().sql`select payload->'event'->'payload' as said from event
    where job_id = ${jobId} and type = 'notice' and payload->>'kind' = 'trigger_event'
    order by seq`;
  return rows.map((row) => row.said);
}

/**
 * Bob asks the room's agent for something only his own setup can do. The
 * room's request hands it to him and waits to hear how it ended.
 */
async function handOff(roomId: string, task: string, member?: Person) {
  const { broker, runner } = database();
  const opened = roomMessageResponse.parse(
    await ok(
      send(world.bob.cookie, `/rooms/${roomId}/threads`, 'POST', {
        text: '@Melete send the launch summary from my email to Dana',
        submission_id: submission(),
      }),
      201,
    ),
  );
  const requestId = opened.request_job_id ?? '';
  const claims = await claim(requestId);
  const proposed = await broker.propose(claims, {
    connection_id: await roomConnection(roomId),
    kind: 'room.handoff',
    payload: { task, ...(member ? { member_id: member.id } : {}) },
  });
  // The person's consent card is the approval: handing it over asks nobody.
  expect(proposed.requires_approval).toBe(false);
  const { status, detail } = await receiptOf(proposed.action_id);
  expect(status).toBe('succeeded');
  const triggerId = String(detail.trigger_id);
  await runner.commitOutcome(claims, {
    kind: 'waiting_for_event_or_time',
    wait: { kind: 'event', trigger_id: triggerId, deadline_at: null },
  });
  expect(await jobState(requestId)).toBe('waiting_for_event_or_time');
  return { requestId, threadId: opened.thread.id, handoffId: String(detail.handoff_id) };
}
async function handoffsOf(person: Person) {
  return handoffList.parse(await ok(send(person.cookie, '/handoffs'))).handoffs;
}
async function accept(person: Person, handoffId: string, task: string) {
  return handoffResponse.parse(
    await ok(
      send(person.cookie, `/handoffs/${handoffId}`, 'POST', {
        decision: 'accept',
        task_hash: sha(task),
      }),
    ),
  ).handoff;
}
/** A person's own work, as they would start it. */
async function ownJob(person: Person, objective: string) {
  return principalContext.run(person.id, () =>
    database().jobs.create(
      { space_id: person.space, title: objective.slice(0, 60), objective },
      'owner_request',
    ),
  );
}

withDb('room handoffs', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  // Alice set the installation up. Bob and Carol are people in her rooms, Dan is a guest
  // where she invites him, and Erin is in none.
  beforeAll(async () => {
    const { app, sql } = database();
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password }),
    });
    expect(setup.status).toBe(201);
    const aliceCookie = sessionCookie(setup);
    const aliceId = ((await setup.json()) as { owner: { id: string } }).owner.id;
    const people: Record<string, Omit<Person, 'space'>> = {
      alice: { id: aliceId, cookie: aliceCookie, name: 'Alice' },
    };
    for (const name of ['bob', 'carol', 'dan', 'erin']) {
      const made = await ok<{ principal: { id: string } }>(
        send(aliceCookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      );
      const label = `${name[0]?.toUpperCase()}${name.slice(1)}`;
      people[name] = {
        id: made.principal.id,
        cookie: '',
        name: label,
      };
    }
    await sql`update principal set kind = 'guest' where id = ${people.dan?.id ?? ''}`;
    const spaced: Record<string, Person> = {};
    for (const [name, person] of Object.entries(people)) {
      if (name !== 'alice') person.cookie = await login(`${name}@example.test`);
      const display = `${name[0]?.toUpperCase()}${name.slice(1)}`;
      await ok(send(person.cookie, '/me', 'PATCH', { display_name: display }));
      const [own] = await sql`select id from space where kind = 'personal'
        and coalesce(owner_principal_id, (select id from owner limit 1)) = ${person.id}`;
      spaced[name] = { ...person, space: String(own?.id) };
    }
    world = spaced as World;
    // Bob's own way of sending notes, which asks him every time.
    const notesId = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes)
      values (${notesId}, ${world.bob.space}, 'test', 'Notes', ${JSON.stringify(['notes.post'])}::jsonb)`;
    registry.register(notesId, notes);
  }, 60_000);

  test('a handoff runs exactly the text the person accepted, in their own space, with their own approvals', async () => {
    const { broker, sql } = database();
    const roomId = await makeRoom('Launch');
    const task = 'Email the launch summary to dana@example.test from my mailbox.\nKeep it short.';
    const { handoffId, threadId } = await handOff(roomId, task);

    // Bob sees the whole task, who asked and which room, on his Home and in his list.
    const [card] = await handoffsOf(world.bob);
    expect(card).toMatchObject({
      id: handoffId,
      room: { id: roomId, name: 'Launch' },
      task,
      task_hash: sha(task),
      state: 'pending',
      job_id: null,
      result: null,
    });
    expect(card?.asked_by).toEqual({
      principal_id: world.bob.id,
      display_name: labelOf(world.bob, roomId),
    });
    const home = homeResponse.parse(await ok(send(world.bob.cookie, '/home')));
    expect(home.handoffs?.map((item) => item.id)).toEqual([handoffId]);
    const approvals = await ok<{ handoffs?: { id: string }[] }>(
      send(world.bob.cookie, '/permissions'),
    );
    expect(approvals.handoffs?.map((item) => item.id)).toEqual([handoffId]);
    // Nobody else sees it or answers it.
    expect(await handoffsOf(world.carol)).toEqual([]);
    expect(homeResponse.parse(await ok(send(world.alice.cookie, '/home'))).handoffs).toEqual([]);
    expect(
      (
        await send(world.carol.cookie, `/handoffs/${handoffId}`, 'POST', {
          decision: 'accept',
          task_hash: sha(task),
        })
      ).status,
    ).toBe(404);

    // Accepting names the task Bob read; any other text is refused and nothing runs.
    const wrong = await send(world.bob.cookie, `/handoffs/${handoffId}`, 'POST', {
      decision: 'accept',
      task_hash: sha(`${task} And copy everyone.`),
    });
    expect(wrong.status).toBe(409);
    expect((await handoffsOf(world.bob))[0]?.state).toBe('pending');

    const running = await accept(world.bob, handoffId, task);
    expect(running.state).toBe('running');
    // While it runs it stays on his Home, as running, with the work it started.
    const runningHome = homeResponse.parse(await ok(send(world.bob.cookie, '/home')));
    expect(runningHome.handoffs?.map((item) => [item.id, item.state, item.job_id])).toEqual([
      [handoffId, 'running', running.job_id],
    ]);
    const [work] = await sql`select * from job where id = ${running.job_id}`;
    expect({
      objective: work?.objective,
      space: work?.space_id,
      principal: work?.principal_id,
      origin: work?.objective_origin,
      audience: work?.audience,
    }).toEqual({
      objective: task,
      space: world.bob.space,
      principal: world.bob.id,
      origin: 'room_handoff',
      audience: 'principal',
    });
    // The room hears that Bob is running it, and nothing of his space.
    const thread = await threadOf(world.carol, roomId, threadId);
    expect(thread.messages.at(-1)).toMatchObject({
      kind: 'system',
      author: { principal_id: world.bob.id, display_name: labelOf(world.bob, roomId) },
      text: `${labelOf(world.bob, roomId)} is running this with their own setup.`,
    });

    // His work sends with his approval, and the address from the room's task
    // carries a warning on his own card.
    const claims = await claim(String(running.job_id));
    const asked = await broker.propose(claims, {
      connection_id: (
        await sql`select id from connection where space_id = ${world.bob.space} and provider = 'test'`
      )[0]?.id,
      kind: 'notes.post',
      payload: { to: ['dana@example.test'], body: 'The launch summary.' },
    });
    expect(asked.requires_approval).toBe(true);
    expect(
      asked.origin_warnings.map((warning) => [warning.origin_trust, warning.description]),
    ).toEqual([
      [
        'external_content',
        'This value came from a request in the room "Launch", not from something you typed.',
      ],
    ]);
    const mine = await ok<{ permissions: { id: string }[] }>(
      send(world.bob.cookie, '/permissions'),
    );
    expect(mine.permissions.map((item) => item.id)).toContain(asked.approval_id ?? '');
    // The room sees no card for it: it is Bob's own work.
    const roomView = await threadOf(world.alice, roomId, threadId);
    expect(roomView.requests.flatMap((request) => request.permissions ?? [])).toEqual([]);
    const theirs = await ok<{ permissions: { id: string }[] }>(
      send(world.alice.cookie, '/permissions'),
    );
    expect(theirs.permissions.map((item) => item.id)).not.toContain(asked.approval_id ?? '');
  });

  test('a handoff result reaches the room only after its owner approves that exact text', async () => {
    const { runner, sql } = database();
    const roomId = await makeRoom('Results');
    const task = 'Find the venue deposit in my mail.';
    const { requestId, handoffId, threadId } = await handOff(roomId, task);
    const running = await accept(world.bob, handoffId, task);
    const answer = 'The deposit was 400 dollars, paid on the 3rd.';
    const claims = await claim(String(running.job_id));
    await runner.commitOutcome(claims, { kind: 'completed', summary: answer, evidence: [] });

    // Finished: Bob sees the exact result, and the room has none of it yet.
    const [settled] = await handoffsOf(world.bob);
    expect(settled).toMatchObject({ state: 'settled', result: answer, result_hash: sha(answer) });
    const before = await threadOf(world.carol, roomId, threadId);
    expect(before.messages.some((message) => message.text?.includes('400'))).toBe(false);
    expect(await jobState(requestId)).toBe('waiting_for_event_or_time');
    expect(await heard(requestId)).toEqual([]);

    // Only Bob shares, and only the text he was shown.
    expect(
      (
        await send(world.carol.cookie, `/handoffs/${handoffId}/result`, 'POST', {
          decision: 'share',
          result_hash: sha(answer),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(world.bob.cookie, `/handoffs/${handoffId}/result`, 'POST', {
          decision: 'share',
          result_hash: sha('The deposit was 4000 dollars.'),
        })
      ).status,
    ).toBe(409);
    const shared = handoffResponse.parse(
      await ok(
        send(world.bob.cookie, `/handoffs/${handoffId}/result`, 'POST', {
          decision: 'share',
          result_hash: sha(answer),
        }),
      ),
    ).handoff;
    expect(shared.state).toBe('shared');
    // The thread holds the shared words; the handoff keeps no copy of them.
    expect(await resultHeld(handoffId)).toEqual({ text: null, hash: null });
    const after = await threadOf(world.carol, roomId, threadId);
    expect(after.messages.filter((message) => message.kind === 'handoff_result')).toMatchObject([
      {
        author: { principal_id: world.bob.id, display_name: labelOf(world.bob, roomId) },
        via_agent: true,
        text: answer,
      },
    ]);
    // The room's request wakes with what Bob shared.
    expect(await jobState(requestId)).toBe('queued');
    expect(await heard(requestId)).toEqual([
      {
        handoff_id: handoffId,
        outcome: 'shared',
        person: labelOf(world.bob, roomId),
        result: answer,
      },
    ]);
    expect(
      (
        await send(world.bob.cookie, `/handoffs/${handoffId}/result`, 'POST', {
          decision: 'share',
          result_hash: sha(answer),
        })
      ).status,
    ).toBe(409);

    // Kept private: the room hears only that, never the words.
    const second = await handOff(roomId, 'Check my calendar for Friday.');
    const kept = await accept(world.bob, second.handoffId, 'Check my calendar for Friday.');
    const secret = 'Friday: dentist at 3pm.';
    await runner.commitOutcome(await claim(String(kept.job_id)), {
      kind: 'completed',
      summary: secret,
      evidence: [],
    });
    await ok(
      send(world.bob.cookie, `/handoffs/${second.handoffId}/result`, 'POST', { decision: 'keep' }),
    );
    const roomRows = await sql`select text from room_message where space_id = ${roomId}`;
    expect(roomRows.some((row) => String(row.text).includes('dentist'))).toBe(false);
    expect(await resultHeld(second.handoffId)).toEqual({ text: null, hash: null });
    expect(await textAnywhere('dentist')).toEqual([]);
    expect(roomRows.map((row) => row.text)).toContain(
      `${labelOf(world.bob, roomId)} kept the result private.`,
    );
    expect(await heard(second.requestId)).toEqual([
      { handoff_id: second.handoffId, outcome: 'kept', person: labelOf(world.bob, roomId) },
    ]);
  });

  test('a declined or expired handoff tells the room request, which settles without it', async () => {
    const { runner, sql } = database();
    const roomId = await makeRoom('Declines');
    // Named: the card goes to Carol, who decides alone.
    const declined = await handOff(roomId, 'Book the meeting room from my account.', world.carol);
    expect((await handoffsOf(world.bob)).map((item) => item.id)).not.toContain(declined.handoffId);
    await ok(
      send(world.carol.cookie, `/handoffs/${declined.handoffId}`, 'POST', { decision: 'decline' }),
    );
    expect(await jobState(declined.requestId)).toBe('queued');
    expect(await heard(declined.requestId)).toEqual([
      { handoff_id: declined.handoffId, outcome: 'declined', person: labelOf(world.carol, roomId) },
    ]);
    const thread = await threadOf(world.bob, roomId, declined.threadId);
    expect(thread.messages.at(-1)?.text).toBe(
      `${labelOf(world.carol, roomId)} declined to run this with their own setup.`,
    );
    // The request goes on without it, and nothing ran in Carol's space.
    await runner.commitOutcome(await claim(declined.requestId), {
      kind: 'completed',
      summary: 'Carol could not book it.',
      evidence: [],
    });
    // Answered, it rests like any conversation, no longer waiting on the handoff.
    expect(await jobState(declined.requestId)).toBe('waiting_for_input');
    const [ran] =
      await sql`select personal_job_id from room_handoff where id = ${declined.handoffId}`;
    expect(ran?.personal_job_id).toBeNull();
    expect(
      (
        await send(world.carol.cookie, `/handoffs/${declined.handoffId}`, 'POST', {
          decision: 'accept',
          task_hash: sha('Book the meeting room from my account.'),
        })
      ).status,
    ).toBe(409);

    // Unanswered past its time: withdrawn, and the room is told.
    const late = await handOff(roomId, 'Forward the invoice.');
    await sql`update room_handoff set expires_at = now() - interval '1 minute' where id = ${late.handoffId}`;
    // Bob's Home is where he would have seen it, and reading it wakes the room's request.
    await ok(send(world.bob.cookie, '/home'));
    expect(await jobState(late.requestId)).toBe('queued');
    const [gone] = (await handoffsOf(world.bob)).filter((item) => item.id === late.handoffId);
    expect(gone?.state).toBe('expired');
    expect(await heard(late.requestId)).toEqual([
      { handoff_id: late.handoffId, outcome: 'expired', person: labelOf(world.bob, roomId) },
    ]);
    expect(
      (
        await send(world.bob.cookie, `/handoffs/${late.handoffId}`, 'POST', {
          decision: 'accept',
          task_hash: sha('Forward the invoice.'),
        })
      ).status,
    ).toBe(409);

    // A request stopped while its handoff waits takes the handoff with it.
    const stopped = await handOff(roomId, 'Draft the agenda from my notes.');
    await ok(send(world.bob.cookie, `/rooms/${roomId}/requests/${stopped.requestId}/stop`, 'POST'));
    const [withdrawn] = (await handoffsOf(world.bob)).filter(
      (item) => item.id === stopped.handoffId,
    );
    expect(withdrawn?.state).toBe('expired');
    expect(
      (
        await send(world.bob.cookie, `/handoffs/${stopped.handoffId}`, 'POST', {
          decision: 'accept',
          task_hash: sha('Draft the agenda from my notes.'),
        })
      ).status,
    ).toBe(409);
    expect((await threadOf(world.carol, roomId, stopped.threadId)).messages.at(-1)?.text).toBe(
      `The request this came from ended, so ${labelOf(world.bob, roomId)} was not asked to run it.`,
    );
  });

  test("only a member's request hands work to a person, and nobody is buried in handoffs", async () => {
    const { broker, sql } = database();
    const roomId = await makeRoom('Limits');
    await sql`insert into space_membership (principal_id, space_id, role)
      values (${world.dan.id}, ${roomId}, 'guest')`;
    const roomTools = await roomConnection(roomId);
    const ask = async (person: Person) => {
      const opened = roomMessageResponse.parse(
        await ok(
          send(person.cookie, `/rooms/${roomId}/threads`, 'POST', {
            text: '@Melete get this done',
            submission_id: submission(),
          }),
          201,
        ),
      );
      return claim(opened.request_job_id ?? '');
    };
    const handTo = (claims: CapabilityClaims, task: string, member: Person) =>
      broker
        .propose(claims, {
          connection_id: roomTools,
          kind: 'room.handoff',
          payload: { task, member_id: member.id },
        })
        .then(
          (proposed) => proposed.status,
          (error: { code?: string }) => error.code,
        );
    // A guest's request reaches nobody's own setup, a member's or their own.
    const guest = await ask(world.dan);
    expect(await handTo(guest, "Read Bob's mail for the invoice.", world.bob)).toBe('scope_denied');
    expect(await handTo(guest, 'Read my mail.', world.dan)).not.toBe('succeeded');
    // One person has at most three waiting from a room.
    for (const n of [1, 2, 3])
      expect(await handTo(await ask(world.bob), `Task ${n}`, world.carol)).toBe('succeeded');
    expect(await handTo(await ask(world.bob), 'Task 4', world.carol)).toBe('payload_invalid');
    // One request hands out at most three.
    const many = await ask(world.alice);
    expect(await handTo(many, 'For Alice', world.alice)).toBe('succeeded');
    expect(await handTo(many, 'For Bob', world.bob)).toBe('succeeded');
    expect(await handTo(many, 'For Bob again', world.bob)).toBe('succeeded');
    expect(await handTo(many, 'For Alice again', world.alice)).toBe('payload_invalid');
    expect((await handoffsOf(world.carol)).filter((item) => item.room.id === roomId)).toHaveLength(
      3,
    );
  });

  test('room.post publishes the approved text as the person, and only while they are a member', async () => {
    const { broker, sql } = database();
    const roomId = await makeRoom('Posts');
    const work = await ownJob(world.bob, 'Post the summary to the Posts room');
    const claims = await claim(work.id);
    const rooms = await roomConnection(world.bob.space);
    const text = 'Summary: we ship on Thursday.';
    const asked = await broker.propose(claims, {
      connection_id: rooms,
      kind: 'room.post',
      payload: { room_id: roomId, text },
    });
    // The card names the room and the thread, and the exact text.
    expect(asked.requires_approval).toBe(true);
    expect(asked.canonical_payload).toMatchObject({
      room_id: roomId,
      room_name: 'Posts',
      thread_id: null,
      thread_title: null,
      text,
    });
    expect(
      (await sql`select count(*)::int as n from room_message where space_id = ${roomId}`)[0]?.n,
    ).toBe(0);
    await broker.decide(
      asked.action_id,
      { decision: 'approved', payload_hash: asked.payload_hash },
      undefined,
      world.bob.id,
    );
    await broker.admit(claims, asked.action_id, asked.payload_hash);
    expect((await broker.dispatch(asked.action_id)).status).toBe('succeeded');
    const [posted] = await sql`select * from room_message where space_id = ${roomId}`;
    expect({
      author: posted?.author_principal_id,
      via: posted?.via_agent,
      text: posted?.text,
      asks: posted?.request_state,
    }).toEqual({ author: world.bob.id, via: true, text, asks: 'none' });
    const view = await threadOf(world.carol, roomId, String(posted?.thread_id));
    expect(view.messages[0]).toMatchObject({
      author: { principal_id: world.bob.id, display_name: labelOf(world.bob, roomId) },
      via_agent: true,
      text,
    });

    // Approved, then Bob leaves before it is sent: nothing reaches the room.
    const reply = await broker.propose(claims, {
      connection_id: rooms,
      kind: 'room.post',
      payload: { room_id: roomId, thread_id: String(posted?.thread_id), text: 'One more thing.' },
    });
    expect(reply.canonical_payload).toMatchObject({
      thread_title: 'Summary: we ship on Thursday.',
    });
    await broker.decide(
      reply.action_id,
      { decision: 'approved', payload_hash: reply.payload_hash },
      undefined,
      world.bob.id,
    );
    await broker.admit(claims, reply.action_id, reply.payload_hash);
    await ok(send(world.bob.cookie, `/rooms/${roomId}/members/${world.bob.id}`, 'DELETE'));
    expect((await broker.dispatch(reply.action_id)).status).not.toBe('succeeded');
    expect(
      (await sql`select count(*)::int as n from room_message where space_id = ${roomId}`)[0]?.n,
    ).toBe(1);
    // And a new post to it is refused outright.
    const refused = await broker
      .propose(claims, {
        connection_id: rooms,
        kind: 'room.post',
        payload: { room_id: roomId, text: 'Still here?' },
      })
      .then(
        () => 'proposed',
        (error: { code?: string }) => error.code,
      );
    expect(refused).toBe('scope_denied');
  });

  test("room.add_file copies the checked file into the room's files", async () => {
    const { broker, sql } = database();
    const roomId = await makeRoom('Files');
    const work = await ownJob(world.carol, 'Add my notes to the Files room');
    const claims = await claim(work.id);
    const [files] = await sql`select id from connection
      where space_id = ${world.carol.space} and provider = 'files'`;
    const write = (content: string) =>
      broker.propose(claims, {
        connection_id: String(files?.id),
        kind: 'files.write',
        payload: { path: 'notes.md', content, expect: { kind: 'text', render: false } },
      });
    await write('# Notes\nShip on Thursday.\n');
    const rooms = await roomConnection(world.carol.space);
    const asked = await broker.propose(claims, {
      connection_id: rooms,
      kind: 'room.add_file',
      payload: { room_id: roomId, path: 'notes.md' },
    });
    expect(asked.requires_approval).toBe(true);
    expect(asked.canonical_payload).toMatchObject({
      room_id: roomId,
      room_name: 'Files',
      name: 'notes.md',
      content_hash: (
        await sql`select content_hash from artifact where job_id = ${work.id} and path = 'notes.md'
          order by created_at desc, id desc limit 1`
      )[0]?.content_hash,
    });
    await broker.decide(
      asked.action_id,
      { decision: 'approved', payload_hash: asked.payload_hash },
      undefined,
      world.carol.id,
    );
    await broker.admit(claims, asked.action_id, asked.payload_hash);
    expect((await broker.dispatch(asked.action_id)).status).toBe('succeeded');
    const copied = join(spacesRoot, roomId, 'artifacts', 'notes.md');
    const original = await readFile(join(workRoot, work.id, 'notes.md'), 'utf8');
    expect(original).toContain('Ship on Thursday.');
    expect(await readFile(copied, 'utf8')).toBe(original);

    // A different file by the same name never replaces the room's copy.
    await write('# Notes\nShip on Friday.\n');
    const again = await broker.propose(claims, {
      connection_id: rooms,
      kind: 'room.add_file',
      payload: { room_id: roomId, path: 'notes.md' },
    });
    await broker.decide(
      again.action_id,
      { decision: 'approved', payload_hash: again.payload_hash },
      undefined,
      world.carol.id,
    );
    await broker.admit(claims, again.action_id, again.payload_hash);
    expect((await broker.dispatch(again.action_id)).status).not.toBe('succeeded');
    expect(await readFile(copied, 'utf8')).toBe(original);
  });

  test('a personal job cannot read a room it is not a member of', async () => {
    const { broker } = database();
    const roomId = await makeRoom('Private plans');
    const work = await ownJob(world.erin, 'What rooms are there?');
    const claims = await claim(work.id);
    const rooms = await roomConnection(world.erin.space);
    const listed = await broker.propose(claims, {
      connection_id: rooms,
      kind: 'room.list',
      payload: {},
    });
    expect((await receiptOf(listed.action_id)).detail.rooms).toEqual([]);
    // Bob's list names only rooms he is in.
    const bobs = await claim((await ownJob(world.bob, 'My rooms')).id);
    const his = await broker.propose(bobs, {
      connection_id: await roomConnection(world.bob.space),
      kind: 'room.list',
      payload: {},
    });
    const named = (await receiptOf(his.action_id)).detail.rooms as { id: string; name: string }[];
    expect(named.map((room) => room.id)).toContain(roomId);
    const refusal = (kind: string, payload: Record<string, JsonValue>) =>
      broker.propose(claims, { connection_id: rooms, kind, payload }).then(
        () => 'proposed',
        (error: { code?: string }) => error.code,
      );
    // Posting, adding a file, or naming a thread in it: refused, and the
    // refusal says nothing of what is there.
    expect(await refusal('room.post', { room_id: roomId, text: 'Hello' })).toBe('scope_denied');
    expect(await refusal('room.add_file', { room_id: roomId, path: 'x.md' })).toBe('scope_denied');
    expect(
      await refusal('room.post', { room_id: 'sp_00000000000000000000000000', text: 'Hi' }),
    ).toBe('scope_denied');
    // A person's work holds no hand-off tool, and a room's request no post.
    expect(await refusal('room.handoff', { task: 'Read the room.' })).toBe('scope_denied');

    // Each later check holds on its own, should an earlier one ever let a post
    // through: admission refuses it, and so does the post itself.
    const connector = registry.get(rooms);
    if (!connector?.validateBinding) throw new Error('No room connector');
    const actionId = recordId('act');
    const post = {
      id: actionId,
      idempotency_key: actionId,
      job_id: work.id,
      connection_id: rooms,
      kind: 'room.post',
      canonical_payload: { room_id: roomId, thread_id: null, text: 'Let me in.' },
    } as unknown as Action;
    const ctx = {
      job_id: work.id,
      space_id: world.erin.space,
      idempotency_key: actionId,
      constraints: {},
    } as Parameters<NonNullable<typeof connector.prepare>>[1];
    const admitted = await connector.validateBinding(post, ctx, database().sql).then(
      () => 'admitted',
      (error: { code?: string }) => error.code,
    );
    expect(admitted).toBe('scope_denied');
    expect(await connector.execute(post, ctx)).toMatchObject({ outcome: 'failed' });
    expect(
      (
        await database().sql`select count(*)::int as n from room_message where space_id = ${roomId}`
      )[0]?.n,
    ).toBe(0);
  });

  test('a result the person forgot, or removed with their space, can no longer be shared and is held nowhere', async () => {
    const { runner, sql } = database();
    const roomId = await makeRoom('Forgetting');
    const finish = async (person: Person, task: string, answer: string) => {
      const handed = await handOff(roomId, task, person);
      const running = await accept(person, handed.handoffId, task);
      await runner.commitOutcome(await claim(String(running.job_id)), {
        kind: 'completed',
        summary: answer,
        evidence: [],
      });
      expect(await resultHeld(handed.handoffId)).toEqual({ text: answer, hash: sha(answer) });
      return handed;
    };

    // Bob forgets what he knows: the result waiting for him is cleared at once,
    // cannot be shared, and the room hears only that it is gone.
    const salary = 'Your salary at Acme is 91,000 dollars.';
    const forgotten = await finish(world.bob, 'Summarise my contract with Acme.', salary);
    const [store] = await sql`select id from owner limit 1`;
    await provisionMemorySpace(sql, String(store?.id), world.bob.space);
    await sql`update memory_spaces set restore_ready = true where space_id = ${world.bob.space}`;
    const records: RestrictionRecord[] = [];
    await forgetMemory(
      sql,
      {
        ownerId: String(store?.id),
        spaceId: world.bob.space,
        publisher: 'owner',
        audience: 'private',
        role: 'owner',
      },
      { all: true },
      {
        read: async () => records,
        append: async (record) => {
          records.push(record);
        },
      },
    );
    expect(await textAnywhere('91,000')).toEqual([]);
    expect(
      (
        await send(world.bob.cookie, `/handoffs/${forgotten.handoffId}/result`, 'POST', {
          decision: 'share',
          result_hash: sha(salary),
        })
      ).status,
    ).toBe(409);
    const [cleared] = (await handoffsOf(world.bob)).filter(
      (item) => item.id === forgotten.handoffId,
    );
    expect(cleared).toMatchObject({ state: 'expired', result: null, result_hash: null });
    expect(await heard(forgotten.requestId)).toEqual([
      { handoff_id: forgotten.handoffId, outcome: 'withdrawn', person: labelOf(world.bob, roomId) },
    ]);
    const words = await sql`select text from room_message where space_id = ${roomId}`;
    expect(words.some((row) => String(row.text).includes('91,000'))).toBe(false);

    // Carol removes her own space's work: what it produced for the room goes with it.
    const plans = 'Carol is moving to Lisbon in May.';
    const removed = await finish(world.carol, 'Tell the room my plans.', plans);
    const jobsOf = await sql`select id from job where space_id = ${world.carol.space}`;
    await sweepOperational(
      sql,
      world.carol.space,
      jobsOf.map((row) => String(row.id)),
    );
    expect(await textAnywhere('Lisbon')).toEqual([]);
    const [gone] = (await handoffsOf(world.carol)).filter((item) => item.id === removed.handoffId);
    expect(gone).toMatchObject({ state: 'expired', result: null });
    expect(await heard(removed.requestId)).toEqual([
      { handoff_id: removed.handoffId, outcome: 'withdrawn', person: labelOf(world.carol, roomId) },
    ]);

    // Left too long without an answer, a result is cleared as well.
    const lapsed = await finish(world.alice, 'Check my calendar.', 'Alice is free on Friday.');
    await sql`update room_handoff set expires_at = now() - interval '1 minute' where id = ${lapsed.handoffId}`;
    await handoffsOf(world.alice);
    expect(await resultHeld(lapsed.handoffId)).toEqual({ text: null, hash: null });
    expect(await heard(lapsed.requestId)).toEqual([
      { handoff_id: lapsed.handoffId, outcome: 'expired', person: labelOf(world.alice, roomId) },
    ]);
  });
});
