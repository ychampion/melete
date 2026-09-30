import { expect, test } from 'bun:test';
import { inlineSpans } from './inline.ts';

test('bold, italic and code become spans; the markers go', () => {
  expect(inlineSpans('interests. *(blocked on you)*')).toEqual([
    { kind: 'text', text: 'interests. ' },
    { kind: 'em', text: '(blocked on you)' },
  ]);
  expect(inlineSpans('**To:** sam and `uname -a`')).toEqual([
    { kind: 'strong', text: 'To:' },
    { kind: 'text', text: ' sam and ' },
    { kind: 'code', text: 'uname -a' },
  ]);
  expect(inlineSpans('_quietly_ done')).toEqual([
    { kind: 'em', text: 'quietly' },
    { kind: 'text', text: ' done' },
  ]);
});

test('arithmetic and snake_case stay as written', () => {
  expect(inlineSpans('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
  expect(inlineSpans('set MELETE_SANDBOX_PROJECT now')).toEqual([
    { kind: 'text', text: 'set MELETE_SANDBOX_PROJECT now' },
  ]);
});
