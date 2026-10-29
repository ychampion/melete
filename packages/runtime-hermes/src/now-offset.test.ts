import { describe, expect, test } from 'bun:test';
import {
  CALENDAR_DAYS,
  CLOCK_CHANGE_NOTE,
  calendarStrip,
  renderNow,
  utcOffset,
} from './instructions.ts';

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

/** The ISO time for a local wall time on a strip date, with the offset the strip shows for it. */
function isoFor(strip: string[], date: string, wall: string, today: string): string {
  const shown = strip.find((day) => day.startsWith(date));
  if (!shown) throw new Error(`${date} is not in the strip`);
  const offset = shown.match(/UTC([+-]\d{2}:\d{2})/)?.[1] ?? today;
  return new Date(`${wall}${offset}`).toISOString();
}

describe('a clock change in the next two weeks', () => {
  test('set on 29 October in Los Angeles, 9 AM on 2 November is 17:00 UTC', () => {
    const at = '2026-10-29T16:00:00Z';
    const strip = calendarStrip(at, 'America/Los_Angeles', CALENDAR_DAYS);
    expect(strip[0]).toBe('Thu 29 Oct 2026 (today)');
    expect(strip).toContain('Sat 31 Oct 2026');
    // The clocks go back at 2 AM on 1 November.
    expect(strip).toContain('Sun 1 Nov 2026 (UTC-08:00)');
    expect(strip).toContain('Mon 2 Nov 2026 (UTC-08:00)');
    expect(isoFor(strip, 'Mon 2 Nov 2026', '2026-11-02T09:00:00', '-07:00')).toBe(
      '2026-11-02T17:00:00.000Z',
    );
    const lines = renderNow({
      at,
      time_zone: 'America/Los_Angeles',
      city: null,
      zone_mismatch: null,
    });
    expect(lines).toContain(CLOCK_CHANGE_NOTE);
  });

  test('set on 5 March in Los Angeles, 9 AM on 9 March is 16:00 UTC', () => {
    const strip = calendarStrip('2026-03-05T17:00:00Z', 'America/Los_Angeles', CALENDAR_DAYS);
    expect(strip).toContain('Sat 7 Mar 2026');
    // The clocks go forward at 2 AM on 8 March.
    expect(strip).toContain('Sun 8 Mar 2026 (UTC-07:00)');
    expect(strip).toContain('Mon 9 Mar 2026 (UTC-07:00)');
    expect(isoFor(strip, 'Mon 9 Mar 2026', '2026-03-09T09:00:00', '-08:00')).toBe(
      '2026-03-09T16:00:00.000Z',
    );
  });

  test('the change day itself, seen before the change, shows the offset it keeps', () => {
    // 1:30 AM on 1 November, still daylight time.
    const strip = calendarStrip('2026-11-01T08:30:00Z', 'America/Los_Angeles', 2);
    expect(strip).toEqual(['Sun 1 Nov 2026 (today, UTC-08:00)', 'Mon 2 Nov 2026 (UTC-08:00)']);
  });

  test('a zone that keeps one offset all year shows no change', () => {
    for (const at of ['2026-10-29T16:00:00Z', '2026-03-05T17:00:00Z']) {
      const strip = calendarStrip(at, 'Asia/Kolkata', CALENDAR_DAYS);
      expect(strip.join(', ')).not.toContain('UTC');
      const lines = renderNow({ at, time_zone: 'Asia/Kolkata', city: null, zone_mismatch: null });
      expect(lines).not.toContain(CLOCK_CHANGE_NOTE);
    }
  });
});
