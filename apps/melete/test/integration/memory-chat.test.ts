/**
 * Automatic memory from chat, end to end on a scripted extractor: what a person
 * says in a conversation is kept, a later conversation is handed it, a plain
 * correction replaces it, "forget ..." removes it everywhere, and each change is
 * told in the conversation as a tool entry.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { ExtractionProposal } from '@melete/contracts';
import { openDatabase } from '../../src/db/client.ts';
import { createScriptedProvider, fakeProvider } from '../../src/gateway/index.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { captureChat, chatIntent } from '../../src/memory/capture.ts';
import { MemoryError, type MemoryScope } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import type { ExtractionGateway } from '../../src/memory/extract.ts';
import { cleanupMemory } from '../../src/memory/forget.ts';
import { failureCode, openMemoryGateway } from '../../src/memory/gateway.ts';
import { memoryHealth } from '../../src/memory/health.ts';
import { attemptRecallQuery, recall } from '../../src/memory/recall.ts';
import { runExtractionWork } from '../../src/memory/service.ts';
import { buildViews } from '../../src/memory/views.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { createJournal } from './lifecycle-fixtures.ts';
import { createScope, createTestDatabase, type TestDatabase } from './postgres.ts';
import { record } from './properties-fixtures.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 2) : null;
const jobs = handle && db ? new JobService(handle.db, db.boss) : null;
const submissions = jobs ? new SubmissionService(jobs) : null;
// The chat surface enqueues a wake for every message it accepts.
if (db) for (const queue of Object.values(QUEUES)) await db.boss.createQueue(queue);
afterAll(async () => {
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
});
const withDb = db ? describe : describe.skip;

/** What the scripted extractor reads out of a message: a key and the exact words of its value. */
const READS: { match: RegExp; key: string; kind: string }[] = [
  { match: /\+351 9\d\d \d{3} \d{3}/, key: 'contact.maya.phone', kind: 'user_statement' },
  { match: /\b\w+@[\w.]+\.example\b/, key: 'contact.ana.email', kind: 'user_statement' },
  { match: /(?:aisle|window) seat/, key: 'pref.travel.seat', kind: 'preference' },
];

/**
 * A charitable extractor: it proposes what READS finds in the evidence, and
 * supersedes the claim on that key when the snapshot it was given shows one.
 */
