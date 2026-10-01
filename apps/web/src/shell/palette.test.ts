/**
 * A palette row shows one title and a second line only when it adds
 * something; the connections every workspace starts with are not results.
 */
import { expect, test } from 'bun:test';
import type { SearchResult } from '../experience/types.ts';
import { secondaryOf, withoutBuiltins } from './palette.ts';

const hit = (over: Partial<SearchResult>): SearchResult => ({
  id: 'x_1',
  kind: 'conversation',
  title: 'Kyoto in October',
  meta: 'Conversation',
  conversation_id: null,
  ...over,
});

test('a line that only restates the kind or the title is left out', () => {
  expect(secondaryOf(hit({}))).toBeNull();
  expect(secondaryOf(hit({ kind: 'plan', meta: 'Plan' }))).toBeNull();
  expect(secondaryOf(hit({ kind: 'task', meta: 'Task' }))).toBeNull();
  expect(secondaryOf(hit({ kind: 'connection', title: 'Mail', meta: 'Mail' }))).toBeNull();
  expect(
    secondaryOf(hit({ kind: 'connection', title: 'Work inbox', meta: 'Connected app' })),
  ).toBeNull();
  expect(secondaryOf(hit({ meta: '  ' }))).toBeNull();
});

test('a line that adds something stays, in plain words', () => {
  expect(secondaryOf(hit({ kind: 'plan', meta: 'Travel' }))).toBe('Travel');
  expect(secondaryOf(hit({ kind: 'task', meta: 'Completed task' }))).toBe('Done');
  expect(secondaryOf(hit({ kind: 'connection', title: 'Work inbox', meta: 'Mail' }))).toBe('Mail');
  expect(secondaryOf(hit({ kind: 'action', meta: 'Dinner on Friday' }))).toBe('Dinner on Friday');
  const when = secondaryOf(hit({ kind: 'event', meta: '2026-10-02T15:00:00.000Z' }));
  expect(when).toMatch(/^\w{3}, \w{3} \d{1,2} · \d{1,2}:\d{2}\s?[AP]M$/);
  expect(secondaryOf(hit({ kind: 'event', meta: 'Thursday' }))).toBe('Thursday');
});

test('built-in connections are dropped and everything else is kept', () => {
  const hits = [
    hit({ id: 'c_files', kind: 'connection', title: 'Files' }),
    hit({ id: 'c_mail', kind: 'connection', title: 'Mail' }),
    hit({ id: 'c_files', kind: 'conversation' }),
  ];
  const kept = withoutBuiltins(hits, new Set(['c_files']));
  expect(kept.map((row) => `${row.kind}:${row.id}`)).toEqual([
    'connection:c_mail',
    'conversation:c_files',
  ]);
});
