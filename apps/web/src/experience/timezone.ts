/**
 * Time zones as the person sees them. The service keeps one zone per account
 * and runs routines on it; until the person chooses, it is only a default.
 */

/** This browser's zone by name, or null when the browser does not say. */
export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && /^[A-Za-z]/.test(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** "America/New_York" reads as "America/New York". */
export const zoneLabel = (zone: string) => zone.replaceAll('_', ' ');

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
