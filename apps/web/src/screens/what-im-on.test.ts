import { describe, expect, test } from 'bun:test';
import { cancelledLine } from './WhatImOnSection.tsx';

const intent = {} as never;

describe('what cancelling says', () => {
  test('what was undone and what is still in place, in one line', () => {
    expect(
      cancelledLine({
        intent,
        effects: [
          { action_id: 'act_2', title: 'Email send', outcome: 'kept', reason: null },
          { action_id: 'act_1', title: 'Calendar create', outcome: 'reversed', reason: null },
        ],
      }),
    ).toBe('1 change undone; still in place: email send.');
  });
  test('nothing had changed yet', () => {
    expect(cancelledLine({ intent, effects: [] })).toBe('Nothing had changed yet.');
  });
});
