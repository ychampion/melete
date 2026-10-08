/**
 * Where each detail of an intent came from, and the one line read back.
 *
 * The rule is the E4 origin rule applied to intents: a detail is the person's
 * (`person`) only when their own words say it; anything else, whether the
 * model chose it or read it somewhere, is `inferred`. Nothing here trusts the
 * model's word for where a value came from. Text has to appear in the words as
 * itself; a number as itself or as a number word; an amount as an amount; a
 * moment has to be what a date parser reads from the words, against the time
 * they were said and the person's zone, to the minute (or to the day, for a
 * deadline given as a day).
 *
 * Pure: no database, no clock of its own.
 */
import type { IntentConstraints, IntentKind, ReadBackPart, ValueOrigin } from '@melete/contracts';
import * as chrono from 'chrono-node';
import { tier0Values, zoneOffsetMinutes } from '../memory/tier0.ts';
import { DATE_ONLY_DUE, localDate, localInstant } from '../situations/detectors.ts';
import { ownWords, type Span, saysNumber, saysWanted } from './said.ts';
import { type Leaf, leaves } from './values.ts';

export { leaves };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long before its deadline an unfinished intent is looked at, by kind. */
export const INTENT_LEADS: Record<IntentKind, number> = {
  booking: 24 * HOUR,
  purchase: 24 * HOUR,
  meeting: 24 * HOUR,
  reply: 2 * HOUR,
  deliver: 2 * HOUR,
  watch: HOUR,
  other: 2 * HOUR,
  remind_check: 15 * MINUTE,
};

/**
 * The lead for one deadline, in whole seconds: the kind's lead, but never more
 * than half the time left, so a deadline set close still gets a look before it
 * is due rather than one at once.
 */
export function intentLeadSeconds(kind: IntentKind, due: number, now: number): number {
  const half = Math.floor((due - now) / 2);
  return Math.max(60, Math.round(Math.min(INTENT_LEADS[kind], half) / 1000));
}

const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** When a deadline is due: the moment given, or the end of the working day for a day alone. */
export function dueOf(value: string, timeZone: string): number {
  return isDay(value) ? localInstant(value, DATE_ONLY_DUE, timeZone) : new Date(value).getTime();
}

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

/** The person's message: its text, when it was said, where, and any stretches the composer saw pasted. */
export type Said = { words: string; eventAt: string; timeZone: string; pasted?: readonly Span[] };

/** "the 6th": a day of the month alone, which the date parser leaves unread. */
const ORDINAL_DAY = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;

/**
 * Every moment the words name, the starts and ends of ranges included. What
 * someone wants done lies ahead, so a weekday or a bare day of the month is
 * the next one, never the last.
 */
function spokenMoments(said: Said): { at: number; minute: boolean }[] {
  const instant = new Date(said.eventAt);
  const found: { at: number; minute: boolean }[] = [];
  for (const result of chrono.parse(
    said.words,
    { instant, timezone: zoneOffsetMinutes(said.timeZone, instant) },
    { forwardDate: true },
  )) {
    for (const part of [result.start, result.end]) {
      if (!part) continue;
      found.push({ at: part.date().getTime(), minute: part.isCertain('hour') });
    }
  }
  const today = localDate(instant.getTime(), said.timeZone);
  const [year = 1970, month = 1, day = 1] = today.split('-').map(Number);
  for (const match of said.words.matchAll(ORDINAL_DAY)) {
    const wanted = Number(match[1]);
    if (wanted < 1 || wanted > 31) continue;
    // This month if the day is still ahead, else the next month that has it.
    for (let ahead = wanted >= day ? 0 : 1; ahead < 3; ahead++) {
      const date = new Date(Date.UTC(year, month - 1 + ahead, wanted, 12));
      if (date.getUTCDate() !== wanted) continue;
      found.push({ at: localInstant(date.toISOString(), '12:00', said.timeZone), minute: false });
      break;
    }
  }
  return found;
}

/** Whether the person's own words say this value as something they want. Only then is it theirs. */
function said(leaf: Leaf, words: Said, moments: () => { at: number; minute: boolean }[]): boolean {
  const text = words.words;
  switch (leaf.type) {
    case 'text':
      return saysWanted(text, String(leaf.value));
    case 'tag':
      return saysWanted(text, String(leaf.value).replace(/[_-]+/g, ' '));
    case 'number': {
      const n = Number(leaf.value);
      return (
        saysNumber(text, n) ||
        (Number.isInteger(n) &&
          n < NUMBER_WORDS.length &&
          saysWanted(text, NUMBER_WORDS[n] ?? '')) ||
        (n === 12 && saysWanted(text, 'dozen'))
      );
    }
    case 'amount': {
      // An amount is said only as an amount: "$4,800" is 4800, never 4 or 800.
      const n = Number(leaf.value);
      return tier0Values(text, { eventAt: words.eventAt, timeZone: words.timeZone }).some(
        (value) => value.type === 'amount' && Number(value.value) === n,
      );
    }
    case 'currency': {
      const code = String(leaf.value).toUpperCase();
      return tier0Values(text, { eventAt: words.eventAt, timeZone: words.timeZone }).some(
        (value) => value.type === 'amount' && value.currency === code,
      );
    }
    case 'when': {
      const value = String(leaf.value);
      if (isDay(value))
        return moments().some((moment) => localDate(moment.at, words.timeZone) === value);
      const at = new Date(value).getTime();
      return moments().some((moment) => moment.minute && Math.abs(moment.at - at) < MINUTE);
    }
  }
}

