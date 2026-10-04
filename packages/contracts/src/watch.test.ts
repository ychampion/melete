import { describe, expect, test } from 'bun:test';
import {
  evaluateWatch,
  evaluateWatchClause,
  MAX_WATCH_CLAUSES,
  readWatchField,
  WATCH_OPERATORS,
  watchClause,
  watchPredicate,
  watchPredicateProblem,
} from './watch.ts';

const clause = (field: string, op: string, value: unknown = null) =>
  watchClause.parse({ field, op, value });

describe('reading a field out of an observation', () => {
  const observation = {
    subject: 'Invoice 7731 is overdue',
    from: { address: 'billing@example.test', name: 'Billing' },
    amount: 240.5,
    unread: true,
    labels: ['finance', 'urgent'],
    received_at: '2026-09-11T09:00:00.000Z',
  };

  test('walks a dotted path', () => {
    expect(readWatchField(observation, 'subject')).toBe('Invoice 7731 is overdue');
    expect(readWatchField(observation, 'from.address')).toBe('billing@example.test');
  });

  test('a missing field is undefined, not an error', () => {
    expect(readWatchField(observation, 'nowhere')).toBeUndefined();
    expect(readWatchField(observation, 'from.nowhere.deeper')).toBeUndefined();
  });

  test('an array in the middle of a path stops the walk', () => {
    expect(readWatchField(observation, 'labels.0')).toBeUndefined();
  });
});

describe('one clause', () => {
  const observation = {
    subject: 'Invoice 7731 is overdue',
    from: { address: 'billing@example.test' },
    amount: 240.5,
    unread: true,
    labels: ['finance', 'urgent'],
    received_at: '2026-09-11T09:00:00.000Z',
  };

  test('eq compares exactly', () => {
    expect(
      evaluateWatchClause(clause('from.address', 'eq', 'billing@example.test'), observation),
    ).toBe(true);
    expect(
      evaluateWatchClause(clause('from.address', 'eq', 'Billing@Example.test'), observation),
    ).toBe(false);
    expect(evaluateWatchClause(clause('unread', 'eq', true), observation)).toBe(true);
    expect(evaluateWatchClause(clause('amount', 'eq', 240.5), observation)).toBe(true);
  });

  test('contains works on text and on a list', () => {
    expect(evaluateWatchClause(clause('subject', 'contains', 'overdue'), observation)).toBe(true);
    expect(evaluateWatchClause(clause('subject', 'contains', 'paid'), observation)).toBe(false);
    expect(evaluateWatchClause(clause('labels', 'contains', 'urgent'), observation)).toBe(true);
    expect(evaluateWatchClause(clause('labels', 'contains', 'holiday'), observation)).toBe(false);
  });

  test('matches is a regular expression, and a broken one never matches', () => {
    expect(evaluateWatchClause(clause('subject', 'matches', '^Invoice \\d+'), observation)).toBe(
      true,
    );
    expect(evaluateWatchClause(clause('subject', 'matches', '^Receipt'), observation)).toBe(false);
    expect(evaluateWatchClause(clause('subject', 'matches', '('), observation)).toBe(false);
  });

  test('lt and gt compare numbers, and timestamps as timestamps', () => {
    expect(evaluateWatchClause(clause('amount', 'gt', 200), observation)).toBe(true);
    expect(evaluateWatchClause(clause('amount', 'lt', 200), observation)).toBe(false);
    expect(
      evaluateWatchClause(clause('received_at', 'gt', '2026-09-10T00:00:00.000Z'), observation),
    ).toBe(true);
    expect(
      evaluateWatchClause(clause('received_at', 'lt', '2026-09-10T00:00:00.000Z'), observation),
    ).toBe(false);
  });

  test('a comparison between things that are not comparable is false, not an error', () => {
    expect(evaluateWatchClause(clause('subject', 'gt', 3), observation)).toBe(false);
    expect(evaluateWatchClause(clause('unread', 'lt', 3), observation)).toBe(false);
    expect(evaluateWatchClause(clause('nowhere', 'eq', 'anything'), observation)).toBe(false);
    expect(evaluateWatchClause(clause('amount', 'contains', 'finance'), observation)).toBe(false);
  });

  test('changed needs something to compare against', () => {
    const later = { ...observation, amount: 300 };
    expect(evaluateWatchClause(clause('amount', 'changed'), later, observation)).toBe(true);
    expect(evaluateWatchClause(clause('amount', 'changed'), observation, observation)).toBe(false);
    // A first sighting is not evidence of a change.
    expect(evaluateWatchClause(clause('amount', 'changed'), observation, null)).toBe(false);
  });

  test('a field that appears is a change; so is one that disappears', () => {
    expect(evaluateWatchClause(clause('status', 'changed'), { status: 'open' }, { other: 1 })).toBe(
      true,
    );
    expect(evaluateWatchClause(clause('status', 'changed'), { other: 1 }, { status: 'open' })).toBe(
      true,
    );
  });
});

