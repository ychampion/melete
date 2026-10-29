import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Loaded } from '../experience/hooks.ts';
import type { Home, Task } from '../experience/types.ts';
import { Rail } from './Shell.tsx';

const loaded = <T,>(data: T): Loaded<T> => ({
  data,
  error: null,
  unavailable: null,
  loading: false,
  reload() {},
  set() {},
});

test('the upcoming rail shows recurrence words and identifies all-day occurrences', () => {
  const home: Home = {
    greeting: 'Good morning',
    date: 'Sunday, 1 November',
    time_zone: 'America/Los_Angeles',
    within_day_hours: true,
    tasks: [],
    open_task_count: 0,
    routine_results: [],
    upcoming: [
      {
        id: 'con_cal:daily',
        title: 'Holiday',
        connection_id: 'con_cal',
        starts_at: '2026-11-01T07:00:00.000Z',
        ends_at: '2026-11-02T08:00:00.000Z',
        all_day: true,
        recurrence_summary: 'Every day',
      },
    ],
  };
  const html = renderToStaticMarkup(
    <Rail day={{ home: loaded(home), tasks: loaded<{ tasks: Task[] }>({ tasks: [] }) }} />,
  );
  expect(html).toContain('Holiday');
  expect(html).toContain('All day');
  expect(html).toContain('Every day');
  expect(html).not.toContain('25 hours');
});
