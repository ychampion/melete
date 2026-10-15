/**
 * The rail's week, Monday first, on the profile's clock: the same days the
 * events under it are listed on, whatever zone the browser is in.
 */
import { dayKey } from '../experience/clock.ts';

export type WeekDay = { label: string; num: number; key: string; today: boolean; has: boolean };

const DAY = 86_400_000;
const LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

export function weekStrip(
  now: Date,
  zone: string,
  events: readonly { starts_at: string }[],
): { month: string; days: WeekDay[] } {
  // Today's date in the zone, as midnight UTC, so counting days is plain arithmetic.
  const [year, month, day] = dayKey(now, zone).split('-').map(Number);
  const today = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  const dow = (new Date(today).getUTCDay() + 6) % 7;
  const eventDays = new Set(events.map((e) => dayKey(new Date(e.starts_at), zone)));
  const days = LABELS.map((label, i) => {
    const date = new Date(today + (i - dow) * DAY);
    const key = date.toISOString().slice(0, 10);
    return { label, num: date.getUTCDate(), key, today: i === dow, has: eventDays.has(key) };
  });
  return {
    month: new Date(today).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }),
    days,
  };
}
