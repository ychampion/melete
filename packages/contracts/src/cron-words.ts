/**
 * Schedules in plain words, shared by the service and the clients that show
 * standing work.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const listWords = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const ordinal = (n: number) =>
  n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** A cron field of plain numbers, lists and ranges, as the numbers it names. */
function numbers(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value++) out.add(value);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A cron schedule in plain words, for the common shapes: every N minutes or
 * hours, daily, weekdays, given days of the week or of the month, at one or
 * more times. Anything else gets a neutral line rather than a wrong one.
 */
export function cronWords(cron: string): string {
  const fallback = 'On a set schedule';
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields;
  if (month !== '*') return fallback;
  const every = /^\*\/(\d+)$/;
  const anyDay = dom === '*' && dow === '*';
  if (anyDay && hour === '*') {
    if (minute === '*') return 'Every minute';
    const step = every.exec(minute);
    if (step) return Number(step[1]) === 1 ? 'Every minute' : `Every ${Number(step[1])} minutes`;
  }
  const minutes = numbers(minute, 0, 59);
  if (minutes?.length !== 1) return fallback;
  const at = minutes[0] ?? 0;
  const past = at === 0 ? '' : `, at ${at} past`;
  if (anyDay && hour === '*') return `Every hour${past}`;
  const hourStep = every.exec(hour);
  if (anyDay && hourStep)
    return Number(hourStep[1]) === 1
      ? `Every hour${past}`
      : `Every ${Number(hourStep[1])} hours${past}`;
  const hours = numbers(hour, 0, 23);
  if (!hours) return fallback;
  const times = `at ${listWords(hours.map((h) => `${h}:${String(at).padStart(2, '0')}`))}`;
  if (anyDay) return `Every day ${times}`;
  if (dom === '*') {
    const days = numbers(dow, 0, 7)?.map((day) => day % 7);
    if (!days) return fallback;
    const set = [...new Set(days)].sort((a, b) => a - b);
    const key = set.join(',');
    if (key === '0,1,2,3,4,5,6') return `Every day ${times}`;
    if (key === '1,2,3,4,5') return `Every weekday ${times}`;
    if (key === '0,6') return `Every Saturday and Sunday ${times}`;
    // The week read from Monday, as people say it.
    const ordered = [...set.filter((day) => day !== 0), ...set.filter((day) => day === 0)];
    return `Every ${listWords(ordered.map((day) => DAYS[day] ?? ''))} ${times}`;
  }
  if (dow === '*') {
    const dates = numbers(dom, 1, 31);
    if (!dates) return fallback;
    return `On the ${listWords(dates.map(ordinal))} of every month ${times}`;
  }
  return fallback;
}
