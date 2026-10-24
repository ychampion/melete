import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { NO_LIMIT, SpendingGuard, type SpendingLimits } from '../gateway/spending.ts';
import { runOutcome, runThread } from './my-usage.ts';

test('how a piece of work ended reads from its latest turn first, then from its job', () => {
  expect(runOutcome('done', 'running')).toBe('done');
  expect(runOutcome('idle', 'waiting_for_event_or_time')).toBe('done');
  expect(runOutcome('needs_you', 'running')).toBe('needs_you');
  expect(runOutcome('paused', 'running')).toBe('needs_you');
  expect(runOutcome('failed', 'completed')).toBe('failed');
  expect(runOutcome('stopped', 'running')).toBe('failed');
  expect(runOutcome('streaming', 'running')).toBe('working');
  expect(runOutcome(null, 'completed')).toBe('done');
  expect(runOutcome(null, 'cancelled')).toBe('failed');
  expect(runOutcome(null, 'failed')).toBe('failed');
  expect(runOutcome(null, 'waiting_for_approval')).toBe('needs_you');
  expect(runOutcome(null, 'needs_reconciliation')).toBe('needs_you');
  expect(runOutcome(null, 'queued')).toBe('working');
  expect(runOutcome(null, 'waiting_for_event_or_time')).toBe('working');
});

test('a piece of work opens its own thread, else the chat that started it, else none', () => {
  const row = { id: 'j1', parent_id: null, parent_kind: null };
  expect(runThread({ ...row, kind: 'chat' })).toBe('j1');
  expect(runThread({ ...row, kind: 'routine' })).toBe('j1');
  expect(runThread({ ...row, kind: 'command', parent_id: 'c1', parent_kind: 'chat' })).toBe('c1');
  expect(
    runThread({ ...row, kind: 'command', parent_id: 'job_watch', parent_kind: 'watch' }),
  ).toBeNull();
  expect(runThread({ ...row, kind: 'watch' })).toBeNull();
});

const limits: SpendingLimits = {
  installation: { day: NO_LIMIT, month: { usd: 1000, tokens: null } },
  person: { day: { usd: 2, tokens: null }, month: { usd: 20, tokens: 1_000_000 } },
  noticePercent: 80,
};
// The thresholds are read from totals alone; no query is made.
const guard = new SpendingGuard({} as Sql, limits);
const now = new Date('2026-10-13T15:00:00Z');
const totals = (month: number, day = 0, tokens = 0) => ({
  installation: { month: { usd: 0, tokens: 0 }, day: { usd: 0, tokens: 0 } },
  person: { month: { usd: month, tokens }, day: { usd: day, tokens: 0 } },
  background: null,
});

test('the banner comes at 80% of a limit, and turns to reached at 100%', () => {
  expect(guard.noticeFor(totals(15.98), now, false)).toBeNull();
  expect(guard.noticeFor(totals(16), now, false)).toMatchObject({
    level: 'warning',
    period: 'month',
    scope: 'person',
    message: "You have used 80% of this month's model allowance.",
    resets_at: '2026-11-01T00:00:00.000Z',
  });
  expect(guard.noticeFor(totals(19.99), now, false)?.level).toBe('warning');
  expect(guard.noticeFor(totals(20), now, false)).toMatchObject({
    level: 'reached',
    message: "This month's limit is reached; it resets on November 1.",
  });
  // Tokens count as well as dollars: the further along of the two.
  expect(guard.noticeFor(totals(1, 0, 850_000), now, false)?.message).toBe(
    "You have used 85% of this month's model allowance.",
  );
  // The day's limit, with its own reset; a reached day outranks a month's warning.
  expect(guard.noticeFor(totals(16, 2), now, false)).toMatchObject({
    level: 'reached',
    period: 'day',
    resets_at: '2026-10-14T00:00:00.000Z',
  });
});
