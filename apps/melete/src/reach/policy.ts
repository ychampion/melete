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
 * - Never outside the person's day unless they agreed to nights as well. A
 *   person whose day has no clear hours (no profile, or a day that starts
 *   when it ends) is treated as always off.
 * - A call follows only a text that went out.
 * - Texts and calls say only that a deadline the person set is at risk: no
 *   title or reason, which a lock screen, a carrier or a phone log would show.
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
  /** The person's day, or null when it isn't known. */
  day: DayWindow | null;
  /** For a call: whether this deadline's text went out (sent, delivered, or possibly sent). */
  textWent?: boolean;
  now: Date;
};

/** Outside the person's day. A day that isn't known, or has no clear hours, is all night. */
export function offHours(now: Date, day: DayWindow | null): boolean {
  if (!day || day.start === day.end) return true;
  return isQuiet(now, day);
}

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
  if (channel === 'call' && !input.textWent)
    return { send: false, reason: 'The text before it didn’t go, so Melete didn’t call.' };
  if (!consent.nights && offHours(input.now, input.day))
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

/**
 * North American numbers outside the US and Canada. They share +1 but are
 * charged as international texts, which is what SMS pumping looks for.
 */
const NANP_ELSEWHERE = new Set([
  '242',
  '246',
  '264',
  '268',
  '284',
  '345',
  '441',
  '473',
  '649',
  '658',
  '664',
  '721',
  '758',
  '767',
  '784',
  '809',
  '829',
  '849',
  '868',
  '869',
  '876',
]);

/**
 * Whether a verification code may be texted to this number: it starts with
 * one of the operator's calling-code prefixes (`+1` by default). Under `+1`,
 * the Caribbean and Atlantic area codes are refused unless the operator named
 * one exactly (`+1876`).
 */
export function codeAllowed(number: string, prefixes: readonly string[]): boolean {
  const matched = prefixes.filter((prefix) => number.startsWith(prefix));
  if (!matched.length) return false;
  if (matched.some((prefix) => prefix.length > 2)) return true;
  return !(number.startsWith('+1') && NANP_ELSEWHERE.has(number.slice(2, 5)));
}

/** The local day a send counts toward. */
export const dayOfSend = (at: Date, day: DayWindow) => localTime(at, day.timeZone).day;

/** The single keywords the provider itself answers (Twilio's default opt-out handling). */
const PROVIDER_KEYWORDS =
  /^(stop|stopall|unsubscribe|cancel|end|quit|optout|revoke|start|yes|unstop|help|info)$/;

/**
 * What a reply to Melete's number means. A reply that carries any sign of
 * wanting it to stop is an opt-out: the words the FCC lists for revoking
 * consent (stop, quit, end, revoke, opt out, cancel, unsubscribe) anywhere in
 * it, the carriers' STOPALL, or asking not to be texted, called or messaged.
 * Missing an opt-out is the costly mistake, so a reply that only might be one
 * counts as one. START and UNSTOP lift a STOP; HELP asks who this is.
 * Anything else is the person answering, which counts as having seen it.
 */
export function replyKind(body: string): 'stop' | 'start' | 'help' | 'answer' {
  const text = body
    .normalize('NFKC')
    .toLowerCase()
    // Phones send curly apostrophes: "don’t" is "don't".
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    /\b(stop|stopall|quit|end|revoke|cancel|unsubscribe|optout|opt out|unenroll)\b/.test(text) ||
    /\b(don't|dont|do not|no more|never|not) (text|call|message|contact|ring|phone)/.test(text) ||
    /\b(leave me alone|remove me|take me off|opt me out)\b/.test(text)
  )
    return 'stop';
  if (/^(start|unstop|yes)$/.test(text)) return 'start';
  if (/^(help|info)$/.test(text)) return 'help';
  return 'answer';
}

/** Whether the provider answers this reply itself, so Melete sends no confirmation of its own. */
export function providerAnswers(body: string): boolean {
  return PROVIDER_KEYWORDS.test(body.trim().toLowerCase());
}

/** The one confirmation an opt-out gets, with how to undo it. */
export const OPT_OUT_CONFIRMATION =
  'Melete: you won’t get texts or calls about deadlines. To restart, text START here, then turn it on again in Settings.';

/** The text: no title or reason, only that a deadline is at risk, how to answer and how to stop. */
export const TEXT_BODY =
  'Melete: a deadline you set is at risk. Open Melete to see it. Reply to say you’ve seen it, or STOP to end texts and calls.';

/** The code text. */
export const codeBody = (code: string) =>
  `Your Melete code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this text.`;

/** A phone number read out digit by digit: "+1 415…" becomes "1, 4 1 5, …". */
export function spokenNumber(number: string): string {
  return number.replace(/^\+/, '').split('').join(' ');
}

/**
 * What a call says: who is calling, that a deadline the person set is at
 * risk, the keys, and the number to text Melete back on. No title or reason.
 */
export function callWords(from: string): { lead: string; keys: string; after: string } {
  return {
    lead: 'This is Melete, calling about a deadline you set. It is at risk. Open Melete to see it.',
    keys: 'Press 1 if you’ve seen this. Press 9 to stop these calls and texts.',
    after: `You can text Melete at ${spokenNumber(from)}, or reply STOP to that number to end texts and calls. Goodbye.`,
  };
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
