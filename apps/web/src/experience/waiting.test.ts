import { expect, test } from 'bun:test';
import { isWaiting, waitingOn, waitingUntilWords } from './waiting.ts';

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

test('a chat resting on a time it set itself is waiting for that time, not for the person', () => {
  const at = new Date(2026, 9, 10, 22, 50).toISOString();
  expect(isWaiting({ id: 'job_remind', status: 'needs_you', waiting_until: at }, new Set())).toBe(
    false,
  );
  // An open decision in it still waits on the person.
  expect(
    isWaiting(
      { id: 'job_remind', status: 'needs_you', waiting_until: at },
      new Set(['job_remind']),
    ),
  ).toBe(true);
  const now = new Date(2026, 9, 10, 17, 0).getTime();
  expect(waitingUntilWords(at, now)).toBe('Waiting until 10:50 PM');
  expect(waitingUntilWords(new Date(2026, 9, 11, 7, 0).toISOString(), now)).toBe(
    'Waiting until tomorrow at 7:00 AM',
  );
});
