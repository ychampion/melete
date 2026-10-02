/**
 * A routine whose job ended can be started again from its card; one that is
 * still on offers pause and a test run instead.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Automation } from '../experience/types.ts';
import { RoutineCard } from './Automations.tsx';

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
