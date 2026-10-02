import { expect, test } from 'bun:test';
import {
  prefLabel,
  restoreWelcome,
  saveWelcome,
  sessionWelcome,
  welcomeQuery,
  welcomeStep,
} from './welcome.ts';

const questions = [
  { id: 'who', memory_key: 'pref.inbox.important-senders' },
  { id: 'voice', memory_key: 'pref.inbox.reply-voice' },
];
const none = {
  hasRoutine: true,
  routineMade: false,
  routineDeclined: false,
  questions,
  saved: new Map<string, string>(),
  skipped: new Set<string>(),
};

test('the welcome offers the routine first, then each question, then is done', () => {
  const start = restoreWelcome(none);
  expect(welcomeStep(start, 2)).toEqual({ kind: 'routine' });
  const declined = { ...start, routine: 'declined' as const };
  expect(welcomeStep(declined, 2)).toEqual({ kind: 'question', index: 0 });
  const one = { ...declined, answers: [{ id: 'who', text: 'My manager' }] };
  expect(welcomeStep(one, 2)).toEqual({ kind: 'question', index: 1 });
  expect(
    welcomeStep({ ...one, answers: [...one.answers, { id: 'voice', text: null }] }, 2),
  ).toEqual({ kind: 'done' });
  // No routine and no questions: nothing to ask.
  expect(welcomeStep(restoreWelcome({ ...none, hasRoutine: false, questions: [] }), 0)).toEqual({
    kind: 'done',
  });
});

test('after a reload, the routine and saved answers come back from the service, skips from the link', () => {
  const restored = restoreWelcome({
    ...none,
    routineMade: true,
    saved: new Map([['inbox: important senders', 'My manager']]),
    skipped: new Set(['voice']),
  });
  expect(restored).toEqual({
    routine: 'made',
    answers: [
      { id: 'who', text: 'My manager' },
      { id: 'voice', text: null },
    ],
  });
  // A routine turned down stays turned down; questions are asked in order, so a
  // skip after an unanswered question waits its turn.
  expect(restoreWelcome({ ...none, routineDeclined: true, skipped: new Set(['voice']) })).toEqual({
    routine: 'declined',
    answers: [],
  });
});

test('the link keeps only the noes, and this session’s progress is kept as it is', () => {
  expect(
    welcomeQuery('inbox-triage', { routine: 'made', answers: [{ id: 'who', text: 'x' }] }),
  ).toBe('welcome=inbox-triage');
  expect(
    welcomeQuery('inbox-triage', {
      routine: 'declined',
      answers: [
        { id: 'who', text: null },
        { id: 'voice', text: null },
      ],
    }),
  ).toBe('welcome=inbox-triage&routine=no&skipped=who%2Cvoice');
  const ref = { agentId: 'ag_3', templateId: 'bill-tracker' };
  expect(sessionWelcome(ref)).toBeNull();
  saveWelcome(ref, { routine: 'made', answers: [] });
  expect(sessionWelcome(ref)).toEqual({ routine: 'made', answers: [] });
});

test('a pref key reads as the memory list labels it', () => {
  expect(prefLabel('pref.inbox.important-senders')).toBe('inbox: important senders');
  expect(prefLabel('pref.trip-planner.home-airport')).toBe('trip planner: home airport');
});
