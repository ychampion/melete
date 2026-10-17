import { describe, expect, test } from 'bun:test';
import { headState, QUIET_AFTER_MS, quietFor } from './head-state.ts';

const NOW = Date.parse('2026-10-18T15:00:00Z');

describe('the chat header state', () => {
  test('work under way reads as working until it goes quiet', () => {
    expect(headState({ status: 'working' }, NOW - 5_000, NOW)).toEqual({
      tone: 'working',
      words: 'Working',
    });
    expect(headState({ status: 'queued' }, NOW, NOW)?.words).toBe('Starting');
    expect(headState({ status: 'streaming' }, NOW - QUIET_AFTER_MS - 14_000, NOW)).toEqual({
      tone: 'quiet',
      words: 'No progress for 34 s',
    });
    expect(headState({ status: 'working' }, NOW - 125_000, NOW)?.words).toBe(
      'No progress for 2 min',
    );
  });

  test('a lost stream reads as reconnecting, not as work that stopped moving', () => {
    const quiet = NOW - QUIET_AFTER_MS - 30_000;
    expect(headState({ status: 'working' }, quiet, NOW, false)).toEqual({
      tone: 'quiet',
      words: 'Reconnecting',
    });
    expect(headState({ status: 'working' }, quiet, NOW, true)?.words).toBe('No progress for 50 s');
    // A short drop, before anything would read as quiet, changes nothing.
    expect(headState({ status: 'working' }, NOW - 2_000, NOW, false)?.words).toBe('Working');
    // Waiting on the person is known without the stream.
    expect(headState({ status: 'needs_you' }, quiet, NOW, false)?.words).toBe('Waiting for you');
  });

  test('a stalled turn says so even before the header has counted', () => {
    expect(headState({ status: 'stalled' }, null, NOW)).toEqual({
      tone: 'quiet',
      words: 'No progress lately',
    });
  });

  test('waiting on the person, on a time, paused and stopped each say so', () => {
    expect(headState({ status: 'needs_you' }, null, NOW)?.words).toBe('Waiting for you');
    const later = new Date(NOW + 60 * 60_000).toISOString();
    expect(headState({ status: 'needs_you', waiting_until: later }, null, NOW)?.words).toMatch(
      /^Waiting until /,
    );
    expect(headState({ status: 'paused' }, null, NOW)).toEqual({
      tone: 'stopped',
      words: 'Paused',
    });
    expect(headState({ status: 'stopped' }, null, NOW)?.words).toBe('Stopped');
    expect(headState({ status: 'failed' }, null, NOW)?.words).toBe('Stopped without finishing');
  });

  test('a ready or finished conversation shows nothing', () => {
    expect(headState({ status: 'idle' }, null, NOW)).toBeNull();
    expect(headState({ status: 'done' }, NOW - 600_000, NOW)).toBeNull();
    expect(headState(null, null, NOW)).toBeNull();
  });

  test('durations read plainly', () => {
    expect(quietFor(20_400)).toBe('20 s');
    expect(quietFor(61_000)).toBe('1 min');
    expect(quietFor(3_600_000)).toBe('1 h');
    expect(quietFor(3_900_000)).toBe('1 h 5 min');
  });
});
