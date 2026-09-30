import { describe, expect, test } from 'bun:test';
import {
  COUNTRY_ZONES,
  knownZone,
  localMinutes,
  normalizeNumber,
  withinHours,
  zonesFor,
} from './hours.ts';

describe('calling hours in the callee’s local time', () => {
  test('every zone in the table is one this runtime knows', () => {
    for (const zones of Object.values(COUNTRY_ZONES))
      for (const zone of zones) expect([zone, knownZone(zone)]).toEqual([zone, true]);
  });

  test('the longest country code wins, and an unknown one needs the zone named', () => {
    expect(zonesFor('+353861234567')).toEqual(['Europe/Dublin']);
    expect(zonesFor('+442071234567')).toEqual(['Europe/London']);
    expect(zonesFor('+79161234567')).toBeNull();
    expect(zonesFor('+79161234567', 'Europe/Moscow')).toEqual(['Europe/Moscow']);
    expect(zonesFor('+442071234567', 'Not/A_Zone')).toBeNull();
  });

  test('a single-zone country is inside or outside the window by its own clock', () => {
    // 2026-01-15 10:00 in London (UTC in winter).
    const morning = new Date('2026-01-15T10:00:00Z');
    const night = new Date('2026-01-15T21:30:00Z');
    const london = zonesFor('+442071234567') ?? [];
    expect(withinHours(london, '09:00', '20:00', morning)).toBe(true);
    expect(withinHours(london, '09:00', '20:00', night)).toBe(false);
    // The end of the window is exclusive.
    expect(withinHours(london, '09:00', '20:00', new Date('2026-01-15T20:00:00Z'))).toBe(false);
    expect(withinHours(london, '09:00', '20:00', new Date('2026-01-15T09:00:00Z'))).toBe(true);
  });

  test('a country spanning zones is called only when every zone is inside the window', () => {
    const northAmerica = zonesFor('+14155550100') ?? [];
    // 14:00 in New York is 09:00 in Honolulu in winter: acceptable everywhere.
    expect(withinHours(northAmerica, '09:00', '20:00', new Date('2026-01-15T19:30:00Z'))).toBe(
      true,
    );
    // 10:00 in New York is 05:00 in Honolulu: somebody would be woken.
    expect(withinHours(northAmerica, '09:00', '20:00', new Date('2026-01-15T15:00:00Z'))).toBe(
      false,
    );
    // Naming the zone narrows it to that zone alone.
    expect(
      withinHours(
        zonesFor('+14155550100', 'America/New_York') ?? [],
        '09:00',
        '20:00',
        new Date('2026-01-15T15:00:00Z'),
      ),
    ).toBe(true);
  });

  test('local minutes follow daylight saving', () => {
    expect(localMinutes('Europe/London', new Date('2026-07-15T10:00:00Z'))).toBe(11 * 60);
    expect(localMinutes('Europe/London', new Date('2026-01-15T10:00:00Z'))).toBe(10 * 60);
  });

  test('a caller id is reduced to international form, or to nothing', () => {
    expect(normalizeNumber('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizeNumber('0044 20 7123 4567')).toBe('+442071234567');
    expect(normalizeNumber('14155550100')).toBe('+14155550100');
    expect(normalizeNumber('anonymous')).toBeNull();
    expect(normalizeNumber('')).toBeNull();
    expect(normalizeNumber(undefined)).toBeNull();
  });
});
