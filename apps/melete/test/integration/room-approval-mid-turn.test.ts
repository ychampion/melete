/**
 * A room's request asks a member before it adds to their calendar, and the
 * member may answer while the agent is still writing its reply. The answer
 * is never lost: the work picks it up once the turn ends, carries the add out
 * once, and the thread shows what happened. Stopping the request ends what it
 * waits on, answered or not, so nothing it asked for can still happen later.
 * The broker here leaves the park to the runner, as a deployment does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  type CapabilityClaims,
  type DispatchResult,
  roomDetail,
  roomMessageResponse,
  roomThreadView,
} from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { roomManifest } from '../../src/connectors/room.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { ApprovalService } from '../../src/jobs/approvals.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { ANSWER_CEILING_NOTE, JobService } from '../../src/jobs/service.ts';
import { resolveRoomCalendarShare } from '../../src/rooms/calendar-shares.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-room-mid-turn-'));
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'room-mid-turn-signing-key-32-bytes!',
      liveConnectionScopes: true,
    })
  : null;
const broker =
  handle && queue
    ? new BrokerService({
        sql: handle.sql,
        connectors: registry,
        boss: queue.boss,
        deferApprovalWaitToRunner: true,
      })
    : null;
// What the service wires beside its runner: an approval wait whose answers are all in goes on.
const approvals = jobs && runner ? new ApprovalService(jobs, runner) : undefined;
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
        approvals,
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
const submission = () => `s${randomBytes(8).toString('hex')}`;

type Person = { id: string; cookie: string };
let alice: Person;
let bob: Person;

/** Each add the member's calendar received, by action. */
const added: string[] = [];

