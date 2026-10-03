import { describe, expect, test } from 'bun:test';
import { FailureWindow, limitKey, MemoryLimitStore, WindowLimiter } from './limiter.ts';

describe('request limits', () => {
  test('a fixed window counts each key on its own and opens again when it ends', async () => {
    let now = 0;
    const limiter = new WindowLimiter(new MemoryLimitStore(), 'test', 3, 60_000, () => now);
    const tries = async (key: string, count: number) => {
      const answers: boolean[] = [];
      for (let index = 0; index < count; index++) answers.push(await limiter.allow(key));
      return answers;
    };
    expect(await tries('a', 4)).toEqual([true, true, true, false]);
    expect(await tries('b', 1)).toEqual([true]);
    now = 59_999;
    expect(await tries('a', 1)).toEqual([false]);
    now = 60_000;
    expect(await tries('a', 4)).toEqual([true, true, true, false]);
  });

  test('wrong codes make a key wait until the oldest one ages out', async () => {
    const window = new FailureWindow(new MemoryLimitStore(), 'test', 3, 10_000);
    for (const at of [0, 1000, 2000]) {
      expect(await window.retryAfter('address', at)).toBe(0);
      await window.fail('address', at);
    }
    expect(await window.retryAfter('address', 2500)).toBe(8);
    expect(await window.retryAfter('other', 2500)).toBe(0);
    // The first failure ages out at 10 s; the key may try again.
    expect(await window.retryAfter('address', 10_000)).toBe(0);
  });

  test('limiters sharing a store keep their scopes apart', async () => {
    const store = new MemoryLimitStore();
    const first = new WindowLimiter(store, 'first', 1, 60_000, () => 0);
    const second = new WindowLimiter(store, 'second', 1, 60_000, () => 0);
    expect([await first.allow('key'), await first.allow('key')]).toEqual([true, false]);
    expect(await second.allow('key')).toBe(true);
    expect(limitKey('first', 'key')).not.toBe(limitKey('second', 'key'));
    expect(limitKey('first', 'key')).toMatch(/^[a-f0-9]{64}$/);
  });
});
