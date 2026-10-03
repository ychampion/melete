/**
 * Memory and the privacy router, end to end on Postgres: a message said in a
 * private conversation is read by memory only on the person's own model (or not
 * at all), and what memory learns from it is kept out of everything that goes
 * to a cloud model: recall into ordinary conversations, the details memory
 * shows the model when it reads other messages, another assistant's view, and,
 * as a second line, any cloud request its wording turns up in.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type AttemptBundle, attemptBundle, type ExtractionProposal } from '@melete/contracts';
import { openDatabase } from '../../src/db/client.ts';
import { ExperienceMemory } from '../../src/experience/memory.ts';
import {
  createScriptedProvider,
  fakeProvider,
  type GatewayProvider,
} from '../../src/gateway/index.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { captureChat } from '../../src/memory/capture.ts';
import {
  NOT_REMEMBERED_NOTE,
  newMessagesNotRemembered,
  withMemoryRuntime,
} from '../../src/memory/context.ts';
import { MemoryError, type MemoryScope } from '../../src/memory/db.ts';
import { openMemoryGateway } from '../../src/memory/gateway.ts';
import { recall } from '../../src/memory/recall.ts';
import { runExtractionWork } from '../../src/memory/service.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { PostgresPrivacyStore, PrivacyRouter } from '../../src/privacy/index.ts';
import { updateSettings } from '../../src/privacy/routes.ts';
import { createJournal } from './lifecycle-fixtures.ts';
import { createScope, createTestDatabase, type TestDatabase } from './postgres.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 2) : null;
const jobs = handle && db ? new JobService(handle.db, db.boss) : null;
const submissions = jobs ? new SubmissionService(jobs) : null;
if (db) for (const queue of Object.values(QUEUES)) await db.boss.createQueue(queue);
afterAll(async () => {
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
});
const withDb = db ? describe : describe.skip;

/** What the scripted reader keeps from a message: a key, for the words that name it. */
const READS: { match: RegExp; key: string }[] = [
  { match: /(?:aisle|window) seat/, key: 'pref.travel.seat' },
  { match: /lithium at night/, key: 'pref.health.medicine' },
  { match: /cried at work/, key: 'pref.health.mood' },
];

