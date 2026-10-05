/**
 * When Melete may text or call the person's own number. Pure, so every rule
 * is a test:
 *
 * - Only an urgent situation about a deadline the person set climbs the
 *   ladder: a push at once, a text three minutes later, a call five minutes
 *   after that, each only while the person has not acknowledged it.
 * - Only to the number the person verified, and only while their agreement
 *   covers that number and that channel.
 * - At most six texts and three calls a day, in the person's own day.
 * - Never outside the person's day unless they agreed to nights as well.
 */
import { type DayWindow, isQuiet, localTime } from '../push/policy.ts';

const MINUTE = 60_000;
/** After the push, how long Melete waits for the person before each rung. */
export const LADDER = { textAfterMs: 3 * MINUTE, callAfterMs: 8 * MINUTE } as const;
export const DAILY_CAPS = { text: 6, call: 3 } as const;

/** Verification codes: how long one lasts, how many tries it takes, how many a day. */
export const CODE_RULES = { ttlMs: 10 * MINUTE, tries: 5, perDay: 5 } as const;

export type Consent = {
  number: string;
  texts: boolean;
  calls: boolean;
  nights: boolean;
};

export type RungInput = {
  channel: 'text' | 'call';
  /** The situation is still open, urgent, from a deadline the person set. */
  situation: { live: boolean; urgent: boolean; personSet: boolean; acked: boolean } | null;
  /** The verified number, or null. */
  number: string | null;
  consent: Consent | null;
  optedOut: boolean;
  providerReady: boolean;
  sentToday: { text: number; call: number };
  day: DayWindow;
  now: Date;
};

export type RungDecision =
  | { send: true; to: string }
  | { send: false; reason: string; cancel?: boolean };

/** Whether this rung goes out now, and to which number; or why it does not, in plain words. */
export function decideRung(input: RungInput): RungDecision {
  const { situation, consent, channel } = input;
  if (!situation?.live)
    return { send: false, reason: 'It was settled or closed before this was due.', cancel: true };
  if (situation.acked)
    return { send: false, reason: 'You saw it, so Melete stopped.', cancel: true };
  // The database holds urgent to person-set already; the ladder does not trust that alone.
  if (!situation.urgent || !situation.personSet)
    return { send: false, reason: 'Only a deadline you set is texted or called about.' };
  if (!input.providerReady)
    return {
      send: false,
      reason:
        'Texts and calls aren’t set up on this installation, so Melete reached you by push only.',
    };
  if (!input.number) return { send: false, reason: 'There is no verified number to reach you on.' };
  if (input.optedOut)
    return { send: false, reason: 'You replied STOP, so Melete no longer texts or calls you.' };
  if (!consent || consent.number !== input.number)
    return {
      send: false,
      reason:
        'You haven’t agreed to texts and calls on this number, so Melete reached you by push only.',
    };
  if (channel === 'text' && !consent.texts)
    return { send: false, reason: 'You haven’t agreed to texts.' };
  if (channel === 'call' && !consent.calls)
    return { send: false, reason: 'You chose texts only, so Melete didn’t call.' };
  if (!consent.nights && isQuiet(input.now, input.day))
    return {
      send: false,
      reason: 'It was outside your day, and you didn’t ask to be woken for deadlines you set.',
    };
  if (input.sentToday[channel] >= DAILY_CAPS[channel])
    return {
      send: false,
      reason:
        channel === 'text'
          ? `Melete had already sent ${DAILY_CAPS.text} texts today, the most it sends in a day.`
          : `Melete had already called ${DAILY_CAPS.call} times today, the most it calls in a day.`,
    };
  return { send: true, to: input.number };
}

/** The local day a send counts toward. */
export const dayOfSend = (at: Date, day: DayWindow) => localTime(at, day.timeZone).day;

/**
 * What a reply to Melete's number means. The words the FCC lists for
 * revoking consent (stop, quit, end, revoke, opt out, cancel, unsubscribe),
 * the carriers' STOPALL, and a plain "stop texting me" all end it; START and
 * UNSTOP undo a STOP; HELP asks who this is. Anything else is the person
 * answering, which counts as having seen it.
 */
export function replyKind(body: string): 'stop' | 'start' | 'help' | 'answer' {
  const words = body
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const text = words.join(' ');
  if (
    /^(stop|stopall|stop all|quit|end|revoke|opt out|optout|cancel|unsubscribe)$/.test(text) ||
    /^(stop|quit|unsubscribe|revoke)\b/.test(text) ||
    /\b(stop|quit|don't|do not|never) (texting|calling|messaging|contacting)\b/.test(text) ||
    /\b(opt me out|unsubscribe me|remove me)\b/.test(text)
  )
    return 'stop';
  if (/^(start|unstop|yes)$/.test(text)) return 'start';
  if (/^(help|info)$/.test(text)) return 'help';
  return 'answer';
}

const clip = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

/** The text: Melete's own words for the deadline, how to say it was seen, and how to stop. */
export function textBody(title: string, reason: string): string {
  return `Melete: ${clip(title, 80)}. ${clip(reason, 90)} Reply to say you've seen it. Reply STOP to end texts and calls.`;
}

/** The code text. */
export const codeBody = (code: string) =>
  `Your Melete code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this text.`;

/** The one sentence a call speaks about the deadline, after saying who is calling. */
export function callSentence(title: string, reason: string): string {
  return `This is Melete, about a deadline you set. ${clip(title, 100)}. ${clip(reason, 100)}`;
}

/** The words the person agrees to, with their number in them. They are recorded as shown. */
export function consentWording(number: string): { texts: string; calls: string; nights: string } {
  return {
    texts: `Melete may text ${number} when a deadline you set is about to be missed and you haven’t opened its push, at most 6 texts a day. Texts come from this installation’s number and may cost what your carrier charges. Reply STOP at any time to end texts and calls.`,
    calls: `If a text also goes unanswered, Melete may call ${number}, at most 3 calls a day. The call is an automated voice; press 1 to say you’ve seen it, or 9 to end texts and calls.`,
    nights: 'Also outside your day hours. Otherwise nothing is texted or called while you’re off.',
  };
}

/** The recorded agreement: the sentences for what was agreed, joined. */
export function agreedWording(
  number: string,
  consent: { calls: boolean; nights: boolean },
): string {
  const words = consentWording(number);
  return [words.texts, consent.calls ? words.calls : null, consent.nights ? words.nights : null]
    .filter(Boolean)
    .join(' ');
}