function scriptedGateway(): ExtractionGateway & { calls: number } {
  const gateway = {
    calls: 0,
    async chat(body: { messages: { role: string; content: string }[] }) {
      gateway.calls++;
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
          valid_from: new Date().toISOString(),
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
  };
  return gateway;
}

/** The owner's scope for this space's jobs, and a refusal for any other space's. */
const scopeFor = (db: TestDatabase, scope: MemoryScope) => async (jobId: string) => {
  const [job] = await db.sql`select space_id from job where id = ${jobId}`;
  if (job?.space_id !== scope.spaceId) throw new MemoryError('scope_denied');
  return scope;
};
/** A conversation, created as the chat surface creates one, in the person's own name. */
async function conversation(_db: TestDatabase, scope: MemoryScope, title = 'New chat') {
  if (!jobs) throw new Error('no job service');
  const service = jobs;
  const row = await principalContext.run(scope.ownerId, () =>
    service.transaction((tx) =>
      service.createInTransaction(
        tx,
        { space_id: scope.spaceId, title, objective: title },
        { kind: 'chat' },
        'owner_request',
      ),
    ),
  );
  return row.id;
}
/**
 * A message typed into a conversation through the chat surface's own writer,
 * which records who said it. The turn then ends, as a runner would end it, so
 * the next message is accepted.
 */
async function say(db: TestDatabase, jobId: string, text: string) {
  if (!submissions) throw new Error('no submission service');
  const service = submissions;
  const [job] =
    await db.sql`select coalesce(principal_id, (select id from owner limit 1)) as principal_id from job where id = ${jobId}`;
  await principalContext.run(job?.principal_id as string, () =>
    service.input(jobId, { text }, `sub_${newId('turn')}`),
  );
  await db.sql`update job set state = 'waiting_for_input', current_turn_id = null where id = ${jobId}`;
}
/** A conversation row written directly, for the cases the chat surface now refuses. */
async function legacyConversation(db: TestDatabase, scope: MemoryScope) {
  const jobId = newId('job');
  await db.sql`insert into job (id, space_id, title, objective, kind, state, revision, lease_epoch)
    values (${jobId}, ${scope.spaceId}, 'New chat', 'New chat', 'chat', 'completed', 1, 1)`;
  return jobId;
}
/**
 * A message event written directly: a speaker the writer would refuse, or none
 * at all, as events written before speakers were recorded carry.
 */
async function legacySay(db: TestDatabase, jobId: string, text: string, speaker: string | null) {
  const payload = { kind: 'user_message', text, ...(speaker ? { principal_id: speaker } : {}) };
  await db.sql`insert into event (job_id, type, payload, dedup_key)
    values (${jobId}, 'notice', ${JSON.stringify(payload)}::text::jsonb, ${`evt:${newId('turn')}`})`;
}
/** The memory notices a conversation holds: what was done, to what, and the words quoted. */
async function traces(db: TestDatabase, jobId: string) {
  const rows = await db.sql`select payload from event where job_id = ${jobId}
    and type = 'notice' and payload->>'kind' = 'memory_tool' order by seq`;
  return rows.map((row) => {
    const notice = row.payload as { op: string; labels: string[]; value: string | null };
    return { op: notice.op, labels: notice.labels, value: notice.value };
  });
}

withDb('automatic memory from chat', () => {
  test('say, recall later, correct in plain words, and forget, each told as a tool entry', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
    const journal = await createJournal();
    const gateway = scriptedGateway();
    const service = { sql: db.sql, boss: db.boss, journal: journal.journal, gateway };
    const capture = { sql: db.sql, journal: journal.journal, scopeForJob: scopeFor(db, owner) };
    // One pass of what the service's loops do: capture, extract, rebuild views.
    const settle = async () => {
      await captureChat(capture);
      const work =
        await db.sql`select id from memory_work where space_id = ${scope.spaceId} and status = 'pending'`;
      for (const row of work) await runExtractionWork(service, row.id as string);
      await cleanupMemory(db.sql, scope.spaceId);
      await buildViews(db.sql, scope);
    };
    const handed = async (text: string) =>
      (
        await recall(
          db.sql,
          scope,
          {
            query: attemptRecallQuery({
              job: { objective: 'New chat' },
              inputs: { new_user_messages: [{ content: text }] },
            }),
            max_tokens: 2000,
          },
          { includeProfile: true },
        )
      ).items.map((item) => `${item.key}=${item.content}`);
    try {
      const first = await conversation(db, scope);
      await say(db, first, 'Hi! Could you help me plan the weekend?');
      await say(
        db,
        first,
        "My sister Maya's number is +351 912 345 678, and I prefer an aisle seat.",
      );
      await settle();
      const kept = await db.sql`select c.key, b.content from memory_claims c
        join memory_revision_content b on b.claim_id = c.id and b.revision = c.head_revision
        where c.space_id = ${scope.spaceId} and not c.hidden order by c.key`;
      expect(kept.map((row) => `${row.key}=${row.content}`)).toEqual([
        'contact.maya.phone=+351 912 345 678',
        'pref.travel.seat=aisle seat',
      ]);
      expect(await traces(db, first)).toEqual([
        { op: 'write', labels: ["maya's phone"], value: '+351 912 345 678' },
        { op: 'write', labels: ['travel: seat'], value: 'aisle seat' },
      ]);

      // A new conversation, days later, is handed what it needs without asking.
      const later = await handed('Text Maya that I am running late');
      expect(later).toContain('contact.maya.phone=+351 912 345 678');
      expect(later).toContain('pref.travel.seat=aisle seat');

      // A correction in plain words replaces the value.
      const second = await conversation(db, scope);
      await say(db, second, "That's wrong, Maya's number is now +351 911 111 111.");
      await settle();
      expect(await traces(db, second)).toEqual([
        { op: 'correct', labels: ["maya's phone"], value: '+351 911 111 111' },
      ]);
      const corrected = await handed('Call Maya');
      expect(corrected).toContain('contact.maya.phone=+351 911 111 111');
      expect(corrected.join()).not.toContain('912 345 678');

      // "Forget Maya's number" removes it from recall and from every stored copy.
      await say(db, second, "Forget Maya's number.");
      await settle();
      // A forget names the detail and never repeats its value, and the entries
      // that quoted it earlier keep their label and lose the quotation.
      expect((await traces(db, second)).at(-1)).toEqual({
        op: 'forget',
        labels: ["maya's phone"],
        value: null,
      });
      expect(await traces(db, first)).toEqual([
        { op: 'write', labels: ["maya's phone"], value: null },
        { op: 'write', labels: ['travel: seat'], value: 'aisle seat' },
      ]);
      expect((await traces(db, second))[0]).toEqual({
        op: 'correct',
        labels: ["maya's phone"],
        value: null,
      });
      expect((await handed('Call Maya')).join()).not.toContain('maya');
      for (const number of ['912 345 678', '911 111 111']) {
        const [left] = await db.sql`select
          (select count(*)::int from memory_source_content b join memory_sources s on s.id = b.source_id
            where s.space_id = ${scope.spaceId} and b.content like ${`%${number}%`})
          + (select count(*)::int from memory_revision_content b join memory_claims c on c.id = b.claim_id
            where c.space_id = ${scope.spaceId} and b.content like ${`%${number}%`}) as copies`;
        expect([number, left?.copies]).toEqual([number, 0]);
      }
      // The seat, said in the same message as the first number, is still kept.
      expect(await handed('Book my flight')).toContain('pref.travel.seat=aisle seat');

      // "Don't remember this: ..." is not kept, and nothing is asked of the model.
      const calls = gateway.calls;
      await say(db, second, "Don't remember this: Ana's email is ana@secret.example");
      await settle();
      expect(gateway.calls).toBe(calls);
      const [secret] = await db.sql`select count(*)::int as n from memory_source_content b
        join memory_sources s on s.id = b.source_id where s.space_id = ${scope.spaceId} and b.content like '%secret%'`;
      expect(secret?.n).toBe(0);

      // "Forget that" reaches back to the previous kept message in the conversation.
      await say(db, second, 'Actually I prefer a window seat.');
      await settle();
      expect(await handed('Book my flight')).toContain('pref.travel.seat=window seat');
      await say(db, second, 'Forget that.');
      await settle();
      expect((await handed('Book my flight')).join()).not.toContain('window');
    } finally {
      await journal.close();
    }
  });

  test('a person who turns memory off is not remembered, and can still say forget', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
    const journal = await createJournal();
    try {
      const capture = { sql: db.sql, journal: journal.journal, scopeForJob: scopeFor(db, owner) };
      await db.sql`insert into memory_settings (principal_id, capture) values (${scope.ownerId}, false)
        on conflict (principal_id) do update set capture = false`;
      const job = await conversation(db, scope);
      await say(db, job, 'I prefer an aisle seat.');
      await captureChat(capture);
      const [row] =
        await db.sql`select count(*)::int as n from memory_sources where space_id = ${scope.spaceId}`;
      expect(row?.n).toBe(0);
      const [outcome] =
        await db.sql`select c.outcome from memory_capture c join event e on e.seq = c.event_seq where e.job_id = ${job}`;
      expect(outcome?.outcome).toBe('skipped:off');
    } finally {
      await db.sql`delete from memory_settings where principal_id = ${scope.ownerId}`;
      await journal.close();
    }
  });

  test('a message from someone who does not own the space is never kept in its memory', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const journal = await createJournal();
    try {
      const member: MemoryScope = {
        ...scope,
        principalId: newId('own'),
        role: 'reader',
        audience: 'space',
      };
      const capture = { sql: db.sql, journal: journal.journal, scopeForJob: scopeFor(db, member) };
      const job = await conversation(db, scope);
      await say(db, job, 'My sister Maya is on +351 912 345 678.');
      await captureChat(capture);
      // The Compose path resolves every job to the owner's scope; the speaker is
      // still whoever the job belongs to, and a member's job is not the owner's.
      const memberId = newId('own');
      await db.sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
      // The chat surface refuses both of the next cases now; events written
      // before it did are still read, and must still not be kept.
      const theirs = await legacyConversation(db, scope);
      await db.sql`update job set principal_id = ${memberId} where id = ${theirs}`;
      await legacySay(db, theirs, 'My sister Maya is on +351 912 345 678.', memberId);
      await captureChat({ ...capture, scopeForJob: scopeFor(db, scope) });
      const [row] =
        await db.sql`select count(*)::int as n from memory_sources where space_id = ${scope.spaceId}`;
      expect(row?.n).toBe(0);
      // A member's words accepted onto the owner's own conversation are still the
      // member's, and a message whose speaker was not recorded is nobody's.
      const owners = await legacyConversation(db, scope);
      await legacySay(db, owners, 'My sister Maya is on +351 912 345 678.', memberId);
      await legacySay(db, owners, 'My sister Maya is on +351 912 345 678.', null);
      await captureChat({ ...capture, scopeForJob: scopeFor(db, scope) });
      const [kept] =
        await db.sql`select count(*)::int as n from memory_sources where space_id = ${scope.spaceId}`;
      expect(kept?.n).toBe(0);
      const outcomes =
        await db.sql`select outcome from memory_capture where job_id in (${job}, ${theirs}, ${owners}) order by event_seq`;
      expect(outcomes.map((entry) => entry.outcome)).toEqual([
        'skipped:member',
        'skipped:member',
        'skipped:member',
        'skipped:member',
      ]);
    } finally {
      await journal.close();
    }
  });

  test('the memory gateway holds each person to a daily number of calls', async () => {
    if (!db) return;
    const opened = await openMemoryGateway({
      sql: db.sql,
      provider: 'fake',
      model: 'fake-scripted-v1',
      providers: [fakeProvider],
      fake: createScriptedProvider([{ text: '{"proposals":[]}' }]),
      dailyCalls: 2,
    });
    try {
      const ownerId = newId('own');
      const ask = (workId: string) =>
        opened.gateway.chat(
          {
            messages: [
              { role: 'system', content: 'Return JSON.' },
              { role: 'user', content: '{}' },
            ],
            max_tokens: 100,
            signal: AbortSignal.timeout(10_000),
          },
          { ownerId, spaceId: 'sp_budget', workId },
        );
      expect(await ask('first-call')).toBe('{"proposals":[]}');
      expect(await ask('second-call')).toBe('{"proposals":[]}');
      expect(await ask('third-call').catch((error: Error) => error.message)).toBe(
        'memory_daily_budget',
      );
      // Another person's budget is their own.
      const other = await opened.gateway
        .chat(
          {
            messages: [{ role: 'user', content: '{}' }],
            max_tokens: 100,
            signal: AbortSignal.timeout(10_000),
          },
          { ownerId: newId('own'), spaceId: 'sp_budget', workId: 'fourth-call' },
        )
        .catch((error: Error) => error.message);
      expect(other).toBe('{"proposals":[]}');
      // A call that was sent counts even when no answer came back, a timeout
      // included; only a call the provider answered with an error does not.
      const sent = newId('own');
      for (const settlement of [
        { status: 'unknown', httpStatus: null },
        { status: 'unknown', httpStatus: null },
      ])
        await db.sql`insert into memory_model_calls (id, owner_id, space_id, work_id, provider, model, reserved_tokens, settlement)
          values (${newId('turn')}, ${sent}, 'sp_budget', ${newId('task')}, 'fake', 'fake-scripted-v1', 100, ${JSON.stringify(settlement)}::text::jsonb)`;
      const timedOut = await opened.gateway
        .chat(
          {
            messages: [{ role: 'user', content: '{}' }],
            max_tokens: 100,
            signal: AbortSignal.timeout(10_000),
          },
          { ownerId: sent, spaceId: 'sp_budget', workId: 'after-timeouts' },
        )
        .catch((error: Error) => error.message);
      expect(timedOut).toBe('memory_daily_budget');
      const refused = newId('own');
      for (let i = 0; i < 2; i++)
        await db.sql`insert into memory_model_calls (id, owner_id, space_id, work_id, provider, model, reserved_tokens, settlement)
          values (${newId('turn')}, ${refused}, 'sp_budget', ${newId('task')}, 'fake', 'fake-scripted-v1', 100, ${JSON.stringify({ status: 'failed', httpStatus: 503 })}::text::jsonb)`;
      const afterErrors = await opened.gateway
        .chat(
          {
            messages: [{ role: 'user', content: '{}' }],
            max_tokens: 100,
            signal: AbortSignal.timeout(10_000),
          },
          { ownerId: refused, spaceId: 'sp_budget', workId: 'after-errors' },
        )
        .catch((error: Error) => error.message);
      expect(afterErrors).toBe('{"proposals":[]}');
    } finally {
      await opened.close();
    }
  });
});

