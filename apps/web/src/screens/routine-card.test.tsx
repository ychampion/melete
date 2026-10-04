/**
 * A routine whose job ended can be started again from its card; one that is
 * still on offers pause and a test run instead.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Automation, Run } from '../experience/types.ts';
import { RepeatingWorkCard, RoutineCard, repeats } from './Automations.tsx';

const routine = (over: Partial<Automation> = {}): Automation => ({
  id: 'trg_1',
  title: 'Your morning brief',
  schedule: 'Every day at 8:30 AM (UTC)',
  enabled: true,
  ended: false,
  conversation_id: 'job_1',
  runs: [],
  ...over,
});
const card = (automation: Automation) =>
  renderToStaticMarkup(
    <RoutineCard
      automation={automation}
      onChange={() => {}}
      onRemoved={() => {}}
      onReplaced={() => {}}
    />,
  );

test('an ended routine says it stopped and offers to start again', () => {
  const html = card(routine({ enabled: false, ended: true }));
  expect(html).toContain('Stopped');
  expect(html).toContain('Start again');
  expect(html).not.toContain('Pause');
  expect(html).not.toContain('Test run');
});

test('a routine that is on offers no start again', () => {
  const html = card(routine());
  expect(html).toContain('Pause');
  expect(html).not.toContain('Start again');
});

const work = (over: Partial<Run> = {}): Run => ({
  id: 'job_2',
  title: 'retest-routine',
  goal: 'Check in with me every Monday at 9:00',
  done_when: null,
  status: 'waiting',
  status_line: 'Waiting until next time',
  conversation_id: 'job_9',
  agent_id: null,
  started_at: '2026-10-04T09:00:00.000Z',
  finished_at: null,
  next_shift_at: '2026-10-05T09:00:00.000Z',
  standing: {
    kind: 'schedule',
    description: 'Every Monday at 9:00',
    next_wake_at: '2026-10-05T09:00:00.000Z',
  },
  shifts: 1,
  metric: null,
  limit: null,
  plan: null,
  latest_report: null,
  next: null,
  result: null,
  experiments: { count: 0, best: null, recent: [] },
  findings: 0,
  steps: [],
  question: null,
  check: { enabled: false, state: null, gaps: [] },
  ...over,
});
const workCard = (run: Run) =>
  renderToStaticMarkup(<RepeatingWorkCard run={run} onChange={() => {}} onStopped={() => {}} />);

test('only open work that repeats is shown as a routine', () => {
  expect(repeats(work())).toBe(true);
  expect(repeats(work({ standing: null }))).toBe(false);
  expect(repeats(work({ status: 'stopped' }))).toBe(false);
});

test('a routine set up in a conversation shows its schedule, and pause and stop', () => {
  const html = workCard(work());
  expect(html).toContain('retest-routine');
  expect(html).toContain('Every Monday at 9:00 · next');
  expect(html).toContain('On');
  expect(html).toContain('Pause');
  expect(html).toContain('Stop');
  expect(html).not.toContain('Resume');
});

test('a paused one says so and offers resume', () => {
  const html = workCard(
    work({
      status_line: 'Paused',
      standing: { kind: 'schedule', description: 'Every Monday at 9:00', next_wake_at: null },
    }),
  );
  expect(html).toContain('Paused');
  expect(html).toContain('Resume');
  expect(html).toContain('Every Monday at 9:00');
});
