import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { NO_OWN_CAPS, type PersonCaps, PersonLimitStore } from './person-limits.ts';

type Row = { principal_id: string } & PersonCaps;

/**
 * A stand-in for the database: writes land at once, and each read answers
 * with the rows as they were when it began, only when the test lets it.
 */
function database() {
  let rows: Row[] = [];
  const reads: Array<() => void> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.startsWith('select')) {
      const snapshot = rows.map((row) => ({ ...row }));
      return new Promise((resolve) => reads.push(() => resolve(snapshot)));
    }
    const [principal] = values as [string];
    rows = rows.filter((row) => row.principal_id !== principal);
    if (text.startsWith('insert')) {
      const [, day_usd, month_usd, background_day_usd, background_month_usd] = values as [
        string,
        number | null,
        number | null,
        number | null,
        number | null,
      ];
      rows.push({
        principal_id: principal,
        day_usd,
        month_usd,
        background_day_usd,
        background_month_usd,
      });
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  return {
    sql,
    /** Lets every read begun so far answer. */
    answer: () => {
      for (const read of reads.splice(0)) read();
    },
  };
}

test('a cap set while an older read is still out is seen at once', async () => {
  const db = database();
  const store = new PersonLimitStore(db.sql);
  // A read begins before the owner's change.
  const before = store.of('own_ann');
  const caps: PersonCaps = { ...NO_OWN_CAPS, day_usd: 5 };
  await store.set(db.sql, 'own_ann', caps);
  // The next read must not take the older one's answer, nor be cached from it.
  const after = store.of('own_ann');
  db.answer();
  expect(await before).toEqual(NO_OWN_CAPS);
  db.answer();
  expect(await after).toEqual(caps);
  const later = store.of('own_ann');
  db.answer();
  expect(await later).toEqual(caps);
});

test('reads side by side share one query, and the answer is kept for a moment', async () => {
  const db = database();
  let now = 0;
  const store = new PersonLimitStore(db.sql, () => now);
  await store.set(db.sql, 'own_ann', { ...NO_OWN_CAPS, month_usd: 20 });
  const both = Promise.all([store.of('own_ann'), store.any()]);
  db.answer();
  expect(await both).toEqual([{ ...NO_OWN_CAPS, month_usd: 20 }, true]);
  // Cached: answered with no read.
  now = 4_000;
  expect(await store.of('own_ann')).toEqual({ ...NO_OWN_CAPS, month_usd: 20 });
});
