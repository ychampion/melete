/**
 * Memory the person can rely on, against Postgres.
 *
 * - Recall answers this message: the safety details (allergies, diets) always
 *   come first, and what matches the question comes before the newest
 *   preferences, with or without an embedder. The oyster case: a saved
 *   shellfish allergy is handed to a seafood dinner ask, and a saved sister to
 *   a question about her, however many preferences came later.
 * - A request to forget is acted on, and the agent is told memory's own answer:
 *   it may say a detail is forgotten only when memory forgot it.
 * - A "hi" recalls no old details to act on, and stays fast with a large memory.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type AttemptBundle, attemptBundle } from '@melete/contracts';
import { openDatabase } from '../../src/db/client.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { captureChat } from '../../src/memory/capture.ts';
import { FORGET_NOTES, forgetOutcomeNote, withMemoryRuntime } from '../../src/memory/context.ts';
import { MemoryError, type MemoryScope } from '../../src/memory/db.ts';
import { recall } from '../../src/memory/recall.ts';
import { buildViews, type EmbeddingProvider } from '../../src/memory/views.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { classify } from '../../src/privacy/classify.ts';
import { createJournal } from './lifecycle-fixtures.ts';
import { createScope, createTestDatabase, type TestDatabase } from './postgres.ts';
import { record } from './properties-fixtures.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 2) : null;
const jobs = handle && db ? new JobService(handle.db, db.boss) : null;
if (db) for (const queue of Object.values(QUEUES)) await db.boss.createQueue(queue);
afterAll(async () => {
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
});
const withDb = db ? describe : describe.skip;

type Kind = 'user_statement' | 'preference';
let said = 0;
/** Several details said in one message, each quoted from it. */
async function details(
  database: TestDatabase,
  scope: MemoryScope,
  items: { key: string; content: string; kind?: Kind }[],
) {
  said += 1;
  await record(
    database,
    scope,
    {
      identity: `said-${said}`,
      text: items.map((item) => `${item.content}.`).join(' '),
      eventAt: new Date(Date.UTC(2026, 8, 1) + said * 60_000).toISOString(),
    },
    items.map((item) => ({
      key: item.key,
      content: item.content,
      quote: item.content,
      kind: item.kind ?? 'user_statement',
      unkeyed: !item.key.startsWith('pref.'),
    })),
  );
}

/** Newer preferences than anything that matters to the question, as a busy memory has. */
const PREFERENCES = [
  'Focus this month is the launch',
  'Check-ins should be short',
  'Prefers morning meetings',
  'Likes bullet points',
  'Writes in British English',
  'Prefers dark mode',
  'Keeps receipts in Drive',
  'Prefers window seats on trains',
  'Likes jazz while working',
  'Prefers tea in the afternoon',
  'Uses metric units',
  'Prefers short summaries',
].map((content, index) => ({ key: `pref.misc.p${index}`, content, kind: 'preference' as Kind }));

const failing: EmbeddingProvider = {
  model: 'scripted/down',
  version: '1',
  dimensions: 3,
  recipe: 'scripted-v1',
  async embed() {
    throw new MemoryError('embedding_provider_failed');
  },
};

const scopeFor = (database: TestDatabase, scope: MemoryScope) => async (jobId: string) => {
  const [job] = await database.sql`select space_id from job where id = ${jobId}`;
  if (job?.space_id !== scope.spaceId) throw new MemoryError('scope_denied');
  return scope;
};

