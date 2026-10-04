import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { NO_LIMIT, SpendingGuard, spendingLimitsFromEnv } from './spending.ts';
import { serviceClass, TURN_PURPOSES, tierOf } from './usage-class.ts';
import { percentile } from './usage-day.ts';

describe('which calls a person is waiting on', () => {
  test('memory and learning run in the background; a voice aside and a scan the person asked for do not', () => {
    expect(serviceClass('memory')).toBe('background');
    expect(serviceClass('learning')).toBe('background');
    expect(serviceClass('triage')).toBe('background');
    expect(serviceClass('voice')).toBe('interactive');
    expect(serviceClass('companies')).toBe('interactive');
    // A purpose nobody has classified yet runs with nobody waiting.
    expect(serviceClass('something_new')).toBe('background');
  });

  test("a turn's searches and reviews take the class of the turn", () => {
    expect([...TURN_PURPOSES].sort()).toEqual(['action_review', 'web_search']);
  });

  test('the tier says which step made the call', () => {
    expect(tierOf('job', 'agent', 'interactive')).toBe('interactive');
    expect(tierOf('job', 'agent', 'background')).toBe('t2');
    expect(tierOf('service', 'memory', 'background')).toBe('service');
    expect(tierOf('service', 'voice', 'interactive')).toBe('service');
    expect(tierOf('service', 'triage', 'background')).toBe('t1');
  });
});

describe('background limits', () => {
  test('are off unless the operator sets them, and then hold background calls alone', () => {
    const unset = spendingLimitsFromEnv(loadEnv({ NODE_ENV: 'test' }));
    expect(unset.background).toEqual({ day: NO_LIMIT, month: NO_LIMIT });
    const sql = (() => {
      throw new Error('no database read expected');
    }) as never;
    expect(new SpendingGuard(sql, unset).backgroundLimited).toBe(false);
    expect(new SpendingGuard(sql, unset).limited).toBe(false);

    const set = spendingLimitsFromEnv(
      loadEnv({
        NODE_ENV: 'test',
        MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD: '0.5',
        MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_TOKENS: '2000000',
      }),
    );
    expect(set.background).toEqual({
      day: { usd: 0.5, tokens: null },
      month: { usd: null, tokens: 2_000_000 },
    });
    const guard = new SpendingGuard(sql, set);
    expect(guard.backgroundLimited).toBe(true);
    // The person's and the installation's limits are still unset.
    expect(guard.limited).toBe(false);
  });

  test("a job's model dollars count against its dollar limit only when the operator says so", () => {
    expect(loadEnv({ NODE_ENV: 'test' }).MELETE_JOB_USD_COUNTS_MODELS).toBe(false);
    expect(
      loadEnv({ NODE_ENV: 'test', MELETE_JOB_USD_COUNTS_MODELS: 'true' })
        .MELETE_JOB_USD_COUNTS_MODELS,
    ).toBe(true);
  });
});

describe('percentiles of person-days', () => {
  test('take the nearest rank, and are zero with no days', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([0.1], 0.95)).toBe(0.1);
    expect(percentile([0.1, 0.2, 0.3, 0.4], 0.5)).toBe(0.2);
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(twenty, 0.95)).toBe(19);
    expect(percentile(twenty, 0.5)).toBe(10);
  });
});
