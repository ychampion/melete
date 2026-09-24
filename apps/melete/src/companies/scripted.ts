/**
 * The scripted extractor: what stands where the model stands, when no provider
 * key is configured.
 *
 * It exists for the same reason the gateway's scripted provider exists. A test,
 * a demo and a screenshot all need the scan to produce the same map twice, and
 * none of them should need a key or a network. So this reads the same message
 * text the model would read and returns the same schema, by rule rather than by
 * inference: a phrase decides the kind, and the amount and the date come from
 * the Tier 0 grammar the memory system already uses for exactly these values.
 *
 * It is deliberately literal. It finds what its rules name and nothing else, so
 * a map built from it understates rather than invents — and every item it does
 * produce carries a real span into real text, which is the property the rest of
 * the pipeline is built to enforce.
 */

import type { LedgerDirection, LedgerItemKind } from '@melete/contracts';
import { tier0Values } from '../memory/tier0.ts';
import type { CompanyExtractor, ExtractedItem, ExtractionRequest } from './extract.ts';

type Rule = {
  pattern: RegExp;
  kind: LedgerItemKind;
  direction: LedgerDirection;
  playbook: ExtractedItem['suggested_playbook'];
  summary: string;
  /** A rule that must not also fire as something else; first match on a sentence wins. */
  confidence?: ExtractedItem['confidence'];
};

/**
 * Ordered: the first rule that matches a sentence owns it. A promise is last so
 * that "we will refund you £42 within 5 working days" is read as the refund it
 * is, and the promise rules pick up the commitments that stand on their own.
 */
