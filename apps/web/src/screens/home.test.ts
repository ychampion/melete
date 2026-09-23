/**
 * The brief under the greeting is composed from counts alone, so every clause
 * in it is a number the service returned. A clause whose count is zero is not
 * said, and small counts are spelled out.
 */
import { expect, test } from 'bun:test';
import { progressOf, toolOf } from '../experience/trace.ts';
import { briefLine } from './Home.tsx';

test('both clauses, spelled out, with the money the map totals', () => {
  expect(briefLine(2, 6, 481_100, 'GBP')).toBe(
    'Two decisions are waiting, and six companies owe you £4,811.',
  );
});

test('one of each reads in the singular', () => {
  expect(briefLine(1, 1, 6_400, 'GBP')).toBe(
    'One decision is waiting, and one company owes you £64.',
  );
});

test('a clause whose count is zero is dropped', () => {
  expect(briefLine(0, 3, 12_000, 'GBP')).toBe('Three companies owe you £120.');
  expect(briefLine(4, 0, 0, 'GBP')).toBe('Four decisions are waiting.');
  // Companies are only mentioned while the owed total is above zero.
  expect(briefLine(4, 2, 0, 'GBP')).toBe('Four decisions are waiting.');
  expect(briefLine(0, 0, 0, 'GBP')).toBeNull();
});

test('ten and above are figures', () => {
  expect(briefLine(12, 0, 0, 'GBP')).toBe('12 decisions are waiting.');
});

test('a trail step carries a tool entry only when the service sends one', () => {
  expect(toolOf({ type: 'action', label: 'Read', meta: '', sources: [] })).toBeNull();
  const tool = toolOf({
    type: 'action',
    label: 'Read',
    meta: '',
    sources: [],
    tool: {
      id: 'action:act_2',
      kind: 'web',
      title: 'Read a web page',
      status: 'done',
      input_summary: { text: 'On bistro.example' },
      output_summary: { text: 'Page read', quote: { text: 'Book a table', from: 'page' } },
    },
  });
  expect(tool?.title).toBe('Read a web page');
  expect(tool?.output_summary?.quote).toEqual({ text: 'Book a table', from: 'page' });
});

test('progress is read only when present, as steps and never a percentage', () => {
  expect(progressOf({ id: 'job_1', status: 'working' })).toBeNull();
  expect(progressOf({ progress: { steps_done: 3, current: 'Sending the email' } })).toEqual({
    steps_done: 3,
    current: 'Sending the email',
  });
  expect(progressOf({ progress: { steps_done: 2, current: null } })?.current).toBeNull();
});
