import { expect, test } from 'bun:test';
import { isWaiting, waitingOn } from './waiting.ts';

test('open permissions and questions name the conversations they hold up', () => {
  const waiting = waitingOn({
    permissions: [{ conversation_id: 'job_chase' }, { conversation_id: null }],
    questions: [{ conversation_id: 'job_trip' }],
  });
  expect([...waiting].sort()).toEqual(['job_chase', 'job_trip']);
});

test('a conversation waits while a decision is open or its turn asked, not otherwise', () => {
  const waiting = new Set(['job_chase']);
  expect(isWaiting({ id: 'job_chase', status: 'done' }, waiting)).toBe(true);
  expect(isWaiting({ id: 'job_ask', status: 'needs_you' }, waiting)).toBe(true);
  expect(isWaiting({ id: 'job_other', status: 'done' }, waiting)).toBe(false);
  expect(isWaiting({ id: 'job_chase', status: 'done' }, new Set())).toBe(false);
});
