import { describe, expect, test } from 'bun:test';
import { renderNow, utcOffset } from './instructions.ts';

describe("the person's UTC offset beside their local time", () => {
  test('it follows daylight saving for the date shown', () => {
    expect(utcOffset('2026-11-03T17:15:00Z', 'America/Los_Angeles')).toBe('UTC-08:00');
    expect(utcOffset('2026-07-14T16:15:00Z', 'America/Los_Angeles')).toBe('UTC-07:00');
  });

  test('a half-hour zone, UTC itself, and an unknown zone', () => {
    expect(utcOffset('2026-11-03T03:45:00Z', 'Asia/Kolkata')).toBe('UTC+05:30');
    expect(utcOffset('2026-01-10T03:45:00Z', 'Australia/Adelaide')).toBe('UTC+10:30');
    expect(utcOffset('2026-01-10T03:45:00Z', 'UTC')).toBe('UTC+00:00');
    expect(utcOffset('2026-01-10T03:45:00Z', 'Mars/Olympus')).toBeNull();
  });

  test('the Now section says it with the zone', () => {
    const now = (at: string) =>
      renderNow({ at, time_zone: 'America/Los_Angeles', city: null, zone_mismatch: null }).join(
        '\n',
      );
    expect(now('2026-11-03T17:15:00Z')).toContain(
      'It is Tuesday, November 3, 2026 at 9:15 AM for the person (America/Los_Angeles, UTC-08:00).',
    );
    expect(now('2026-07-14T16:15:00Z')).toContain('(America/Los_Angeles, UTC-07:00).');
  });
});
