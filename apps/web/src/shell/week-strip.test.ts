/**
 * The rail's week strip is on the profile's clock, the same one the events
 * under it are listed on, whatever zone the browser is in.
 */
import { expect, test } from 'bun:test';
import { weekStrip } from './week-strip.ts';

test('late evening in UTC is already the next day in Kolkata, and the dots fall on Kolkata days', () => {
  const strip = weekStrip(new Date('2026-10-15T23:30:00.000Z'), 'Asia/Kolkata', [
    // 01:30 on Saturday the 17th in Kolkata; still Friday in UTC.
    { starts_at: '2026-10-16T20:00:00.000Z' },
    // 00:30 on Tuesday the 13th in Kolkata; still Monday in UTC.
    { starts_at: '2026-10-12T19:00:00.000Z' },
  ]);
  expect(strip.month).toBe('October');
  expect(strip.days.map((d) => d.num)).toEqual([12, 13, 14, 15, 16, 17, 18]);
  expect(strip.days.map((d) => d.label)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  expect(strip.days.filter((d) => d.today).map((d) => d.num)).toEqual([16]);
  expect(strip.days.filter((d) => d.has).map((d) => d.num)).toEqual([13, 17]);
});

test('a week that crosses into a new month counts on, and the month is the zone’s', () => {
  // 01:30 on Sunday 1 November in Kolkata.
  const strip = weekStrip(new Date('2026-10-31T20:00:00.000Z'), 'Asia/Kolkata', []);
  expect(strip.month).toBe('November');
  expect(strip.days.map((d) => d.num)).toEqual([26, 27, 28, 29, 30, 31, 1]);
  expect(strip.days.at(-1)?.today).toBe(true);
  expect(new Set(strip.days.map((d) => d.key)).size).toBe(7);
});

test('west of UTC the evening is still the earlier day', () => {
  const strip = weekStrip(new Date('2026-10-16T02:00:00.000Z'), 'America/Los_Angeles', []);
  expect(strip.days.filter((d) => d.today).map((d) => d.num)).toEqual([15]);
});
