/**
 * A routine's run says what it produced or why it did not finish, and links
 * to the thread with the whole answer. A list that could not be read says so
 * and offers a retry, never "nothing here".
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadError } from '../design/LoadError.tsx';
import type { AutomationRun } from '../experience/types.ts';
import { RunRow } from './Automations.tsx';
import { RoutineResults } from './RoutineResults.tsx';

const run = (over: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'att_1',
  status: 'done',
  started_at: '2026-09-30T03:00:00.000Z',
  finished_at: '2026-09-30T03:01:00.000Z',
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  summary: 'Two meetings today.',
  reason: null,
  ...over,
});

test('a finished run shows what it said and links to its result', () => {
  const html = renderToStaticMarkup(<RunRow run={run()} />);
  expect(html).toContain('Succeeded');
  expect(html).toContain('Two meetings today.');
  expect(html).toContain('href="#/chat/job_1"');
});

test('a failed run says why', () => {
  const html = renderToStaticMarkup(
    <RunRow
      run={run({
        status: 'failed',
        summary: null,
        reason: 'It failed: the calendar could not be reached.',
      })}
    />,
  );
  expect(html).toContain('Failed');
  expect(html).toContain('the calendar could not be reached');
});

test('Home lists the newest run of each routine, and nothing when none ran', () => {
  const now = Date.parse('2026-09-30T04:00:00.000Z');
  const html = renderToStaticMarkup(
    <RoutineResults
      now={now}
      results={[
        {
          automation_id: 'trg_1',
          title: 'Your morning brief',
          conversation_id: 'job_1',
          run: run(),
        },
      ]}
    />,
  );
  expect(html).toContain('From your routines');
  expect(html).toContain('Your morning brief · Finished');
  expect(html).toContain('Two meetings today.');
  expect(html).toContain('href="#/chat/job_1"');
  expect(renderToStaticMarkup(<RoutineResults now={now} results={[]} />)).toBe('');
});

test('a list that failed to load offers a retry instead of an empty state', () => {
  const html = renderToStaticMarkup(
    <LoadError what="your chats" error="The request could not be completed." onRetry={() => {}} />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain('Couldn’t load your chats.');
  expect(html).toContain('The request could not be completed.');
  expect(html).toContain('Retry');
  expect(html).not.toContain('Nothing yet');
});
