import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResultCard as ResultCardData } from '../experience/types.ts';
import { ResultCard } from './parts.tsx';

const card = (facts: ResultCardData['facts']): ResultCardData => ({
  id: 'act_calendar:0',
  title: 'Planning',
  meta: 'My calendar',
  facts,
  primary_action: null,
  secondary_actions: [],
  source_connection: 'con_cal',
});

test('a recurring result card renders its next date and plain recurrence summary', () => {
  const html = renderToStaticMarkup(
    <ResultCard
      card={card([
        { label: 'Next', value: '2026-11-03T17:00:00.000Z' },
        { label: 'Repeats', value: 'Every Tuesday' },
      ])}
      readOnly
    />,
  );
  expect(html).toContain('Next');
  // Cards show the next date the way people read it, not the raw timestamp.
  expect(html).toContain('Nov 3');
  expect(html).not.toContain('2026-11-03T17:00:00.000Z');
  expect(html).toContain('Every Tuesday');
  expect(html).not.toContain('Starts');
});

test('an ended recurring result card renders the ended status without a stale date', () => {
  const html = renderToStaticMarkup(
    <ResultCard
      card={card([
        { label: 'Status', value: 'Series ended' },
        { label: 'Repeats', value: 'Every Tuesday, 3 times' },
      ])}
      readOnly
    />,
  );
  expect(html).toContain('Series ended');
  expect(html).toContain('Every Tuesday, 3 times');
  expect(html).not.toContain('Starts');
  expect(html).not.toContain('Next');
});
