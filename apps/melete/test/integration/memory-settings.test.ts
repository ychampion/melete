/**
 * What Settings lists: every detail memory is using, a disputed one included,
 * however many there are.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { ExperienceMemory } from '../../src/experience/memory.ts';
import { newId } from '../../src/ids.ts';
import { createScope, createTestDatabase } from './postgres.ts';
import { record } from './properties-fixtures.ts';

const db = await createTestDatabase();
afterAll(async () => {
  await db?.close();
});
const withDb = db ? describe : describe.skip;

type Listed = { items: { id: string; key: string; value: string }[]; next?: string | null };

withDb('saved details in Settings', () => {
  test('a disputed detail is listed, since it is still what memory uses', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const said = (identity: string, day: string, value: string) =>
      record(
        db,
        scope,
        { identity, text: `The offsite is on ${value}.`, eventAt: `2026-08-${day}T09:00:00Z` },
        [{ key: 'event.offsite.date', content: value, quote: value, kind: 'user_statement' }],
      );
    await said('first', '01', '9 September 2026');
    // A later statement with no explicit correction disputes the key.
    await said('second', '03', '16 September 2026');
    const [row] =
      await db.sql`select r.status from memory_claims c join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
      where c.space_id = ${scope.spaceId} and c.key = 'event.offsite.date'`;
    expect(row?.status).toBe('disputed');
    const listed = (await new ExperienceMemory(db.sql).list(
      scope.spaceId,
      scope.ownerId,
    )) as Listed;
    expect(listed.items.map((item) => item.value)).toEqual(['16 September 2026']);
  });

  test('details past the first page are reached by following next', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const total = 205;
    // One detail recorded as a conversation records it, and the rest copied
    // from it in one insert per table, each cited by the same message.
    const result = await record(
      db,
      scope,
      { identity: 'habits', text: 'Habit 0 is value0.', eventAt: '2026-08-01T09:00:00Z' },
      [{ key: 'pref.habits.h0', content: 'value0', quote: 'value0', kind: 'preference' }],
    );
    expect(result.status).toBe('committed');
    const [seed] = await db.sql`select id from memory_claims
      where space_id = ${scope.spaceId} and key = 'pref.habits.h0'`;
    const id = String(seed?.id);
    const copies = Array.from({ length: total - 1 }, () => newId('k'));
    await db.sql`insert into memory_claims (id, space_id, domain_key, key, audience, head_revision)
      select x.id, c.space_id, 'pref.habits.h' || x.n, 'pref.habits.h' || x.n, c.audience, c.head_revision
      from memory_claims c, unnest(${copies}::text[]) with ordinality x(id, n) where c.id = ${id}`;
    await db.sql`insert into memory_revisions
      (claim_id, revision, kind, factual_status, status, valid_from, data_revision, origin_trust)
      select x.id, r.revision, r.kind, r.factual_status, r.status, r.valid_from, r.data_revision,
        r.origin_trust
      from memory_revisions r, unnest(${copies}::text[]) x(id) where r.claim_id = ${id}`;
    await db.sql`insert into memory_revision_content (claim_id, revision, content)
      select x.id, r.revision, 'value' || x.n
      from memory_revision_content r, unnest(${copies}::text[]) with ordinality x(id, n)
      where r.claim_id = ${id}`;
    await db.sql`insert into memory_references (claim_id, revision, source_id, source_version, start, "end")
      select x.id, r.revision, r.source_id, r.source_version, r.start, r."end"
      from memory_references r, unnest(${copies}::text[]) x(id) where r.claim_id = ${id}`;
    const memory = new ExperienceMemory(db.sql);
    const first = (await memory.list(scope.spaceId, scope.ownerId)) as Listed;
    expect(first.items).toHaveLength(200);
    expect(first.next).toBeTruthy();
    const second = (await memory.list(scope.spaceId, scope.ownerId, first.next ?? null)) as Listed;
    expect(second.items).toHaveLength(total - 200);
    expect(second.next).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((item) => item.id));
    expect(ids.size).toBe(total);
  });
});
