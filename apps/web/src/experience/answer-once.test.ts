/**
 * An answer is shown once. The saved copy and the streamed text can each hold
 * all or part of the other, and a reopened chat can be sent the same events
 * again; none of these prints the reply twice or splices two copies together.
 */
import { expect, test } from 'bun:test';
import {
  answerOf,
  applyEvents,
  fillAnswers,
  fromTurns,
  replayedStatus,
  type TranscriptTurn,
} from './reduce.ts';
import type { ExperienceEvent, Turn } from './types.ts';

const AT = '2026-10-02T09:00:00.000Z';
const A = 'The folder you asked about is empty.';
const B = 'The write was denied, so nothing was saved.';

const turnOf = (answer: string, status: Turn['status'] = 'done'): Turn => ({
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'Save a note',
  answer,
  status,
  delivery: null,
  created_at: AT,
});

/** A turn still running, read with part of its answer saved and more streamed since. */
const shown = (answer: string, streamed: string) => {
  const [turn] = fromTurns([turnOf(answer, 'working')], 'pause', 'working').turns;
  return answerOf({ ...(turn as TranscriptTurn), streamed });
};

test('saved A with streamed B then A reads A, B once (not A, B, A)', () => {
  expect(shown(A, `${B} ${A}`)).toBe(`${B} ${A}`);
  expect(shown(A, `${B} ${A}`).split(A)).toHaveLength(2);
});

test('the stream repeating the saved answer, or part of it, adds nothing', () => {
  expect(shown(A, A)).toBe(A);
  expect(shown(`${A} ${B}`, B)).toBe(`${A} ${B}`);
  expect(shown(`${A} ${B}`, 'was denied')).toBe(`${A} ${B}`);
});

test('text that streamed after the saved answer is still added', () => {
  expect(shown(A, ' More to come.')).toBe(`${A} More to come.`);
  expect(shown('', B)).toBe(B);
  expect(shown(A, '')).toBe(A);
});

let seq = 0;
const delta = (text: string, turnId = 'turn_2'): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: turnId,
  created_at: AT,
  item: { type: 'text_delta', text },
});
const status = (value: Turn['status'], turnId = 'turn_2'): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: turnId,
  created_at: AT,
  item: { type: 'status', status: value, composer: value === 'done' ? 'send' : 'pause' },
});

test('the same events applied twice, as on a reopen, give one copy of the answer', () => {
  seq = 0;
  const events = [status('working'), delta('Everything is '), delta('lined up.'), status('done')];
  const live = fromTurns([{ ...turnOf(''), id: 'turn_2', status: 'working' }], 'pause', 'working');
  const once = applyEvents(live, events);
  const twice = applyEvents(once, events);
  expect(answerOf(twice.turns[0] as TranscriptTurn)).toBe('Everything is lined up.');
  expect(twice.turns[0]?.status).toBe('done');
  expect(twice.turns[0]?.streaming).toBe(false);
  // And a replay that overlaps the tail, the way a reconnect picks up from a
  // point it already had, adds nothing either.
  const overlap = applyEvents(once, events.slice(2));
  expect(answerOf(overlap.turns[0] as TranscriptTurn)).toBe('Everything is lined up.');
});

test('a finished turn read with its answer is not set working by replayed text', () => {
  seq = 100;
  const saved = fromTurns([{ ...turnOf('Everything is lined up.'), id: 'turn_2' }], 'send', 'done');
  const replayed = applyEvents(saved, [delta('Everything is '), delta('lined up.')]);
  const turn = replayed.turns[0] as TranscriptTurn;
  expect(answerOf(turn)).toBe('Everything is lined up.');
  expect(turn.streaming).toBe(false);
});

test('a finished turn shows only its final answer, not what was written before an approval', () => {
  seq = 200;
  const waiting = 'Waiting on your approval to open https://example.com.';
  const opened = 'Opened example.com. It is a placeholder page.';
  // Live: the words before the approval and the final answer both streamed.
  const live = fromTurns([{ ...turnOf(''), id: 'turn_2', status: 'working' }], 'pause', 'working');
  const ran = applyEvents(live, [
    status('working'),
    delta(waiting),
    status('needs_you'),
    status('working'),
    delta(opened),
    status('done'),
  ]);
  // Its saved copy, read once it ends, keeps only the final message.
  const read = fillAnswers(ran, [{ ...turnOf(opened), id: 'turn_2' }]);
  expect(answerOf(read.turns[0] as TranscriptTurn)).toBe(opened);
  // And a reload reads the same.
  const reloaded = fromTurns([{ ...turnOf(opened), id: 'turn_2' }], 'send', 'done');
  expect(
    answerOf({ ...(reloaded.turns[0] as TranscriptTurn), streamed: `${waiting}${opened}` }),
  ).toBe(opened);
  // A turn still running keeps everything it has streamed.
  const running = applyEvents(live, [status('working'), delta(waiting)]);
  expect(answerOf(running.turns[0] as TranscriptTurn)).toBe(waiting);
});

test('replaying a long finished turn never reads as working', () => {
  seq = 300;
  const saved = fromTurns([{ ...turnOf('All done.'), id: 'turn_2' }], 'send', 'done');
  // The first page of its events ends before the final status arrives.
  const firstPage = [status('working'), delta('All '), status('needs_you'), status('working')];
  expect(replayedStatus(saved, firstPage[0] as ExperienceEvent)).toBe(true);
  const midway = applyEvents(saved, firstPage);
  expect(midway.status).toBe('done');
  expect(midway.composer).toBe('send');
  expect(midway.turns[0]?.status).toBe('done');
  const after = applyEvents(midway, [status('done')]);
  expect(after.status).toBe('done');
  // A turn the saved copy says is still running follows its statuses as before.
  const running = fromTurns([{ ...turnOf('', 'working'), id: 'turn_2' }], 'pause', 'working');
  expect(applyEvents(running, [status('needs_you')]).status).toBe('needs_you');
});