withDb('a model provider outage', () => {
  test('a message waits out a provider outage unread, costs no reads, and is kept once it recovers', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const journal = await createJournal();
    const text = "Ana's email is ana@studio.example.";
    const evidence = await ingest(db.sql, scope, {
      stream: 'chat',
      source_identity: 'outage',
      source_version: '1',
      source_type: 'message',
      author: 'owner',
      event_at: '2026-08-02T09:00:00Z',
      text,
    });
    const quote = 'ana@studio.example';
    const start = text.indexOf(quote);
    const reply = JSON.stringify({
      proposals: [
        {
          op: 'add',
          expected_revision: null,
          domain_key: 'contact.ana.email',
          key: 'contact.ana.email',
          content: quote,
          kind: 'user_statement',
          factual_status: 'attributed',
          valid_from: '2026-08-02T09:00:00Z',
          valid_until: null,
          sources: [
            {
              source_id: evidence.source.source_id,
              source_version: '1',
              start,
              end: start + quote.length,
              quote,
            },
          ],
        },
      ],
    });
    let down = true;
    const answers = createScriptedProvider([{ text: reply }]);
    const opened = await openMemoryGateway({
      sql: db.sql,
      provider: 'fake',
      model: 'fake-scripted-v1',
      providers: [fakeProvider],
      // The provider answers 503 until it comes back.
      fake: async (body, attemptId, protocol) =>
        down
          ? new Response('{"error":"unavailable"}', {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          : answers(body, attemptId, protocol),
      dailyCalls: 2,
    });
    const service = {
      sql: db.sql,
      boss: db.boss,
      journal: journal.journal,
      gateway: opened.gateway,
    };
    const work = async () => {
      const [row] = await db.sql`select id, status, calls, provider_failures,
        extract(epoch from (retry_at - clock_timestamp()))::float as wait from memory_work where source_id = ${evidence.source.source_id}`;
      return row as {
        id: string;
        status: string;
        calls: number;
        provider_failures: number;
        wait: number | null;
      };
    };
    try {
      const waits: number[] = [];
      // Five failures, more than the message's four calls and the person's two daily reads.
      for (let failure = 1; failure <= 5; failure++) {
        const { id } = await work();
        await runExtractionWork(service, id);
        const after = await work();
        expect([after.status, after.calls, after.provider_failures]).toEqual([
          'pending',
          0,
          failure,
        ]);
        waits.push(Math.round(after.wait ?? 0));
        // While the wait lasts the message is not tried at all.
        await runExtractionWork(service, id);
        expect((await work()).provider_failures).toBe(failure);
        await db.sql`update memory_work set retry_at = clock_timestamp() - interval '1 second' where id = ${id}`;
      }
      // 30 s after the first failure, doubling each time.
      expect(waits.map((wait) => Math.round(wait / 30))).toEqual([1, 2, 4, 8, 16]);
      // The operator sees messages waiting on the provider, without their content.
      expect(await memoryHealth(db.sql)).toEqual({
        status: 'waiting',
        waiting: 1,
        reason: 'provider_unavailable',
        failed: 0,
      });
      // However long the outage, the gap stops growing at 30 minutes.
      const { id } = await work();
      await db.sql`update memory_work set provider_failures = 6 where id = ${id}`;
      await runExtractionWork(service, id);
      expect(Math.round((await work()).wait ?? 0)).toBeLessThanOrEqual(1800);
      await db.sql`update memory_work set retry_at = clock_timestamp() - interval '1 second' where id = ${id}`;
      // The provider comes back: the message is read and kept, and only that read is counted.
      down = false;
      await runExtractionWork(service, id);
      expect((await work()).status).toBe('done');
      expect((await memoryHealth(db.sql)).waiting).toBe(0);
      const [kept] = await db.sql`select b.content from memory_claims c
        join memory_revision_content b on b.claim_id = c.id and b.revision = c.head_revision
        where c.space_id = ${scope.spaceId} and c.key = 'contact.ana.email'`;
      expect(kept?.content).toBe(quote);
      const [reads] = await db.sql`select count(*)::int as n from memory_model_calls
        where owner_id = ${scope.ownerId} and settlement->>'status' = 'succeeded'`;
      expect(reads?.n).toBe(1);
    } finally {
      await opened.close();
      await journal.close();
    }
  });
});

withDb('asking to forget in plain words', () => {
  test('forget acts only on the one detail it names, and otherwise answers without keeping the request', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
    const journal = await createJournal();
    try {
      const detail = (identity: string, text: string, key: string, value: string) =>
        record(db, scope, { identity, text, eventAt: '2026-08-02T09:00:00Z' }, [
          { key, content: value, quote: value, kind: 'user_statement' },
        ]);
      await detail(
        'mine',
        'My number is +351 910 000 001.',
        'contact.me.phone',
        '+351 910 000 001',
      );
      await detail(
        'bob',
        "Bob's number is +351 910 000 002.",
        'contact.bob.phone',
        '+351 910 000 002',
      );
      await detail(
        'maya-phone',
        "Maya's number is +351 910 000 003.",
        'contact.maya.phone',
        '+351 910 000 003',
      );
      await detail(
        'maya-email',
        "Maya's email is maya@home.example.",
        'contact.maya.email',
        'maya@home.example',
      );
      const capture = { sql: db.sql, journal: journal.journal, scopeForJob: scopeFor(db, owner) };
      const chat = await conversation(db, scope);
      const kept = async () =>
        (
          await db.sql`select c.key from memory_claims c where c.space_id = ${scope.spaceId} and not c.hidden order by c.key`
        ).map((row) => row.key as string);
      const replies = async () =>
        (
          await db.sql`select payload->'call'->'output_summary'->>'text' as text from event
            where job_id = ${chat} and payload->>'kind' = 'tool_trace' order by seq`
        ).map((row) => row.text as string);
      await detail(
        'ana',
        "Ana's email is ana@studio.example.",
        'contact.ana.email',
        'ana@studio.example',
      );
      const everything = await kept();

      // "My number" is the person's own number, and only that: Bob's stays.
      await say(db, chat, 'Forget my number.');
      await captureChat(capture);
      const withoutMine = everything.filter((key) => key !== 'contact.me.phone');
      expect(await kept()).toEqual(withoutMine);

      // "My address": the person has none saved, so nothing goes, Ana's email least of all.
      await say(db, chat, 'Forget my address.');
      await captureChat(capture);
      expect(await kept()).toEqual(withoutMine);
      expect((await replies()).at(-1)).toBe('Nothing saved matched');

      // A field alone names nobody: it asks whose, and forgets nothing.
      await say(db, chat, 'Forget the number.');
      await captureChat(capture);
      expect(await kept()).toEqual(withoutMine);
      expect((await replies()).at(-1)).toBe(
        'Say whose the number to forget, for example "forget Ana\'s email"',
      );

      // Two details name Maya: it asks which, and forgets neither.
      await say(db, chat, "Forget Maya's details.");
      await captureChat(capture);
      expect(await kept()).toEqual(withoutMine);
      expect((await replies()).at(-1)).toBe(
        "More than one saved detail matched: maya's email, maya's phone. Say which one to forget",
      );

      // Nothing saved names Carol: it says so.
      await say(db, chat, "Forget Carol's number.");
      await captureChat(capture);
      expect((await replies()).at(-1)).toBe('Nothing saved matched');

      // A request that names something not saved matches nothing: the number in
      // it is not kept, and Maya's saved number stays.
      await say(db, chat, "Forget Maya's old number +351 910 000 099.");
      await captureChat(capture);
      expect((await replies()).at(-1)).toBe('Nothing saved matched');
      expect(await kept()).toEqual(withoutMine);

      // Named exactly, the one detail goes and nothing else does.
      await say(db, chat, "Forget Maya's number.");
      await captureChat(capture);
      expect(await kept()).toEqual(withoutMine.filter((key) => key !== 'contact.maya.phone'));

      // None of the requests was kept as something the person said.
      const [requests] = await db.sql`select count(*)::int as n from memory_sources
        where space_id = ${scope.spaceId} and publisher = 'chat'`;
      expect(requests?.n).toBe(0);
      const outcomes =
        await db.sql`select c.outcome from memory_capture c join event e on e.seq = c.event_seq
        where e.job_id = ${chat} and e.type = 'notice' order by c.event_seq`;
      expect(outcomes.map((row) => row.outcome)).toEqual([
        'forgot',
        'forgot:none',
        'forgot:ask',
        'forgot:ask',
        'forgot:none',
        'forgot:none',
        'forgot',
      ]);
    } finally {
      await journal.close();
    }
  });

  test("a job's first objective is kept when the person typed it, and not when it was derived", async () => {
    if (!db || !jobs) return;
    const service = jobs;
    const scope = await createScope(db);
    const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
    const journal = await createJournal();
    try {
      const task = (objective: string, origin: 'owner_request' | 'derived') =>
        principalContext.run(scope.ownerId, () =>
          service.transaction((tx) =>
            service.createInTransaction(
              tx,
              { space_id: scope.spaceId, title: 'Task', objective },
              undefined,
              origin,
            ),
          ),
        );
      await task('Book the dentist for me, Dr Silva is on +351 912 000 111.', 'owner_request');
      await task('Reply to the supplier who wrote +351 912 000 222.', 'derived');
      await captureChat({
        sql: db.sql,
        journal: journal.journal,
        scopeForJob: scopeFor(db, owner),
      });
      const kept =
        await db.sql`select b.content from memory_sources s join memory_source_content b on b.source_id = s.id
        where s.space_id = ${scope.spaceId} and s.publisher = 'chat'`;
      expect(kept.map((row) => row.content)).toEqual([
        'Book the dentist for me, Dr Silva is on +351 912 000 111.',
      ]);
    } finally {
      await journal.close();
    }
  });
});

