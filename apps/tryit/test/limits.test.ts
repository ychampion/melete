/**
 * The caps. Both of them are about money, so they are tested as arithmetic
 * rather than through a request.
 */
import { describe, expect, test } from 'bun:test';
import { memoryLimiter } from '../src/limiter.ts';
import type { Limits } from '../src/limits.ts';
import {
  checkInput,
  DEFAULT_LIMITS,
  emptyCounters,
  limitsFrom,
  refund,
  spend,
} from '../src/limits.ts';

const LIMITS: Limits = { ...DEFAULT_LIMITS, perIpPerDay: 3, globalPerDay: 5 };
const DAY = 24 * 60 * 60 * 1000;
const NOON = Date.parse('2026-09-18T12:00:00Z');

describe('the paste cap', () => {
  test('accepts a real email and trims what surrounds it', () => {
    const result = checkInput(`  ${'x'.repeat(200)}  `, DEFAULT_LIMITS);
    expect(result).toEqual({ ok: true, text: 'x'.repeat(200) });
  });

  test('refuses nothing, and refuses a novel', () => {
    expect(checkInput('', DEFAULT_LIMITS)).toMatchObject({ ok: false, code: 'empty_input' });
    expect(checkInput('too short', DEFAULT_LIMITS)).toMatchObject({
      ok: false,
      code: 'empty_input',
    });
    expect(checkInput(42, DEFAULT_LIMITS)).toMatchObject({ ok: false, code: 'empty_input' });
    expect(checkInput('x'.repeat(20_001), DEFAULT_LIMITS)).toMatchObject({
      ok: false,
      code: 'too_long',
      limit: 20_000,
    });
  });

  test('counts characters, not bytes, so an emoji costs what it looks like', () => {
    const text = '🙂'.repeat(60);
    expect(checkInput(text, { ...DEFAULT_LIMITS, maxInputChars: 200 })).toMatchObject({ ok: true });
  });
});

describe('reading the caps from the Worker’s variables', () => {
  test('takes what is usable and keeps the default for the rest', () => {
    const limits = limitsFrom({
      TRYIT_PER_IP_PER_DAY: '9',
      TRYIT_GLOBAL_PER_DAY: 'not a number',
      TRYIT_MAX_INPUT_CHARS: '-4',
      TRYIT_PER_BLOCK_PER_DAY: '31',
    });
    expect(limits.perIpPerDay).toBe(9);
    expect(limits.perBlockPerDay).toBe(31);
    expect(limits.globalPerDay).toBe(DEFAULT_LIMITS.globalPerDay);
    expect(limits.maxInputChars).toBe(DEFAULT_LIMITS.maxInputChars);
  });
});

describe('one address', () => {
  test('gets its allowance and then hears the same thing all day', () => {
    let counters = emptyCounters(NOON);
    for (let turn = 1; turn <= LIMITS.perIpPerDay; turn += 1) {
      const result = spend(counters, '1.2.3.4', NOON, LIMITS);
      expect(result.allowed).toBe(true);
      counters = result.counters;
    }
    const over = spend(counters, '1.2.3.4', NOON, LIMITS);
    expect(over).toMatchObject({ allowed: false, reason: 'ip' });
    expect(spend(counters, '5.6.7.8', NOON, LIMITS).allowed).toBe(true);
  });

  test('starts again the next day', () => {
    let counters = emptyCounters(NOON);
    for (let turn = 0; turn < LIMITS.perIpPerDay; turn += 1)
      counters = spend(counters, '1.2.3.4', NOON, LIMITS).counters;
    expect(spend(counters, '1.2.3.4', NOON + DAY, LIMITS).allowed).toBe(true);
  });
});

describe('the whole page', () => {
  test('stops at the day’s budget, whoever is asking', () => {
    let counters = emptyCounters(NOON);
    for (let turn = 0; turn < LIMITS.globalPerDay; turn += 1) {
      const result = spend(counters, `10.0.0.${turn}`, NOON, LIMITS);
      expect(result.allowed).toBe(true);
      counters = result.counters;
    }
    expect(spend(counters, '10.0.0.99', NOON, LIMITS)).toMatchObject({
      allowed: false,
      reason: 'global',
    });
  });

  test('being out of budget does not spend an address’s own allowance', () => {
    let counters = emptyCounters(NOON);
    for (let turn = 0; turn < LIMITS.globalPerDay; turn += 1)
      counters = spend(counters, `10.0.0.${turn}`, NOON, LIMITS).counters;
    const blocked = spend(counters, 'fresh', NOON, LIMITS);
    expect(blocked.counters.perIp.fresh).toBeUndefined();
  });
});

/**
 * An ISP often hands one household a /56 or a /48, which is hundreds or
 * thousands of /64s, each with its own allowance. The block is counted as
 * well, and a turn needs room in both.
 */
