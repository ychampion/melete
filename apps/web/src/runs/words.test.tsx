/**
 * Long work reads in plain words: the record's parts have friendly labels,
 * the status is one short word, and tries read as "14 tries · best 0.873".
 * The full record shows each part under its label, with a try's value and
 * whether it was confirmed from its output.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Run, RunEntry } from '../experience/types.ts';
import { RecordTimeline } from './Record.tsx';
import {
  ago,
  appendEntries,
  excerpt,
  formatValue,
  isPaused,
  lastActivity,
  RECORD_LABEL,
  recordFileName,
  recordLabel,
  statusOf,
  triesLine,
  workOrder,
} from './words.ts';

const run = (over: Partial<Run> = {}): Run => ({
  id: 'job_1',
  title: 'Kyoto trip under budget',
  goal: 'Find the cheapest good way to Kyoto.',
  done_when: null,
  status: 'working',
  status_line: 'Working on it',
  conversation_id: null,
  agent_id: null,
  started_at: '2026-10-01T08:00:00.000Z',
  finished_at: null,
  next_shift_at: null,
  shifts: 2,
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

const entry = (over: Partial<RunEntry> = {}): RunEntry => ({
  id: 'e1',
  kind: 'note',
  title: 'A note',
  body: '',
  step_id: null,
  data: {},
  created_at: '2026-10-01T09:00:00.000Z',
  ...over,
});

const INTERNAL = /\b(run|shift|checkpoint|experiment|metric|token|attempt|job)s?\b/i;

test('every record kind has a plain label with no internal word', () => {
  for (const label of Object.values(RECORD_LABEL)) expect(label).not.toMatch(INTERNAL);
  expect(recordLabel({ kind: 'experiment' })).toBe('Tried');
  expect(recordLabel({ kind: 'checkpoint' })).toBe('Progress saved');
  expect(recordLabel({ kind: 'step_started' })).toBe('Helper started');
  expect(recordLabel({ kind: 'report' })).toBe('Update');
  expect(recordLabel({ kind: 'finding' })).toBe('Found');
});

test('paused work is told apart from work that is resting', () => {
  expect(isPaused(run({ status: 'waiting', status_line: 'Paused · 3 tries' }))).toBe(true);
  expect(isPaused(run({ status: 'waiting', status_line: 'Picks up again later' }))).toBe(false);
  expect(statusOf(run({ status: 'waiting', status_line: 'Paused' })).word).toBe('Paused');
  expect(statusOf(run({ status: 'needs_you' }))).toEqual({ word: 'Needs you', tone: 'needs' });
  expect(statusOf(run({ status: 'done' })).tone).toBe('settled');
});

test('tries read as a count and the best value, with the measure named', () => {
  const best = {
    id: 'e9',
    title: 'Osaka, rail pass',
    value: 0.87312,
    outcome: 'kept' as const,
    checked: true,
    created_at: '2026-10-01T10:00:00.000Z',
  };
  expect(triesLine(run())).toBeNull();
  expect(triesLine(run({ experiments: { count: 1, best: null, recent: [] } }))).toBe('1 try');
  expect(
    triesLine(
      run({
        experiments: { count: 41, best, recent: [] },
        metric: { name: 'accuracy', direction: 'higher' },
      }),
    ),
  ).toBe('41 tries · best accuracy 0.8731');
  expect(formatValue(2948)).toBe('2,948');
  expect(formatValue(0.1 + 0.2)).toBe('0.3');
});

test('times, excerpts and file names stay short and readable', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  expect(ago('2026-10-02T11:59:40.000Z', now)).toBe('just now');
  expect(ago('2026-10-02T11:48:00.000Z', now)).toBe('12 min ago');
  expect(ago('2026-10-02T09:00:00.000Z', now)).toBe('3 hr ago');
  expect(ago('2026-10-01T09:00:00.000Z', now)).toBe('yesterday');
  expect(ago('2026-09-28T09:00:00.000Z', now)).toBe('4 days ago');
  expect(excerpt('word '.repeat(80), 40).endsWith('…')).toBe(true);
  expect(excerpt('Short and sweet.')).toBe('Short and sweet.');
  expect(recordFileName('Kyoto trip, under budget!')).toBe('kyoto-trip-under-budget-record.md');
});

test('the newest moment counts as the last update, and work that needs the person leads', () => {
  const updated = run({
    latest_report: { title: 'Update', body: '', created_at: '2026-10-01T15:00:00.000Z' },
  });
  expect(lastActivity(updated)).toBe('2026-10-01T15:00:00.000Z');
  const order = workOrder([
    run({ id: 'done', status: 'done' }),
    run({ id: 'moving' }),
    run({ id: 'asks', status: 'needs_you', started_at: '2026-09-01T08:00:00.000Z' }),
  ]).map((item) => item.id);
  expect(order).toEqual(['asks', 'moving', 'done']);
});

test('a later page joins the end without repeating what is shown', () => {
  const shown = [entry({ id: 'a' }), entry({ id: 'b' })];
  expect(appendEntries(shown, [entry({ id: 'b' }), entry({ id: 'c' })]).map((e) => e.id)).toEqual([
    'a',
    'b',
    'c',
  ]);
});

test('the record shows plain labels, the helper, and a confirmed try', () => {
  const html = renderToStaticMarkup(
    <RecordTimeline
      entries={[
        entry({ id: 'p', kind: 'plan', title: 'How I’ll go about it' }),
        entry({
          id: 'x',
          kind: 'experiment',
          title: 'Fly into Osaka',
          data: { value: 2948, outcome: 'kept', checked: true },
        }),
        entry({
          id: 'c',
          kind: 'checkpoint',
          title: 'Flights priced',
          data: { next: 'Price the rail pass' },
        }),
        entry({ id: 's', kind: 'step_finished', title: 'Ryokan prices', step_id: 'job_h' }),
        entry({ id: 'n', kind: 'note', title: 'A side note', step_id: 'job_h' }),
      ]}
      helpers={new Map([['job_h', 'Compare ryokan prices']])}
      more
      loading={false}
      onMore={() => {}}
    />,
  );
  for (const label of ['Plan', 'Tried', 'Progress saved', 'Helper finished'])
    expect(html).toContain(`>${label}<`);
  expect(html).toContain('2,948');
  expect(html).toContain('Kept');
  expect(html).toContain('confirmed from its output');
  expect(html).toContain('Next: Price the rail pass');
  // Named once, on the note it wrote, not again on its own finish.
  expect(html.split('Compare ryokan prices').length - 1).toBe(1);
  expect(html).toContain('Load more');
  expect(html).not.toMatch(/>(experiment|checkpoint|step_finished)</);
});

test('an empty record says so plainly', () => {
  const html = renderToStaticMarkup(
    <RecordTimeline
      entries={[]}
      helpers={new Map()}
      more={false}
      loading={false}
      onMore={() => {}}
    />,
  );
  expect(html).toContain('Nothing recorded yet.');
});
