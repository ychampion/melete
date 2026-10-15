import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { SpendLimitStore } from './spend-limits.ts';
import { NO_LIMIT, SpendingGuard } from './spending.ts';

const NOW = new Date('2026-10-15T12:00:00Z');
const nothing = { usd: 0, tokens: 0 };

test('a monthly limit of $0 is reached before anything is spent', () => {
  const guard = new SpendingGuard(
    (() => Promise.resolve([])) as unknown as Sql,
    {
      installation: { day: NO_LIMIT, month: NO_LIMIT },
      person: { day: NO_LIMIT, month: NO_LIMIT },
      noticePercent: 80,
    },
    undefined,
    () => NOW,
  );
  const totals = {
    installation: { month: nothing, day: nothing },
    person: { month: nothing, day: nothing },
    background: null,
  };
  expect(guard.noticeFor(totals, NOW, true, 0)).toMatchObject({
    level: 'reached',
    scope: 'person',
    message:
      'You have reached your monthly limit of $0.00; it resets on November 1. The person who runs this Melete can raise it.',
  });
  // With no limit of their own, nothing is reached.
  expect(guard.noticeFor(totals, NOW, true)).toBeNull();
});

test('a limit set while the limits are being read is not lost to that older read', async () => {
  const reads: ((rows: unknown[]) => void)[] = [];
  const sql = ((strings: TemplateStringsArray) =>
    strings.join('').startsWith('select')
      ? new Promise((resolve) => reads.push(resolve))
      : Promise.resolve([])) as unknown as Sql;
  const store = new SpendLimitStore(sql, () => NOW);
  const before = store.all();
  await store.set('member', 'p_1', 5, null);
  // The read begun before the change answers with the table as it was then.
  reads.shift()?.([]);
  expect((await before).member.size).toBe(0);
  // The next read goes to the table again rather than reusing that older answer.
  const after = store.all();
  expect(reads).toHaveLength(1);
  reads.shift()?.([{ kind: 'member', target_id: 'p_1', monthly_usd: 5 }]);
  expect((await after).member.get('p_1')).toBe(5);
});