withDb('failures asking again cannot fix', () => {
  test('a refused call, a very long message and an outage that outlasts the backoff each end the message', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const journal = await createJournal();
    let answer: 'refuse' | 'down' | 'ok' = 'refuse';
    const ok = createScriptedProvider(
      Array.from({ length: 10 }, () => ({ text: '{"proposals":[]}' })),
    );
    const opened = await openMemoryGateway({
      sql: db.sql,
      provider: 'fake',
      model: 'no-such-model',
      providers: [fakeProvider],
      // A wrong model name is refused by the provider with 404; an outage is 503.
      fake: async (body, attemptId, protocol) =>
        answer === 'ok'
          ? ok(body, attemptId, protocol)
          : new Response('{"error":"no"}', {
              status: answer === 'refuse' ? 404 : 503,
              headers: { 'content-type': 'application/json' },
            }),
      dailyCalls: 50,
    });
    const service = {
      sql: db.sql,
      boss: db.boss,
      journal: journal.journal,
      gateway: opened.gateway,
    };
    const message = async (identity: string, text: string) => {
      const evidence = await ingest(db.sql, scope, {
        stream: 'chat',
        source_identity: identity,
        source_version: '1',
        source_type: 'message',
        author: 'owner',
        event_at: '2026-08-02T09:00:00Z',
        text,
      });
      const [work] =
        await db.sql`select id from memory_work where source_id = ${evidence.source.source_id}`;
      return work?.id as string;
    };
    const state = async (id: string) => {
      const [row] = await db.sql`select status, error_code from memory_work where id = ${id}`;
      return [row?.status, row?.error_code];
    };
    try {
      // The provider refuses the model: asking again cannot succeed, so it stops.
      const refused = await message('bad-model', 'My dentist is Dr Silva.');
      await runExtractionWork(service, refused);
      expect(await state(refused)).toEqual(['rejected', 'extraction_provider_refused']);

      // A 14,000-character message reaches an end, answered or refused, never waiting forever.
      answer = 'ok';
      const long = await message('long', '我'.repeat(14_000));
      await runExtractionWork(service, long);
      expect(['done', 'rejected']).toContain((await state(long))[0]);

      // An outage that outlasts eight tries gives the message up with a recorded fault.
      answer = 'down';
      const waited = await message('outage', 'My sister Maya is on +351 912 345 678.');
      await db.sql`update memory_work set provider_failures = 7 where id = ${waited}`;
      await runExtractionWork(service, waited);
      expect(await state(waited)).toEqual(['rejected', 'extraction_provider_unavailable:given_up']);
      const health = await memoryHealth(db.sql);
      expect(health.failed).toBeGreaterThanOrEqual(2);
    } finally {
      await opened.close();
      await journal.close();
    }
  });
});

