/**
 * A page opened while its turn is still queued (Home sends, then opens the
 * chat) reads that turn as "sending". The stream then carries the turn through
 * working to done, and the page settles as a reload would: sent, and worked.
 */
import { expect, test } from 'bun:test';
import { applyEvent, fromTurns } from './reduce.ts';
import type { ExperienceEvent, Turn } from './types.ts';

const AT = '2026-09-25T09:00:00.000Z';
const queued: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'What is on today?',
  answer: '',
  status: 'queued',
  delivery: 'sending',
  created_at: AT,
};
let seq = 0;
const event = (item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item,
});

test('a turn read while queued stops saying "sending" once the service works on it', () => {
  const opened = fromTurns([queued], 'pause', 'queued');
  expect(opened.turns[0]?.delivery).toBe('sending');
  const working = applyEvent(
    opened,
    event({ type: 'status', status: 'working', composer: 'pause' }),
  );
  expect(working.turns[0]?.delivery).toBeNull();
  expect(working.turns[0]?.turn.delivery).toBeNull();
  expect(working.turns[0]?.status).toBe('working');
});

test('the finish on the stream settles the turn and the composer', () => {
  let transcript = fromTurns([queued], 'pause', 'queued');
  for (const item of [
    { type: 'status', status: 'working', composer: 'pause' },
    { type: 'say', text: 'Reading your calendar.' },
    {
      type: 'done',
      summary: 'Two meetings and a run.',
      elapsed_ms: 42_000,
      apps: [],
      source_count: 0,
    },
    { type: 'status', status: 'done', composer: 'send' },
  ] satisfies ExperienceEvent['item'][])
    transcript = applyEvent(transcript, event(item));
  expect(transcript.status).toBe('done');
  expect(transcript.composer).toBe('send');
  expect(transcript.turns[0]?.status).toBe('done');
  expect(transcript.turns[0]?.delivery).toBeNull();
});

test('a status that leaves the turn queued keeps it sending', () => {
  const still = applyEvent(
    fromTurns([queued], 'pause', 'queued'),
    event({ type: 'status', status: 'queued', composer: 'pause' }),
  );
  expect(still.turns[0]?.delivery).toBe('sending');
});
