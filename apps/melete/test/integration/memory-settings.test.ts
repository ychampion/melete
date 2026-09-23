/**
 * What Settings lists: every detail memory is using, a disputed one included,
 * however many there are.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { ExperienceMemory } from '../../src/experience/memory.ts';
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
    for (let i = 0; i < total; i++)
      await record(
        db,
        scope,
        {
          identity: `habit-${i}`,
          text: `Habit ${i} is value${i}.`,
          eventAt: '2026-08-01T09:00:00Z',
        },
        [
          {
            key: `pref.habits.h${i}`,
            content: `value${i}`,
            quote: `value${i}`,
            kind: 'preference',
          },
        ],
      );
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
