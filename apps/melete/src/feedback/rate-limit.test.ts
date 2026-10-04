import { expect, test } from 'bun:test';
import { FEEDBACK_BURST, FEEDBACK_WINDOW_MS, FeedbackLimiter } from './rate-limit.ts';

test('admits a burst per person, then says how long to wait', async () => {
  let now = 1_000_000;
  const limiter = new FeedbackLimiter(() => now);
  for (let i = 0; i < FEEDBACK_BURST; i++) {
    expect(await limiter.admit('own_a')).toBe(0);
    now += 1000;
  }
  const wait = await limiter.admit('own_a');
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThanOrEqual(FEEDBACK_WINDOW_MS / 1000);
  // Another person is not held up by the first.
  expect(await limiter.admit('own_b')).toBe(0);
});

test('a refused report does not extend the wait, and the window slides', async () => {
  let now = 0;
  const limiter = new FeedbackLimiter(() => now, 2, 60_000);
  expect(await limiter.admit('p')).toBe(0);
  now = 10_000;
  expect(await limiter.admit('p')).toBe(0);
  now = 20_000;
  expect(await limiter.admit('p')).toBe(40);
  now = 59_999;
  expect(await limiter.admit('p')).toBe(1);
  // The first report has aged out: one more fits, and the next waits on the second.
  now = 60_000;
  expect(await limiter.admit('p')).toBe(0);
  expect(await limiter.admit('p')).toBe(10);
});

test('a report that was not stored is given back', async () => {
  const limiter = new FeedbackLimiter(() => 0, 1, 60_000);
  expect(await limiter.admit('p')).toBe(0);
  await limiter.refund('p');
  expect(await limiter.admit('p')).toBe(0);
  expect(await limiter.admit('p')).toBeGreaterThan(0);
});