/**
 * Where each detail came from, by path. `person` only when the words say it;
 * with no words (an intent taken up with a tap), nothing is the person's.
 */
export function markOrigins(
  constraints: IntentConstraints,
  deadline: string | null | undefined,
  words: Said,
): Record<string, ValueOrigin> {
  // Only the person's own lines: a quote, a forward or a paste says nothing for them.
  // The service reads a paste from the message's shape; what the composer says
  // was pasted can only take more away, so a detail is theirs only when both
  // readings say it.
  const readings = [
    ownWords(words.words),
    ...(words.pasted?.length ? [ownWords(words.words, words.pasted)] : []),
  ].map((text) => {
    const own: Said = { ...words, words: text };
    let cached: { at: number; minute: boolean }[] | null = null;
    const moments = () => {
      cached ??= own.words ? spokenMoments(own) : [];
      return cached;
    };
    return { own, moments };
  });
  const origins: Record<string, ValueOrigin> = {};
  for (const leaf of leaves(constraints, deadline))
    origins[leaf.path] = readings.every(({ own, moments }) => own.words && said(leaf, own, moments))
      ? 'person'
      : 'inferred';
  return origins;
}

const dayWords = (at: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
};
const timeWords = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(
    new Date(at),
  );

/** "Tue 6 Oct" for a day, "Tue 6 Oct, 7:00 PM" for a moment, in the person's zone. */
export function whenWords(value: string, timeZone: string): string {
  if (isDay(value)) return dayWords(localInstant(value, '12:00', timeZone), timeZone);
  const at = new Date(value).getTime();
  return `${dayWords(at, timeZone)}, ${timeWords(at, timeZone)}`;
}

function money(amount: number, currency: string | undefined): string {
  if (!currency) return String(amount);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** How a guess is marked in the line a person reads. */
export const GUESS = '(my guess)';

/**
 * The one line read back: "On it: <reading>. Haidilao, for 6, Tue 6 Oct,
 * 7:00 PM (my guess)." Every detail is a part with its origin, so a page can
 * mark Melete's guesses the same way the line does.
 */
export function readBack(
  input: {
    title: string;
    constraints: IntentConstraints;
    deadline: string | null;
    origins: Record<string, ValueOrigin>;
  },
  timeZone: string,
): { line: string; parts: ReadBackPart[] } {
  const c = input.constraints;
  const parts: ReadBackPart[] = [];
  const add = (path: string, text: string) =>
    parts.push({ path, text, origin: input.origins[path] ?? 'inferred' });
  if (c.place?.name) add('place.name', c.place.name);
  else if (c.place?.kind) add('place.kind', c.place.kind);
  if (c.place?.near) add('place.near', `near ${c.place.near}`);
  if (c.party?.size) add('party.size', `for ${c.party.size}`);
  c.party?.contacts?.forEach((name, index) => {
    add(`party.contacts[${index}]`, `with ${name}`);
  });
  c.counterparties?.forEach((name, index) => {
    add(`counterparties[${index}]`, `with ${name}`);
  });
  if (c.window?.from) add('window.from', whenWords(c.window.from, timeZone));
  if (c.window?.to) {
    const to = c.window.to;
    const sameDay =
      c.window.from &&
      !isDay(to) &&
      !isDay(c.window.from) &&
      localDate(new Date(to).getTime(), timeZone) ===
        localDate(new Date(c.window.from).getTime(), timeZone);
    add(
      'window.to',
      `until ${sameDay ? timeWords(new Date(to).getTime(), timeZone) : whenWords(to, timeZone)}`,
    );
  }
  if (input.deadline) add('deadline_at', `by ${whenWords(input.deadline, timeZone)}`);
  if (c.budget?.max !== undefined)
    add('budget.max', `up to ${money(c.budget.max, c.budget.currency)}`);
  c.must?.forEach((value, index) => {
    add(`must[${index}]`, value.replace(/[_-]+/g, ' '));
  });
  c.must_not?.forEach((value, index) => {
    add(`must_not[${index}]`, `not ${value.replace(/[_-]+/g, ' ')}`);
  });
  if (c.deliverable) add('deliverable', c.deliverable);
  const details = parts
    .map((part) => (part.origin === 'inferred' ? `${part.text} ${GUESS}` : part.text))
    .join(', ');
  const title = input.title.replace(/[.\s]+$/, '');
  return { line: details ? `On it: ${title}. ${details}.` : `On it: ${title}.`, parts };
}