/** Proposals for whatever READS finds in the evidence, superseding a claim the snapshot shows. */
function propose(requestBody: Record<string, unknown>): string {
  const messages = requestBody.messages as { content: string }[];
  const input = JSON.parse(messages.at(-1)?.content ?? '{}') as {
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
      kind: 'user_statement',
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
}

const scopeFor = (database: TestDatabase, scope: MemoryScope) => async (jobId: string) => {
  const [job] = await database.sql`select space_id from job where id = ${jobId}`;
  if (job?.space_id !== scope.spaceId) throw new MemoryError('scope_denied');
  return scope;
};

async function conversation(scope: MemoryScope) {
  if (!jobs) throw new Error('no job service');
  const service = jobs;
  const row = await principalContext.run(scope.ownerId, () =>
    service.transaction((tx) =>
      service.createInTransaction(
        tx,
        { space_id: scope.spaceId, title: 'New chat', objective: 'New chat' },
        { kind: 'chat' },
        'owner_request',
      ),
    ),
  );
  return row.id;
}

async function say(database: TestDatabase, jobId: string, text: string) {
  if (!submissions) throw new Error('no submission service');
  const service = submissions;
  const [job] =
    await database.sql`select coalesce(principal_id, (select id from owner limit 1)) as principal_id from job where id = ${jobId}`;
  await principalContext.run(job?.principal_id as string, () =>
    service.input(jobId, { text }, `sub_${newId('turn')}`),
  );
  await database.sql`update job set state = 'waiting_for_input', current_turn_id = null where id = ${jobId}`;
}

const cloud: GatewayProvider = {
  name: 'fireworks',
  baseUrl: 'https://api.fireworks.ai/inference/v1/',
  apiKey: 'k',
  protocols: ['chat/completions'],
};

withDb('memory keeps private conversations private', () => {
  test('read on the local model or not at all, and kept out of cloud requests', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
    const journal = await createJournal();
    const router = new PrivacyRouter({
      store: new PostgresPrivacyStore(db.sql, () => 'a'.repeat(64)),
      resolve: async () => [{ address: '93.184.216.34' }],
    });
    /** Every body the cloud model and the local model were sent. */
    const toCloud: string[] = [];
    const toLocal: string[] = [];
    const opened = await openMemoryGateway({
      privacy: router,
      sql: db.sql,
      provider: 'fake',
      model: 'fake-scripted-v1',
      providers: [fakeProvider],
      dailyCalls: 100,
      fake: (body, attemptId, protocol) => {
        toCloud.push(JSON.stringify(body));
        return createScriptedProvider([{ text: propose(body) }])(body, attemptId, protocol);
      },
      fetch: async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        toLocal.push(JSON.stringify(body));
        return Response.json({
          id: 'local-1',
          object: 'chat.completion',
          model: 'llama3.3',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: propose(body) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      },
    });
    const service = {
      sql: db.sql,
      boss: db.boss,
      journal: journal.journal,
      gateway: opened.gateway,
    };
    const settle = async () => {
      await captureChat({
        sql: db.sql,
        journal: journal.journal,
        scopeForJob: scopeFor(db, owner),
        privacyOrigin: (jobId, text) => router.captureOrigin(jobId, text),
      });
      const work =
        await db.sql`select id from memory_work where space_id = ${scope.spaceId} and status = 'pending'`;
      for (const row of work) await runExtractionWork(service, row.id as string);
    };
    const origins = async () =>
      (
        await db.sql`select b.content, s.private_origin from memory_sources s
          join memory_source_content b on b.source_id = s.id
          where s.space_id = ${scope.spaceId} order by s.stream_sequence`
      ).map((row) => `${row.content} | ${row.private_origin ?? 'ordinary'}`);
    try {
      const ordinary = await conversation(scope);
      const therapy = await conversation(scope);
      // Earlier in this conversation a message was found to be about therapy.
      await router.store.updateConversation(therapy, scope.spaceId, { sensitive: 'therapy' });

      // 1. No local model: the private message is not read by any model.
      await say(db, therapy, 'I cried at work again, same as with my dad.');
      await say(db, ordinary, 'For flights I prefer an aisle seat.');
      await settle();
      expect(await origins()).toEqual([
        'I cried at work again, same as with my dad. | therapy',
        'For flights I prefer an aisle seat. | ordinary',
      ]);
      expect(toCloud.join('\n')).not.toContain('cried');
      expect(toCloud.join('\n')).toContain('aisle seat');
      const [kept] = await db.sql`select w.status, w.error_code from memory_work w
        join memory_sources s on s.id = w.source_id join memory_source_content b on b.source_id = s.id
        where b.content like 'I cried%'`;
      expect(kept).toMatchObject({ status: 'rejected', error_code: 'extraction_kept_private' });
      // The agent answering that turn is told nothing from it was remembered;
      // an ordinary conversation's agent is not.
      const latestTurn = async (jobId: string) => {
        const rows = await db.sql`select payload->>'text' as text, created_at from event
          where job_id = ${jobId} and type = 'notice' and payload->>'kind' = 'user_message'
          order by seq desc limit 1`;
        return {
          attempt: { id: 'att_x', job_id: jobId, epoch: 1, revision: 1, token: 't' },
          inputs: {
            new_user_messages: rows.map((row) => ({
              role: 'user' as const,
              content: row.text as string,
              at: new Date(row.created_at as string).toISOString(),
            })),
            approval_results: [],
            trigger_events: [],
            repair_briefs: [],
          },
        };
      };
      expect(await newMessagesNotRemembered(db.sql, scope, await latestTurn(therapy))).toBe(true);
      expect(await newMessagesNotRemembered(db.sql, scope, await latestTurn(ordinary))).toBe(false);

      // 2. With a local model, the private message is read there, and only there.
      await updateSettings(router, scope.spaceId, {
        local_model: { base_url: 'http://127.0.0.1:11434/v1', model: 'llama3.3' },
      });
      await say(db, therapy, 'The doctor has me on lithium at night now.');
      await settle();
      expect(toLocal.join('\n')).toContain('lithium at night');
      // Read on the local model, so that turn's agent is not told otherwise.
      expect(await newMessagesNotRemembered(db.sql, scope, await latestTurn(therapy))).toBe(false);
      expect(toCloud.join('\n')).not.toContain('lithium');
      const learned = await db.sql`select c.key, b.content from memory_claims c
        join memory_revision_content b on b.claim_id = c.id and b.revision = c.head_revision
        where c.space_id = ${scope.spaceId} and not c.hidden order by c.key`;
      expect(learned.map((row) => `${row.key}=${row.content}`)).toEqual([
        'pref.health.medicine=lithium at night',
        'pref.travel.seat=aisle seat',
      ]);

      // 3. Recall into an ordinary attempt leaves it out; the person's own view has it.
      const recalled = async (privateOrigin: boolean) =>
        (
          await recall(
            db.sql,
            scope,
            { query: 'lithium night aisle seat', max_tokens: 2000 },
            { includeProfile: true, privateOrigin },
          )
        ).items.map((item) => item.content);
      expect(await recalled(false)).toEqual(['aisle seat']);
      expect((await recalled(true)).sort()).toEqual(['aisle seat', 'lithium at night']);

      // 4. When memory reads an ordinary message, the model is not shown it either.
      const before = toCloud.length;
      await say(db, ordinary, 'Actually a window seat now.');
      await settle();
      const reading = toCloud.slice(before).join(' ');
      expect(reading).toContain('aisle seat');
      expect(reading).not.toContain('lithium');
      expect(reading).not.toContain('pref.health.medicine');

      // 5. Another assistant reading saved details through the MCP endpoint does not get it.
      const items = new ExperienceMemory(db.sql);
      const listed = async (forAssistant: boolean) => {
        const page = (await items.list(scope.spaceId, scope.ownerId, null, { forAssistant })) as {
          items: { value: string }[];
        };
        return page.items.map((item) => item.value).sort();
      };
      expect(await listed(false)).toContain('lithium at night');
      expect(await listed(true)).not.toContain('lithium at night');

      // 6. As a second line, its wording is swapped out of any cloud request it appears in.
      const prepared = await router.prepare({
        principal: {
          jobId: ordinary,
          attemptId: 'att_x',
          epoch: 1,
          revision: 1,
          maxRequests: 1,
          maxTokens: 100,
          allowedModels: [],
          privacy: { kind: 'job' },
        },
        provider: cloud,
        protocol: 'chat/completions',
        body: {
          model: 'm',
          messages: [{ role: 'system', content: 'Known: lithium at night. Seat: window.' }],
        },
      });
      expect(prepared.route).toBe('cloud');
      expect(JSON.stringify(prepared.body)).not.toContain('lithium');
      expect(JSON.stringify(prepared.body)).toContain('⟦PRIVATE_');
    } finally {
      await opened.close();
      await journal.close();
    }
  });
});

withDb('the agent is told when a private message will not be kept', () => {
  test('decided when the turn starts, before memory has read the message', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
    const journal = await createJournal();
    const router = new PrivacyRouter({
      store: new PostgresPrivacyStore(db.sql, () => 'a'.repeat(64)),
      resolve: async () => [{ address: '93.184.216.34' }],
    });
    const opened = await openMemoryGateway({
      privacy: router,
      sql: db.sql,
      provider: 'fake',
      model: 'fake-scripted-v1',
      providers: [fakeProvider],
      dailyCalls: 100,
      fake: (body, attemptId, protocol) =>
        createScriptedProvider([{ text: propose(body) }])(body, attemptId, protocol),
    });
    /** The memory worker: capture what was said, then read it. Not run until a step says so. */
    const readByMemory = async () => {
      await captureChat({
        sql: db.sql,
        journal: journal.journal,
        scopeForJob: scopeFor(db, owner),
        privacyOrigin: (jobId, text) => router.captureOrigin(jobId, text),
      });
      const work =
        await db.sql`select id from memory_work where space_id = ${scope.spaceId} and status = 'pending'`;
      for (const row of work)
        await runExtractionWork(
          { sql: db.sql, boss: db.boss, journal: journal.journal, gateway: opened.gateway },
          row.id as string,
        );
    };
    /** What the turn answering the person's latest message is told, as the runtime receives it. */
    const objectiveFor = async (jobId: string): Promise<string> => {
      // Each turn is a new lease on the conversation, as a claim makes it.
      const [job] = await db.sql`update job set lease_epoch = lease_epoch + 1
        where id = ${jobId} returning revision, lease_epoch`;
      const attemptId = newId('att');
      await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${attemptId}, ${jobId}, ${job?.lease_epoch}, 'scripted-v1', 'fake', 'fake-scripted-v1')`;
      const [message] = await db.sql`select payload->>'text' as text, created_at from event
        where job_id = ${jobId} and type = 'notice' and payload->>'kind' = 'user_message'
        order by seq desc limit 1`;
      let objective = '';
      const runtime = {
        async capabilities() {
          return { version: 'scripted-v1', tools: false, streaming: true, interrupt: true };
        },
        async start(bundle: AttemptBundle) {
          objective = bundle.job.objective;
          return { kind: 'completed' as const, summary: 'Done.', evidence: [] };
        },
      };
      await withMemoryRuntime(runtime, db.sql, scopeFor(db, owner), {
        refusesMemoryRead: (id) => router.refusesServiceRead(id, { protocol: 'chat/completions' }),
      }).start(
        attemptBundle.parse({
          attempt: {
            id: attemptId,
            job_id: jobId,
            epoch: Number(job?.lease_epoch),
            revision: Number(job?.revision),
            token: 'fixture-only',
          },
          job: {
            title: 'Chat',
            objective: 'Help with what the person asks',
            constraints: {},
            progress_summary: '',
            unresolved_questions: [],
            deliverable: {},
          },
          inputs: {
            new_user_messages: [
              {
                role: 'user',
                content: message?.text as string,
                at: new Date(message?.created_at as string).toISOString(),
              },
            ],
            approval_results: [],
            trigger_events: [],
          },
          transcript: [],
          tools: [],
          skills: [],
          knowledge: [],
          workspace: { mount: '/work', files: [] },
          budget: { max_turns: 1, max_output_tokens: 100, max_wall_ms: 1000, max_actions: 0 },
          model: { provider: 'fake', model: 'fake-scripted-v1', fallback: null },
        }),
        { async emit() {} },
        new AbortController().signal,
      );
      return objective;
    };
    const workFor = async (text: string) =>
      (
        await db.sql`select w.status, w.error_code from memory_work w
          join memory_source_content b on b.source_id = w.source_id where b.content = ${text}`
      )[0];
    try {
      // 1. A private conversation with no local model: the turn is told at once,
      //    before memory has even captured the message.
      const therapy = await conversation(scope);
      await router.store.updateConversation(therapy, scope.spaceId, { sensitive: 'therapy' });
      await say(db, therapy, 'Remember that I cried at work again.');
      expect(await objectiveFor(therapy)).toContain(NOT_REMEMBERED_NOTE);
      // ...and memory then refuses it, as the turn was told.
      await readByMemory();
      expect(await workFor('Remember that I cried at work again.')).toMatchObject({
        status: 'rejected',
        error_code: 'extraction_kept_private',
      });

      // 2. Once the person agrees to a redacted version, a new message is read,
      //    so the turn is not told otherwise, and memory does keep it.
      await router.store.updateConversation(therapy, scope.spaceId, { consent: 'allowed' });
      await say(db, therapy, 'Remember that for flights I prefer an aisle seat.');
      expect(await objectiveFor(therapy)).not.toContain(NOT_REMEMBERED_NOTE);
      await readByMemory();
      expect(await workFor('Remember that for flights I prefer an aisle seat.')).toMatchObject({
        status: 'done',
      });

      // 3. A message memory refused before the person agreed stays unread, and
      //    the turn that resumes it after they agree is told so.
      const finances = await conversation(scope);
      await router.store.updateConversation(finances, scope.spaceId, { sensitive: 'finance' });
      await say(db, finances, 'Please remember my window seat preference.');
      await readByMemory();
      await router.store.updateConversation(finances, scope.spaceId, { consent: 'allowed' });
      expect(await objectiveFor(finances)).toContain(NOT_REMEMBERED_NOTE);

      // 3b. The live order: the person writes, agrees to a redacted version, and
      //     the turn starts before memory has read the message. Memory then reads
      //     it under that agreement and keeps it, so the turn is not told otherwise.
      const budget = await conversation(scope);
      await router.store.updateConversation(budget, scope.spaceId, { sensitive: 'finance' });
      await say(db, budget, 'Remember that I prefer an aisle seat on long flights.');
      await router.store.updateConversation(budget, scope.spaceId, { consent: 'allowed' });
      expect(await objectiveFor(budget)).not.toContain(NOT_REMEMBERED_NOTE);
      await readByMemory();
      expect(await workFor('Remember that I prefer an aisle seat on long flights.')).toMatchObject({
        status: 'done',
      });

      // 4. An ordinary conversation is never told.
      const ordinary = await conversation(scope);
      await say(db, ordinary, 'Remember that I like a window seat on trains.');
      expect(await objectiveFor(ordinary)).not.toContain(NOT_REMEMBERED_NOTE);
    } finally {
      await opened.close();
      await journal.close();
    }
  });
});
