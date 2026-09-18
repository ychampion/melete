/**
 * A provider that never calls anything. It reads the pasted text, works out
 * which of a few situations it is, picks real sentences and real figures out
 * of it, and returns a case file built from them.
 *
 * It exists for two reasons. The tests drive every gate and every failure
 * state through it, so the guarantees are proved without a key and without the
 * network. And when no key is configured the page still works end to end: it
 * reads the text rather than the world, so it never cites a page and never
 * names a rule, and the case file says only what the paste supports.
 */
import type { CaseFileProvider, ProviderResult, ProviderRun } from './provider.ts';
import { ProviderError } from './provider.ts';
import type { DraftCaseFile } from './schema.ts';
import { canonical } from './text.ts';
import type { SearchSource } from './validate.ts';

export type Script = {
  /** Fail instead of answering. */
  fail?: ProviderError;
  /** Wait this long first, so a timeout can be driven in a test. */
  delayMs?: number;
  /** The pages the search "returned". Empty by default: nothing was searched. */
  sources?: SearchSource[];
  /** Replace or bend the draft before it goes back, to drive the gates. */
  mutate?: (draft: DraftCaseFile, run: ProviderRun) => unknown;
};

/* ---------- reading the text ---------- */

const HEADER = /^\s*(from|to|cc|bcc|subject|date|sent|received|reply-to)\s*:/i;
/** Split after a full stop only when a new sentence starts, so 249.99 stays whole. */
const BREAK = /(?<=[.!?])\s+(?=["'(\p{Lu}])/u;

const MONEY_ALL =
  /(?:([$£€₹])\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?))|(?:([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s?(USD|GBP|EUR|INR))/g;
const MONEY = new RegExp(MONEY_ALL.source);

const SYMBOLS: Record<string, string> = { $: 'USD', '£': 'GBP', '€': 'EUR', '₹': 'INR' };

type Amount = { minor: number; currency: string };

/**
 * Sentences worth quoting: long enough to prove something, short enough to
 * read, and not the envelope. The ones carrying a figure come first, because
 * the sentence with the money in it is the one a person wants quoted back.
 */
function sentences(pasted: string): string[] {
  const body = pasted
    .split('\n')
    .filter((line) => !HEADER.test(line))
    .join('\n');
  const found = canonical(body)
    .split(BREAK)
    // A greeting has no full stop, so it runs into the first real sentence.
    .map((line) => line.replace(/^(dear|hi|hello)\b[^,]{0,40},\s*/i, '').trim())
    .filter((line) => line.length >= 24 && line.length <= 300);
  const score = (line: string): number => (MONEY.test(line) ? 2 : /\d/.test(line) ? 1 : 0);
  return found
    .map((line, at) => ({ line, at, score: score(line) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((entry) => entry.line);
}

/** Every amount in the text, in the order it appears, in minor units. */
function amounts(text: string): Amount[] {
  const found: Amount[] = [];
  for (const match of text.matchAll(MONEY_ALL)) {
    const digits = (match[2] ?? match[3] ?? '').replace(/,/g, '');
    const symbol = match[1];
    const currency = symbol ? SYMBOLS[symbol] : match[4];
    const value = Number(digits);
    if (currency && Number.isFinite(value))
      found.push({ minor: Math.round(value * 100), currency });
  }
  return found;
}

/** A company name from an address in the text, else from the first thing that reads like one. */
function company(text: string): string {
  const domain = /@([a-z0-9-]+)\.[a-z.]{2,}/i.exec(text);
  const word =
    domain?.[1] ?? /\b([A-Z][a-zA-Z]{2,})\s+(?:Support|Team|Customer|Care)\b/.exec(text)?.[1];
  if (!word) return 'the company';
  return word
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const money = (amount: Amount): string =>
  new Intl.NumberFormat('en', {
    style: 'currency',
    currency: amount.currency,
    currencyDisplay: 'narrowSymbol',
  }).format(amount.minor / 100);

/* ---------- which situation this is ---------- */

export type Kind = 'refund' | 'price_rise' | 'delay' | 'general';

/** Ordered: a delay notice often mentions a refund, and a price rise often mentions both. */
export function kindOf(text: string): Kind {
  if (
    /\b(delay|delays|delayed|cancell?ed)\b/i.test(text) &&
    /\b(flight|train|service)\b/i.test(text)
  )
    return 'delay';
  if (/\b(instead of|new price|price (is )?(chang|increas|ris)|going up)\b/i.test(text))
    return 'price_rise';
  if (/\brefund(ed|ing)?\b|\bmoney back\b|\breturned? (item|order)\b/i.test(text)) return 'refund';
  return 'general';
}

type Case = {
  issue: string;
  summary: string;
  amount: Amount | null;
  level: 'high' | 'medium' | 'low';
  why: string;
  days: number;
  subject: string;
  ask: string;
};

/**
 * One reading per situation. Each says what is owed and what to ask for, in
 * the person's own terms, and none of them names a law: nothing was looked up,
 * so nothing is cited.
 */
function read(kind: Kind, name: string, found: Amount[]): Case {
  const first = found[0] ?? null;

  if (kind === 'price_rise') {
    const now = found[1] ?? null;
    const rise = first && now && first.minor > now.minor ? first.minor - now.minor : null;
    const yearly = rise && first ? { minor: rise * 12, currency: first.currency } : null;
    return {
      issue: `${name} is putting your price up at renewal.`,
      summary: yearly
        ? `That is ${money(yearly)} a year more. You can hold your current price or leave before the renewal date, and you do not have to accept the new one quietly.`
        : `You can hold your current price or leave before the renewal date, and you do not have to accept the new one quietly.`,
      amount: yearly,
      level: 'medium',
      why: 'A price rise letter is the moment a company is most willing to make an offer to keep you.',
      days: 7,
      subject: `My renewal price`,
      ask: yearly
        ? `I would like to stay, but not at the new price. Please keep me on my current price, or tell me what you can do. Otherwise please treat this as my notice to cancel before the renewal date, with no penalty.`
        : `I would like to stay, but not at the new price. Please tell me what you can do, or treat this as my notice to cancel before the renewal date, with no penalty.`,
    };
  }

  if (kind === 'delay') {
    return {
      issue: `${name} ran late and offered you a voucher.`,
      summary:
        'A voucher is not the same thing as compensation. Ask them to confirm what cash payment applies to this delay and to pay it to the card you booked with.',
      amount: null,
      level: 'medium',
      why: 'The delay and its cause are in their own message, which is the part that usually has to be proved.',
      days: 30,
      subject: `Compensation for the delay, not a voucher`,
      ask: 'Please confirm what cash compensation applies to this delay and pay it to the card I booked with. I would rather not take the voucher in place of it.',
    };
  }

  if (kind === 'refund' && first) {
    return {
      issue: `${name} approved ${money(first)} and it has not arrived.`,
      summary: `${name} owes you ${money(first)}, on its own account of what happened.`,
      amount: first,
      level: 'medium',
      why: 'The amount is named in their own message, which is the part companies argue about least.',
      days: 14,
      subject: `${money(first)} still outstanding`,
      ask: `Please pay the ${money(first)} back to the original payment method and send me the reference for it.`,
    };
  }

  return {
    issue: `${name} has not settled this and you are still waiting.`,
    summary: `${name} owes you the outcome it described, or a straight answer about when it is coming.`,
    amount: first,
    level: first ? 'medium' : 'low',
    why: first
      ? 'A figure in their own message is easier to hold them to than one of yours.'
      : 'Nothing here names an amount, so the first reply will be a question rather than a payment.',
    days: first ? 14 : 21,
    subject: `Following up on my open case`,
    ask: 'Please tell me what you are going to do about this, and by when.',
  };
}

/**
 * The plain case file: everything in it comes from the paste, so every quote
 * clears the gate and the page can be seen working before a key exists.
 */
export function draftFrom(run: ProviderRun): DraftCaseFile {
  const text = canonical(run.pasted);
  const name = company(text);
  const reading = read(kindOf(text), name, amounts(text));
  const quoted = sentences(run.pasted).slice(0, 3);

  return {
    company: name,
    issue: reading.issue,
    entitlement: {
      summary: reading.summary,
      amount_minor: reading.amount?.minor ?? null,
      currency: reading.amount?.currency ?? null,
      basis: quoted.slice(0, 2).map((line, at) => ({
        claim:
          at === 0
            ? `${name} put this in writing, unprompted.`
            : `${name} set out what would happen next, and it has not.`,
        source_kind: 'quote' as const,
        quote: line,
        url: null,
        title: null,
      })),
    },
    evidence: quoted.map((line) => ({ quote: line, why: 'From the message itself.' })),
    odds: { level: reading.level, why: reading.why, expected_days: reading.days },
    message: {
      subject: reading.subject,
      body: [
        'Hello,',
        '',
        `I am writing about ${name === 'the company' ? 'this account' : `my account with ${name}`}.`,
        quoted[0] ? `Your own message says: "${quoted[0]}"` : 'I have had no resolution so far.',
        '',
        reading.ask,
        '',
        'Could you confirm by return, and give me a reference for this?',
        '',
        'Thank you,',
      ].join('\n'),
    },
    ladder: [
      { day_offset: 0, step: 'Send the message above and keep a copy of the reply.' },
      {
        day_offset: 7,
        step: 'No reply: send it again on the same thread and ask for a reference.',
      },
      {
        day_offset: 14,
        step: 'Still nothing: ask for it to go to a complaints handler, and ask for that in writing.',
      },
      {
        day_offset: 30,
        step: 'Unresolved: take it to the scheme or regulator that covers this company.',
      },
    ],
    melete_next: [
      'Melete would send this from your own address once you say yes, watch for the reply, follow up',
      'on the dates above, and stop the moment it is settled.',
    ].join(' '),
  };
}

export function scriptedProvider(script: Script = {}): CaseFileProvider {
  return {
    name: 'scripted',
    async run(run: ProviderRun): Promise<ProviderResult> {
      if (script.delayMs) await wait(script.delayMs, run.signal);
      if (script.fail) throw script.fail;
      const draft = draftFrom(run);
      return {
        json: script.mutate ? script.mutate(draft, run) : draft,
        sources: script.sources ?? [],
        searches: script.sources?.length ? 1 : 0,
      };
    },
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      // Nothing was called, so nothing was paid for.
      reject(new ProviderError('timeout', 'the model took too long', false));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      // Nothing was called, so nothing was paid for.
      reject(new ProviderError('timeout', 'the model took too long', false));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