describe('a whole predicate', () => {
  const overdue = watchPredicate.parse({
    all: [
      { field: 'from.address', op: 'eq', value: 'billing@example.test' },
      { field: 'subject', op: 'contains', value: 'overdue' },
      { field: 'amount', op: 'gt', value: 100 },
    ],
  });

  test('every clause has to hold', () => {
    const matching = {
      from: { address: 'billing@example.test' },
      subject: 'Invoice 7731 is overdue',
      amount: 240.5,
    };
    expect(evaluateWatch(overdue, matching)).toBe(true);
    expect(evaluateWatch(overdue, { ...matching, amount: 40 })).toBe(false);
    expect(evaluateWatch(overdue, { ...matching, subject: 'Invoice 7731' })).toBe(false);
    expect(evaluateWatch(overdue, { ...matching, from: { address: 'someone@else.test' } })).toBe(
      false,
    );
  });

  test('an empty observation matches nothing', () => {
    expect(evaluateWatch(overdue, {})).toBe(false);
  });

  test('the language is small on purpose: at most five clauses, and one or group', () => {
    expect(MAX_WATCH_CLAUSES).toBe(5);
    const six = Array.from({ length: 6 }, () => ({ field: 'a', op: 'eq', value: 1 }));
    expect(() => watchPredicate.parse({ all: six })).toThrow();
    expect(() => watchPredicate.parse({ all: [] })).toThrow();
    const three = six.slice(0, 3);
    expect(() => watchPredicate.parse({ all: three, any: three })).toThrow();
    expect(() => watchPredicate.parse({ any: six.slice(0, 1) })).toThrow();
    expect(watchPredicate.parse({ any: six.slice(0, 2) }).all).toEqual([]);
    expect(() => watchClause.parse({ field: 'a', op: 'startsWith', value: 'x' })).toThrow();
    expect(() => watchClause.parse({ field: 'items[0]', op: 'eq', value: 1 })).toThrow();
  });

  test('evaluation is pure: the same inputs give the same answer', () => {
    const observation = {
      from: { address: 'billing@example.test' },
      subject: 'overdue',
      amount: 200,
    };
    expect(evaluateWatch(overdue, observation)).toBe(evaluateWatch(overdue, observation));
  });
});

