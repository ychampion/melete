/** Exercise the real worker's pickup and the consent/write/read-back sequence without inference. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  type AttemptOutcome,
  boardAnswerResponse,
  boardList,
  type JsonObject,
  type RuntimeAdapter,
  roomDetail,
  roomMessageResponse,
  roomThreadView,
} from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { CalendarConnector, calendarManifest } from '../../src/connectors/calendar.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createRoomConnector, roomManifest } from '../../src/connectors/room.ts';
import type { ConnectorContext } from '../../src/connectors/types.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { ApprovalService } from '../../src/jobs/approvals.ts';
import { verifyCapability } from '../../src/jobs/capability.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-router-'));
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const key = 'router-worker-fixture-signing-key-32-bytes';
const event = {
  summary: 'Practice pickup',
  start: '2026-11-02T16:00:00-08:00',
  end: '2026-11-02T17:00:00-08:00',
};
const completed = (summary: string): AttemptOutcome => ({
  kind: 'completed',
  summary,
  evidence: [],
});
const cases = new Map<string, Case>();
const errors: unknown[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
let alice: { id: string; cookie: string };
let bob: { id: string; cookie: string };

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Case = {
  roomId: string;
  roomConnection: string;
  boardConnection: string;
  mode: 'parked' | 'finishing' | 'declined';
  itemId?: string;
  actionId?: string;
  approvalId?: string;
  consentJob?: string;
  resumedAt?: number;
  finishing: ReturnType<typeof gate>;
  reads: Map<string, number>;
  writes: Action[];
  verified: string[];
  dav: ReturnType<typeof caldav>;
  stages: string[];
};

/** This fixture checks every acknowledged write through the real provider verifier before returning it. */
class CountingCalendar extends CalendarConnector {
  constructor(...args: ConstructorParameters<typeof CalendarConnector>) {
    super(...args);
  }
  onRead = () => {};
  onWrite = (_action: Action) => {};
  onVerified = (_action: Action) => {};
  override async execute(action: Action, ctx: ConnectorContext) {
    if (action.kind === 'calendar.freebusy') this.onRead();
    if (action.kind === 'calendar.create') this.onWrite(action);
    const result = await super.execute(action, ctx);
    if (action.kind !== 'calendar.create' || result.outcome !== 'succeeded') return result;
    const checked = await super.verify(action, ctx);
    expect(checked.decision).toBe('succeeded');
    if (checked.decision !== 'succeeded' || !checked.receipt)
      throw new Error('Provider read-back failed');
    this.onVerified(action);
    return { outcome: 'succeeded' as const, receipt: checked.receipt };
  }
}

