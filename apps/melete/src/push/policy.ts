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
 *
 * Situations add two faster lanes beside that one, each with its own cap:
 *
 * - `soon` waits a minute for company, at most six a day, and holds through
 *   quiet hours like everything else.
 * - `urgent` goes at once, at most three a day. It holds through quiet hours
 *   too, unless it is about a deadline the person set or accepted: that one
 *   goes now, whatever the hour.
 *
 * A push past its lane's cap is not lost: it waits in the lane below.
 *
 * What the person asked for at a time they chose (a reminder coming due, a
 * routine's result, a scheduled report) is a `reminder`. The person set the
 * hour, so it goes the moment it comes, quiet hours or not, and no cap holds
 * it back or counts it. What Melete decides to say by itself keeps every rule
 * above.
 */
import type { PushPayload, Urgency } from '@melete/contracts';

/**
 * `progress` is news from long work: a report, or that it is done. `situation`
 * is something noticed. `needs_you` is a conversation or job that stopped on
 * the person for a reason no decision card names; `done` is a conversation
 * that answered while they were away. `reminder` is something the person asked
 * for at a time they chose, coming due.
 */
export type IntentKind =
  | 'decision'
  | 'settled'
  | 'weekly'
  | 'progress'
  | 'situation'
  | 'needs_you'
  | 'done'
  | 'reminder';

/** The faster lanes' own pacing. */
export const SOON_PACING = { dailyCap: 6, batchMinutes: 1 } as const;
export const URGENT_DAILY_CAP = 3;

export type Waiting = {
  id: string;
  kind: IntentKind;
  title: string;
  body: string;
  because: string;
  url: string;
  createdAt: Date;
  /** `normal` when left out. */
  urgency?: Urgency;
  /** About a deadline the person set or accepted. */
  personSet?: boolean;
  /** Where the service worker says the person saw it. */
  ack?: string;
};

export type DayWindow = { start: string; end: string; timeZone: string };

export type Pacing = { dailyCap: number; batchMinutes: number };

export type Plan =
  | {
      send: PushPayload;
      ids: string[];
      urgency: Urgency;
      /** Reminders the person timed: sent whatever the hour, and counted against no cap. */
      onTime?: true;
    }
  | { hold: 'nothing' | 'quiet' | 'cap' | 'batching' };

/** Pushes already sent today, in each lane. */
export type SentToday = { normal: number; soon: number; urgent: number };

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
      // Each reminder is its own notification: one must never silently replace another.
      tag: first.kind === 'reminder' ? `reminder:${first.id}`.slice(0, 64) : first.kind,
      ...(first.ack ? { ack: first.ack } : {}),
    };
  const decisions = waiting.filter((w) => w.kind === 'decision');
  const settled = waiting.filter((w) => w.kind === 'settled');
  const weekly = waiting.filter((w) => w.kind === 'weekly');
  const progress = waiting.filter((w) => w.kind === 'progress');
  const noticed = waiting.filter((w) => w.kind === 'situation');
  const needs = waiting.filter((w) => w.kind === 'needs_you');
  const done = waiting.filter((w) => w.kind === 'done');
  const asked = waiting.filter((w) => w.kind === 'reminder');
  if (asked.length === waiting.length)
    return {
      title: `${counted(asked.length, 'thing', 'things')} you asked for`,
      body: waiting
        .map((w) => w.body)
        .join(' · ')
        .slice(0, 400),
      because: 'Because you asked for these at this time.',
      url: first.url,
      tag: `reminder:${first.id}`.slice(0, 64),
    };
  const title =
    noticed.length > 0 && noticed.length === waiting.length
      ? `${counted(noticed.length, 'thing needs', 'things need')} you`
      : decisions.length > 0
        ? decisions.length === 1
          ? 'One decision is waiting'
          : `${counted(decisions.length, 'decision', 'decisions')} are waiting`
        : needs.length > 0
          ? `${counted(needs.length, 'conversation needs', 'conversations need')} you`
          : settled.length > 0
            ? settled.length === 1
              ? 'A chase settled'
              : `${counted(settled.length, 'chase', 'chases')} settled`
            : progress.length > 0
              ? progress.length === 1
                ? (progress[0]?.title ?? first.title)
                : `${counted(progress.length, 'update', 'updates')} on your work`
              : done.length > 0
                ? `${counted(done.length, 'answer is', 'answers are')} ready`
                : (weekly[0]?.title ?? first.title);
  const reasons = [
    decisions.length ? counted(decisions.length, 'decision waits', 'decisions wait') : null,
    needs.length ? counted(needs.length, 'conversation stopped', 'conversations stopped') : null,
    done.length ? counted(done.length, 'answer came', 'answers came') : null,
    asked.length
      ? counted(asked.length, 'thing you asked for came', 'things you asked for came')
      : null,
    settled.length ? counted(settled.length, 'chase settled', 'chases settled') : null,
    progress.length ? counted(progress.length, 'work update', 'work updates') : null,
    noticed.length ? counted(noticed.length, 'thing came up', 'things came up') : null,
    weekly.length ? 'your weekly summary is ready' : null,
  ].filter(Boolean) as string[];
  const said = reasons.map((reason) => reason.replace(/^./, (c) => c.toLowerCase()));
  const listed =
    said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}` : said[0];
  const because = `Because ${listed} since the last one.`;
  const lead = decisions[0] ?? needs[0] ?? settled[0] ?? progress[0] ?? done[0] ?? first;
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

const byAge = (waiting: Waiting[]) =>
  [...waiting].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

/**
 * Whether to send now, and what; or why not yet. One lane at a time, the
 * fastest first: an urgent push never waits behind a batch.
 */
export function planPush(input: {
  waiting: Waiting[];
  day: DayWindow;
  pacing: Pacing;
  /** Normal pushes sent today, or every lane's count. */
  sentToday: number | SentToday;
  now: Date;
}): Plan {
  const { waiting, day, pacing, now } = input;
  const sent: SentToday =
    typeof input.sentToday === 'number'
      ? { normal: input.sentToday, soon: 0, urgent: 0 }
      : input.sentToday;
  if (waiting.length === 0) return { hold: 'nothing' };
  // The person chose this hour: it goes now, ahead of anything paced, never held by quiet or a cap.
  const due = waiting.filter((w) => w.kind === 'reminder');
  if (due.length) {
    const ordered = byAge(due);
    return {
      send: composeBatch(ordered),
      ids: ordered.map((w) => w.id),
      urgency: 'urgent',
      onTime: true,
    };
  }
  const quiet = isQuiet(now, day);
  // Each push in its lane; one past its lane's cap waits in the lane below.
  const urgentRoom = sent.urgent < URGENT_DAILY_CAP;
  const soonRoom = sent.soon < SOON_PACING.dailyCap;
  const laneOf = (w: Waiting): Urgency => {
    const wanted = w.urgency ?? 'normal';
    if (wanted === 'urgent' && urgentRoom) return 'urgent';
    if (wanted !== 'normal' && soonRoom) return 'soon';
    return 'normal';
  };
  const urgent = waiting.filter((w) => laneOf(w) === 'urgent' && (!quiet || w.personSet === true));
  if (urgent.length) {
    const ordered = byAge(urgent);
    return { send: composeBatch(ordered), ids: ordered.map((w) => w.id), urgency: 'urgent' };
  }
  if (quiet) return { hold: 'quiet' };
  const at = now.getTime();
  const soon = waiting.filter((w) => laneOf(w) === 'soon' || laneOf(w) === 'urgent');
  if (soon.length) {
    const oldest = Math.min(...soon.map((w) => w.createdAt.getTime()));
    if (at - oldest >= SOON_PACING.batchMinutes * 60_000) {
      const ordered = byAge(soon);
      return { send: composeBatch(ordered), ids: ordered.map((w) => w.id), urgency: 'soon' };
    }
  }
  const normal = waiting.filter((w) => laneOf(w) === 'normal');
  if (!normal.length) return { hold: 'batching' };
  if (sent.normal >= pacing.dailyCap) return { hold: 'cap' };
  const oldest = Math.min(...normal.map((w) => w.createdAt.getTime()));
  if (at - oldest < pacing.batchMinutes * 60_000) return { hold: 'batching' };
  const ordered = byAge(normal);
  return { send: composeBatch(ordered), ids: ordered.map((w) => w.id), urgency: 'normal' };
}
