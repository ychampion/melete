import { describe, expect, test } from 'bun:test';
import { digestWeek, dueDigest, nextDigestAt, withinDayHours } from './digest.ts';
import { dayWindow, zonedInstant } from './zoned.ts';

const hours = { start: '08:00', end: '22:00' };
const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

describe('local days', () => {
  test('a day is 24 hours, except the days the clocks change', () => {
    const plain = dayWindow('2026-06-10', 'America/New_York');
    expect(plain.start.toISOString()).toBe('2026-06-10T04:00:00.000Z');
    expect(hoursBetween(plain.start, plain.end)).toBe(24);
    // US clocks spring forward on 8 March 2026 and fall back on 1 November.
    expect(
      hoursBetween(...(Object.values(dayWindow('2026-03-08', 'America/New_York')) as [Date, Date])),
    ).toBe(23);
    expect(
      hoursBetween(...(Object.values(dayWindow('2026-11-01', 'America/New_York')) as [Date, Date])),
    ).toBe(25);
    // Europe changes on 29 March and 25 October 2026.
    expect(
      hoursBetween(...(Object.values(dayWindow('2026-03-29', 'Europe/London')) as [Date, Date])),
    ).toBe(23);
  });
  test('a wall time the clocks skip lands just after the gap; a repeated one is its first', () => {
    expect(zonedInstant('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(zonedInstant('2026-11-01', '01:30', 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(zonedInstant('2026-09-27', '08:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-09-27T02:30:00.000Z',
    );
  });
});

describe('the weekly digest schedule', () => {
  test('it is due on Sunday at the start of the person’s day, in their own zone', () => {
    // Sunday 27 September 2026.
    const kolkata = digestWeek(new Date('2026-09-27T03:00:00Z'), 'Asia/Kolkata', hours);
    expect(kolkata.weekOf).toBe('2026-09-27');
    expect(kolkata.dueAt.toISOString()).toBe('2026-09-27T02:30:00.000Z');
    expect(kolkata.windowStart.toISOString()).toBe('2026-09-20T02:30:00.000Z');
    // The same instant is still Saturday night in Los Angeles: last week's is the latest.
    const la = digestWeek(new Date('2026-09-27T03:00:00Z'), 'America/Los_Angeles', hours);
    expect(la.weekOf).toBe('2026-09-20');
    expect(la.dueAt.toISOString()).toBe('2026-09-20T15:00:00.000Z');
    // Auckland is already a day ahead.
    expect(
      nextDigestAt(new Date('2026-09-26T19:00:00Z'), 'Pacific/Auckland', hours).toISOString(),
    ).toBe('2026-10-03T19:00:00.000Z');
  });

  test('a week the clocks change in is built from wall times: 167 or 169 hours', () => {
    const spring = digestWeek(new Date('2026-03-08T20:00:00Z'), 'America/New_York', hours);
    expect(spring.weekOf).toBe('2026-03-08');
    expect(spring.dueAt.toISOString()).toBe('2026-03-08T12:00:00.000Z');
    expect(hoursBetween(spring.windowStart, spring.windowEnd)).toBe(167);
    const autumn = digestWeek(new Date('2026-11-01T20:00:00Z'), 'America/New_York', hours);
    expect(autumn.dueAt.toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(hoursBetween(autumn.windowStart, autumn.windowEnd)).toBe(169);
    // The Sunday after, both before and after the change, it is 08:00 local.
    expect(
      nextDigestAt(new Date('2026-03-02T12:00:00Z'), 'America/New_York', hours).toISOString(),
    ).toBe('2026-03-08T12:00:00.000Z');
    expect(
      nextDigestAt(new Date('2026-03-09T12:00:00Z'), 'America/New_York', hours).toISOString(),
    ).toBe('2026-03-15T12:00:00.000Z');
  });

  test('never inside quiet hours: one due at night waits for the morning', () => {
    // Day hours 09:00 to 21:00 in London; Sunday 27 September 2026.
    const london = { start: '09:00', end: '21:00' };
    expect(
      dueDigest(new Date('2026-09-27T07:30:00Z'), 'Europe/London', london, '2026-09-20'),
    ).toBeNull();
    expect(
      dueDigest(new Date('2026-09-27T08:00:00Z'), 'Europe/London', london, '2026-09-20')?.weekOf,
    ).toBe('2026-09-27');
    // Sunday 21:30 is quiet; Monday 09:10 writes the Sunday it missed.
    expect(
      dueDigest(new Date('2026-09-27T20:30:00Z'), 'Europe/London', london, '2026-09-20'),
    ).toBeNull();
    expect(
      dueDigest(new Date('2026-09-28T08:10:00Z'), 'Europe/London', london, '2026-09-20')?.weekOf,
    ).toBe('2026-09-27');
    // A week missed by more than two days waits for the next Sunday.
    expect(
      dueDigest(new Date('2026-10-01T10:00:00Z'), 'Europe/London', london, '2026-09-20'),
    ).toBeNull();
    // Once written, the week is not written again.
    expect(
      dueDigest(new Date('2026-09-28T08:10:00Z'), 'Europe/London', london, '2026-09-27'),
    ).toBeNull();
  });

  test('day hours that cross midnight are read the right way round', () => {
    const night = { start: '18:00', end: '02:00' };
    expect(withinDayHours(new Date('2026-09-27T23:00:00Z'), 'UTC', night)).toBe(true);
    expect(withinDayHours(new Date('2026-09-27T01:00:00Z'), 'UTC', night)).toBe(true);
    expect(withinDayHours(new Date('2026-09-27T12:00:00Z'), 'UTC', night)).toBe(false);
  });
});
