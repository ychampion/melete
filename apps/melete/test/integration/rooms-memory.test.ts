/**
 * A room's memory. What anyone in a room says there becomes the room's memory
 * under their name; the room's requests recall it, and the details people
 * shared into the room from their own memory, and nothing else of anyone's
 * memory. Forgetting holds in the room and across a restore from an older
 * backup: a detail forgotten at its source, a message its author deleted, a
 * detail forgotten from the room.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AttemptBundle,
  type ExtractionProposal,
  type RoomMemoryItem,
  roomDetail,
  roomMemoryView,
  roomMessageResponse,
  roomShareResponse,
  roomThreadView,
} from '@melete/contracts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { buildBundle } from '../../src/jobs/bundle.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { captureRoom } from '../../src/memory/capture.ts';
import { recordAttemptContext } from '../../src/memory/context.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import type { ExtractionGateway } from '../../src/memory/extract.ts';
import { forgetMemory } from '../../src/memory/forget.ts';
import { recall } from '../../src/memory/recall.ts';
import { restoreMemory } from '../../src/memory/restore.ts';
import { runExtractionWork } from '../../src/memory/service.ts';
import { startServiceMemory } from '../../src/memory/start.ts';
import { roomHandle } from '../../src/rooms/transcript.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

/** What the scripted extractor reads out of a message: a key and the exact words of its value. */
const READS: { match: RegExp; key: string; kind: string }[] = [
  { match: /\+351 9\d\d \d{3} \d{3}/, key: 'contact.maya.phone', kind: 'user_statement' },
  { match: /\b\w+@[\w.]+\.example\b/, key: 'contact.ana.email', kind: 'user_statement' },
  { match: /(?:aisle|window) seat/, key: 'pref.travel.seat', kind: 'preference' },
  { match: /\b\d+ euros\b/, key: 'pref.venue.deposit', kind: 'user_statement' },
];
function scriptedGateway(): ExtractionGateway {
  return {
    async chat(body: { messages: { role: string; content: string }[] }) {
      const input = JSON.parse(body.messages.at(-1)?.content ?? '{}') as {
        evidence: {
          source: { source_id: string; source_version: string };
          start: number;
          text: string;
        };
        claims: { id: string; key: string | null; head_revision: number }[];
      };
      const proposals: ExtractionProposal[] = [];
      for (const read of READS) {
        const found = read.match.exec(input.evidence.text);
        if (!found) continue;
        const start = input.evidence.start + found.index;
        const current = input.claims.find((claim) => claim.key === read.key);
        proposals.push({
          ...(current
            ? { op: 'supersede', claim_id: current.id, expected_revision: current.head_revision }
            : { op: 'add', expected_revision: null }),
          domain_key: read.key,
          key: read.key,
          content: found[0],
          kind: read.kind,
          factual_status: 'attributed',
          valid_from: new Date(Date.now() - 60_000).toISOString(),
          valid_until: null,
          sources: [
            {
              source_id: input.evidence.source.source_id,
              source_version: input.evidence.source.source_version,
              start,
              end: start + found[0].length,
              quote: found[0],
            },
          ],
        } as ExtractionProposal);
      }
      return JSON.stringify({ proposals });
    },
  } as ExtractionGateway;
}

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-room-memory-'));
const gateway = scriptedGateway();
const memory =
  handle && queue
    ? await startServiceMemory(handle.sql, queue.boss, join(directory, 'spaces'), undefined, {
        gateway,
      })
    : null;
const registry = new ConnectorRegistry();
const signingKey = 'room-memory-signing-key-32-bytes!!';
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: signingKey }) : null;
const app =
  handle && jobs && runner && memory
    ? createApp({
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: join(directory, 'spaces') }),
        db: handle.db,
        sql: handle.sql,
        jobs,
        runner,
        registry,
        memory,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';

