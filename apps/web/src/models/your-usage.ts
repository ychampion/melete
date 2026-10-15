/**
 * The figures behind Settings › Usage and the limit banner in chat, worked
 * out apart from the page so each can be checked on its own: how a total
 * reads against its limit, when it starts again, the bars of the month, what
 * the money went to, and how each piece of work ended.
 */
import type { MyUsage, Usage, UsageRun } from './api.ts';

/**
 * When the day's count starts again, in the reader's own time: "today at
 * 5:00 PM", "tomorrow at 5:30 AM", or a date if further off. The service's day
 * ends at midnight UTC, which is rarely midnight where the reader is.
 */
export function dayResetLine(iso: string, now = new Date(), timeZone?: string) {
  const at = new Date(iso);
  const zone = timeZone ? { timeZone } : {};
  const dateKey = (date: Date) => date.toLocaleDateString('en-CA', zone);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...zone });
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (dateKey(at) === dateKey(now)) return `today at ${time}`;
  if (dateKey(at) === dateKey(tomorrow)) return `tomorrow at ${time}`;
  return `on ${at.toLocaleDateString('en-US', { month: 'long', day: 'numeric', ...zone })} at ${time}`;
}

type Window = { usd: number | null; tokens: number | null };
type Spent = { usd: number; tokens: number };

/** Dollars as a person reads them: "$4.20", or "under $0.01" for a sliver. */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}

/** A month and day in the reader's words, from a UTC moment: "November 1". */
export function monthDay(iso: string, timeZone = 'UTC'): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone });
}

/**
 * One period against its limit: the share used, from dollars or tokens,
 * whichever is further along, or null when the period has no limit.
 */
export function shareUsed(spent: Spent, limit: Window): number | null {
  const shares = [
    limit.usd !== null && limit.usd > 0 ? spent.usd / limit.usd : null,
    limit.tokens !== null && limit.tokens > 0 ? spent.tokens / limit.tokens : null,
  ].filter((share): share is number => share !== null);
  return shares.length ? Math.max(...shares) : null;
}

export type CapRow = {
  label: string;
  /** "$4.20", or "123k" against a limit in tokens alone. */
  spent: string;
  /** "of $20.00", or null with no limit. */
  limit: string | null;
  /** 0 to 1, or null with no limit. */
  share: number | null;
  tone: 'calm' | 'near' | 'reached';
  resets: string;
};

/** A count of tokens: "800", "123k". */
const tokenCount = (tokens: number) =>
  tokens < 1000 ? `${tokens}` : `${Math.round(tokens / 1000)}k`;

/** A limit in tokens alone is read in tokens; any other in dollars. */
const inTokens = (limit: Window) => limit.usd === null && limit.tokens !== null;

const limitWords = (limit: Window) =>
  limit.usd !== null
    ? `of ${money(limit.usd)}`
    : limit.tokens !== null
      ? `of ${tokenCount(limit.tokens)} tokens`
      : null;

const toneOf = (share: number | null): CapRow['tone'] =>
  share === null || share < 0.8 ? 'calm' : share >= 1 ? 'reached' : 'near';

/**
 * This month and today, each against the person's own limit when the
 * installation sets one, with when it starts again in the reader's time.
 */
export function capRows(data: MyUsage, now = new Date(), timeZone?: string): CapRow[] {
  const caps = data.caps;
  const rows: Array<[string, Spent, Window | null, string]> = [
    [
      'This month',
      data.spent.month,
      caps?.month ?? null,
      `Starts again on ${monthDay(data.month_resets_at, timeZone)}`,
    ],
    [
      'Today',
      data.spent.day,
      caps?.day ?? null,
      `Starts again ${dayResetLine(data.day_resets_at, now, timeZone)}`,
    ],
  ];
  return rows.map(([label, spent, limit, resets]) => {
    const share = limit ? shareUsed(spent, limit) : null;
    return {
      label,
      spent: limit && inTokens(limit) ? tokenCount(spent.tokens) : money(spent.usd),
      limit: limit ? limitWords(limit) : null,
      share,
      tone: toneOf(share),
      resets,
    };
  });
}

/** Background work's own limit, when the installation sets one: "$1.20 of $5.00 this month". */
export function backgroundCapLine(data: MyUsage): string | null {
  const limits = data.caps?.background;
  if (!limits) return null;
  if (limits.month.usd !== null)
    return `${money(data.background_spent.month.usd)} of ${money(limits.month.usd)} this month`;
  if (limits.day.usd !== null)
    return `${money(data.background_spent.day.usd)} of ${money(limits.day.usd)} today`;
  return null;
}

