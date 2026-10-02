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
import { stoppedLine, Trail } from './parts.tsx';

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

const reasoning = (text: string) => event({ type: 'reasoning', text });
const finished = (elapsed_ms = 3000) =>
  event({ type: 'done', summary: 'Hey!', elapsed_ms, apps: [], source_count: 0 });
const count = (html: string, text: string) => html.split(text).length - 1;

test('reasoning pieces become one step in the trail, never part of the answer', () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  for (const item of [reasoning('The person said hey. '), reasoning('Greet them back.')])
    transcript = applyEvent(transcript, item);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  expect(turn.trail).toEqual([
    { type: 'reasoning', text: 'The person said hey. Greet them back.' },
  ]);
  expect(turn.streamed).toBe('');
  // While the agent works and has said nothing yet, the reasoning is in view.
  const html = renderToStaticMarkup(<Trail turn={turn} now={Date.parse(AT)} />);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('The person said hey. Greet them back.');
  expect(html).toContain('Working');
});

test('once the answer is being drawn, the trail closes to its live header', () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  transcript = applyEvent(transcript, reasoning('Greet them back.'));
  transcript = applyEvent(transcript, event({ type: 'text_delta', text: 'Hey' }));
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const html = renderToStaticMarkup(<Trail turn={turn} now={Date.parse(AT)} answering />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('Working');
  expect(html).not.toContain('Greet them back.');
});

test('a finished turn says once how long it worked, closed, and opens onto its steps', () => {
  let transcript = fromTurns([TURN], 'send', 'working');
  for (const item of [
    reasoning('Greet them back.'),
    finished(),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ])
    transcript = applyEvent(transcript, item);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const html = renderToStaticMarkup(<Trail turn={turn} now={Date.parse(AT)} answering />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls=');
  expect(count(html, 'Worked for 3s')).toBe(1);
  expect(html).not.toContain('Greet them back.');
});

test('a finished turn with no steps has a header and nothing to open', () => {
  let transcript = fromTurns([TURN], 'send', 'working');
  for (const item of [finished(), event({ type: 'status', status: 'done', composer: 'send' })])
    transcript = applyEvent(transcript, item);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const html = renderToStaticMarkup(<Trail turn={turn} now={Date.parse(AT)} answering />);
  expect(count(html, 'Worked for 3s')).toBe(1);
  expect(html).not.toContain('<button');
});

test('a running turn shows its live header before any step arrives', () => {
  const transcript = fromTurns([TURN], 'pause', 'working');
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const html = renderToStaticMarkup(<Trail turn={turn} now={Date.parse(AT) + 4000} />);
  expect(html).toContain('Working · 4s');
});

test('a stopped turn counts its steps once, the same way in the header and the line under it', () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  const step = (id: string, status: 'running' | 'done', title: string) =>
    event({
      type: 'tool',
      tool: {
        id,
        kind: 'web',
        title,
        status,
        started_at: AT,
        ended_at: status === 'done' ? '2026-09-24T09:00:04.000Z' : null,
        input_summary: null,
        output_summary: null,
        detail: null,
        parent: null,
      },
    } as ExperienceEvent['item']);
  for (const item of [
    step('call:a', 'done', 'Searched the web'),
    step('call:b', 'done', 'Read a listing'),
    step('call:c', 'running', 'Reading another listing'),
    event({ type: 'status', status: 'stopped', composer: 'send' }),
  ])
    transcript = applyEvent(transcript, item);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const html = renderToStaticMarkup(<Trail turn={turn} now={Date.parse(AT) + 600_000} />);
  expect(html).toContain('Stopped after 4s');
  expect(html).toContain('3 steps');
  expect(html).toContain('after 3 steps');
  expect(html).not.toContain('after 2 steps');
  expect(stoppedLine([])).toContain('before it got to work');
  expect(stoppedLine([{ title: 'Read a page' }])).toContain('after 1 step. Last: Read a page.');
});
