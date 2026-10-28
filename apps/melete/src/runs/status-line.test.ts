import { expect, test } from 'bun:test';
import { statusLine } from './service.ts';

const resting = {
  status: 'waiting' as const,
  paused: false,
  experiments: 0,
  best: undefined,
  helpersWorking: 0,
  waitingOnSteps: false,
  nextWakeAt: new Date('2026-10-29T00:00:00.000Z'),
  question: null,
  standing: null,
  check: null,
  closing: false,
};

test('work resting on the background limit says why and when it picks up again', () => {
  const until = new Date('2026-10-29T00:00:00.000Z');
  expect(statusLine({ ...resting, limited: { period: 'day', until } })).toBe(
    "Background work reached today's limit; picks up again on October 29 at 00:00 UTC",
  );
  expect(
    statusLine({
      ...resting,
      limited: { period: 'month', until: new Date('2026-11-01T00:00:00.000Z') },
    }),
  ).toBe("Background work reached this month's limit; picks up again on November 1 at 00:00 UTC");
  // The tries made so far still follow, and a watch resting on the limit says the limit.
  expect(
    statusLine({
      ...resting,
      experiments: 3,
      standing: 'event',
      limited: { period: 'day', until },
    }),
  ).toBe(
    "Background work reached today's limit; picks up again on October 29 at 00:00 UTC · 3 tries",
  );
});

test('work resting for any other reason reads as before', () => {
  expect(statusLine(resting)).toBe('Picks up again later');
  expect(statusLine({ ...resting, limited: null })).toBe('Picks up again later');
  expect(statusLine({ ...resting, nextWakeAt: null })).toBe('Waiting');
  expect(
    statusLine({
      ...resting,
      paused: true,
      limited: { period: 'day', until: new Date('2026-10-29T00:00:00.000Z') },
    }),
  ).toBe('Paused');
});