test('nested repetition matches an adversarial observation within a bounded time', async () => {
  // Isolate the probe so a regression cannot block the test runner or its cleanup.
  const probe = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    const { evaluateWatchClause } = await import('./watch.ts');
    const start = performance.now();
    const matched = evaluateWatchClause(
      { field: 'text', op: 'matches', value: '^(a+)+$' },
      { text: 'a'.repeat(8191) + '!' },
    );
    console.log(JSON.stringify({ matched, elapsed: performance.now() - start }));
  `,
    ],
    { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    probe.kill();
  }, 5000);
  try {
    const exitCode = await probe.exited;
    expect(timedOut).toBe(false);
    expect(exitCode).toBe(0);
    const result = JSON.parse(await new Response(probe.stdout).text());
    expect(result.matched).toBe(false);
    expect(result.elapsed).toBeLessThan(500);
  } finally {
    clearTimeout(timer);
    if (probe.exitCode === null) probe.kill();
  }
}, 10000);

describe('time, either, and absence', () => {
  const now = Date.parse('2026-10-05T14:55:00.000Z');
  const meeting = { start: '2026-10-05T15:00:00.000Z', status: 'declined' };

  test('before and after compare a time with now plus seconds; older_than with now less them', () => {
    expect(evaluateWatchClause(clause('start', 'before', 600), meeting, null, { now })).toBe(true);
    expect(evaluateWatchClause(clause('start', 'before', 60), meeting, null, { now })).toBe(false);
    expect(evaluateWatchClause(clause('start', 'after', 60), meeting, null, { now })).toBe(true);
    expect(evaluateWatchClause(clause('start', 'after', -60), meeting, null, { now })).toBe(true);
    expect(evaluateWatchClause(clause('start', 'after', 600), meeting, null, { now })).toBe(false);
    const sent = { sent_at: '2026-10-01T14:55:00.000Z' };
    expect(
      evaluateWatchClause(clause('sent_at', 'older_than', 3 * 86_400), sent, null, { now }),
    ).toBe(true);
    expect(
      evaluateWatchClause(clause('sent_at', 'older_than', 5 * 86_400), sent, null, { now }),
    ).toBe(false);
  });

  test('a time clause with no clock, no time, or no whole number of seconds is false', () => {
    expect(evaluateWatchClause(clause('start', 'before', 600), meeting)).toBe(false);
    expect(evaluateWatchClause(clause('status', 'before', 600), meeting, null, { now })).toBe(
      false,
    );
    expect(evaluateWatchClause(clause('start', 'before', '600'), meeting, null, { now })).toBe(
      false,
    );
    expect(evaluateWatchClause(clause('start', 'before', 1.5), meeting, null, { now })).toBe(false);
    expect(
      evaluateWatchClause(clause('start', 'older_than', -1), { start: '2026-01-01' }, null, {
        now,
      }),
    ).toBe(false);
  });

  test('any holds when one of its clauses does, beside every clause in all', () => {
    const either = watchPredicate.parse({
      all: [{ field: 'start', op: 'before', value: 3600 }],
      any: [
        { field: 'status', op: 'eq', value: 'declined' },
        { field: 'status', op: 'eq', value: 'cancelled' },
      ],
    });
    expect(evaluateWatch(either, meeting, null, { now })).toBe(true);
    expect(evaluateWatch(either, { ...meeting, status: 'cancelled' }, null, { now })).toBe(true);
    expect(evaluateWatch(either, { ...meeting, status: 'accepted' }, null, { now })).toBe(false);
    expect(evaluateWatch(either, meeting, null, {})).toBe(false);
  });

  test('absent asks the clock what was seen, and nothing else can answer it', () => {
    const nothing = clause('mail.received', 'absent');
    expect(evaluateWatchClause(nothing, {}, null, { now, seen: () => false })).toBe(true);
    expect(evaluateWatchClause(nothing, {}, null, { now, seen: () => true })).toBe(false);
    expect(evaluateWatchClause(nothing, {}, null, { now })).toBe(false);
    let asked: number | null = -1;
    evaluateWatchClause(clause('mail.received', 'absent', 3600), {}, null, {
      now,
      seen: (_, since) => {
        asked = since;
        return false;
      },
    });
    expect(asked).toBe(now - 3_600_000);
  });

  test('a trigger may not use absent, and time clauses need whole seconds within a year', () => {
    expect(WATCH_OPERATORS).not.toContain('absent');
    const absent = watchPredicate.parse({ all: [{ field: 'mail.received', op: 'absent' }] });
    expect(watchPredicateProblem(absent, 'trigger')).toContain('absent');
    expect(watchPredicateProblem(absent, 'clock')).toBeNull();
    const far = watchPredicate.parse({
      all: [{ field: 'start', op: 'before', value: 400 * 86_400 }],
    });
    expect(watchPredicateProblem(far, 'trigger')).toContain('seconds');
    const text = watchPredicate.parse({ all: [{ field: 'start', op: 'after', value: 'soon' }] });
    expect(watchPredicateProblem(text, 'trigger')).toContain('seconds');
    const fine = watchPredicate.parse({ all: [{ field: 'start', op: 'before', value: -300 }] });
    expect(watchPredicateProblem(fine, 'trigger')).toBeNull();
  });
});
