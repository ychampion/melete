/**
 * The day something happened, as a person says it, on the profile clock:
 * "Today", "Yesterday", a weekday within the last week, and the date beyond
 * that. A weekday further back would name the wrong week: "Thu" for something
 * nine days ago reads as last Thursday. A day still to come is "Tomorrow" or
 * its date, never "Today".
 */
import { dayKey, displayZone, monthDay, weekday } from './clock.ts';

const DAY = 86_400_000;
const daysOf = (key: string) => {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) / DAY;
};

export function pastDay(when: string | Date, now: number, zone: string = displayZone()): string {
  const date = typeof when === 'string' ? new Date(when) : when;
  const then = dayKey(date, zone);
  const today = dayKey(new Date(now), zone);
  const days = daysOf(today) - daysOf(then);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  // A day still to come: tomorrow, or its date; a weekday would read as one gone by.
  if (days === -1) return 'Tomorrow';
  if (days > 0 && days < 7) return weekday(date, zone);
  const year = then.slice(0, 4);
  return year === today.slice(0, 4) ? monthDay(date, zone) : `${monthDay(date, zone)}, ${year}`;
}
