import { describe, expect, test } from 'bun:test';
import { undoable } from './learned.ts';

describe('what can be offered for undo', () => {
  test('an engine skill removal erases its text, so it is never offered', () => {
    expect(undoable({ source: 'engine', action: 'remove' })).toBe(false);
  });

  test('every other change keeps its undo', () => {
    for (const change of [
      { source: 'engine', action: 'pause' },
      { source: 'engine', action: 'resume' },
      { source: 'correction', action: 'remove' },
      { source: 'correction', action: 'pause' },
      { source: 'correction', action: 'keep' },
    ])
      expect(undoable(change)).toBe(true);
  });
});
