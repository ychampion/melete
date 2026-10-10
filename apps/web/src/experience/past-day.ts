/**
 * The day something happened, as a person says it: "Today", "Yesterday", a
 * weekday within the last week, and the date beyond that. A weekday further
 * back would name the wrong week: "Thu" for something nine days ago reads as
 * last Thursday.
 */
const DAY = 86_400_000;

const startOf = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

export function pastDay(when: string | Date, now: number): string {
  const date = typeof when === 'string' ? new Date(when) : when;
  const today = new Date(now);
  const days = Math.round((startOf(today) - startOf(date)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'short' });
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}