const RULES: readonly Rule[] = [
  {
    // "In credit" is the same claim in an energy or telecoms voice, and it is
    // usually the sentence carrying the figure, so it must be reachable.
    pattern: /\b(?:refund(?:ed)?|money back|reimburse(?:d|ment)?|in credit)\b/i,
    kind: 'refund_owed',
    direction: 'owed_to_you',
    playbook: 'refund-owed',
    summary: 'Refund owed to you',
  },
  {
    pattern:
      /\b(?:charged (?:you )?twice|duplicate charge|incorrect(?:ly)? charged|billed twice|charged in error|over-?charg(?:e|es|ed|ing)|charged too much)\b/i,
    kind: 'wrong_charge',
    direction: 'owed_to_you',
    playbook: 'wrong-charge',
    summary: 'A charge that looks wrong',
  },
  {
    pattern: /\b(?:compensation|delay repay|delayed by \d+|cancelled your (?:train|flight))\b/i,
    kind: 'compensation',
    direction: 'owed_to_you',
    playbook: 'refund-owed',
    summary: 'Compensation you can claim',
  },
  {
    // Companies announce a rise in the present continuous far more often than
    // the simple present: "your price is increasing", "the price is changing".
    pattern:
      /\b(?:price (?:is |are )?(?:going up|ris(?:e|es|ing)|increas(?:e|es|ed|ing)|chang(?:e|es|ed|ing))|new price|increasing your|price rise|price (?:will|is going to) (?:increase|rise|change))\b/i,
    kind: 'price_rise',
    direction: 'you_pay',
    playbook: 'price-rise',
    summary: 'The price is going up',
  },
  {
    pattern: /\b(?:free trial|trial (?:ends|ending|expires)|end of your trial)\b/i,
    kind: 'trial_ending',
    direction: 'info',
    playbook: 'cancel-subscription',
    summary: 'A trial is ending',
  },
  {
    pattern: /\b(?:renews?|renewal|auto-?renew(?:s|al)?|will be renewed)\b/i,
    kind: 'renewal',
    direction: 'you_pay',
    playbook: 'cancel-subscription',
    summary: 'A renewal is coming',
  },
  {
    // An invoice line names the invoice and then, some way further along the
    // same sentence, what is wrong with it: "Invoice 2026-121 for GBP 6,750.00
    // is now overdue". The words in between are the amount, so the two halves
    // are matched with a bounded gap rather than side by side.
    // The gap admits full stops, because the thing sitting between the invoice
    // number and its verdict is usually the amount, and an amount has a decimal
    // point in it. A character class that excluded stops could never span one.
    pattern:
      /\binvoice\b[\s\S]{0,90}?\b(?:is (?:now )?(?:due|overdue)|remains unpaid|still outstanding|awaiting payment)\b|\bpayment is overdue\b/i,
    kind: 'invoice_unpaid',
    direction: 'owed_to_you',
    playbook: 'unpaid-invoice',
    summary: 'An invoice has not been paid',
  },
  {
    pattern: /\b(?:deposit|holding fee)\b/i,
    kind: 'deposit',
    direction: 'owed_to_you',
    playbook: 'refund-owed',
    summary: 'A deposit somebody is holding',
  },
  {
    pattern: /\b(?:warranty|guarantee(?:d)? for|covered (?:for|until))\b/i,
    kind: 'warranty',
    direction: 'info',
    playbook: null,
    summary: 'A warranty that is still running',
  },
  {
    pattern:
      /\b(?:personal data|data we (?:hold|store)|your data is|retain your (?:data|information)|data retention)\b/i,
    kind: 'data_held',
    direction: 'info',
    playbook: null,
    summary: 'They are holding your data',
  },
  {
    pattern:
      /\b(?:your (?:monthly )?(?:subscription|plan|membership)|billed monthly|monthly payment|receipt for your)\b/i,
    kind: 'subscription',
    direction: 'you_pay',
    playbook: 'cancel-subscription',
    summary: 'A subscription you are paying for',
  },
  {
    pattern:
      /\bwe (?:will|'ll|shall)\b|\bwithin \d+(?:[-–]\d+)? (?:working |business )?days?\b|\bheld for \d+ days\b|\bprice is locked\b|\bcancel any time\b|\bno price (?:rise|increase) (?:until|before)\b/i,
    kind: 'promise',
    direction: 'info',
    playbook: null,
    summary: 'Something they promised',
    confidence: 'medium',
  },
];

/** One sentence of the message, with the offsets it sits at. */
export type Segment = { start: number; end: number; text: string };

/**
 * The message cut into sentences with their spans preserved. Offsets are what
 * matters here, so the cut is done with a match over the original string rather
 * than by splitting and re-adding lengths.
 */
export function segments(text: string): Segment[] {
  const found: Segment[] = [];
  for (const match of text.matchAll(/[^\n]+/g)) {
    const line = match[0];
    let offset = match.index;
    // A full stop between two digits is a decimal point, not the end of a
    // sentence: splitting "GBP 129.99" in half loses the pence, and the pence
    // are the figure. The split is zero-width, so offsets stay exact.
    for (const raw of line.split(/(?<=[.!?])(?!\d)/)) {
      const leading = raw.length - raw.trimStart().length;
      const body = raw.trim();
      if (body)
        found.push({ start: offset + leading, end: offset + leading + body.length, text: body });
      offset += raw.length;
    }
  }
  return found;
}

/** Whole minor units from a Tier 0 decimal string: `42.50` becomes 4250. */
export function minorUnits(decimal: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) return null;
  const [whole = '0', fraction = ''] = decimal.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * A rule-driven stand-in for the model. It reads the exact text the store keeps,
 * so every span it reports is a span `evidenceHolds` will admit.
 */
export function scriptedExtractor(): CompanyExtractor {
  return {
    async extract(request: ExtractionRequest): Promise<ExtractedItem[]> {
      return scriptedItems(request);
    },
  };
}

/** A sentence that states the figure beats one that only names the subject. */
const sharper = (item: ExtractedItem): number =>
  (item.amount_minor === null ? 0 : 2) + (item.due_at === null ? 0 : 1);

export function scriptedItems(request: ExtractionRequest): ExtractedItem[] {
  // One item per kind per message: a subject line and the sentence under it say
  // the same thing twice, and two rows for one claim is noise, not evidence.
  // Where both match, the one that states an amount or a date wins, because
  // that is the sentence a person wants to open.
  const best = new Map<LedgerItemKind, ExtractedItem>();
  const order: LedgerItemKind[] = [];
  for (const segment of segments(request.text)) {
    const rule = RULES.find((entry) => entry.pattern.test(segment.text));
    if (!rule) continue;
    const values = tier0Values(segment.text, { eventAt: request.receivedAt }, segment.start);
    const amount = values.find((value) => value.type === 'amount');
    const date = values.find((value) => value.type === 'date');
    const minor = amount ? minorUnits(amount.value) : null;
    const money = minor !== null && amount?.currency ? { minor, currency: amount.currency } : null;
    const item: ExtractedItem = {
      kind: rule.kind,
      direction: rule.direction,
      amount_minor: rule.direction === 'info' ? null : (money?.minor ?? null),
      currency: rule.direction === 'info' ? null : (money?.currency ?? null),
      // A subscription is a standing charge, not a deadline. The date in the
      // sentence beside it is the renewal, and the renewal is its own item.
      // A date stated only to the day is given as a day, the way the model is
      // asked to give one, so it is admitted as a date rather than an instant.
      due_at:
        rule.kind === 'subscription' || !date
          ? null
          : date.granularity === 'day'
            ? date.value.slice(0, 10)
            : date.value,
      confidence: rule.confidence ?? (money || date ? 'high' : 'medium'),
      suggested_playbook: rule.playbook,
      summary: `${rule.summary} — ${request.companyName}`,
      evidence: [{ quote: segment.text, start: segment.start, end: segment.end }],
    };
    const held = best.get(rule.kind);
    if (!held) order.push(rule.kind);
    if (!held || sharper(item) > sharper(held)) best.set(rule.kind, item);
  }
  return order.flatMap((kind) => best.get(kind) ?? []);
}