async function chat(scope: MemoryScope) {
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

/** A message the person typed, as the chat surface records it. */
async function say(database: TestDatabase, scope: MemoryScope, jobId: string, text: string) {
  const payload = { kind: 'user_message', text, principal_id: scope.ownerId };
  const [row] = await database.sql`insert into event (job_id, type, payload, dedup_key)
    values (${jobId}, 'notice', ${JSON.stringify(payload)}::text::jsonb, ${`evt:${newId('turn')}`})
    returning created_at`;
  return { role: 'user' as const, content: text, at: new Date(row?.created_at).toISOString() };
}

function bundleFor(
  jobId: string,
  attemptId: string,
  epoch: number,
  revision: number,
  message: { content: string; at: string },
) {
  return attemptBundle.parse({
    attempt: { id: attemptId, job_id: jobId, epoch, revision, token: 'fixture-only' },
    job: {
      title: 'New chat',
      objective: 'New chat',
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
      deliverable: {},
    },
    inputs: {
      new_user_messages: [{ role: 'user', content: message.content, at: message.at }],
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
  });
}

/** What an attempt in this chat is handed for this message, through the memory wrapper, and how long it took. */
async function attempt(
  database: TestDatabase,
  scope: MemoryScope,
  jobId: string,
  message: { content: string; at: string },
) {
  const [job] = await database.sql`update job set lease_epoch = lease_epoch + 1
    where id = ${jobId} returning revision, lease_epoch`;
  const attemptId = newId('att');
  await database.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${jobId}, ${job?.lease_epoch}, 'scripted-v1', 'fake', 'fake-scripted-v1')`;
  let handed: AttemptBundle | null = null;
  const runtime = {
    async capabilities() {
      return { version: 'scripted-v1', tools: false, streaming: true, interrupt: true };
    },
    async start(bundle: AttemptBundle) {
      handed = structuredClone(bundle);
      return { kind: 'completed' as const, summary: 'Done.', evidence: [] };
    },
  };
  const started = Date.now();
  await withMemoryRuntime(runtime, database.sql, scopeFor(database, scope)).start(
    bundleFor(jobId, attemptId, Number(job?.lease_epoch), Number(job?.revision), message),
    { async emit() {} },
    new AbortController().signal,
  );
  if (!handed) throw new Error('the runtime was not started');
  return { bundle: handed as AttemptBundle, ms: Date.now() - started };
}

const contents = (items: { content: string }[]) => items.map((item) => item.content);

withDb('recall answers this message', () => {
  test('the oyster case: the allergy and the sister come back, whatever came later and with no embedder', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await details(db, scope, [
      { key: 'pref.food.allergy', content: 'Allergic to shellfish', kind: 'preference' },
    ]);
    await details(db, scope, [
      { key: 'family.sister.city', content: 'My sister Lena moved to Seattle' },
      { key: 'family.sister.birthday', content: "My sister Lena's birthday is March 3" },
    ]);
    await details(db, scope, PREFERENCES);
    await buildViews(db.sql, scope);
    for (const embedding of [undefined, failing]) {
      const options = {
        includeProfile: true,
        ...(embedding ? { embedding, onError: () => {} } : {}),
      };
      const dinner = await recall(
        db.sql,
        scope,
        { query: 'Where should we go for a seafood dinner tonight? Oysters maybe?' },
        options,
      );
      // The allergy comes first, before anything else.
      expect(dinner.items[0]?.content).toBe('Allergic to shellfish');
      const sister = await recall(
        db.sql,
        scope,
        { query: "When is my sister's birthday, and where does she live now?" },
        options,
      );
      expect(contents(sister.items)).toEqual(
        expect.arrayContaining([
          'My sister Lena moved to Seattle',
          "My sister Lena's birthday is March 3",
        ]),
      );
      // The answer comes before the newest preferences, and a few of them still come.
      expect(contents(sister.items).slice(0, 3)).toEqual(
        expect.arrayContaining(['My sister Lena moved to Seattle']),
      );
      expect(
        sister.items.filter((item) => item.key?.startsWith('pref.misc')).length,
      ).toBeGreaterThan(0);
      expect(sister.items.length).toBeLessThanOrEqual(10);
    }
  });

  test('saying the allergy, with a correction beside it, is not a health conversation', () => {
    expect(
      classify(
        'I have a shellfish allergy, you just told me oysters are the safer bet?! Also Lena moved to Seattle',
        ['health', 'therapy', 'finance'],
      ),
    ).toBeNull();
    // A diagnosis still is.
    expect(classify('I was diagnosed with celiac disease last year', ['health'])).toBe('health');
  });
});

withDb('a request to forget', () => {
  test('is acted on, and the agent is told only what memory did', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
    const journal = await createJournal();
    try {
      await details(db, scope, [
        { key: 'health.allergy.shellfish', content: 'The user is allergic to shellfish' },
      ]);
      await buildViews(db.sql, scope);
      const capture = {
        privacyOrigin: async () => null,
        sql: db.sql,
        journal: journal.journal,
        scopeForJob: scopeFor(db, owner),
      };
      const job = await chat(scope);
      const bundle = (message: { content: string; at: string }) =>
        ({
          attempt: { job_id: job },
          inputs: { new_user_messages: [{ role: 'user' as const, ...message }] },
        }) as unknown as Pick<AttemptBundle, 'attempt' | 'inputs'>;

      // Not acted on yet: the agent is told it has not been done.
      const early = await say(db, scope, job, 'Please forget my shellfish allergy entirely');
      expect(await forgetOutcomeNote(db.sql, bundle(early), 300)).toBe(FORGET_NOTES.unconfirmed);

      // Acted on: the extra words do not stop it matching, and the detail is gone.
      await captureChat(capture);
      const left = await db.sql`select 1 from memory_claims
        where space_id = ${scope.spaceId} and not hidden and domain_key = 'health.allergy.shellfish'`;
      expect(left).toHaveLength(0);
      expect(await forgetOutcomeNote(db.sql, bundle(early), 300)).toBe(FORGET_NOTES.forgot);

      // Nothing matches: the agent is told nothing was forgotten.
      const none = await say(db, scope, job, "Please forget my cat's name");
      await captureChat(capture);
      expect(await forgetOutcomeNote(db.sql, bundle(none), 300)).toBe(FORGET_NOTES.none);

      // The agent's own brief carries memory's answer.
      const handed = await attempt(db, scope, job, none);
      expect(handed.bundle.job.objective).toContain(FORGET_NOTES.none);
      // Any other message carries no note.
      const plain = await say(db, scope, job, 'What should I cook tonight?');
      expect(await forgetOutcomeNote(db.sql, bundle(plain), 300)).toBeNull();
    } finally {
      await journal.close();
    }
  });
});

withDb('a greeting with a large memory', () => {
  test('recalls no old details to act on, and stays fast', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await details(db, scope, [
      {
        key: 'file.p_b_note',
        content: 'The file p-b-note.txt should contain the line: hello from B',
      },
    ]);
    for (let batch = 0; batch < 16; batch++)
      await details(
        db,
        scope,
        Array.from({ length: 25 }, (_, index) => ({
          key: `note.batch${batch}.item${index}`,
          content: `New chat note ${batch}-${index} about project ${batch * 25 + index}`,
        })),
      );
    await details(db, scope, [
      { key: 'pref.food.allergy', content: 'Allergic to shellfish', kind: 'preference' },
    ]);
    await buildViews(db.sql, scope);
    const job = await chat(scope);
    const hi = await say(db, scope, job, 'hi');
    const handed = await attempt(db, scope, job, hi);
    const excerpts = handed.bundle.knowledge.map((item) => item.excerpt).join('\n');
    expect(excerpts).not.toContain('p-b-note');
    // Nothing matched by the chat's title: only the profile and the safety details.
    expect(excerpts).not.toContain('New chat note');
    expect(excerpts).toContain('Allergic to shellfish');
    expect(handed.ms).toBeLessThan(5000);
    // A real question is still answered from the same memory.
    const asked = await say(db, scope, job, 'What did I note about project 123?');
    const answered = await attempt(db, scope, job, asked);
    expect(answered.bundle.knowledge.map((item) => item.excerpt).join('\n')).toContain(
      'project 123',
    );
  }, 120_000);
});
