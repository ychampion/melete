import { expect, test } from 'bun:test';
import {
  carriedWelcome,
  carryWelcome,
  saveWelcome,
  welcomeProgress,
  welcomeStep,
} from './welcome.ts';

test('the welcome offers the routine first, then each question, then is done', () => {
  const ref = { agentId: 'ag_1', templateId: 'inbox-triage' };
  const start = welcomeProgress(ref, true);
  expect(welcomeStep(start, 2)).toEqual({ kind: 'routine' });
  const declined = { ...start, routine: 'declined' as const };
  expect(welcomeStep(declined, 2)).toEqual({ kind: 'question', index: 0 });
  const one = { ...declined, answers: [{ id: 'a', text: 'My manager' }] };
  expect(welcomeStep(one, 2)).toEqual({ kind: 'question', index: 1 });
  expect(welcomeStep({ ...one, answers: [...one.answers, { id: 'b', text: null }] }, 2)).toEqual({
    kind: 'done',
  });
  // No routine and no questions: nothing to ask.
  expect(welcomeStep(welcomeProgress({ ...ref, agentId: 'ag_2' }, false), 0)).toEqual({
    kind: 'done',
  });
});

test('where the person got to is kept, and the chat they start keeps the welcome', () => {
  const ref = { agentId: 'ag_3', templateId: 'bill-tracker' };
  saveWelcome(ref, { routine: 'made', answers: [{ id: 'bills', text: 'Rent' }] });
  expect(welcomeProgress(ref, true)).toEqual({
    routine: 'made',
    answers: [{ id: 'bills', text: 'Rent' }],
  });
  expect(carriedWelcome('c_1')).toBeNull();
  carryWelcome('c_1', ref);
  expect(carriedWelcome('c_1')).toEqual(ref);
});
