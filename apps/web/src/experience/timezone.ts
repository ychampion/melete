/**
 * Time zones as the person sees them. The service keeps one zone per account
 * and runs routines on it; until the person chooses, it is only a default.
 */

import { currentZone } from './plain.ts';

/** This browser's zone by name, or null when the browser does not say. */
export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && /^[A-Za-z]/.test(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** "America/New_York" reads as "America/New York"; a retired name reads as its current one. */
export const zoneLabel = (zone: string) => currentZone(zone).replaceAll('_', ' ');

/**
 * The zone setup saves: the one the person already chose, or else this
 * browser's, rather than the default the account started with.
 */
export function setupTimeZone(
  profile: { time_zone: string; time_zone_confirmed: boolean } | null,
  browser: string | null,
): string {
  if (profile?.time_zone_confirmed) return profile.time_zone;
  return browser ?? profile?.time_zone ?? 'UTC';
}

/** Every zone the browser knows, with the current one first when it is missing. */
export function timeZoneChoices(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  if (!zones.includes('UTC')) zones = [...zones, 'UTC'];
  return zones.includes(current) ? zones : [current, ...zones];
}

/**
 * A zone by the name people use for it, with its city: "Pacific Time (Los
 * Angeles)". A zone the browser has no such name for reads by its city alone.
 */
export function zoneName(zone: string, at: Date = new Date()): string {
  const city = (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
  try {
    const named = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (named && !/^GMT[+-]/.test(named) && named !== city) return `${named} (${city})`;
  } catch {
    // A zone this browser does not know reads by its city.
  }
  return city;
}
