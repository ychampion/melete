/**
 * A space's activity log. Its owners (and the person who set the installation
 * up) read every effect the space's work proposed, with the member who asked
 * for a room request and the person who approved it; a member reads none of
 * it; and what an effect said never leaves the service, in the log or in its
 * CSV export.
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
  spaceAuditResponse,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { job } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService, jobView } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-space-audit-'));
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'space-audit-signing-key-32-bytes!!!',
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
          MELETE_SETUP_OPEN: 'true',
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
/** What the effects say. It must never come back from the log. */
const MARKER = 'PAYLOAD-BODY-NEVER-LEAVES-48213';

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

type Person = { id: string; cookie: string };
let alice: Person;
let bob: Person;
let carol: Person;

withDb('a space’s activity log', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  // Alice set the installation up. Bob owns the room; Carol is a member of it.
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
      [bob, 'Bob'],
      [carol, 'Carol'],
    ] as const)
      await ok(send(person.cookie, '/me', 'PATCH', { display_name: name }));
  }, 60_000);

  test('owners read who asked and who approved; members read nothing; bodies never leave', async () => {
    const { sql, runner, broker, db } = database();
    const made = roomDetail.parse(
      await ok(send(bob.cookie, '/rooms', 'POST', { name: 'Launch' }), 201),
    );
    const roomId = made.room.id;
    await ok(send(bob.cookie, `/rooms/${roomId}/members`, 'POST', { principal_id: carol.id }), 201);
    const connectionId = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
      values (${connectionId}, ${roomId}, ${notesManifest.provider}, 'Team notes',
        ${JSON.stringify(['notes.post'])}::jsonb, 'room')`;
    registry.register(connectionId, notesConnector());

    // Carol asks the room's agent. The request is the room's work, asked by Carol.
    const opened = roomMessageResponse.parse(
      await ok(
        send(carol.cookie, `/rooms/${roomId}/threads`, 'POST', {
          text: 'The notes from today are ready.',
          submission_id: submission(),
        }),
        201,
      ),
    );
    const asked = roomMessageResponse.parse(
      await ok(
        send(carol.cookie, `/rooms/${roomId}/threads/${opened.thread.id}/messages`, 'POST', {
          text: '@Melete post the notes to the team',
          submission_id: submission(),
        }),
      ),
    );
    const requestId = asked.request_job_id ?? '';
    expect(requestId).not.toBe('');
    const [requestRow] = await db.select().from(job).where(eq(job.id, requestId));
    if (!requestRow) throw new Error('The request job is missing');
    expect(jobView(requestRow).requested_by).toBe(carol.id);
    expect(jobView(requestRow).principal_id).not.toBe(carol.id);

    const [epoch] = await sql`select lease_epoch, state_version from job where id = ${requestId}`;
    const claimed = await runner.claim({
      job_id: requestId,
      expected_epoch: Number(epoch?.lease_epoch),
      expected_version: Number(epoch?.state_version),
      reason: 'input',
    });
    if (!claimed) throw new Error('The request could not be claimed');
    // The attempt runs as the room, and keeps who asked.
    const [attemptRow] = await sql`select principal_id, requested_by_principal_id from attempt
      where id = ${claimed.claims.attempt_id}`;
    expect(attemptRow?.principal_id).toBe(requestRow.principalId);
    expect(attemptRow?.requested_by_principal_id).toBe(carol.id);

    const claims = claimed.claims as CapabilityClaims;
    const first = await broker.propose(claims, {
      connection_id: connectionId,
      kind: 'notes.post',
      payload: { to: ['team'], body: `${MARKER} first` },
    });
    const second = await broker.propose(claims, {
      connection_id: connectionId,
      kind: 'notes.post',
      payload: { to: ['team'], body: `${MARKER} second` },
    });
    await runner.commitOutcome(claims, {
      kind: 'waiting_for_approval',
      action_ids: [first.action_id, second.action_id],
    });
    const approvalId = first.approval_id ?? '';
    const card = roomThreadView
      .parse(await ok(send(bob.cookie, `/rooms/${roomId}/threads/${opened.thread.id}`)))
      .requests.flatMap((entry) => entry.permissions ?? [])
      .find((entry) => entry.id === approvalId);
    if (!card) throw new Error('The permission is not on the thread');
    await ok(
      send(bob.cookie, `/rooms/${roomId}/approvals/${approvalId}`, 'POST', {
        option: 'allow_once',
        version: card.version,
        payload_hash: first.payload_hash,
      }),
    );

    // A member reads none of it, in either form.
    for (const path of [`/spaces/${roomId}/audit`, `/spaces/${roomId}/audit/export`]) {
      const refused = await send(carol.cookie, path);
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain(MARKER);
    }

    // The owner reads both effects, newest first.
    const response = await send(bob.cookie, `/spaces/${roomId}/audit`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(MARKER);
    const log = spaceAuditResponse.parse(JSON.parse(text));
    expect(log.next_cursor).toBeNull();
    expect(log.entries.map((entry) => entry.action_id)).toEqual([
      second.action_id,
      first.action_id,
    ]);
    const approved = log.entries[1];
    expect(approved?.payload_hash).toBe(first.payload_hash);
    expect(approved?.audience).toBe('room');
    expect(approved?.connection).toEqual({
      id: connectionId,
      label: 'Team notes',
      provider: 'test',
    });
    expect(approved?.requested_by).toEqual({ id: carol.id, name: 'Carol' });
    expect(approved?.principal?.id).toBe(requestRow.principalId ?? undefined);
    expect(approved?.approval?.decided_by).toBe(bob.id);
    expect(approved?.approval?.decided_by_name).toBe('Bob');
    expect(approved?.approval?.decision).toBe('approved');
    expect(log.entries[0]?.approval?.decided_by).toBeNull();
    // Nobody is named by their email.
    expect(text).not.toContain('example.test');

    // The owner, in the room, reads what was asked: the room's own words.
    expect(approved?.job_title).toBe('@Melete post the notes to the team');

    // The person who set the installation up reads any room, one they are not
    // in included, but not what was said in it: a request's title is the first
    // line of a member's message there.
    const setupText = await (await send(alice.cookie, `/spaces/${roomId}/audit`)).text();
    const setupRead = spaceAuditResponse.parse(JSON.parse(setupText));
    expect(setupRead.entries).toHaveLength(2);
    expect(setupRead.entries.map((entry) => entry.job_title)).toEqual([null, null]);
    expect(setupText).not.toContain('post the notes');
    const setupCsv = await (await send(alice.cookie, `/spaces/${roomId}/audit/export`)).text();
    expect(setupCsv).not.toContain('post the notes');

    // Pages follow on from each other without repeating an entry.
    const firstPage = spaceAuditResponse.parse(
      await ok(send(bob.cookie, `/spaces/${roomId}/audit?limit=1`)),
    );
    expect(firstPage.entries.map((entry) => entry.action_id)).toEqual([second.action_id]);
    expect(firstPage.next_cursor).not.toBeNull();
    const secondPage = spaceAuditResponse.parse(
      await ok(
        send(
          bob.cookie,
          `/spaces/${roomId}/audit?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor ?? '')}`,
        ),
      ),
    );
    expect(secondPage.entries.map((entry) => entry.action_id)).toEqual([first.action_id]);
    expect(secondPage.next_cursor).toBeNull();
    expect((await send(bob.cookie, `/spaces/${roomId}/audit?cursor=nonsense`)).status).toBe(400);

    // Filters: by the person who asked, by kind of effect, by time.
    const byCarol = spaceAuditResponse.parse(
      await ok(send(bob.cookie, `/spaces/${roomId}/audit?principal_id=${carol.id}`)),
    );
    expect(byCarol.entries).toHaveLength(2);
    const byBob = spaceAuditResponse.parse(
      await ok(send(bob.cookie, `/spaces/${roomId}/audit?principal_id=${bob.id}`)),
    );
    expect(byBob.entries).toHaveLength(0);
    const reads = spaceAuditResponse.parse(
      await ok(send(bob.cookie, `/spaces/${roomId}/audit?effect_class=read`)),
    );
    expect(reads.entries).toHaveLength(0);
    const later = spaceAuditResponse.parse(
      await ok(
        send(
          bob.cookie,
          `/spaces/${roomId}/audit?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
        ),
      ),
    );
    expect(later.entries).toHaveLength(0);
    expect((await send(bob.cookie, `/spaces/${roomId}/audit?since=yesterday`)).status).toBe(400);

    // The export carries the same entries, and still no bodies.
    const exported = await send(bob.cookie, `/spaces/${roomId}/audit/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('text/csv');
    expect(exported.headers.get('content-disposition')).toContain('attachment');
    const csv = await exported.text();
    expect(csv).not.toContain(MARKER);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith('created_at,action_id,job_id')).toBe(true);
    expect(lines[1]).toContain(second.action_id);
    expect(lines[2]).toContain(first.payload_hash);
    expect(lines[2]).toContain('Carol');
    // Everything fit, so the file does not say it was cut short.
    expect(exported.headers.get('x-melete-export-truncated')).toBeNull();

    // Two effects proposed in the same microsecond still page apart: the id
    // breaks the tie, and each is shown exactly once.
    await sql`update action set created_at = '2026-10-15T09:00:00.123456Z'
      where id in (${first.action_id}, ${second.action_id})`;
    const tiedFirst = spaceAuditResponse.parse(
      await ok(send(bob.cookie, `/spaces/${roomId}/audit?limit=1`)),
    );
    expect(tiedFirst.entries).toHaveLength(1);
    expect(tiedFirst.next_cursor).not.toBeNull();
    const tiedSecond = spaceAuditResponse.parse(
      await ok(
        send(
          bob.cookie,
          `/spaces/${roomId}/audit?limit=1&cursor=${encodeURIComponent(tiedFirst.next_cursor ?? '')}`,
        ),
      ),
    );
    expect(tiedSecond.next_cursor).toBeNull();
    expect(
      [...tiedFirst.entries, ...tiedSecond.entries].map((entry) => entry.action_id).sort(),
    ).toEqual([first.action_id, second.action_id].sort());
  }, 120_000);

  // The log's routes skip the membership check every other space route gets,
  // so the setup owner can read rooms they are not in. These are the readers
  // that leaves to the routes themselves to turn away.
  test('nobody else reads it: not someone outside the room, not in another person’s own space', async () => {
    const made = roomDetail.parse(
      await ok(send(bob.cookie, '/rooms', 'POST', { name: 'Private plans' }), 201),
    );
    const roomId = made.room.id;
    const dan = await ok<{ principal: { id: string } }>(
      send(alice.cookie, '/principals', 'POST', { email: 'dan@example.test', password }),
      201,
    );
    const danCookie = await login('dan@example.test');
    expect(dan.principal.id).not.toBe(bob.id);
    for (const path of [`/spaces/${roomId}/audit`, `/spaces/${roomId}/audit/export`])
      expect((await send(danCookie, path)).status).toBe(403);

    await ok(send(bob.cookie, '/spaces'));
    const [personal] = await database()
      .sql`select id from space where owner_principal_id = ${bob.id} and kind = 'personal'`;
    if (!personal) throw new Error('Bob has no space of his own');
    for (const path of [`/spaces/${personal.id}/audit`, `/spaces/${personal.id}/audit/export`]) {
      expect((await send(carol.cookie, path)).status).toBe(403);
      expect((await send(danCookie, path)).status).toBe(403);
    }
    await ok(send(bob.cookie, `/spaces/${personal.id}/audit`));
    // A person's own space is theirs alone, the setup owner's reach included.
    for (const path of [`/spaces/${personal.id}/audit`, `/spaces/${personal.id}/audit/export`])
      expect((await send(alice.cookie, path)).status).toBe(403);

    // A page marker made up by hand is a bad request, even one whose time
    // JavaScript would read, and never a failed query.
    const forged = Buffer.from('["1","act_1"]').toString('base64url');
    expect((await send(bob.cookie, `/spaces/${roomId}/audit?cursor=${forged}`)).status).toBe(400);

    // A space that does not exist is refused like one that is not yours.
    expect((await send(bob.cookie, '/spaces/spc_missing/audit')).status).toBe(403);
  }, 60_000);

  // A person's own work in a room is private to them: nobody else can open
  // the chat it came from. Another owner of the room, and the setup owner,
  // still see the effect it made through the room's account, but not what
  // the chat was called.
  test('another owner sees the effect of the owner’s own work, not its title', async () => {
    const { sql, runner, broker } = database();
    const made = roomDetail.parse(
      await ok(send(bob.cookie, '/rooms', 'POST', { name: 'Board' }), 201),
    );
    const roomId = made.room.id;
    await ok(send(bob.cookie, `/rooms/${roomId}/members`, 'POST', { principal_id: carol.id }), 201);
    await sql`update space_membership set role = 'owner'
      where space_id = ${roomId} and principal_id = ${carol.id}`;
    const connectionId = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes, shared_use)
      values (${connectionId}, ${roomId}, ${notesManifest.provider}, 'Bob notes',
        ${JSON.stringify(['notes.post'])}::jsonb, 'owner')`;
    registry.register(connectionId, notesConnector());

    const secretTitle = 'Talk to a lawyer about the divorce 5521';
    const created = await ok<{ job: { id: string } }>(
      send(bob.cookie, '/jobs', 'POST', {
        space_id: roomId,
        title: secretTitle,
        objective: secretTitle,
      }),
      201,
    );
    const [epoch] =
      await sql`select lease_epoch, state_version from job where id = ${created.job.id}`;
    const claimed = await runner.claim({
      job_id: created.job.id,
      expected_epoch: Number(epoch?.lease_epoch),
      expected_version: Number(epoch?.state_version),
      reason: 'created',
    });
    if (!claimed) throw new Error('The owner’s job could not be claimed');
    const proposed = await broker.propose(claimed.claims as CapabilityClaims, {
      connection_id: connectionId,
      kind: 'notes.post',
      payload: { to: ['me'], body: `${MARKER} own` },
    });

    // Bob reads his own work's title.
    const own = spaceAuditResponse.parse(await ok(send(bob.cookie, `/spaces/${roomId}/audit`)));
    expect(own.entries.map((entry) => [entry.action_id, entry.job_title])).toEqual([
      [proposed.action_id, secretTitle],
    ]);

    // Carol, an owner too, and Alice, who set the installation up, see the
    // effect and whose work it was, never what the chat was about.
    for (const reader of [carol, alice]) {
      const text = await (await send(reader.cookie, `/spaces/${roomId}/audit`)).text();
      const log = spaceAuditResponse.parse(JSON.parse(text));
      expect(log.entries.map((entry) => entry.action_id)).toEqual([proposed.action_id]);
      expect(log.entries[0]?.principal?.id).toBe(bob.id);
      expect(log.entries[0]?.job_title).toBeNull();
      expect(text).not.toContain('lawyer');
      const csv = await (await send(reader.cookie, `/spaces/${roomId}/audit/export`)).text();
      expect(csv).toContain(proposed.action_id);
      expect(csv).not.toContain('lawyer');
    }
  }, 60_000);
});
