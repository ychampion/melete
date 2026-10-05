import { describe, expect, test } from 'bun:test';
import { sourcesNamed, sourceWords } from './needs.ts';

describe('the sources a goal names', () => {
  test('a day or its meetings is the calendar; an inbox is mail', () => {
    expect(sourcesNamed('Every weekday at 8am summarize my day')).toEqual(['calendar']);
    expect(sourcesNamed('List tomorrow’s meetings')).toEqual(['calendar']);
    expect(sourcesNamed('Sort my inbox and flag what needs a reply')).toEqual(['mail']);
    expect(sourcesNamed('Brief me on my calendar and unread email')).toEqual(['calendar', 'mail']);
  });

  test('work that names neither needs nothing connected', () => {
    expect(sourcesNamed('Check the supplier price list and tell me what changed')).toEqual([]);
    expect(sourcesNamed('Run this on a schedule every Monday')).toEqual([]);
  });

  test('both are said together', () => {
    expect(sourceWords(['calendar', 'mail'])).toBe('calendar and email');
  });
});
