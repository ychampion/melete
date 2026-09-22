/**
 * Recall as a person using memory every day meets it: a request in their own
 * words finds what it needs, and preferences reach every attempt.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { MemoryScope } from '../../src/memory/db.ts';
import { recall } from '../../src/memory/recall.ts';
import { buildViews } from '../../src/memory/views.ts';
import { createScope, createTestDatabase } from './postgres.ts';
import { record } from './properties-fixtures.ts';

const db = await createTestDatabase();
afterAll(async () => {
  await db?.close();
});
const withDb = db ? describe : describe.skip;

withDb('recall for everyday requests', () => {
  test('a request phrased as a sentence recalls the fact it needs and not the others', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await record(
      db,
      scope,
      {
        identity: 'ana',
        text: "Ana's email is ana@studio.example.",
        eventAt: '2026-08-02T09:00:00Z',
      },
      [
        {
          key: 'contact.ana.email',
          content: 'ana@studio.example',
          quote: 'ana@studio.example',
          kind: 'user_statement',
        },
      ],
    );
    await record(
      db,
      scope,
      {
        identity: 'maya',
        text: "My sister Maya's number is +351 912 345 678.",
        eventAt: '2026-08-03T09:00:00Z',
      },
      [
        {
          key: 'contact.maya.phone',
          content: '+351 912 345 678',
          quote: '+351 912 345 678',
          kind: 'user_statement',
        },
      ],
    );
    await buildViews(db.sql, scope);
    const result = await recall(db.sql, scope, {
      query: "Email Ana the agenda for Thursday's meeting",
    });
    const keys = result.items.map((item) => item.key);
    expect(keys).toContain('contact.ana.email');
    expect(keys).not.toContain('contact.maya.phone');
  });

  const prefer = (
    db2: NonNullable<typeof db>,
    scope: MemoryScope,
    name: string,
    text: string,
    value: string,
    day: number,
  ) =>
    record(
      db2,
      scope,
      { identity: name, text, eventAt: `2026-08-${String(day).padStart(2, '0')}T09:00:00Z` },
      [{ key: `pref.habits.${name}`, content: value, quote: value, kind: 'preference' }],
    );
  const attemptKeys = async (db2: NonNullable<typeof db>, scope: MemoryScope, query: string) =>
    (await recall(db2.sql, scope, { query, max_tokens: 2000 }, { includeProfile: true })).items.map(
      (item) => item.key,
    );

  test('the four setup answers all reach an everyday request within the knowledge budget', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await prefer(db, scope, 'city', 'My home city is Lisbon.', 'Lisbon', 1);
    await prefer(
      db,
      scope,
      'people',
      'The people I talk about most are Ana and Maya.',
      'Ana and Maya',
      1,
    );
    await prefer(
      db,
      scope,
      'focus',
      'This month I am focused on the Atlas launch.',
      'the Atlas launch',
      1,
    );
    await prefer(
      db,
      scope,
      'checkins',
      'Check in with me briefly each morning.',
      'briefly each morning',
      1,
    );
    await buildViews(db.sql, scope);
    const keys = await attemptKeys(db, scope, 'Plan my week');
    for (const name of ['city', 'people', 'focus', 'checkins'])
      expect(keys).toContain(`pref.habits.${name}`);
  });

  test('a preference saved a moment ago reaches the next attempt before the views rebuild', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await prefer(db, scope, 'tone', 'Keep replies friendly but brief.', 'friendly but brief', 2);
    expect(await attemptKeys(db, scope, 'Draft a reply to the landlord')).toContain(
      'pref.habits.tone',
    );
  });

  test('the newest preferences are the ones every attempt carries', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const said = [
      'milk',
      'music',
      'lamp',
      'commute',
      'font',
      'coffee',
      'signature',
      'reminder',
      'meetings',
      'tone',
    ];
    for (const [i, name] of said.entries())
      await prefer(db, scope, name, `About ${name}: value ${name}.`, `value ${name}`, i + 1);
    await buildViews(db.sql, scope);
    const keys = await attemptKeys(db, scope, 'Plan my day');
    expect(keys).toContain('pref.habits.tone');
    expect(keys).toContain('pref.habits.meetings');
  });
});
