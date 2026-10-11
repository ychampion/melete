/** A routine run that finished with nothing to show is not called a success. */
import { expect, test } from 'bun:test';
import type { AutomationRun } from '../experience/types.ts';
import { runLabel } from './Automations.tsx';

const run = (patch: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'att_1',
  status: 'done',
  started_at: '2026-10-10T08:30:00.000Z',
  finished_at: '2026-10-10T08:31:00.000Z',
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  summary: null,
  reason: null,
  ...patch,
});

test('a run with a result succeeded', () => {
  expect(runLabel(run())).toBe('Succeeded');
});

test('a run where some steps were held back is partly done, not a success', () => {
  expect(runLabel(run({ partial: true }))).toBe('Partly done');
});

test('a run whose every step failed finished with nothing', () => {
  expect(runLabel(run({ empty: true }))).toBe('Finished with nothing');
});