describe('one IPv6 block', () => {
  const BLOCKS: Limits = { ...LIMITS, perBlockPerDay: 4, globalPerDay: 50 };
  const BLOCK = '2001:db8:1::/48';

  test('runs out however many of its /64s ask', () => {
    let counters = emptyCounters(NOON);
    const verdicts: boolean[] = [];
    for (let net = 0; net < 8; net += 1) {
      const result = spend(counters, `net-${net}`, NOON, BLOCKS, BLOCK);
      verdicts.push(result.allowed);
      counters = result.counters;
    }
    expect(verdicts.filter(Boolean)).toHaveLength(BLOCKS.perBlockPerDay);
    expect(spend(counters, 'net-99', NOON, BLOCKS, BLOCK)).toMatchObject({
      allowed: false,
      reason: 'ip',
    });
    expect(spend(counters, 'net-99', NOON, BLOCKS, '2001:db8:2::/48').allowed).toBe(true);
  });

  test('a /64 still has its own, smaller allowance inside the block', () => {
    let counters = emptyCounters(NOON);
    for (let turn = 0; turn < BLOCKS.perIpPerDay; turn += 1)
      counters = spend(counters, 'net-1', NOON, BLOCKS, BLOCK).counters;
    expect(spend(counters, 'net-1', NOON, BLOCKS, BLOCK)).toMatchObject({ allowed: false });
    expect(spend(counters, 'net-2', NOON, BLOCKS, BLOCK).allowed).toBe(true);
  });

  test('a refusal spends nothing from either count', () => {
    let counters = emptyCounters(NOON);
    for (let net = 0; net < BLOCKS.perBlockPerDay; net += 1)
      counters = spend(counters, `net-${net}`, NOON, BLOCKS, BLOCK).counters;
    const refused = spend(counters, 'net-99', NOON, BLOCKS, BLOCK);
    expect(refused.counters).toEqual(counters);
  });

  test('a turn given back is given back to the block too', () => {
    const taken = spend(emptyCounters(NOON), 'net-1', NOON, BLOCKS, BLOCK).counters;
    const back = refund(taken, 'net-1', NOON, BLOCK);
    expect(back.perBlock?.[BLOCK]).toBe(0);
    expect(back.perIp['net-1']).toBe(0);
    expect(back.global).toBe(0);
  });

  test('counters stored before blocks were counted still work', () => {
    const old = { day: '2026-09-18', global: 2, perIp: { 'net-1': 1 } };
    const result = spend(old, 'net-1', NOON, BLOCKS, BLOCK);
    expect(result.allowed).toBe(true);
    expect(result.counters.perBlock?.[BLOCK]).toBe(1);
    expect(refund(old, 'net-1', NOON, BLOCK).perIp['net-1']).toBe(0);
  });

  test('by default one block is a small share of the day', () => {
    const { perIpPerDay, perBlockPerDay, globalPerDay } = DEFAULT_LIMITS;
    expect(perBlockPerDay).toBeGreaterThan(perIpPerDay);
    expect(perBlockPerDay * 20).toBeLessThanOrEqual(globalPerDay);
  });

  test('the in-isolate counter counts blocks too', async () => {
    const limiter = memoryLimiter(BLOCKS, () => NOON);
    for (let net = 0; net < BLOCKS.perBlockPerDay; net += 1)
      expect((await limiter.take(`net-${net}`, BLOCK)).allowed).toBe(true);
    expect(await limiter.take('net-99', BLOCK)).toMatchObject({ allowed: false });
    await limiter.giveBack('net-0', BLOCK);
    expect((await limiter.take('net-99', BLOCK)).allowed).toBe(true);
  });
});

describe('giving one back', () => {
  test('an attempt that produced nothing is not charged for', () => {
    const taken = spend(emptyCounters(NOON), '1.2.3.4', NOON, LIMITS).counters;
    const back = refund(taken, '1.2.3.4', NOON);
    expect(back.perIp['1.2.3.4']).toBe(0);
    expect(back.global).toBe(0);
  });

  test('a refund for a day that has turned over changes nothing', () => {
    const taken = spend(emptyCounters(NOON), '1.2.3.4', NOON, LIMITS).counters;
    expect(refund(taken, '1.2.3.4', NOON + DAY)).toEqual(taken);
  });
});

describe('the in-isolate counter', () => {
  test('behaves like the rules it wraps', async () => {
    const limiter = memoryLimiter(LIMITS, () => NOON);
    for (let turn = 0; turn < LIMITS.perIpPerDay; turn += 1)
      expect((await limiter.take('1.2.3.4')).allowed).toBe(true);
    expect(await limiter.take('1.2.3.4')).toMatchObject({ allowed: false, reason: 'ip' });
    await limiter.giveBack('1.2.3.4');
    expect((await limiter.take('1.2.3.4')).allowed).toBe(true);
  });
});
