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
import { canonical, SENTINEL } from './text.ts';
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
/** A line the person wrote, carried along under the company's reply. */
const QUOTED = /^\s*>/;
/** Where the company's own message ends and the thread beneath it begins. */
const SEPARATOR =
  /^\s*(on\s.{0,80}\bwrote\s*:|-{2,}\s*original message|_{5,}|>{0,2}\s*from\s*:.*\bwrote)/i;

/**
 * Everything above the thread: the reply itself, envelope included, with the
 * quoted message beneath it removed.
 *
 * This is the whole of the third finding. Read as one blob, a reply and the
 * message quoted underneath it are one voice, so the person's own words came
 * back labelled as the company's and their own figure came back as a debt the
 * company had admitted. Nothing that decides what this text *is* may see past
 * this line.
 */
export function beforeThread(pasted: string): string {
  const lines: string[] = [];
  for (const line of pasted.split('\n')) {
    if (SEPARATOR.test(line)) break;
    if (QUOTED.test(line)) continue;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * The company's own prose: the above, with the envelope off as well. Quoting
 * a `Subject:` line back at the company it came from reads as a machine, so
 * the headers are kept out of anything a person will see — but they are the
 * surest sign of who wrote the message, so `company()` still reads them.
 */
export const companyText = (pasted: string): string =>
  beforeThread(pasted)
    .split('\n')
    .filter((line) => !HEADER.test(line))
    .join('\n');

/**
 * Whether this reads as a message from a company at all, rather than someone
 * describing what happened. An address, a corporate sign-off or a company
 * "we" is a message; "I bought a laptop and they stopped replying" is not.
 * Nothing may be attributed to a company that never wrote any of it.
 */
export function fromCompany(pasted: string): boolean {
  if (/^\s*(from|subject|sent)\s*:/im.test(pasted)) return true;
  if (/@[a-z0-9-]+\.[a-z]{2,}/i.test(pasted)) return true;
  return /\b(kind regards|best regards|yours (sincerely|faithfully)|customer (care|service|support)|we (have|are|can|will|would|apologise))\b/i.test(
    pasted,
  );
}
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
function sentences(body: string): string[] {
  const found = canonical(body)
    // Each block was written as its own piece. A candidate never spans two, or
    // the gate would refuse it — and rightly, since nobody wrote it that way.
    .split(SENTINEL)
    .flatMap((block) => block.split(BREAK))
    // A greeting has no full stop, so it runs into the first real sentence.
    .map((line) => line.replace(/^(dear|hi|hello)\b[^,]{0,40},\s*/i, '').trim())
    .filter((line) => line.length >= 24 && line.length <= 300)
    // A sign-off proves nothing, and quoting one back reads as a machine.
    .filter(
      (line) =>
        !/^(kind|best|warm) (regards|wishes)\b|^yours (sincerely|faithfully)\b|^(many )?thanks\b|^(the )?\w+ (customer (care|service|support)|team)$/i.test(
          line,
        ),
    );
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

export type Kind = 'refused' | 'refund' | 'price_rise' | 'delay' | 'general';

/**
 * A refusal says the word "refund" as often as a promise does, and reading
 * only for that word turned "we are not able to offer a refund" into a debt
 * the company had admitted. So a refusal is looked for first, and the rest of
 * the word-matching only runs on text that is not one.
 */
const REFUSAL =
  /\b(not able to|unable to|cannot|can ?not|won'?t be able|will not be able|are not in a position)\b[^.!?]{0,60}\b(offer|give|provide|issue|make|process|agree|honour|honor)\b|\b(we (have )?(decline|declined|rejected|denied)|not upheld|not entitled|no refund (is|will be)|unable to uphold|regret to (inform|advise))\b/i;

/** Ordered: a delay notice often mentions a refund, and a price rise often mentions both. */
export function kindOf(text: string): Kind {
  if (REFUSAL.test(text)) return 'refused';
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

  if (kind === 'refused') {
    // They have said no. Nothing is owed on their own account, so no figure
    // is claimed; what is worth having is the reason, in writing.
    return {
      issue: `${name} has turned down what you asked for.`,
      summary:
        'A first no is usually the cheapest answer to give, not the final one. Ask for the reason in writing, the term they are relying on, and how to take it further.',
      amount: null,
      level: 'low',
      why: 'A refusal already in writing is the thing a complaints handler, or a scheme, will look at first.',
      days: 30,
      subject: `Please put the reason in writing`,
      ask: 'Please send me the reason for this decision in writing, the term or policy you are relying on, and how I take this further if I disagree.',
    };
  }

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
  // Everything that decides what this is reads the company's own words only.
  // The thread underneath belongs to the person, and reading it as the
  // company's is how a refusal turned into an admission of debt.
  const above = beforeThread(run.pasted);
  const body = companyText(run.pasted);
  const text = canonical(body);
  const theirs = fromCompany(above);
  // Who wrote it is clearest from the envelope, so this one line reads it.
  const name = company(canonical(above));
  const reading = read(kindOf(text), name, amounts(text));
  const quoted = sentences(body).slice(0, 3);
  const said = theirs ? quoted : [];

  return {
    company: name,
    issue: reading.issue,
    entitlement: {
      summary: reading.summary,
      amount_minor: reading.amount?.minor ?? null,
      currency: reading.amount?.currency ?? null,
      // A basis is something the company put in writing. With no message from
      // one there is nothing to stand on, and saying otherwise would put the
      // person's own account in the company's mouth.
      basis: said.slice(0, 2).map((line, at) => ({
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
    evidence: quoted.map((line) => ({
      quote: line,
      why: theirs ? 'From the message itself.' : 'From what you described.',
    })),
    odds: { level: reading.level, why: reading.why, expected_days: reading.days },
    message: {
      subject: reading.subject,
      body: [
        'Hello,',
        '',
        `I am writing about ${name === 'the company' ? 'this account' : `my account with ${name}`}.`,
        said[0] ? `Your own message says: "${said[0]}"` : 'I have had no resolution so far.',
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
