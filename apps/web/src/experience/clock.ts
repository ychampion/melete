/**
 * The one clock every time in the app is shown on: the person's own time zone
 * from their profile, the same one the greeting is said in and routines run
 * on. Until the profile has loaded, or when it cannot be read, this browser's
 * zone stands in.
 */
import { browserTimeZone } from './timezone.ts';

let chosen: string | null = null;

/** Whether this browser knows a zone by that name. */
function known(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Set from the profile as it loads; null goes back to this browser's zone. */
export function setDisplayZone(zone: string | null | undefined): void {
  chosen = zone && known(zone) ? zone : null;
}

/** The zone times are shown in now. */
export function displayZone(): string {
  return chosen ?? browserTimeZone() ?? 'UTC';
}

function partsOf(date: Date, zone: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date))
    parts[part.type] = part.value;
  return parts;
}

/** The calendar day an instant falls on in the zone, as "2026-10-10". */
export function dayKey(date: Date, zone: string = displayZone()): string {
  const parts = partsOf(date, zone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The day before a day key, counted on the calendar rather than in hours. */
function dayBefore(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - 1))
    .toISOString()
    .slice(0, 10);
}

export const sameDay = (a: Date, b: Date, zone: string = displayZone()): boolean =>
  dayKey(a, zone) === dayKey(b, zone);

export const isYesterday = (date: Date, now: Date, zone: string = displayZone()): boolean =>
  dayKey(date, zone) === dayBefore(dayKey(now, zone));

/** Hours since midnight on the zone's clock, minutes as a fraction: 8:30 PM is 20.5. */
export function hourOfDay(date: Date, zone: string = displayZone()): number {
  const parts = partsOf(date, zone);
  return (Number(parts.hour) % 24) + Number(parts.minute) / 60;
}

/** "8:26 PM" on the zone's clock. */
export const clockTime = (date: Date, zone: string = displayZone()): string =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });

/** "Sat", or "Saturday" when long. */
export const weekday = (date: Date, zone: string = displayZone(), long = false): string =>
  date.toLocaleDateString('en-US', { weekday: long ? 'long' : 'short', timeZone: zone });

/** "Oct 10". */
export const monthDay = (date: Date, zone: string = displayZone()): string =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: zone });

/** "Today", "Yesterday", or "Sat, Oct 3": the day something happened, said from now. */
export function dayWords(date: Date, now: Date, zone: string = displayZone()): string {
  if (sameDay(date, now, zone)) return 'Today';
  if (isYesterday(date, now, zone)) return 'Yesterday';
  return `${weekday(date, zone)}, ${monthDay(date, zone)}`;
}