function database() {
  if (!handle || !queue || !app || !jobs || !runner || !memory)
    throw new Error('Postgres unavailable');
  return { ...handle, app, jobs, runner, memory, boss: queue.boss };
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

type Person = { id: string; cookie: string; name: string };
/** How a room labels a person: their name, then the handle that room gives them. */
const labelOf = (person: Person, roomId: string) =>
  `${person.name} <${roomHandle(roomId, person.id)}>`;
let alice: Person;
let bob: Person;
let carol: Person;

async function makeRoom(name: string, members: Person[]) {
  const made = roomDetail.parse(await ok(send(alice.cookie, '/rooms', 'POST', { name }), 201));
  for (const member of members)
    await ok(
      send(alice.cookie, `/rooms/${made.room.id}/members`, 'POST', { principal_id: member.id }),
      201,
    );
  return made.room.id;
}
async function startThread(person: Person, roomId: string, text: string) {
  return roomMessageResponse.parse(
    await ok(
      send(person.cookie, `/rooms/${roomId}/threads`, 'POST', {
        text,
        submission_id: submission(),
      }),
      201,
    ),
  );
}
async function post(person: Person, roomId: string, threadId: string, text: string) {
  return roomMessageResponse.parse(
    await ok(
      send(person.cookie, `/rooms/${roomId}/threads/${threadId}/messages`, 'POST', {
        text,
        submission_id: submission(),
      }),
    ),
  );
}

/** One pass of what the service's loops do for a space: capture what was said, then extract. */
async function settle(spaceId: string) {
  const { sql, memory: started, boss } = database();
  await captureRoom({
    sql,
    journal: started.journal,
    scopeForJob: started.scopeForJob,
    privacyOrigin: async () => null,
    roomScope: started.storageScope,
    roomPrivacyOrigin: async () => null,
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const work = await sql`select id, status from memory_work
      where space_id = ${spaceId} and status in ('pending', 'leased') order by id`;
    if (!work.length) return;
    for (const row of work)
      if (row.status === 'pending')
        await runExtractionWork({ sql, boss, journal: started.journal, gateway }, row.id as string);
    if (Date.now() > deadline) throw new Error('Extraction did not settle');
    await Bun.sleep(50);
  }
}
/** A person's own memory: a detail they said in their own space, kept there at owner trust. */
async function remember(person: Person, text: string, privately = false) {
  const { sql, memory: started } = database();
  const [own] = await sql`select id from space
    where kind = 'personal' and owner_principal_id = ${person.id}`;
  const scope: MemoryScope = await started.storageScope(own?.id as string);
  const saved = await ingest(sql, scope, {
    stream: 'chat',
    source_identity: `said:${submission()}`,
    source_version: '1',
    source_type: 'message',
    author: 'owner',
    event_at: new Date(Date.now() - 120_000).toISOString(),
    text,
  });
  // Said in a conversation that was private, as the privacy router marks it.
  if (privately)
    await sql`update memory_sources set private_origin = 'space' where id = ${saved.source.source_id}`;
  await settle(scope.spaceId);
  return scope;
}
async function claimOf(scope: MemoryScope, key: string) {
  const [row] = await database().sql`select id from memory_claims
    where space_id = ${scope.spaceId} and key = ${key} and not hidden`;
  if (!row) throw new Error(`No ${key} in ${scope.spaceId}`);
  return row.id as string;
}
/**
 * Claim a request's attempt as the runner does and assemble it as the memory
 * runtime does, recording what it was handed; then finish the attempt.
 */
async function attemptOf(jobId: string, privateOrigin = false) {
  const { sql, runner, memory: started } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  const claimed = await runner.claim({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
  if (!claimed) throw new Error(`Request ${jobId} could not be claimed`);
  const scope = await started.scopeForJob(jobId);
  const built = await buildBundle(claimed.bundle, {
    sql,
    scope,
    catalog: async () => [],
    privateOrigin,
  });
  const context = await recordAttemptContext(
    sql,
    scope,
    claimed.bundle.attempt.id,
    jobId,
    built.recall,
  );
  return {
    bundle: built.bundle,
    context,
    finish: () =>
      runner.commitOutcome(claimed.claims, { kind: 'completed', summary: 'Done.', evidence: [] }),
  };
}
const handed = (bundle: AttemptBundle) => bundle.knowledge.map((item) => item.excerpt).join('\n');
async function ask(person: Person, roomId: string, text: string) {
  const opened = await startThread(person, roomId, `@Melete ${text}`);
  const jobId = opened.request_job_id;
  if (!jobId) throw new Error('The ask did not start a request');
  return { jobId, threadId: opened.thread.id };
}
async function roomMemory(person: Person, roomId: string) {
  return roomMemoryView.parse(await ok(send(person.cookie, `/rooms/${roomId}/memory`)));
}
/**
 * An older backup of what the room keeps: the memory tables as they are now,
 * and the room's own rows a deletion would scrub. Calling the result puts them
 * back, as restoring that backup would, and leaves memory waiting for replay.
 */
async function backup(roomId: string) {
  const { sql } = database();
  const schema = `backup_${randomBytes(6).toString('hex')}`;
  const tables = (
    await sql`select tablename from pg_tables where schemaname = 'public' and tablename like 'memory_%'`
  ).map((row) => row.tablename as string);
  await sql.unsafe(`create schema "${schema}"`);
  for (const table of tables)
    await sql.unsafe(`create table "${schema}"."${table}" as table "public"."${table}"`);
  const messages = await sql`select id, text, mentions, redacted_at, request_state
    from room_message where space_id = ${roomId}`;
  const threads = await sql`select id, title from room_thread where space_id = ${roomId}`;
  const turns = await sql`select t.id, t.text from experience_turn t
    join job j on j.id = t.job_id where j.space_id = ${roomId}`;
  const requests = await sql`select id, title, objective from job where space_id = ${roomId}`;
  const events = await sql`select e.seq, e.payload from event e
    join job j on j.id = e.job_id where j.space_id = ${roomId}`;
  const first = ['memory_spaces', 'memory_streams', 'memory_sources', 'memory_claims'];
  const order = [...first, ...tables.filter((table) => !first.includes(table))];
  return async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe(`truncate ${tables.map((table) => `"public"."${table}"`).join(',')}`);
      for (const table of order)
        await tx.unsafe(`insert into "public"."${table}" select * from "${schema}"."${table}"`);
      await tx`update memory_spaces set restore_ready = false`;
      await tx.unsafe(`drop schema "${schema}" cascade`);
      for (const row of messages)
        await tx`update room_message set text = ${row.text}, mentions = ${JSON.stringify(row.mentions)}::text::jsonb,
          redacted_at = ${row.redacted_at}, request_state = ${row.request_state} where id = ${row.id}`;
      for (const row of threads)
        await tx`update room_thread set title = ${row.title} where id = ${row.id}`;
      for (const row of turns)
        await tx`update experience_turn set text = ${row.text} where id = ${row.id}`;
      for (const row of requests)
        await tx`update job set title = ${row.title}, objective = ${row.objective} where id = ${row.id}`;
      for (const row of events)
        await tx`update event set payload = ${JSON.stringify(row.payload)}::text::jsonb where seq = ${row.seq}`;
    });
  };
}

withDb('room memory', () => {
  afterAll(async () => {
    await memory?.stop();
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
    alice = { id: aliceId, cookie: aliceCookie, name: 'Alice' };
    const made: Person[] = [];
    for (const name of ['bob', 'carol']) {
      const created = await ok<{ principal: { id: string } }>(
        send(aliceCookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      );
      made.push({
        id: created.principal.id,
        cookie: await login(`${name}@example.test`),
        name: `${name[0]?.toUpperCase()}${name.slice(1)}`,
      });
    }
    [bob, carol] = made as [Person, Person];
    for (const [person, name] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
      [carol, 'Carol'],
    ] as const)
      await ok(send(person.cookie, '/me', 'PATCH', { display_name: name }));
  }, 60_000);

  test("every member's words in a room become room memory with their author", async () => {
    const { sql } = database();
    const roomId = await makeRoom('Offsite', [bob]);
    const opened = await startThread(bob, roomId, "Maya's number is +351 912 345 678.");
    await post(alice, roomId, opened.thread.id, 'I would like an aisle seat on the way there.');
    await post(bob, roomId, opened.thread.id, "Don't remember this: the deposit is 300 euros.");
    await settle(roomId);
    const sources = await sql`select s.author, s.author_principal_id, s.origin_trust, s.audience,
        s.publisher, b.content
      from memory_sources s join memory_source_content b on b.source_id = s.id
      where s.space_id = ${roomId} order by s.stream_sequence`;
    expect(
      sources.map((row) => [
        row.author,
        row.author_principal_id,
        row.origin_trust,
        row.audience,
        row.publisher,
      ]),
    ).toEqual([
      ['member', bob.id, 'external_content', 'space', 'room'],
      ['member', alice.id, 'external_content', 'space', 'room'],
    ]);
    // "Don't remember this" keeps that one message out of the room's memory.
    expect(sources.map((row) => row.content).join()).not.toContain('300 euros');
    const outcomes = await sql`select c.outcome from memory_room_capture c
      join room_message m on m.id = c.message_id where m.space_id = ${roomId}
      order by m.created_at, m.id`;
    expect(outcomes.map((row) => row.outcome)).toEqual([
      'remembered',
      'remembered',
      'skipped:asked',
    ]);
    // Each detail carries whose words it came from; nothing is kept in anyone's own memory.
    const view = await roomMemory(bob, roomId);
    expect(
      view.items
        .map((item) => [item.key, item.content, item.said_by.map((who) => who.display_name)])
        .sort(),
    ).toEqual([
      ['contact.maya.phone', '+351 912 345 678', [labelOf(bob, roomId)]],
      ['pref.travel.seat', 'aisle seat', [labelOf(alice, roomId)]],
    ]);
    const [elsewhere] = await sql`select count(*)::int as n from memory_source_content b
      join memory_sources s on s.id = b.source_id
      where s.space_id <> ${roomId} and b.content like '%912 345 678%'`;
    expect(elsewhere?.n).toBe(0);
    // Somebody outside the room reads none of it.
    expect((await send(carol.cookie, `/rooms/${roomId}/memory`)).status).toBe(404);
  }, 60_000);

  test("a room request recalls room memory and shared items, and never a member's or the owner's private memory", async () => {
    const { sql, memory: started } = database();
    const roomId = await makeRoom('Travel', [bob]);
    const opened = await startThread(bob, roomId, 'We booked a window seat for everyone.');
    await settle(roomId);
    // The room owner's private detail in the room's own space, and in her own space.
    const roomStore = await started.storageScope(roomId);
    await ingest(
      sql,
      { ...roomStore, audience: 'private' },
      {
        stream: 'chat',
        source_identity: `owner:${submission()}`,
        source_version: '1',
        source_type: 'message',
        author: 'owner',
        event_at: new Date(Date.now() - 120_000).toISOString(),
        text: 'Our private deposit is 900 euros.',
      },
    );
    await settle(roomId);
    await remember(alice, "Maya's number is +351 933 333 333.");
    // Bob's own details: one he shares into the room, one he keeps.
    const bobs = await remember(bob, 'Ana writes from ana@home.example and I like an aisle seat.');
    const shared = roomShareResponse.parse(
      await ok(
        send(bob.cookie, `/rooms/${roomId}/shares`, 'POST', {
          claim_id: await claimOf(bobs, 'contact.ana.email'),
        }),
        201,
      ),
    );
    expect([shared.share.shared_by.display_name, shared.share.content]).toEqual([
      labelOf(bob, roomId),
      'ana@home.example',
    ]);
    // Sharing the same detail again answers with the share already there.
    await ok(
      send(bob.cookie, `/rooms/${roomId}/shares`, 'POST', {
        claim_id: await claimOf(bobs, 'contact.ana.email'),
      }),
    );
    // A detail is shared only from one's own memory: not someone else's, nor a room's.
    expect(
      (
        await send(alice.cookie, `/rooms/${roomId}/shares`, 'POST', {
          claim_id: await claimOf(bobs, 'pref.travel.seat'),
        })
      ).status,
    ).toBe(404);

    const { jobId } = await ask(
      alice,
      roomId,
      'Book the train for the team, email Ana and call Maya.',
    );
    const attempt = await attemptOf(jobId);
    const knowledge = handed(attempt.bundle);
    expect(knowledge).toContain('window seat');
    expect(knowledge).toContain('ana@home.example');
    expect(knowledge).toContain(`Shared into this room by ${JSON.stringify(labelOf(bob, roomId))}`);
    for (const secret of ['aisle seat', '933 333 333', '900 euros'])
      expect([secret, knowledge.includes(secret)]).toEqual([secret, false]);
    // The shared detail is someone else's word to the room, never the requester's own.
    const sharedItem = attempt.bundle.knowledge.find((item) =>
      item.excerpt.includes('ana@home.example'),
    );
    expect(sharedItem?.origin_trust).toBe('external_content');
    // What the attempt holds is on its context record, shared detail included.
    expect(attempt.context.items.map((item) => item.key).sort()).toEqual([
      'contact.ana.email',
      'pref.travel.seat',
    ]);
    await attempt.finish();
    void opened;
  }, 90_000);

  test('forgetting a shared personal claim removes it from the room, and a restored old database keeps it out', async () => {
    const { sql, memory: started } = database();
    const roomId = await makeRoom('Contacts', [bob]);
    const bobs = await remember(bob, 'Ana moved; she is ana@new.example now.');
    const claimId = await claimOf(bobs, 'contact.ana.email');
    await ok(send(bob.cookie, `/rooms/${roomId}/shares`, 'POST', { claim_id: claimId }), 201);
    const { jobId } = await ask(alice, roomId, 'Write to Ana about the offsite.');
    const holding = await attemptOf(jobId);
    expect(handed(holding.bundle)).toContain('ana@new.example');
    const restoreBackup = await backup(roomId);

    // Bob forgets the detail in his own memory: the room loses it at once,
    // and the attempt that was handed it is invalidated.
    await forgetMemory(sql, bobs, { claim_id: claimId }, started.journal);
    const [context] = await sql`select invalidated_at from memory_contexts
      where attempt_id = ${holding.bundle.attempt.id}`;
    expect(context?.invalidated_at).not.toBeNull();
    const after = await roomMemory(alice, roomId);
    expect(after.shares.map((share) => share.content)).toEqual([null]);
    const next = await ask(alice, roomId, 'Write to Ana about the offsite, again.');
    const fresh = await attemptOf(next.jobId);
    expect(handed(fresh.bundle)).not.toContain('ana@new.example');
    await fresh.finish();

    // An older backup comes back, share and detail and all. The journal,
    // kept apart from the database, puts the forgetting back.
    await restoreBackup();
    await restoreMemory(sql, started.journal);
    expect((await roomMemory(alice, roomId)).shares.map((share) => share.content)).toEqual([null]);
    const third = await ask(alice, roomId, 'One more note to Ana.');
    const restored = await attemptOf(third.jobId);
    expect(handed(restored.bundle)).not.toContain('ana@new.example');
    await restored.finish();
  }, 120_000);

  test('an author deletes their message and nothing of it is recalled, replayed or shown', async () => {
    const { sql, memory: started } = database();
    const roomId = await makeRoom('Calls', [bob, carol]);
    const opened = await startThread(carol, roomId, 'Planning the calls for Friday.');
    const aside = await post(
      carol,
      roomId,
      opened.thread.id,
      'Ring her office line in Porto first.',
    );
    const asked = await post(
      bob,
      roomId,
      opened.thread.id,
      '@Melete call Maya, her number is +351 914 141 414.',
    );
    const jobId = asked.request_job_id;
    if (!jobId) throw new Error('The ask did not start a request');
    // A thread Bob starts with the same number names the thread after it.
    const own = await startThread(bob, roomId, 'Text Maya tonight on +351 914 141 414.');
    expect(own.thread.title).toContain('914 141 414');
    await settle(roomId);
    expect((await roomMemory(bob, roomId)).items.map((item) => item.content)).toContain(
      '+351 914 141 414',
    );
    // A request under way read the whole thread. Carol deletes her aside, which
    // taught memory nothing: the request still starts again without it.
    const reading = await attemptOf(jobId);
    expect(JSON.stringify(reading.bundle)).toContain('office line in Porto');
    await ok(send(carol.cookie, `/rooms/${roomId}/messages/${aside.message.id}`, 'DELETE'));
    const [stopped] =
      await sql`select outcome from attempt where id = ${reading.bundle.attempt.id}`;
    expect(stopped?.outcome).toBe('fenced');
    // The request is under way again, holding the thread as it now is.
    const running = await attemptOf(jobId);
    expect(JSON.stringify(running.bundle)).toContain('914 141 414');
    expect(JSON.stringify(running.bundle)).not.toContain('office line in Porto');
    const restoreBackup = await backup(roomId);

    // Only the person who wrote it deletes it.
    expect(
      (await send(carol.cookie, `/rooms/${roomId}/messages/${asked.message.id}`, 'DELETE')).status,
    ).toBe(403);
    const deleted = await ok<{ message: { text: string | null } }>(
      send(bob.cookie, `/rooms/${roomId}/messages/${asked.message.id}`, 'DELETE'),
    );
    expect(deleted.message.text).toBeNull();
    await ok(send(bob.cookie, `/rooms/${roomId}/messages/${own.message.id}`, 'DELETE'));

    const nowhere = async () => {
      const view = roomThreadView.parse(
        await ok(send(carol.cookie, `/rooms/${roomId}/threads/${opened.thread.id}`)),
      );
      const deletedMessage = view.messages.find((message) => message.id === asked.message.id);
      expect(deletedMessage?.text).toBeNull();
      expect(JSON.stringify(view)).not.toContain('914 141 414');
      const threads = await ok(send(carol.cookie, `/rooms/${roomId}/threads`));
      expect(JSON.stringify(threads)).not.toContain('914 141 414');
      expect(
        JSON.stringify(await ok(send(carol.cookie, `/rooms/${roomId}/threads/${own.thread.id}`))),
      ).not.toContain('914 141 414');
      const [copies] = await sql`select
        (select count(*)::int from room_message where space_id = ${roomId} and text like '%914 141 414%')
        + (select count(*)::int from event e join job j on j.id = e.job_id
            where j.space_id = ${roomId} and e.payload::text like '%914 141 414%')
        + (select count(*)::int from experience_turn t join job j on j.id = t.job_id
            where j.space_id = ${roomId} and t.text like '%914 141 414%')
        + (select count(*)::int from room_thread where space_id = ${roomId} and title like '%914 141 414%')
        + (select count(*)::int from job where space_id = ${roomId}
            and (objective like '%914 141 414%' or title like '%914 141 414%')) as copies`;
      expect(copies?.copies).toBe(0);
      const roomScope = await started.scopeForJob(jobId);
      const recalled = await recall(sql, roomScope, { query: 'call Maya number' });
      expect(JSON.stringify(recalled.items)).not.toContain('914 141 414');
      expect(JSON.stringify(await roomMemory(bob, roomId))).not.toContain('914 141 414');
      const [kept] = await sql`select count(*)::int as n from memory_sources
        where space_id = ${roomId} and state = 'active'
          and source_identity = ${`room_message:${asked.message.id}`}`;
      expect(kept?.n).toBe(0);
    };
    await nowhere();
    // The attempt that read it was fenced; the request runs again without it.
    const [fenced] = await sql`select outcome from attempt where id = ${running.bundle.attempt.id}`;
    expect(fenced?.outcome).toBe('fenced');
    const again = await attemptOf(jobId);
    expect(JSON.stringify(again.bundle)).not.toContain('914 141 414');
    await again.finish();
    // The journal names the message, never its words.
    expect(await readFile(started.journal.path, 'utf8')).not.toContain('914 141 414');

    // An older backup comes back with the words in it; the journal's replay takes them out again.
    await restoreBackup();
    const [back] = await sql`select text from room_message where id = ${asked.message.id}`;
    expect(back?.text).toContain('914 141 414');
    await restoreMemory(sql, started.journal);
    await nowhere();
    // Nothing captures it again.
    await settle(roomId);
    await nowhere();
  }, 120_000);

  test('a shared detail later said in a private conversation is shown to nobody in the room and handed to none of its work', async () => {
    const roomId = await makeRoom('Private', [bob]);
    const bobs = await remember(bob, 'Ana can be reached at ana@shared.example these days.');
    const claimId = await claimOf(bobs, 'contact.ana.email');
    // Bob sees and manages his own details in Settings, though he did not set the installation up.
    const listed = await ok<{ items: { id: string; value: string }[] }>(
      send(bob.cookie, '/memory/items'),
    );
    expect(listed.items.map((item) => item.value)).toContain('ana@shared.example');
    await ok(send(bob.cookie, `/rooms/${roomId}/shares`, 'POST', { claim_id: claimId }), 201);
    expect((await roomMemory(alice, roomId)).shares.map((share) => share.content)).toEqual([
      'ana@shared.example',
    ]);
    // Bob then gives Ana's new address in a private conversation: the same detail, a new value.
    await remember(bob, 'Her private address is ana@secret.example now.', true);
    expect(await claimOf(bobs, 'contact.ana.email')).toBe(claimId);
    // Nobody in the room sees it.
    const seen = JSON.stringify(await roomMemory(alice, roomId));
    expect(seen).not.toContain('ana@secret.example');
    expect((await roomMemory(alice, roomId)).shares.map((share) => share.content)).toEqual([null]);
    // No attempt is handed it, on the person's own model or any other.
    for (const local of [true, false]) {
      const { jobId } = await ask(alice, roomId, `Email Ana (${local ? 'local' : 'cloud'}).`);
      const attempt = await attemptOf(jobId, local);
      expect([local, handed(attempt.bundle).includes('ana@secret.example')]).toEqual([
        local,
        false,
      ]);
      await attempt.finish();
    }
    // Bob forgets his own detail from Settings.
    await ok(send(bob.cookie, `/memory/items/${claimId}`, 'DELETE'));
    const after = await ok<{ items: { id: string }[] }>(send(bob.cookie, '/memory/items'));
    expect(after.items.map((item) => item.id)).not.toContain(claimId);
  }, 120_000);

  test('a members-only share stays out while a guest is in the room', async () => {
    const { sql } = database();
    const roomId = await makeRoom('Guests', [bob]);
    const bobs = await remember(bob, 'Ana is at ana@private.example and the deposit is 450 euros.');
    await ok(
      send(bob.cookie, `/rooms/${roomId}/shares`, 'POST', {
        claim_id: await claimOf(bobs, 'contact.ana.email'),
      }),
      201,
    );
    await ok(
      send(bob.cookie, `/rooms/${roomId}/shares`, 'POST', {
        claim_id: await claimOf(bobs, 'pref.venue.deposit'),
        members_only: false,
      }),
      201,
    );
    const first = await ask(alice, roomId, 'What do we know about Ana and the deposit?');
    const before = await attemptOf(first.jobId);
    expect(handed(before.bundle)).toContain('ana@private.example');
    expect(handed(before.bundle)).toContain('450 euros');
    await before.finish();

    // A guest joins the room by invitation.
    const invited = await ok<{ path: string }>(
      send(alice.cookie, `/rooms/${roomId}/invites`, 'POST', { email: 'gus@guest.example' }),
      201,
    );
    const token = new URLSearchParams(invited.path.split('?')[1] ?? '').get('token');
    const joined = await database().app.request('/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'a-long-enough-password' }),
    });
    expect(joined.status).toBe(200);
    const [guest] = await sql`select id from principal where email = 'gus@guest.example'`;
    const guestId = String(guest?.id);
    const second = await ask(alice, roomId, 'What do we know about Ana and the deposit now?');
    const during = await attemptOf(second.jobId);
    expect(handed(during.bundle)).not.toContain('ana@private.example');
    expect(handed(during.bundle)).toContain('450 euros');
    await during.finish();

    // An owner removes the guest; the members-only share is back for the room's work.
    await ok(send(alice.cookie, `/rooms/${roomId}/members/${guestId}`, 'DELETE'));
    const third = await ask(alice, roomId, 'And after the guest left?');
    const after = await attemptOf(third.jobId);
    expect(handed(after.bundle)).toContain('ana@private.example');
    await after.finish();
  }, 120_000);

  test('an owner forgets any room claim, and a member forgets only claims from their own words', async () => {
    const roomId = await makeRoom('Venue', [bob, carol]);
    const opened = await startThread(bob, roomId, "The hall's deposit is 500 euros.");
    await post(carol, roomId, opened.thread.id, 'I would rather have a window seat.');
    await post(bob, roomId, opened.thread.id, "Maya's number is +351 915 151 515.");
    await settle(roomId);
    const items = async (person: Person): Promise<Record<string, RoomMemoryItem>> =>
      Object.fromEntries(
        (await roomMemory(person, roomId)).items.map((item) => [item.key ?? item.claim_id, item]),
      );
    const seenByBob = await items(bob);
    expect(
      Object.values(seenByBob)
        .map((item) => [item.key, item.can_forget])
        .sort(),
    ).toEqual([
      ['contact.maya.phone', true],
      ['pref.travel.seat', false],
      ['pref.venue.deposit', true],
    ]);
    const seat = seenByBob['pref.travel.seat']?.claim_id;
    const deposit = seenByBob['pref.venue.deposit']?.claim_id;
    if (!seat || !deposit) throw new Error('Room memory is missing a detail');
    // Bob cannot forget what Carol said; he can forget his own.
    expect((await send(bob.cookie, `/rooms/${roomId}/memory/${seat}/forget`, 'POST')).status).toBe(
      403,
    );
    await ok(send(bob.cookie, `/rooms/${roomId}/memory/${deposit}/forget`, 'POST'));
    // An owner forgets anything in the room, whoever said it.
    expect(Object.values(await items(alice)).every((item) => item.can_forget)).toBe(true);
    await ok(send(alice.cookie, `/rooms/${roomId}/memory/${seat}/forget`, 'POST'));
    expect(Object.keys(await items(carol))).toEqual(['contact.maya.phone']);
    // "Forget that" in plain words takes back the speaker's own last kept message.
    await post(bob, roomId, opened.thread.id, 'Forget that.');
    await settle(roomId);
    expect(Object.keys(await items(carol))).toEqual([]);
  }, 120_000);
});
