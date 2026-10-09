/**
 * `memory.search`, against Postgres: the agent looks in memory before it says
 * it doesn't know something about the person.
 *
 * - A saved detail the turn's own recall did not bring is found by a search,
 *   however many newer preferences crowd the recall.
 * - A search reads under the attempt's own rules: a forgotten detail is gone,
 *   an agent set not to read memory and public research search nothing, and
 *   what came from a private conversation is never returned.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { ZodError } from 'zod';
import { openDatabase } from '../../src/db/client.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { MemoryError, type MemoryScope } from '../../src/memory/db.ts';
import { forgetMemory } from '../../src/memory/forget.ts';
import { recall } from '../../src/memory/recall.ts';
import { SEARCH_GUIDANCE, searchMemory } from '../../src/memory/search.ts';
import { buildViews } from '../../src/memory/views.ts';
import { principalContext } from '../../src/principals/authority.ts';
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
  return record(
    database,
    scope,
    {
      identity: `search-${said}`,
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

/** Newer than the birthday, and enough of them to fill a turn's recall. */
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

const scopeFor = (database: TestDatabase, scope: MemoryScope) => async (jobId: string) => {
  const [job] = await database.sql`select space_id from job where id = ${jobId}`;
  if (job?.space_id !== scope.spaceId) throw new MemoryError('scope_denied');
  return scope;
};

async function chat(_database: TestDatabase, scope: MemoryScope) {
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

withDb('memory.search', () => {
  test('finds a saved detail the turn did not recall, and nothing once it is forgotten', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const journal = await createJournal();
    try {
      await details(db, scope, [
        { key: 'pref.food.allergy', content: 'Allergic to shellfish', kind: 'preference' },
      ]);
      await details(db, scope, [
        { key: 'family.sister.city', content: 'My sister Lena moved to Seattle' },
      ]);
      await details(db, scope, [
        { key: 'family.sister.birthday', content: "My sister Lena's birthday is March 3" },
      ]);
      await details(db, scope, PREFERENCES);
      await buildViews(db.sql, scope);
      const job = await chat(db, scope);
      const options = { sql: db.sql, scopeForJob: scopeFor(db, scope) };

      // The turn was handed ten details recalled for its own words; a search reaches the rest.
      const turn = await recall(
        db.sql,
        scope,
        { job_id: job, query: 'Any good dinner spots near home this week?' },
        { includeProfile: true },
      );
      expect(turn.items.map((item) => item.content)).not.toContain(
        "My sister Lena's birthday is March 3",
      );

      // A search before denying it finds it.
      const found = await searchMemory(options, { job_id: job }, { query: "Lena's birthday" });
      expect(found.status).toBe('found');
      expect(found.details.map((item) => item.detail)).toContain(
        "My sister Lena's birthday is March 3",
      );
      expect(found.guidance).toBe(SEARCH_GUIDANCE.found);
      // A search names no profile or safety details it was not asked about.
      expect(found.details.map((item) => item.detail)).not.toContain('Prefers dark mode');

      // Forgotten: a search finds nothing, and is told not to say it was never told.
      const [claim] = await db.sql`select id from memory_claims
        where space_id = ${scope.spaceId} and domain_key = 'family.sister.birthday' and not hidden`;
      await forgetMemory(db.sql, scope, { claim_id: claim?.id }, journal.journal);
      const gone = await searchMemory(options, { job_id: job }, { query: "Lena's birthday" });
      expect(gone.details.map((item) => item.detail)).not.toContain(
        "My sister Lena's birthday is March 3",
      );
      const nothing = await searchMemory(
        options,
        { job_id: job },
        { query: 'birthday March 3 born' },
      );
      if (nothing.status === 'nothing_saved') {
        expect(nothing.guidance).toContain('never say they never told you');
      } else {
        expect(nothing.details.map((item) => item.detail)).not.toContain(
          "My sister Lena's birthday is March 3",
        );
      }
    } finally {
      await journal.close();
    }
  });

  test('searches nothing for an agent that does not read memory, or for public research', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await details(db, scope, [
      { key: 'family.sister.birthday', content: "My sister Lena's birthday is March 3" },
    ]);
    await buildViews(db.sql, scope);
    const options = { sql: db.sql, scopeForJob: scopeFor(db, scope) };

    const withheld = await chat(db, scope);
    const agentId = newId('agent');
    await db.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction, reads_memory)
      values (${agentId}, ${scope.spaceId}, 'Scout', 'assistant', 'blue', 'soft', 'dark', 'plain', '', false)`;
    await db.sql`update job set agent_id = ${agentId} where id = ${withheld}`;
    const refused = await searchMemory(options, { job_id: withheld }, { query: "Lena's birthday" });
    expect(refused).toEqual({
      status: 'not_available_here',
      details: [],
      notes: [],
      guidance: SEARCH_GUIDANCE.not_available_here,
    });

    const research = await chat(db, scope);
    await db.sql`update job set constraints = '{"public_compartment": true}'::jsonb where id = ${research}`;
    expect(
      (await searchMemory(options, { job_id: research }, { query: "Lena's birthday" })).status,
    ).toBe('not_available_here');

    // A job in another space reaches nothing, and says it could not check.
    const elsewhere = await chat(db, await createScope(db));
    expect(
      (await searchMemory(options, { job_id: elsewhere }, { query: "Lena's birthday" })).status,
    ).toBe('unavailable');
  });

  test('a detail learned in a private conversation is never returned', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const kept = await details(db, scope, [
      { key: 'health.condition', content: 'Lena has a heart condition' },
    ]);
    await db.sql`update memory_sources set private_origin = 'health' where id = ${kept.sourceId}`;
    await buildViews(db.sql, scope);
    const job = await chat(db, scope);
    const result = await searchMemory(
      { sql: db.sql, scopeForJob: scopeFor(db, scope) },
      { job_id: job },
      { query: 'Lena heart condition' },
    );
    expect(result.details.map((item) => item.detail)).not.toContain('Lena has a heart condition');
  });

  test('a search with no words is refused as bad arguments', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const job = await chat(db, scope);
    const options = { sql: db.sql, scopeForJob: scopeFor(db, scope) };
    await expect(searchMemory(options, { job_id: job }, { query: '   ' })).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(searchMemory(options, { job_id: job }, { q: 'x' })).rejects.toBeInstanceOf(
      ZodError,
    );
  });
});
