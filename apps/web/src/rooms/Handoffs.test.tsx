/**
 * A room's task on Home: waiting to run, running with the person's setup, or
 * a result to share. A running one stays in sight and asks nothing of them.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoomHandoff } from '../experience/types.ts';
import { RoomHandoffs } from './Handoffs.tsx';

const base = {
  id: 'rho_1',
  room: { id: 'sp_1', name: 'Launch' },
  thread_id: 'rth_1',
  asked_by: { principal_id: 'own_bob', display_name: 'Bob <p3vz8ndr>' },
  task: 'Send the agency a note from my email.',
  task_hash: 'a'.repeat(64),
  job_id: null,
  result: null,
  result_hash: null,
  created_at: '2026-10-02T10:00:00.000Z',
  decided_at: null,
  expires_at: '2026-10-09T10:00:00.000Z',
};
const render = (handoffs: RoomHandoff[]) =>
  renderToStaticMarkup(<RoomHandoffs handoffs={handoffs} onChanged={() => {}} />);

test('a running task stays on Home as running, with nothing to answer and no count', () => {
  const running = { ...base, state: 'running', job_id: 'job_9' } as RoomHandoff;
  const html = render([running]);
  expect(html).toContain('Running with your setup for Launch');
  expect(html).toContain('Send the agency a note from my email.');
  expect(html).toContain('Open the room');
  expect(html).not.toContain('Run with my setup');
  expect(html).not.toContain('Decline');
  expect(html).not.toContain('nav-count');
});

test('a task to run is counted and offers to run it or decline', () => {
  const html = render([{ ...base, state: 'pending' } as RoomHandoff]);
  expect(html).toContain('Run with my setup');
  expect(html).toContain('Decline');
  expect(html).toContain('nav-count');
});