test('a failed call is sorted by whether asking again can help', () => {
  expect(failureCode(429, '{"error":{"code":"memory_daily_budget"}}', undefined)).toBe(
    'memory_daily_budget',
  );
  expect(failureCode(429, '{"error":{"code":"memory_call_too_large"}}', undefined)).toBe(
    'extraction_call_refused',
  );
  expect(failureCode(413, '{"error":{"code":"input_context_exceeded"}}', undefined)).toBe(
    'extraction_call_refused',
  );
  expect(failureCode(502, 'provider_rejected_request', 404)).toBe('extraction_provider_refused');
  expect(failureCode(502, 'provider_rejected_request', 400)).toBe('extraction_provider_refused');
  expect(failureCode(429, 'provider_rejected_request', 429)).toBe('extraction_gateway_failure');
  expect(failureCode(502, 'provider_rejected_request', 503)).toBe('extraction_gateway_failure');
  expect(failureCode(504, 'request_timeout', null)).toBe('extraction_gateway_failure');
});

test('what a message asks of memory is read from its opening words', () => {
  expect(chatIntent('Remember that my dentist is Dr Silva.')).toEqual({
    kind: 'message',
    explicit: true,
  });
  expect(chatIntent('Forget that.')).toEqual({ kind: 'forget', target: null });
  expect(chatIntent("Don't remember that")).toEqual({ kind: 'forget', target: null });
  expect(chatIntent("Please forget Maya's number!")).toEqual({
    kind: 'forget',
    target: "Maya's number",
  });
  expect(chatIntent("Don't remember this: my PIN is 4921")).toEqual({ kind: 'skip' });
  expect(chatIntent('Off the record, I am job hunting.')).toEqual({ kind: 'skip' });
  // Not requests to forget: a message about something else that starts with the word.
  expect(chatIntent('Forget it, just book the train.').kind).toBe('message');
  expect(chatIntent('Erase the whiteboard photo from the album.').kind).toBe('message');
  expect(chatIntent("Erase Maya's number from your memory.")).toEqual({
    kind: 'forget',
    target: "Maya's number",
  });
  // "Don't remember this" is about this message, not the one before it.
  expect(chatIntent("Don't remember this.")).toEqual({ kind: 'skip' });
  // Explicit trust is the person's own words only.
  expect(chatIntent('> Remember that the code is 4921')).toEqual({
    kind: 'message',
    explicit: false,
  });
  expect(chatIntent('"Remember that the meeting moved," she wrote.')).toEqual({
    kind: 'message',
    explicit: false,
  });
  expect(chatIntent('Note that the office is closed.')).toEqual({
    kind: 'message',
    explicit: false,
  });
  expect(chatIntent('Keep in mind that I am vegetarian.')).toEqual({
    kind: 'message',
    explicit: true,
  });
  expect(chatIntent('Could you draft the invitation?')).toEqual({
    kind: 'message',
    explicit: false,
  });
  expect(chatIntent(`Forget ${'the long list '.repeat(40)}`).kind).toBe('message');
});
