import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { usageFixture } from './usage-fixture.ts';
import { YourUsageView } from './YourUsage.tsx';
import {
  backgroundCapLine,
  capBanner,
  capRows,
  chartSummary,
  duration,
  kindRows,
  money,
  monthBars,
  shareUsed,
  whenRan,
} from './your-usage.ts';

const now = new Date('2026-10-13T15:00:00Z');

test('money reads as dollars, and a sliver says so', () => {
  expect(money(0)).toBe('$0.00');
  expect(money(0.004)).toBe('under $0.01');
  expect(money(16.4)).toBe('$16.40');
});

test('a period against its limit: the further along of dollars and tokens', () => {
  expect(shareUsed({ usd: 5, tokens: 0 }, { usd: 10, tokens: null })).toBe(0.5);
  expect(shareUsed({ usd: 1, tokens: 900 }, { usd: 10, tokens: 1000 })).toBe(0.9);
  expect(shareUsed({ usd: 1, tokens: 1 }, { usd: null, tokens: null })).toBeNull();
});

test('with limits, each period shows its share, its tone and when it starts again', () => {
  const [month, day] = capRows(usageFixture(), now, 'UTC');
  expect(month).toMatchObject({
    label: 'This month',
    spent: '$16.40',
    limit: 'of $20.00',
    tone: 'near',
    resets: 'Starts again on November 1',
  });
  expect(month?.share).toBeCloseTo(0.82, 9);
  expect(day).toMatchObject({
    label: 'Today',
    limit: 'of $2.00',
    tone: 'calm',
    resets: 'Starts again tomorrow at 12:00 AM',
  });
  const reached = capRows(
    usageFixture({ spent: { month: { usd: 20, tokens: 0 }, day: { usd: 0, tokens: 0 } } }),
    now,
    'UTC',
  );
  expect(reached[0]?.tone).toBe('reached');
  expect(backgroundCapLine(usageFixture())).toBe('$1.20 of $5.00 this month');
});

test('a limit in tokens alone is read against the tokens spent, in the same units', () => {
  const tokens = usageFixture({
    spent: { month: { usd: 4.2, tokens: 123_456 }, day: { usd: 0.3, tokens: 800 } },
    caps: {
      month: { usd: null, tokens: 500_000 },
      day: { usd: null, tokens: 50_000 },
      background: null,
    },
  });
  expect(capRows(tokens, now, 'UTC').map((row) => [row.spent, row.limit])).toEqual([
    ['123k', 'of 500k tokens'],
    ['800', 'of 50k tokens'],
  ]);
  // With a dollar limit as well, both read in dollars.
  const both = usageFixture({
    caps: {
      month: { usd: 20, tokens: 500_000 },
      day: { usd: null, tokens: null },
      background: null,
    },
  });
  expect(capRows(both, now, 'UTC')[0]).toMatchObject({ spent: '$16.40', limit: 'of $20.00' });
});

test('without limits it is spending alone', () => {
  const open = usageFixture({ caps: null });
  expect(capRows(open, now, 'UTC').map((row) => [row.spent, row.limit, row.share])).toEqual([
    ['$16.40', null, null],
    ['$0.30', null, null],
  ]);
  expect(backgroundCapLine(open)).toBeNull();
  const html = renderToStaticMarkup(<YourUsageView data={open} now={now} />);
  expect(html).toContain('Your spending');
  expect(html).not.toContain('role="meter"');
  expect(html).not.toContain(' of $');
});

test('the chart has a bar for every day of the month, the days to come left empty', () => {
  const bars = monthBars(usageFixture());
  expect(bars).toHaveLength(31);
  expect(bars[4]).toMatchObject({ day: '2026-10-05', label: 'Oct 5', total: 1.2, later: false });
  expect(bars[4]?.chats).toBeCloseTo(1, 9);
  expect(bars[4]?.background).toBeCloseTo(0.2, 9);
  expect(bars[12]?.later).toBe(false);
  expect(bars[13]?.later).toBe(true);
  expect(chartSummary(bars)).toBe(
    'Spending each day this month: $2.70 in all, most on Oct 5 at $1.20.',
  );
  expect(chartSummary(monthBars({ ...usageFixture(), days: [] }))).toBe(
    'No spending yet this month.',
  );
  // February has its own length.
  expect(monthBars({ month_start: '2027-02-01T00:00:00.000Z', days: [] })).toHaveLength(28);
});

test('where it went: chats, background work, and computer time when there was some', () => {
  const rows = kindRows(usageFixture());
  expect(rows.map((row) => [row.label, row.value])).toEqual([
    ['Chats', '$15.20'],
    ['Routines and background', '$1.20'],
  ]);
  expect(rows[0]?.note).toBe('40 model calls while you waited');
  const withComputer = kindRows(usageFixture({ computer_seconds: 8100 }));
  expect(withComputer.at(-1)).toMatchObject({ label: 'Computer time', value: '2h 15m' });
  expect(duration(30)).toBe('under a minute');
  expect(duration(2400)).toBe('40m');
  expect(duration(7200)).toBe('2h');
});

test('recent work opens its chat, and work without one is not a link', () => {
  expect(whenRan('2026-10-13T14:10:00Z', now, 'UTC')).toBe('Today, 2:10 PM');
  expect(whenRan('2026-10-11T09:30:00Z', now, 'UTC')).toBe('Oct 11, 9:30 AM');
  const html = renderToStaticMarkup(<YourUsageView data={usageFixture()} now={now} />);
  expect(html).toContain('href="#/chat/job_1"');
  expect(html).not.toContain('href="#/chat/null"');
  expect(html).toContain('data-tone="settled"');
  expect(html).toContain('>Done<');
  expect(html).toContain('>Failed<');
  expect(html).toContain('under $0.01');
  expect(html).toContain('in the background');
  expect(html).toContain('aria-valuenow="82"');
  const empty = renderToStaticMarkup(<YourUsageView data={usageFixture({ runs: [] })} now={now} />);
  expect(empty).toContain('Nothing yet this month.');
});

test('the chat banner: nothing below 80%, a calm line with the reset time, then reached', () => {
  expect(capBanner(null, now, 'UTC')).toBeNull();
  expect(capBanner(undefined, now, 'UTC')).toBeNull();
  expect(
    capBanner(
      {
        level: 'warning',
        period: 'month',
        scope: 'person',
        message: "You have used 84% of this month's model allowance.",
        resets_at: '2026-11-01T00:00:00.000Z',
      },
      now,
      'UTC',
    ),
  ).toEqual({
    level: 'warning',
    text: "You have used 84% of this month's model allowance. It starts again on November 1.",
  });
  expect(
    capBanner(
      {
        level: 'warning',
        period: 'day',
        scope: 'person',
        message: "You have used 90% of today's model allowance.",
        resets_at: '2026-10-14T00:00:00.000Z',
      },
      now,
      'America/Los_Angeles',
    )?.text,
  ).toBe("You have used 90% of today's model allowance. It starts again today at 5:00 PM.");
  // A reached limit's own sentence already says when it starts again.
  expect(
    capBanner(
      {
        level: 'reached',
        period: 'month',
        scope: 'person',
        message: "This month's limit is reached; it resets on November 1.",
        resets_at: '2026-11-01T00:00:00.000Z',
      },
      now,
      'UTC',
    ),
  ).toEqual({ level: 'reached', text: "This month's limit is reached; it resets on November 1." });
});
