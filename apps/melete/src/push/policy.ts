/**
 * When Melete may speak. Pure, so every rule is a test:
 *
 * - Quiet hours are the profile's day hours read the other way round; nothing
 *   is sent outside the person's day, in their own time zone.
 * - Events that arrive close together go out as one push: a batch is due once
 *   its oldest event has waited the batching window.
 * - At most `daily_cap` pushes a local day. What is held back is not lost; it
 *   goes out folded into the next push the cap allows.
 * - Every push says why it was sent.
 */
import type { PushPayload } from '@melete/contracts';

export type IntentKind = 'decision' | 'settled' | 'weekly';

export type Waiting = {
  id: string;
  kind: IntentKind;
  title: string;
  body: string;
  because: string;
  url: string;
  createdAt: Date;
};

export type DayWindow = { start: string; end: string; timeZone: string };

export type Pacing = { dailyCap: number; batchMinutes: number };

export type Plan =
  | { send: PushPayload; ids: string[] }
  | { hold: 'nothing' | 'quiet' | 'cap' | 'batching' };

const minutesOf = (clock: string) => {
  const [hours = 0, minutes = 0] = clock.split(':').map(Number);
  return hours * 60 + minutes;
};

/** The wall clock and calendar day in a time zone; an unknown zone reads as UTC. */
export function localTime(
  now: Date,
  timeZone: string,
): { minutes: number; day: string; weekday: number } {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone);
  } catch {
    parts = format('UTC');
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
    day: `${part('year')}-${part('month')}-${part('day')}`,
    weekday: weekdays.indexOf(part('weekday')),
  };
}

/** Outside the person's day. A day that ends after midnight wraps. */
export function isQuiet(now: Date, day: DayWindow): boolean {
  const { minutes } = localTime(now, day.timeZone);
  const start = minutesOf(day.start);
  const end = minutesOf(day.end);
  if (start === end) return false;
  const inDay = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  return !inDay;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const counted = (n: number, one: string, many: string) =>
  `${n < WORDS.length ? WORDS[n] : n} ${n === 1 ? one : many}`;

/** One push from what waited: alone it speaks for itself; together, it is counted. */
export function composeBatch(waiting: Waiting[]): PushPayload {
  const [first] = waiting;
  if (!first) throw new Error('nothing to compose');
  if (waiting.length === 1)
    return {
      title: first.title,
      body: first.body,
      because: first.because,
      url: first.url,
      tag: first.kind,
    };
  const decisions = waiting.filter((w) => w.kind === 'decision');
  const settled = waiting.filter((w) => w.kind === 'settled');
  const weekly = waiting.filter((w) => w.kind === 'weekly');
  const title =
    decisions.length > 0
      ? decisions.length === 1
        ? 'One decision is waiting'
        : `${counted(decisions.length, 'decision', 'decisions')} are waiting`
      : settled.length > 0
        ? settled.length === 1
          ? 'A chase settled'
          : `${counted(settled.length, 'chase', 'chases')} settled`
        : (weekly[0]?.title ?? first.title);
  const reasons = [
    decisions.length ? counted(decisions.length, 'decision waits', 'decisions wait') : null,
    settled.length ? counted(settled.length, 'chase settled', 'chases settled') : null,
    weekly.length ? 'your weekly summary is ready' : null,
  ].filter(Boolean) as string[];
  const said = reasons.map((reason) => reason.replace(/^./, (c) => c.toLowerCase()));
  const listed =
    said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}` : said[0];
  const because = `Because ${listed} since the last one.`;
  const lead = decisions[0] ?? settled[0] ?? first;
  return {
    title,
    body: waiting
      .map((w) => w.body)
      .join(' · ')
      .slice(0, 400),
    because: because.slice(0, 200),
    // A decision is the one thing only the person can do, so tapping goes there first.
    url: lead.url,
    tag: 'batch',
  };
}

/** Whether to send now, and what; or why not yet. */
export function planPush(input: {
  waiting: Waiting[];
  day: DayWindow;
  pacing: Pacing;
  sentToday: number;
  now: Date;
}): Plan {
  const { waiting, day, pacing, sentToday, now } = input;
  if (waiting.length === 0) return { hold: 'nothing' };
  if (isQuiet(now, day)) return { hold: 'quiet' };
  if (sentToday >= pacing.dailyCap) return { hold: 'cap' };
  const oldest = Math.min(...waiting.map((w) => w.createdAt.getTime()));
  if (now.getTime() - oldest < pacing.batchMinutes * 60_000) return { hold: 'batching' };
  const ordered = [...waiting].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return { send: composeBatch(ordered), ids: ordered.map((w) => w.id) };
}