/** A room Alice owns, with Bob in it, whose calendar the room may add to once he says so. */
async function calendarRoom(name: string) {
  const { sql } = database();
  const made = roomDetail.parse(await ok(send(alice.cookie, '/rooms', 'POST', { name }), 201));
  const roomId = made.room.id;
  await ok(send(alice.cookie, `/rooms/${roomId}/members`, 'POST', { principal_id: bob.id }), 201);
  const [personal] = await sql`select id from space where kind = 'personal'
    and owner_principal_id = ${bob.id}`;
  const calendar = recordId('conn');
  await sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
    values (${calendar}, ${String(personal?.id)}, ${calendarManifest.provider}, 'Calendar',
      ${JSON.stringify(calendarManifest.tools.map((tool) => tool.name))}::jsonb, 'owner')`;
  await ok(
    send(bob.cookie, `/rooms/${roomId}/calendar-shares`, 'PUT', {
      connection_id: calendar,
      mode: 'freebusy_add',
    }),
  );
  const connector: Connector = {
    manifest: roomManifest,
    async prepare(payload, ctx, tx) {
      const member = String(payload.member);
      const { share, connection } = await resolveRoomCalendarShare(tx, ctx.space_id, member, true);
      return {
        ...payload,
        calendar_connection_id: connection.id,
        share_created_at: share.createdAt.toISOString(),
        membership_generation: share.membershipGeneration,
      };
    },
    async execute(action: Action): Promise<DispatchResult> {
      added.push(action.id);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: `event:${action.id}`,
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
  const roomConnection = recordId('conn');
  await sql`insert into connection (id, space_id, provider, label, scopes, shared_use, configuration)
    values (${roomConnection}, ${roomId}, ${roomManifest.provider}, 'Room',
      ${JSON.stringify(roomManifest.tools.map((tool) => tool.name))}::jsonb, 'room',
      ${JSON.stringify({ builtin: 'test_room' })}::jsonb)`;
  registry.register(roomConnection, connector);
  return { roomId, roomConnection };
}

async function claim(jobId: string) {
  const { sql, runner } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  return runner.claim({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
}
async function claimed(jobId: string) {
  const attempt = await claim(jobId);
  if (!attempt) throw new Error(`Request ${jobId} could not be claimed`);
  return attempt;
}

/** Alice asks for the add; the running turn proposes it, and it waits for Bob. */
async function askForAdd(roomId: string, roomConnection: string) {
  const { broker } = database();
  const opened = roomMessageResponse.parse(
    await ok(
      send(alice.cookie, `/rooms/${roomId}/threads`, 'POST', {
        text: "@Melete put the planning session on Bob's calendar",
        submission_id: submission(),
      }),
      201,
    ),
  );
  const requestId = opened.request_job_id ?? '';
  const { claims } = await claimed(requestId);
  const asked = await broker.propose(claims as CapabilityClaims, {
    connection_id: roomConnection,
    kind: 'room.add_to_member_calendar',
    payload: {
      member: bob.id,
      event: {
        summary: 'Planning session',
        start: '2027-01-10T09:00:00Z',
        end: '2027-01-10T10:00:00Z',
      },
    },
  });
  expect(asked.status).toBe('needs_approval');
  // The broker leaves the job running until the runner records the turn's end.
  expect(await state(requestId)).toBe('running');
  return {
    requestId,
    threadId: opened.thread.id,
    claims: claims as CapabilityClaims,
    approvalId: asked.approval_id ?? '',
    actionId: asked.action_id,
    hash: asked.payload_hash,
  };
}
type Asked = Awaited<ReturnType<typeof askForAdd>>;

/** Bob allows the add from the card on the thread. */
const bobAllows = (roomId: string, asked: Asked) => bobAnswers(roomId, asked, 'allow_once');
/** Bob declines it from the same card. */
const bobDeclines = (roomId: string, asked: Asked) => bobAnswers(roomId, asked, 'deny');
async function bobAnswers(roomId: string, asked: Asked, option: 'allow_once' | 'deny') {
  const view = roomThreadView.parse(
    await ok(send(bob.cookie, `/rooms/${roomId}/threads/${asked.threadId}`)),
  );
  const card = view.requests
    .flatMap((request) => request.permissions ?? [])
    .find((entry) => entry.id === asked.approvalId);
  if (!card) throw new Error('The permission is not on the thread');
  await ok(
    send(bob.cookie, `/rooms/${roomId}/approvals/${asked.approvalId}`, 'POST', {
      option,
      version: card.version,
      payload_hash: asked.hash,
    }),
  );
}

/** The turn may run only once more: the attempt now running is its last. */
async function lastAttempt(jobId: string) {
  await database().sql`update job set budget = jsonb_set(budget, '{max_attempts}', '1')
    where id = ${jobId}`;
}
/** The next attempt is told Bob declined, and says so. */
async function sayDeclined(asked: Asked) {
  const { runner } = database();
  const next = await claimed(asked.requestId);
  expect(next.bundle.inputs.approval_results).toContainEqual(
    expect.objectContaining({ action_id: asked.actionId, decision: 'denied' }),
  );
  await runner.commitOutcome(next.claims, {
    kind: 'completed',
    summary: 'Bob declined, so the planning session is not on his calendar.',
    evidence: [],
  });
}

async function state(jobId: string) {
  const [row] = await database().sql`select state from job where id = ${jobId}`;
  return String(row?.state);
}
async function actionStatus(actionId: string) {
  const [row] = await database().sql`select status from action where id = ${actionId}`;
  return String(row?.status);
}
/** Wakes queued for the request that a claim can still take. */
async function liveWakes(jobId: string) {
  const { sql } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  const [count] = await sql`select count(*)::int as n from pgboss.job
    where data->>'job_id' = ${jobId} and state in ('created', 'retry')
      and (data->>'expected_epoch')::int = ${Number(row?.lease_epoch)}
      and (data->>'expected_version')::int = ${Number(row?.state_version)}`;
  return Number(count?.n);
}

/** The next attempt, told of the answer, carries the add out as the model would. */
async function carryOut(asked: Asked) {
  const { broker, runner } = database();
  const next = await claimed(asked.requestId);
  expect(next.bundle.inputs.approval_results).toContainEqual(
    expect.objectContaining({
      action_id: asked.actionId,
      decision: 'approved',
      status: 'approved',
    }),
  );
  const resumed = await broker.resume(next.claims as CapabilityClaims, asked.actionId);
  expect(resumed.status).toBe('succeeded');
  await runner.commitOutcome(next.claims, {
    kind: 'completed',
    summary: "I added the planning session to Bob's calendar.",
    evidence: [],
  });
}

withDb('a room approval given while the turn runs', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  beforeAll(async () => {
    const { app } = database();
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password }),
    });
    expect(setup.status).toBe(201);
    alice = {
      cookie: sessionCookie(setup),
      id: ((await setup.json()) as { owner: { id: string } }).owner.id,
    };
    const made = await ok<{ principal: { id: string } }>(
      send(alice.cookie, '/principals', 'POST', { email: 'bob@example.test', password }),
      201,
    );
    const login = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.test', password }),
    });
    bob = { id: made.principal.id, cookie: sessionCookie(login) };
  }, 60_000);

  test('an approval given before the turn ends is carried out once, and the thread shows it', async () => {
    const { runner } = database();
    const { roomId, roomConnection } = await calendarRoom('Mid-turn approval');
    const asked = await askForAdd(roomId, roomConnection);
    // Bob allows it while the agent is still writing its reply.
    await bobAllows(roomId, asked);
    expect(await actionStatus(asked.actionId)).toBe('approved');
    expect(await state(asked.requestId)).toBe('running');
    // The runtime looked for waiting actions after the answer, found none, and
    // reported a tidy end with the reply it had written.
    await runner.commitOutcome(asked.claims, {
      kind: 'completed',
      summary: 'I asked Bob to allow the planning session on his calendar.',
      evidence: [],
    });
    // The answer was not lost: the work goes on by itself, once.
    expect(await state(asked.requestId)).toBe('queued');
    expect(await liveWakes(asked.requestId)).toBe(1);
    expect(added).not.toContain(asked.actionId);
    await carryOut(asked);
    expect(added.filter((id) => id === asked.actionId)).toHaveLength(1);
    expect(await actionStatus(asked.actionId)).toBe('succeeded');
    // That attempt saw the answer, so its tidy end does not wake the work again.
    expect(await state(asked.requestId)).toBe('waiting_for_input');
    expect(await liveWakes(asked.requestId)).toBe(0);
    expect(await claim(asked.requestId)).toBeNull();
    const view = roomThreadView.parse(
      await ok(send(alice.cookie, `/rooms/${roomId}/threads/${asked.threadId}`)),
    );
    expect(JSON.stringify(view)).toContain("I added the planning session to Bob's calendar.");
    const request = view.requests.find((entry) => entry.job_id === asked.requestId);
    expect(request?.status).toBe('done');
    expect(request?.receipts.length).toBeGreaterThan(0);
  }, 60_000);

  test('the answer wakes the work once: an attempt that was told and did nothing is not woken again', async () => {
    const { runner } = database();
    const { roomId, roomConnection } = await calendarRoom('Told once');
    const asked = await askForAdd(roomId, roomConnection);
    await bobAllows(roomId, asked);
    await runner.commitOutcome(asked.claims, {
      kind: 'waiting_for_input',
      question: 'Anything else for the planning session?',
    });
    expect(await state(asked.requestId)).toBe('queued');
    const next = await claimed(asked.requestId);
    expect(next.bundle.inputs.approval_results.map((entry) => entry.action_id)).toEqual([
      asked.actionId,
    ]);
    await runner.commitOutcome(next.claims, {
      kind: 'waiting_for_input',
      question: 'Anything else for the planning session?',
    });
    expect(await state(asked.requestId)).toBe('waiting_for_input');
    expect(await liveWakes(asked.requestId)).toBe(0);
    expect(added).not.toContain(asked.actionId);
  }, 60_000);

  test('a decline given before the turn ends wakes the work once, and its next attempt says so', async () => {
    const { runner } = database();
    const { roomId, roomConnection } = await calendarRoom('Mid-turn decline');
    const asked = await askForAdd(roomId, roomConnection);
    await bobDeclines(roomId, asked);
    expect(await actionStatus(asked.actionId)).toBe('denied');
    await runner.commitOutcome(asked.claims, {
      kind: 'completed',
      summary: 'I asked Bob to allow the planning session on his calendar.',
      evidence: [],
    });
    expect(await state(asked.requestId)).toBe('queued');
    expect(await liveWakes(asked.requestId)).toBe(1);
    await sayDeclined(asked);
    expect(await state(asked.requestId)).toBe('waiting_for_input');
    expect(await liveWakes(asked.requestId)).toBe(0);
    expect(await claim(asked.requestId)).toBeNull();
    expect(added).not.toContain(asked.actionId);
    const view = roomThreadView.parse(
      await ok(send(alice.cookie, `/rooms/${roomId}/threads/${asked.threadId}`)),
    );
    expect(JSON.stringify(view)).toContain('Bob declined, so the planning session');
  }, 60_000);

  test('a decline after the turn parked wakes the work once, and its next attempt says so', async () => {
    const { runner } = database();
    const { roomId, roomConnection } = await calendarRoom('Declined after the park');
    const asked = await askForAdd(roomId, roomConnection);
    await runner.commitOutcome(asked.claims, {
      kind: 'waiting_for_approval',
      action_ids: [asked.actionId],
    });
    await bobDeclines(roomId, asked);
    expect(await state(asked.requestId)).toBe('queued');
    expect(await liveWakes(asked.requestId)).toBe(1);
    await sayDeclined(asked);
    expect(await liveWakes(asked.requestId)).toBe(0);
    expect(await claim(asked.requestId)).toBeNull();
  }, 60_000);

  test('a permission Stop withdraws wakes nothing, mid-turn or parked', async () => {
    const { runner } = database();
    const { roomId, roomConnection } = await calendarRoom('Stop wakes nothing');
    const running = await askForAdd(roomId, roomConnection);
    await ok(send(alice.cookie, `/rooms/${roomId}/requests/${running.requestId}/stop`, 'POST'));
    expect(await actionStatus(running.actionId)).toBe('denied');
    // The stopped attempt's end comes too late to park on the withdrawal.
    await runner
      .commitOutcome(running.claims, {
        kind: 'completed',
        summary: 'I asked Bob to allow the planning session on his calendar.',
        evidence: [],
      })
      .catch(() => null);
    expect(await state(running.requestId)).toBe('waiting_for_input');
    expect(await liveWakes(running.requestId)).toBe(0);
    expect(await claim(running.requestId)).toBeNull();
    const parked = await askForAdd(roomId, roomConnection);
    await runner.commitOutcome(parked.claims, {
      kind: 'waiting_for_approval',
      action_ids: [parked.actionId],
    });
    await ok(send(alice.cookie, `/rooms/${roomId}/requests/${parked.requestId}/stop`, 'POST'));
    expect(await state(parked.requestId)).toBe('waiting_for_input');
    expect(await liveWakes(parked.requestId)).toBe(0);
    expect(await claim(parked.requestId)).toBeNull();
  }, 60_000);

  test("a permission answered on the turn's last attempt still gets the attempt that acts on it", async () => {
    const { runner } = database();
    const { roomId, roomConnection } = await calendarRoom('Last attempt');
    // Allowed while the last attempt runs: carried out once all the same.
    const allowed = await askForAdd(roomId, roomConnection);
    await lastAttempt(allowed.requestId);
    await bobAllows(roomId, allowed);
    await runner.commitOutcome(allowed.claims, {
      kind: 'completed',
      summary: 'I asked Bob to allow the planning session on his calendar.',
      evidence: [],
    });
    expect(await state(allowed.requestId)).toBe('queued');
    expect(await liveWakes(allowed.requestId)).toBe(1);
    await carryOut(allowed);
    expect(added.filter((id) => id === allowed.actionId)).toHaveLength(1);
    expect(await state(allowed.requestId)).toBe('waiting_for_input');
    expect(await claim(allowed.requestId)).toBeNull();
    // Parked on the last attempt and declined later: told, once.
    const declined = await askForAdd(roomId, roomConnection);
    await lastAttempt(declined.requestId);
    await runner.commitOutcome(declined.claims, {
      kind: 'waiting_for_approval',
      action_ids: [declined.actionId],
    });
    expect(await state(declined.requestId)).toBe('waiting_for_approval');
    await bobDeclines(roomId, declined);
    expect(await state(declined.requestId)).toBe('queued');
    expect(await liveWakes(declined.requestId)).toBe(1);
    await sayDeclined(declined);
    expect(await state(declined.requestId)).toBe('waiting_for_input');
    expect(await claim(declined.requestId)).toBeNull();
  }, 60_000);

  test('answers wake a request past its budget three times at most, then it ends instead of waiting', async () => {
    const { broker, runner, sql } = database();
    const { roomId, roomConnection } = await calendarRoom('Answer ceiling');
    let asked = await askForAdd(roomId, roomConnection);
    await lastAttempt(asked.requestId);
    // Each woken attempt asks Bob for one more add, and he declines each.
    for (let attempt = 1; ; attempt++) {
      await runner.commitOutcome(asked.claims, {
        kind: 'waiting_for_approval',
        action_ids: [asked.actionId],
      });
      if (attempt > 3) break;
      expect(await state(asked.requestId)).toBe('waiting_for_approval');
      await bobDeclines(roomId, asked);
      expect(await state(asked.requestId)).toBe('queued');
      expect(await liveWakes(asked.requestId)).toBe(1);
      const next = await claimed(asked.requestId);
      const proposed = await broker.propose(next.claims as CapabilityClaims, {
        connection_id: roomConnection,
        kind: 'room.add_to_member_calendar',
        payload: {
          member: bob.id,
          event: {
            summary: `Planning session ${attempt + 1}`,
            start: '2027-01-10T09:00:00Z',
            end: '2027-01-10T10:00:00Z',
          },
        },
      });
      expect(proposed.status).toBe('needs_approval');
      asked = {
        ...asked,
        claims: next.claims as CapabilityClaims,
        approvalId: proposed.approval_id ?? '',
        actionId: proposed.action_id,
        hash: proposed.payload_hash,
      };
    }
    // The budget's one attempt and three answers' worth, then an end, not a park.
    const [made] =
      await sql`select count(*)::int as n from attempt where job_id = ${asked.requestId}`;
    expect(Number(made?.n)).toBe(4);
    expect(await state(asked.requestId)).toBe('failed');
    expect(await liveWakes(asked.requestId)).toBe(0);
    expect(await claim(asked.requestId)).toBeNull();
    const [open] = await sql`select count(*)::int as n from approval p
      join action a on a.id = p.action_id
      where a.job_id = ${asked.requestId} and p.decision is null`;
    expect(Number(open?.n)).toBe(0);
    expect(await actionStatus(asked.actionId)).not.toBe('pending_approval');
    const [ended] = await sql`select payload from event where job_id = ${asked.requestId}
      and type = 'attempt_ended' order by seq desc limit 1`;
    expect(ended?.payload.outcome).toEqual({
      kind: 'budget_exhausted',
      summary: ANSWER_CEILING_NOTE,
    });
    const [turn] = await sql`select t.answer from experience_turn t
      join job j on j.current_turn_id = t.id where j.id = ${asked.requestId}`;
    expect(String(turn?.answer)).toContain(ANSWER_CEILING_NOTE);
  }, 60_000);

  test('the next attempt is told who answered and what the step was', async () => {
    const { broker, runner, sql } = database();
    await sql`update principal set display_name = 'Bob' where id = ${bob.id}`;
    const { roomId, roomConnection } = await calendarRoom('Who answered');
    const step = 'add "Planning session" to Bob <';
    // Declined while the turn ran.
    const declined = await askForAdd(roomId, roomConnection);
    await bobDeclines(roomId, declined);
    await runner.commitOutcome(declined.claims, {
      kind: 'completed',
      summary: 'I asked Bob to allow the planning session on his calendar.',
      evidence: [],
    });
    const told = await claimed(declined.requestId);
    const [no] = told.bundle.inputs.approval_results;
    expect(no).toMatchObject({ action_id: declined.actionId, decision: 'denied' });
    expect(no?.decided_by_name).toStartWith('Bob <');
    expect(no?.summary).toStartWith(step);
    expect(no?.summary).toEndWith(">'s calendar at 2027-01-10T09:00:00Z");
    await runner.commitOutcome(told.claims, {
      kind: 'completed',
      summary: 'Bob declined, so the planning session is not on his calendar.',
      evidence: [],
    });
    // Allowed after the turn parked.
    const allowed = await askForAdd(roomId, roomConnection);
    await runner.commitOutcome(allowed.claims, {
      kind: 'waiting_for_approval',
      action_ids: [allowed.actionId],
    });
    await bobAllows(roomId, allowed);
    const next = await claimed(allowed.requestId);
    const [yes] = next.bundle.inputs.approval_results;
    expect(yes).toMatchObject({ action_id: allowed.actionId, decision: 'approved' });
    expect(yes?.decided_by_name).toBe(no?.decided_by_name);
    expect(yes?.summary).toBe(no?.summary);
    // Nothing the attempt does not already read: no address, no other ids.
    expect(JSON.stringify([no, yes])).not.toContain('@example.test');
    expect((await broker.resume(next.claims as CapabilityClaims, allowed.actionId)).status).toBe(
      'succeeded',
    );
    await runner.commitOutcome(next.claims, {
      kind: 'completed',
      summary: "I added the planning session to Bob's calendar.",
      evidence: [],
    });
  }, 60_000);

  // The runtime reads the waiting actions just before the turn ends. Bob's
  // answer can land before that read, between it and the end being recorded,
  // or after: each way the add is carried out once, by one woken attempt.
  for (const when of ['before the end is recorded', 'after the end is recorded', 'at once'])
    test(`an approval that lands as the turn ends wakes the work once (${when})`, async () => {
      const { runner } = database();
      const { roomId, roomConnection } = await calendarRoom(`As it ends ${when}`);
      const asked = await askForAdd(roomId, roomConnection);
      const end = () =>
        runner.commitOutcome(asked.claims, {
          kind: 'waiting_for_approval',
          action_ids: [asked.actionId],
        });
      if (when === 'before the end is recorded') {
        await bobAllows(roomId, asked);
        await end();
      } else if (when === 'after the end is recorded') {
        await end();
        expect(await state(asked.requestId)).toBe('waiting_for_approval');
        await bobAllows(roomId, asked);
      } else await Promise.all([bobAllows(roomId, asked), end()]);
      expect(await state(asked.requestId)).toBe('queued');
      expect(await liveWakes(asked.requestId)).toBe(1);
      await carryOut(asked);
      expect(added.filter((id) => id === asked.actionId)).toHaveLength(1);
      expect(await state(asked.requestId)).toBe('waiting_for_input');
      expect(await claim(asked.requestId)).toBeNull();
    }, 60_000);

  test('stopping a request ends what it waits on, answered or not, and nothing of it runs later', async () => {
    const { runner, broker } = database();
    const { roomId, roomConnection } = await calendarRoom('Stopped after the answer');
    const asked = await askForAdd(roomId, roomConnection);
    await bobAllows(roomId, asked);
    await runner.commitOutcome(asked.claims, {
      kind: 'completed',
      summary: 'I asked Bob to allow the planning session on his calendar.',
      evidence: [],
    });
    expect(await state(asked.requestId)).toBe('queued');
    // Alice stops the request before the work picks the answer up.
    await ok(send(alice.cookie, `/rooms/${roomId}/requests/${asked.requestId}/stop`, 'POST'));
    expect(await state(asked.requestId)).toBe('waiting_for_input');
    expect(await actionStatus(asked.actionId)).toBe('failed');
    expect(await liveWakes(asked.requestId)).toBe(0);
    expect(await claim(asked.requestId)).toBeNull();
    // A later reply in the thread starts a turn that cannot carry the add out.
    await ok(
      send(alice.cookie, `/rooms/${roomId}/threads/${asked.threadId}/messages`, 'POST', {
        text: '@Melete thanks',
        submission_id: submission(),
      }),
    );
    const next = await claimed(asked.requestId);
    await broker.resume(next.claims as CapabilityClaims, asked.actionId).catch(() => null);
    expect(added).not.toContain(asked.actionId);
    expect(await actionStatus(asked.actionId)).toBe('failed');

    // Stopped while the permission still waits: it is withdrawn, never left to answer.
    const waiting = await calendarRoom('Stopped while waiting');
    const pending = await askForAdd(waiting.roomId, waiting.roomConnection);
    await runner.commitOutcome(pending.claims, {
      kind: 'waiting_for_approval',
      action_ids: [pending.actionId],
    });
    expect(await state(pending.requestId)).toBe('waiting_for_approval');
    await ok(
      send(alice.cookie, `/rooms/${waiting.roomId}/requests/${pending.requestId}/stop`, 'POST'),
    );
    expect(await state(pending.requestId)).toBe('waiting_for_input');
    expect(await actionStatus(pending.actionId)).toBe('denied');
    expect(await liveWakes(pending.requestId)).toBe(0);
  }, 90_000);

  test('stopping a request whose turn already ended still ends an add it was allowed', async () => {
    const { runner, sql } = database();
    const { roomId, roomConnection } = await calendarRoom('Stopped after it ended');
    const asked = await askForAdd(roomId, roomConnection);
    // The state a lost answer left behind: the turn over, the request resting,
    // and the add allowed but never carried out.
    await sql`update approval set decision = 'approved', decided_at = now(), decided_by = ${bob.id}
      where id = ${asked.approvalId}`;
    await sql`update action set status = 'approved' where id = ${asked.actionId}`;
    await runner.commitOutcome(asked.claims, {
      kind: 'waiting_for_input',
      question: 'The planning session is still being added. What should happen next?',
    });
    expect(await state(asked.requestId)).toBe('waiting_for_input');
    const [turn] = await sql`select t.status from experience_turn t
      join job j on j.current_turn_id = t.id where j.id = ${asked.requestId}`;
    expect(turn?.status).toBe('done');
    await ok(send(alice.cookie, `/rooms/${roomId}/requests/${asked.requestId}/stop`, 'POST'));
    expect(await actionStatus(asked.actionId)).toBe('failed');
    expect(await state(asked.requestId)).toBe('waiting_for_input');
    expect(added).not.toContain(asked.actionId);
  }, 60_000);
});