export type DayBar = {
  day: string;
  /** "Oct 3" */
  label: string;
  chats: number;
  background: number;
  total: number;
  /** A day of this month still to come. */
  later: boolean;
};

/**
 * One bar for every day of the month, the days to come left empty, so the
 * chart reads the same width on the first of the month as on the last.
 */
export function monthBars(data: Pick<MyUsage, 'days' | 'month_start'>): DayBar[] {
  const start = new Date(data.month_start);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const byDay = new Map(data.days.map((point) => [point.day, point]));
  const bars: DayBar[] = [];
  for (let date = 1; date <= length; date++) {
    const day = new Date(Date.UTC(year, month, date)).toISOString().slice(0, 10);
    const point = byDay.get(day);
    const total = point?.usd ?? 0;
    const background = Math.min(point?.background_usd ?? 0, total);
    bars.push({
      day,
      label: new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      chats: total - background,
      background,
      total,
      later: date > data.days.length,
    });
  }
  return bars;
}

/** The sentence a screen reader hears for the chart. */
export function chartSummary(bars: DayBar[]): string {
  const spent = bars.filter((bar) => bar.total > 0);
  if (!spent.length) return 'No spending yet this month.';
  const top = spent.reduce((best, bar) => (bar.total > best.total ? bar : best));
  const sum = spent.reduce((total, bar) => total + bar.total, 0);
  return `Spending each day this month: ${money(sum)} in all, most on ${top.label} at ${money(top.total)}.`;
}

/** Hours and minutes, for computer time: "2h 15m", "40m", "under a minute". */
export function duration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export type KindRow = { label: string; note: string; value: string; share: number };

/** What this month's money went to: chats, background work, and computer time when there was any. */
export function kindRows(data: Pick<MyUsage, 'kinds' | 'computer_seconds'>): KindRow[] {
  const total = data.kinds.reduce((sum, kind) => sum + kind.usd, 0);
  const rows: KindRow[] = data.kinds.map((kind) => ({
    label: kind.kind === 'chats' ? 'Chats' : 'Routines and background',
    note:
      kind.kind === 'chats'
        ? `${kind.calls} model ${kind.calls === 1 ? 'call' : 'calls'} while you waited`
        : `${kind.calls} model ${kind.calls === 1 ? 'call' : 'calls'} on routines, watches and other work`,
    value: money(kind.usd),
    share: total > 0 ? kind.usd / total : 0,
  }));
  if (data.computer_seconds > 0)
    rows.push({
      label: 'Computer time',
      note: 'Your computers kept running for background tasks',
      value: duration(data.computer_seconds),
      share: 0,
    });
  return rows;
}

export const OUTCOME: Record<
  UsageRun['outcome'],
  { label: string; tone: 'settled' | 'needs' | 'late' | 'working' }
> = {
  done: { label: 'Done', tone: 'settled' },
  needs_you: { label: 'Needs you', tone: 'needs' },
  failed: { label: 'Failed', tone: 'late' },
  working: { label: 'Working', tone: 'working' },
};

/** When a piece of work last ran: "Today, 3:04 PM", "Oct 12, 9:30 AM". */
export function whenRan(iso: string, now = new Date(), timeZone?: string): string {
  const at = new Date(iso);
  const zone = timeZone ? { timeZone } : {};
  const key = (date: Date) => date.toLocaleDateString('en-CA', zone);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...zone });
  if (key(at) === key(now)) return `Today, ${time}`;
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...zone })}, ${time}`;
}

export type CapBanner = { level: 'warning' | 'reached'; text: string };

/**
 * The banner chat shows while a limit is close or reached: the service's own
 * sentence, and when the limit starts again where the sentence does not say.
 */
export function capBanner(
  notice: Usage['notice'] | undefined,
  now = new Date(),
  timeZone?: string,
): CapBanner | null {
  if (!notice) return null;
  if (notice.level === 'reached') return { level: 'reached', text: notice.message };
  const resets =
    notice.period === 'day'
      ? `It starts again ${dayResetLine(notice.resets_at, now, timeZone)}.`
      : `It starts again on ${monthDay(notice.resets_at, timeZone)}.`;
  return { level: 'warning', text: `${notice.message} ${resets}` };
}