const runtime: RuntimeAdapter = {
  async capabilities() {
    return {
      streaming: true,
      tools: true,
      interrupt: true,
      version: 'router-script/1',
      workspace: 'job',
    };
  },
  async start(bundle, _sink, signal) {
    try {
      const claims = verifyCapability(bundle.attempt.token, key);
      const current = cases.get(claims.space_id);
      if (!current || !broker || !handle) throw new Error('Missing scripted case');
      const call = async (kind: string, payload: JsonObject) => {
        const result = await broker.propose(claims, {
          kind,
          payload,
          connection_id: kind.startsWith('board.')
            ? current.boardConnection
            : current.roomConnection,
        });
        const [row] = await handle.sql`select receipt from action where id = ${result.action_id}`;
        return { result, detail: row?.receipt?.detail as JsonObject | undefined };
      };
      if (!current.itemId) {
        expect(bundle.local_now?.time_zone).toBe('America/Los_Angeles');
        for (const person of [alice, bob]) {
          const { detail } = await call('room.member_freebusy', {
            member: person.id,
            start: '2026-11-02',
            end: '2026-11-02',
          });
          expect(detail?.complete).toBe(true);
          expect(((detail?.busy ?? []) as unknown[]).length).toBe(person.id === alice.id ? 1 : 0);
        }
        current.stages.push('freebusy');
        const added = await call('board.add', {
          kind: 'event',
          title: event.summary,
          starts_at: '2026-11-02T16:00',
          ends_at: '2026-11-02T17:00',
          assignee: bob.id,
          visibility: 'everyone',
        });
        current.itemId = String(added.detail?.item_id);
        await call('board.ask', {
          assignee: bob.id,
          title: 'Can you take the practice pickup?',
          choices: ['Yes', 'No'],
        });
        current.stages.push('question');
        return completed('I asked the available helper about the pickup.');
      }
      if (!current.actionId) {
        const message = bundle.inputs.new_user_messages.map((m) => m.content).join('\n');
        expect(message).toContain(current.mode === 'declined' ? 'No' : 'Yes');
        const [owner] =
          await handle.sql`select requested_by_principal_id from job where id = ${claims.job_id}`;
        expect(owner?.requested_by_principal_id).toBe(bob.id);
        current.consentJob = claims.job_id;
        current.stages.push('answer');
        if (current.mode === 'declined') return completed('The pickup remains unresolved.');
        const { result } = await call('room.add_to_member_calendar', { member: bob.id, event });
        expect(result.status).toBe('needs_approval');
        current.actionId = result.action_id;
        current.approvalId = result.approval_id ?? undefined;
        current.stages.push('approval');
        if (current.mode === 'finishing') {
          await Promise.race([
            current.finishing.promise,
            new Promise<never>((_, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            ),
          ]);
          return completed('The exact event is awaiting its calendar decision.');
        }
        return { kind: 'waiting_for_approval', action_ids: [result.action_id] };
      }
      current.resumedAt = Date.now();
      expect(bundle.inputs.approval_results).toContainEqual(
        expect.objectContaining({ action_id: current.actionId, decision: 'approved' }),
      );
      const resumed = await broker.resume(claims, current.actionId);
      expect(resumed.status).toBe('succeeded');
      expect(current.verified).toEqual([current.actionId ?? 'missing']);
      current.stages.push('verified');
      await call('board.update', {
        item_id: current.itemId,
        state: 'done',
        assignee: bob.id,
        detail: 'Pickup confirmed on the helper calendar.',
      });
      current.stages.push('board');
      return completed('The pickup is confirmed on the calendar and board.');
    } catch (error) {
      errors.push(error);
      throw error;
    }
  },
};
const runner = jobs
  ? new AttemptRunner(jobs, runtime, { key, liveConnectionScopes: true, concurrency: 2 })
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
const approvals = jobs && runner ? new ApprovalService(jobs, runner) : undefined;
const app =
  handle && jobs && runner && broker
    ? createApp({
        env: loadEnv({
          NODE_ENV: 'test',
          MELETE_PREVIEW_MULTIPLAYER: 'true',
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
function database() {
  if (!handle || !queue || !app || !jobs || !runner) throw new Error('Postgres unavailable');
  return { ...handle, queue, app, jobs, runner };
}
async function send(cookie: string, path: string, method = 'GET', body?: unknown) {
  return database().app.request(path, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Promise<Response> | Response, status = 200) {
  const result = await response;
  const body = await result.text();
  expect([result.status, body.slice(0, 300)]).toEqual([status, body.slice(0, 300)]);
  return JSON.parse(body);
}
function cookie(response: Response) {
  const value = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .find((c) => c?.startsWith('melete_session='));
  if (!value) throw new Error('Missing session cookie');
  return value;
}
async function until<T>(read: () => Promise<T | undefined>, within = 5000): Promise<T> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (errors.length) throw errors[0];
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(10);
  }
  throw new Error('Scripted workflow did not reach its next stage');
}
function caldav() {
  const records = new Map<string, string>();
  const reads: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'PUT') {
        expect(request.headers.get('if-none-match')).toBe('*');
        if (records.has(path)) return new Response(null, { status: 412 });
        records.set(path, await request.text());
        return new Response(null, { status: 201, headers: { etag: '"new"' } });
      }
      if (request.method === 'GET') {
        reads.push(path);
        return records.has(path)
          ? new Response(records.get(path), { headers: { etag: '"new"' } })
          : new Response(null, { status: 404 });
      }
      if (request.method === 'REPORT')
        return new Response(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${[...records]
            .filter(([p]) => p.startsWith(path))
            .map(
              ([href, body]) =>
                `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>"new"</d:getetag><c:calendar-data><![CDATA[${body}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            )
            .join('')}</d:multistatus>`,
          { status: 207 },
        );
      return new Response(null, { status: 405 });
    },
  });
  servers.push(server);
  return { url: server.url, records, reads };
}
async function setup(mode: Case['mode']) {
  const { sql } = database();
  const made = roomDetail.parse(
    await json(send(alice.cookie, '/rooms', 'POST', { name: 'Practice logistics' }), 201),
  );
  const roomId = made.room.id;
  await json(send(alice.cookie, `/rooms/${roomId}/members`, 'POST', { principal_id: bob.id }), 201);
  await sql`insert into experience_profile (space_id, time_zone, time_zone_confirmed_at)
    values (${roomId}, 'America/Los_Angeles', now())`;
  const [board] =
    await sql`select id from connection where space_id = ${roomId} and provider = 'board'`;
  const current: Case = {
    roomId,
    boardConnection: String(board?.id),
    roomConnection: recordId('conn'),
    mode,
    finishing: gate(),
    reads: new Map(),
    writes: [],
    verified: [],
    dav: caldav(),
    stages: [],
  };
  const calendars = new Map<string, CalendarConnector>();
  for (const person of [alice, bob]) {
    const [space] =
      await sql`select id from space where kind = 'personal' and owner_principal_id = ${person.id}`;
    const id = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes, shared_use, configuration)
      values (${id}, ${String(space?.id)}, 'caldav', 'Calendar', ${JSON.stringify(calendarManifest.tools.map((t) => t.name))}::jsonb, 'owner', '{"kind":"caldav"}'::jsonb)`;
    const calendar = new CountingCalendar(
      {
        id,
        spaceId: String(space?.id),
        mode: 'caldav',
        calendarUrl: `${current.dav.url}${id}/`,
        username: 'member@example.test',
        secretRef: 'sec_fixture',
        allowInsecureLocalForTests: true,
      },
      { withSecret: async (_id, _space, use) => use('fixture') },
    );
    if (calendar.signals.stream !== 'calendar') throw new Error('Calendar source missing');
    const occurrences = calendar.signals.occurrences;
    calendar.signals.occurrences = async (...args) => {
      calendar.onRead();
      return occurrences(...args);
    };
    calendar.onRead = () => current.reads.set(person.id, (current.reads.get(person.id) ?? 0) + 1);
    calendar.onWrite = (action) => current.writes.push(action);
    calendar.onVerified = (action) => current.verified.push(action.id);
    calendars.set(id, calendar);
    if (person.id === alice.id)
      current.dav.records.set(
        `/${id}/busy.ics`,
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:private-busy',
          'DTSTART:20261103T000000Z',
          'DTEND:20261103T010000Z',
          'SUMMARY:Private busy title',
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      );
    await json(
      send(person.cookie, `/rooms/${roomId}/calendar-shares`, 'PUT', {
        connection_id: id,
        mode: 'freebusy_add',
      }),
    );
  }
  await sql`insert into connection (id, space_id, provider, label, scopes, shared_use, configuration)
    values (${current.roomConnection}, ${roomId}, 'room', 'Member calendars',
    ${JSON.stringify(roomManifest.tools.map((t) => t.name))}::jsonb, 'room', '{"builtin":"fixture_room"}'::jsonb)`;
  registry.register(
    current.roomConnection,
    createRoomConnector({
      sql,
      workRoot: directory,
      spacesRoot: directory,
      openCalendar: async (row) => {
        const calendar = calendars.get(row.id);
        if (!calendar) throw new Error('Unshared calendar');
        return calendar;
      },
    }),
  );
  cases.set(roomId, current);
  return current;
}

withDb('router consent and worker latency', () => {
  beforeAll(async () => {
    const { app, runner } = database();
    const password = 'router-fixture-long-password';
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password }),
    });
    alice = { cookie: cookie(setup), id: (await json(setup, 201)).owner.id };
    const made = await json(
      send(alice.cookie, '/principals', 'POST', { email: 'bob@example.test', password }),
      201,
    );
    const login = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.test', password }),
    });
    bob = { id: made.principal.id, cookie: cookie(login) };
    await runner.start();
  });

  test.each(['parked', 'finishing', 'declined'] as const)(
    '%s consent preserves the calendar boundary',
    async (mode) => {
      const current = await setup(mode);
      try {
        const opened = roomMessageResponse.parse(
          await json(
            send(alice.cookie, `/rooms/${current.roomId}/threads`, 'POST', {
              text: '@Melete arrange the practice pickup on November 2 at 4 PM.',
              ask_agent: true,
              submission_id: randomUUID(),
            }),
            201,
          ),
        );
        const question = await until(async () => {
          const board = boardList.parse(
            await json(send(bob.cookie, `/rooms/${current.roomId}/board`)),
          );
          return board.items.find((item) => item.kind === 'question' && item.state === 'open');
        });
        expect(question.assignee?.principal_id).toBe(bob.id);
        expect(question.visibility).toBe('assignee');
        expect(JSON.stringify(question)).not.toContain('Private busy title');
        expect(
          (
            await send(
              alice.cookie,
              `/rooms/${current.roomId}/board/${question.id}/answer`,
              'POST',
              { answer: 'Yes' },
            )
          ).status,
        ).toBe(403);
        // Let the first turn settle; the answer then enters through the actual member route.
        await until(async () =>
          (await database().jobs.get(opened.request_job_id ?? '')).state === 'waiting_for_input'
            ? true
            : undefined,
        );
        const answered = boardAnswerResponse.parse(
          await json(
            send(bob.cookie, `/rooms/${current.roomId}/board/${question.id}/answer`, 'POST', {
              answer: mode === 'declined' ? 'No' : 'Yes',
            }),
          ),
        );
        expect(answered.request_job_id).toBeTruthy();
        if (mode === 'declined') {
          await until(async () =>
            current.consentJob &&
            (await database().jobs.get(current.consentJob)).state === 'waiting_for_input'
              ? true
              : undefined,
          );
          expect(current.actionId).toBeUndefined();
          expect(current.writes).toEqual([]);
          const board = boardList.parse(
            await json(send(alice.cookie, `/rooms/${current.roomId}/board`)),
          );
          expect(board.items.find((item) => item.id === current.itemId)?.state).toBe('open');
          return;
        }
        const card = await until(async () => {
          const view = roomThreadView.parse(
            await json(send(bob.cookie, `/rooms/${current.roomId}/threads/${opened.thread.id}`)),
          );
          return view.requests
            .flatMap((r) => r.permissions ?? [])
            .find((p) => p.id === current.approvalId);
        });
        if (mode === 'parked')
          await until(async () =>
            current.consentJob &&
            (await database().jobs.get(current.consentJob)).state === 'waiting_for_approval'
              ? true
              : undefined,
          );
        else expect((await database().jobs.get(current.consentJob ?? '')).state).toBe('running');
        const body = {
          option: 'allow_once',
          version: card.version,
          payload_hash: card.payload_hash,
        };
        expect(
          (await send(alice.cookie, `/rooms/${current.roomId}/approvals/${card.id}`, 'POST', body))
            .status,
        ).toBe(403);
        expect(current.writes).toEqual([]);
        const decisionStarted = Date.now();
        await json(send(bob.cookie, `/rooms/${current.roomId}/approvals/${card.id}`, 'POST', body));
        // Commit lies between request start and response. This brackets commit-to-pickup without inventing a commit timestamp.
        const committed = Date.now();
        current.finishing.release();
        const resumed = await until(async () => current.resumedAt);
        expect(resumed - decisionStarted).toBeLessThan(1000);
        console.info(
          `${mode} approval commit to resumed runtime: ${Math.max(0, resumed - committed)}..${resumed - decisionStarted} ms`,
        );
        await until(async () => (current.stages.includes('board') ? true : undefined));
        expect(current.writes).toHaveLength(1);
        expect(current.writes[0]?.canonical_payload).toMatchObject(event);
        expect(current.verified).toEqual([current.actionId ?? 'missing']);
        expect(
          current.dav.reads.filter((p) => p.endsWith(`/${current.actionId}.ics`)),
        ).toHaveLength(1);
        const stored = [...current.dav.records.values()].find((ics) =>
          ics.includes(`UID:${current.actionId}`),
        );
        expect(stored).toContain('DTSTART:20261103T000000Z');
        expect(current.stages).toEqual([
          'freebusy',
          'question',
          'answer',
          'approval',
          'verified',
          'board',
        ]);
        expect(current.reads.get(alice.id)).toBe(1);
        // The chosen calendar is read again for freshness at proposal/dispatch.
        expect(current.reads.get(bob.id)).toBeGreaterThan(1);
        const board = boardList.parse(
          await json(send(alice.cookie, `/rooms/${current.roomId}/board`)),
        );
        const item = board.items.find((item) => item.id === current.itemId);
        expect(item?.state).toBe('done');
        expect(item?.visibility).toBe('assignee');
        expect(item?.starts_at).toBe('2026-11-03T00:00:00.000Z');
      } finally {
        current.finishing.release();
      }
    },
    30_000,
  );
});

afterAll(async () => {
  for (const current of cases.values()) current.finishing.release();
  await runner?.stop();
  await registry.close();
  for (const server of servers) server.stop(true);
  await queue?.stop();
  await handle?.close();
  await rm(directory, { recursive: true, force: true });
});
