/** A month of personal usage for the usage page's tests. */
import type { MyUsage } from './api.ts';

/** Thirteen days into October, with limits; `caps: null` makes it an installation without. */
export function usageFixture(overrides: Partial<MyUsage> = {}): MyUsage {
  const days = Array.from({ length: 13 }, (_, index) => ({
    day: `2026-10-${String(index + 1).padStart(2, '0')}`,
    usd: index === 4 ? 1.2 : index % 3 === 0 ? 0.3 : 0,
    background_usd: index === 4 ? 0.2 : 0,
    calls: index % 3 === 0 || index === 4 ? 4 : 0,
  }));
  return {
    month_start: '2026-10-01T00:00:00.000Z',
    month_resets_at: '2026-11-01T00:00:00.000Z',
    day_resets_at: '2026-10-14T00:00:00.000Z',
    spent: { month: { usd: 16.4, tokens: 2_000_000 }, day: { usd: 0.3, tokens: 30_000 } },
    background_spent: { month: { usd: 1.2, tokens: 200_000 }, day: { usd: 0, tokens: 0 } },
    caps: {
      month: { usd: 20, tokens: null },
      day: { usd: 2, tokens: null },
      background: { month: { usd: 5, tokens: null }, day: { usd: null, tokens: null } },
    },
    notice: null,
    days,
    kinds: [
      { kind: 'chats', calls: 40, usd: 15.2, tokens: 1_800_000 },
      { kind: 'background', calls: 9, usd: 1.2, tokens: 200_000 },
    ],
    computer_seconds: 0,
    runs: [
      {
        id: 'job_1',
        title: 'Plan a 3-day trip to Lisbon on a budget, with a day by the sea and a museum',
        at: '2026-10-13T14:10:00Z',
        outcome: 'done',
        usd: 0.41,
        background: false,
        conversation_id: 'job_1',
      },
      {
        id: 'job_2',
        title: 'Watch the pricing page',
        at: '2026-10-11T09:30:00Z',
        outcome: 'failed',
        usd: 0.004,
        background: true,
        conversation_id: null,
      },
    ],
    ...overrides,
  };
}
