/**
 * Tool entries in a turn's work. The step under way is named by the running
 * entry the stream sends; a job that keeps going after it first settles (a
 * chase: the send, then the reply and the follow-up) keeps every message it
 * said, in order; reasoning stays in the data and is never drawn.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyEvent, fromTurns } from '../experience/reduce.ts';
import type { ExperienceEvent, Turn } from '../experience/types.ts';
import { stoppedLine } from './parts.tsx';
import { WorkLog } from './WorkLog.tsx';
import { layoutTurn } from './worklog.ts';

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
  const layout = layoutTurn(turn);
  const said = layout.log.flatMap((item) => (item.type === 'message' ? [item.text] : []));
  expect(said).toEqual(['Reading everything they have sent you.']);
  expect(layout.answer).toBe('Sent from your address.');
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(AT)}
      items={layout.log}
      finished
      renderBlock={() => null}
    />,
  );
  expect(html).toContain('Worked for');
  expect(layout.after.some((item) => item.type === 'work')).toBe(true);
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

test('reasoning pieces become one step in the data, never part of the answer, never drawn', () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  for (const item of [reasoning('The person said hey. '), reasoning('Greet them back.')])
    transcript = applyEvent(transcript, item);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  expect(turn.trail).toEqual([
    { type: 'reasoning', text: 'The person said hey. Greet them back.' },
  ]);
  expect(turn.streamed).toBe('');
  expect(turn.flow).toEqual([]);
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(AT)}
      items={layoutTurn(turn).log}
      finished={false}
      renderBlock={() => null}
    />,
  );
  expect(html).not.toContain('Greet them back.');
  expect(html).toContain('Working');
});

test('a finished turn says once how long it worked', () => {
  let transcript = fromTurns([TURN], 'send', 'working');
  for (const item of [
    reasoning('Greet them back.'),
    event({ type: 'text_delta', text: 'Looking.' }),
    tool('done', 'Read their reply'),
    event({ type: 'text_delta', text: 'Hey!' }),
    finished(),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ])
    transcript = applyEvent(transcript, item);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const layout = layoutTurn(turn);
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(AT)}
      items={layout.log}
      finished
      renderBlock={() => null}
    />,
  );
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls=');
  expect(count(html, 'Worked for 3s')).toBe(1);
  expect(html).not.toContain('Greet them back.');
  expect(layout.answer).toBe('Hey!');
});

test('a finished turn with nothing but its answer has no header to open', () => {
  let transcript = fromTurns([TURN], 'send', 'working');
  for (const item of [
    event({ type: 'text_delta', text: 'Hey!' }),
    finished(),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ])
    transcript = applyEvent(transcript, item);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const layout = layoutTurn(turn);
  expect(layout.log).toEqual([]);
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(AT)}
      items={layout.log}
      finished
      renderBlock={() => null}
    />,
  );
  expect(html).toBe('');
});

test('a running turn shows its live header before any step arrives', () => {
  const transcript = fromTurns([TURN], 'pause', 'working');
  const turn = transcript.turns[0];
  if (!turn) throw new Error('no turn');
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(AT) + 4000}
      items={[]}
      finished={false}
      renderBlock={() => null}
    />,
  );
  expect(html).toContain('Working for 4s');
});

test('a stopped turn counts its steps once in the line under its header', () => {
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
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(AT) + 600_000}
      items={layoutTurn(turn).log}
      finished
      renderBlock={() => null}
    />,
  );
  expect(html).toContain('Stopped after 4s');
  expect(html).toContain('after 3 steps');
  expect(html).not.toContain('after 2 steps');
  expect(stoppedLine([])).toContain('before it got to work');
  expect(stoppedLine([{ title: 'Read a page' }])).toContain('after 1 step. Last: Read a page.');
});
