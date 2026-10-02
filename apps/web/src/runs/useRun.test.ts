/**
 * An answer shows only when nothing newer started: a read that began before
 * an action never puts the old state back, reads wait while an action is out,
 * and an action that never answers stops holding them back.
 */
import { expect, test } from 'bun:test';
import { withHours } from '../screens/Work.tsx';
import { ACTION_HOLD_MS, createGate } from './useRun.ts';

test('a read that started before an action is ignored, the action wins', () => {
  const gate = createGate(() => 0);
  const read = gate.read();
  const action = gate.act();
  if (read === null) throw new Error('the first read goes out');
  expect(gate.settle(action)).toBe(true);
  expect(gate.settle(read)).toBe(false);
});

test('reads wait while an action is out, and resume once it answers', () => {
  const gate = createGate(() => 0);
  const action = gate.act();
  expect(gate.read()).toBeNull();
  gate.settle(action);
  const read = gate.read();
  expect(read).not.toBeNull();
  expect(gate.settle(read ?? -1)).toBe(true);
});

test('a later read wins over an earlier one that answers late', () => {
  const gate = createGate(() => 0);
  const slow = gate.read() ?? -1;
  const fresh = gate.read() ?? -1;
  expect(gate.settle(fresh)).toBe(true);
  expect(gate.settle(slow)).toBe(false);
});

test('an action that never answers stops holding reads back', () => {
  let now = 0;
  const gate = createGate(() => now);
  gate.act();
  expect(gate.read()).toBeNull();
  now = ACTION_HOLD_MS + 1;
  expect(gate.read()).not.toBeNull();
});

test('clearing the hours keeps any other limit, and sends nothing once none is left', () => {
  expect(withHours({ max_hours: 4, max_shifts: 20 }, null)).toEqual({ max_shifts: 20 });
  expect(withHours({ max_hours: 4 }, null)).toBeNull();
  expect(withHours(null, null)).toBeNull();
  expect(withHours({ max_output_tokens: 9000 }, 12)).toEqual({
    max_output_tokens: 9000,
    max_hours: 12,
  });
});
