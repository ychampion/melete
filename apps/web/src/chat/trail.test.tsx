/**
 * Tool entries in the trail. The step under way is named by the running entry
 * the stream sends, and a job that keeps going after it first settles (a
 * chase: the send, then the reply and the follow-up) keeps its trail open so
 * what it did after the send is in view.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyEvent, fromTurns } from '../experience/reduce.ts';
import type { ExperienceEvent, Turn } from '../experience/types.ts';
import { Trail } from './parts.tsx';

const AT = '2026-09-24T09:00:00.000Z';
const TURN: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'Chase Tern & Co for the £64.00 refund they owe me.',
  answer: '',
  status: 'working',
  delivery: null,
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
const tool = (status: 'running' | 'done', title: string) =>
  event({
    type: 'tool',
    tool: {
      id: 'call:reply',
      kind: 'connector',
      title,
      status,
      started_at: AT,
      ended_at: status === 'done' ? AT : null,
      input_summary: null,
      output_summary: status === 'done' ? { text: 'They have raised it now' } : null,
      detail: null,
      parent: null,
    },
  } as ExperienceEvent['item']);

test('the step under way is named by its tool entry, and cleared when it finishes', () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  transcript = applyEvent(transcript, tool('running', 'Reading their reply'));
  expect(transcript.turns[0]?.live?.title).toBe('Reading their reply');
  transcript = applyEvent(transcript, tool('done', 'Read their reply'));
  expect(transcript.turns[0]?.live).toBeNull();
});

test('a chase that keeps going after the send keeps its trail open', () => {
  let transcript = fromTurns([TURN], 'send', 'working');
  const done = (summary: string) =>
    event({ type: 'done', summary, elapsed_ms: 1000, apps: ['Mail'], source_count: 1 });
  for (const item of [
    event({ type: 'say', text: 'Reading everything they have sent you.' }),
    done('Your draft is ready to review.'),
    event({ type: 'say', text: 'Sent from your address.' }),
    event({
      type: 'action',
      label: 'Read their reply',
      meta: 'They have raised it now',
      sources: [],
    }),
    done('Settled. £64.00 is back on your card.'),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ])
    transcript = applyEvent(transcript, item);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const html = renderToStaticMarkup(<Trail turn={turn} now={Date.parse(AT)} />);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('Read their reply');
});

test('nothing is under way once the turn stops running, even if its last entry never closed', () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  transcript = applyEvent(transcript, tool('running', 'Reading their reply'));
  expect(transcript.turns[0]?.live?.title).toBe('Reading their reply');
  transcript = applyEvent(
    transcript,
    event({ type: 'status', status: 'failed', composer: 'send' }),
  );
  expect(transcript.turns[0]?.live).toBeNull();
});
