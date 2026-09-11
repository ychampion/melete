import { describe, expect, test } from 'bun:test';
import { mergeGap, type StreamGap } from './hooks.ts';

const gap = (after: number, reason: string, next: number | null = null): StreamGap => ({
  after,
  next,
  reason,
});

describe('mergeGap', () => {
  test('records the first break', () => {
    expect(mergeGap([], gap(4, 'reconnect'))).toEqual([gap(4, 'reconnect')]);
  });

  test('draws one ellipsis however many times reconnecting took', () => {
    let gaps: StreamGap[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      gaps = mergeGap(gaps, gap(4, 'reconnect'));
    }
    expect(gaps).toEqual([gap(4, 'reconnect')]);
  });

  test('a later break at a later point is its own ellipsis', () => {
    const first = mergeGap([], gap(4, 'reconnect'));
    const second = mergeGap(first, gap(9, 'reconnect'));
    expect(second).toEqual([gap(4, 'reconnect'), gap(9, 'reconnect')]);
  });

  test('a skipped sequence is not the same break as a reconnect', () => {
    const both = mergeGap(mergeGap([], gap(4, 'reconnect')), gap(4, 'sequence_skip', 9));
    expect(both.map((g) => g.reason)).toEqual(['reconnect', 'sequence_skip']);
  });

  test('returns the same array when there is nothing to add', () => {
    const gaps = [gap(4, 'reconnect')];
    expect(mergeGap(gaps, gap(4, 'reconnect'))).toBe(gaps);
  });
});
