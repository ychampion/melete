/**
 * Words sent while the agent works: drawn inside the running turn at once,
 * marked queued until the agent reads them and delivered after, and gone
 * from the turn when it ended first and they became the next message.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LogEntries } from '../chat/WorkLog.tsx';
import { logItems } from '../chat/worklog.ts';
import {
  acceptLocalSteer,
  addLocalSteer,
  applyEvents,
  dropLocalSteer,
  fromTurns,
  type Transcript,
} from './reduce.ts';
import type { ExperienceEvent, Turn } from './types.ts';

const AT = '2026-10-01T09:00:00.000Z';
const TURN: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'Find me a keyboard.',
  answer: '',
  status: 'working',
  delivery: null,
  created_at: AT,
};
let seq = 0;
const event = (item: ExperienceEvent['item'], turn = 'turn_1'): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: turn,
  created_at: AT,
  item,
});
const steers = (transcript: Transcript) =>
  transcript.turns.flatMap((turn) =>
    turn.flow.flatMap((entry) =>
      entry.type === 'steer' ? [{ turn: turn.id, id: entry.id, state: entry.state }] : [],
    ),
  );
const running = () =>
  applyEvents(fromTurns([TURN], 'stop', 'working'), [
    event({ type: 'text_delta', text: 'Looking at keyboards.' }),
  ]);

test('words sent while the turn runs are drawn in it, queued, then delivered', () => {
  let transcript = addLocalSteer(running(), 'local_steer_1', 'Wireless only.');
  expect(steers(transcript)).toEqual([{ turn: 'turn_1', id: 'local_steer_1', state: 'sending' }]);
  transcript = acceptLocalSteer(transcript, 'local_steer_1', 'steer_a');
  transcript = applyEvents(transcript, [
    event({ type: 'steer', id: 'steer_a', text: 'Wireless only.', state: 'queued' }),
  ]);
  expect(steers(transcript)).toEqual([{ turn: 'turn_1', id: 'steer_a', state: 'queued' }]);
  transcript = applyEvents(transcript, [
    event({ type: 'steer', id: 'steer_a', state: 'delivered' }),
  ]);
  expect(steers(transcript)).toEqual([{ turn: 'turn_1', id: 'steer_a', state: 'delivered' }]);
  // A late copy of the queued item does not undo the delivery.
  transcript = applyEvents(transcript, [
    event({ type: 'steer', id: 'steer_a', text: 'Wireless only.', state: 'queued' }),
  ]);
  expect(steers(transcript)[0]?.state).toBe('delivered');
});

test('the stream drawing them before the send is answered leaves one copy', () => {
  let transcript = addLocalSteer(running(), 'local_steer_1', 'Wireless only.');
  transcript = applyEvents(transcript, [
    event({ type: 'steer', id: 'steer_a', text: 'Wireless only.', state: 'queued' }),
  ]);
  transcript = acceptLocalSteer(transcript, 'local_steer_1', 'steer_a');
  expect(steers(transcript)).toEqual([{ turn: 'turn_1', id: 'steer_a', state: 'queued' }]);
});

test('words the turn ended without reading leave it, and words not taken are undrawn', () => {
  let transcript = applyEvents(running(), [
    event({ type: 'steer', id: 'steer_a', text: 'Under 50 dollars.', state: 'queued' }),
    event({ type: 'steer', id: 'steer_a', state: 'carried' }, 'turn_2'),
  ]);
  expect(steers(transcript)).toEqual([]);
  transcript = dropLocalSteer(addLocalSteer(transcript, 'local_steer_2', 'Hi'), 'local_steer_2');
  expect(steers(transcript)).toEqual([]);
});

test('the log shows them where they were sent, with where they are', () => {
  const transcript = applyEvents(running(), [
    event({ type: 'steer', id: 'steer_a', text: 'Wireless only.', state: 'queued' }),
  ]);
  const turn = transcript.turns[0];
  if (!turn) throw new Error('missing');
  const items = logItems(turn);
  expect(items.map((item) => item.type)).toEqual(['message', 'steer']);
  const html = renderToStaticMarkup(
    <LogEntries items={items} live streaming={false} renderBlock={() => null} />,
  );
  expect(html).toContain('Wireless only.');
  expect(html).toContain('Queued for the next step');
});
