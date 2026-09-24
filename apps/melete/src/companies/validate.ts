/**
 * The admission gate. Nothing a model said becomes a ledger item here without
 * passing a check this file runs in ordinary code against the stored message.
 *
 * `evidenceHolds` is the contract's own test and it is the only judge of a span.
 * Everything else in this file is the same kind of check applied to the rest of
 * the claim: an amount without a currency does not name a quantity, a due date
 * that does not parse is not a date, and the same claim read twice out of two
 * emails is one item, not two.
 *
 * Every drop is counted and the count is reported with the scan, so a map that
 * looks thin can be explained without anybody reading the mailbox.
 */

import { evidenceHolds, type LedgerItem } from '@melete/contracts';
import { newId } from '../ids.ts';
import type { ExtractedItem } from './extract.ts';

/** Why an item was refused. Names a check, never message content. */
export type DropReason =
  | 'evidence_span'
  | 'amount_without_currency'
  | 'bad_due_date'
  | 'info_with_amount'
  | 'duplicate';

export type DropCounts = Record<DropReason, number>;

export const noDrops = (): DropCounts => ({
  evidence_span: 0,
  amount_without_currency: 0,
  bad_due_date: 0,
  info_with_amount: 0,
  duplicate: 0,
});

/** What a claim needs around it before it can become a row. */
export type AdmissionContext = {
  spaceId: string;
  principalId: string;
  companyId: string;
  messageId: string;
  /** Exactly the stored text the spans were counted against. */
  messageText: string;
};

export type Admission =
  | { admitted: true; item: LedgerItem }
  | { admitted: false; reason: Exclude<DropReason, 'duplicate'> };

/** An ISO instant, or nothing. A date the parser will not take is not a date. */
export function normalizeDueAt(value: string | null): string | null | 'invalid' {
  if (value === null) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return 'invalid';
  return new Date(at).toISOString();
}

/**
 * Judge one claim. The span check runs against the stored message, so a quote
 * the model composed rather than copied fails here however plausible it reads.
 */
export function admit(candidate: ExtractedItem, context: AdmissionContext): Admission {
  for (const evidence of candidate.evidence) {
    if (!evidenceHolds(context.messageText, evidence))
      return { admitted: false, reason: 'evidence_span' };
  }
  if ((candidate.amount_minor === null) !== (candidate.currency === null))
    return { admitted: false, reason: 'amount_without_currency' };
  if (candidate.direction === 'info' && candidate.amount_minor !== null)
    return { admitted: false, reason: 'info_with_amount' };
  const dueAt = normalizeDueAt(candidate.due_at);
  if (dueAt === 'invalid') return { admitted: false, reason: 'bad_due_date' };
  // A bare calendar date names a day, not an instant; the flag keeps that fact,
  // because midnight UTC alone cannot tell the two apart.
  const dateOnly = dueAt !== null && /^\d{4}-\d{2}-\d{2}$/.test(candidate.due_at?.trim() ?? '');
  return {
    admitted: true,
    item: {
      id: newId('li'),
      space_id: context.spaceId,
      principal_id: context.principalId,
      company_id: context.companyId,
      kind: candidate.kind,
      direction: candidate.direction,
      amount_minor: candidate.amount_minor,
      currency: candidate.currency,
      due_at: dueAt,
      due_date_only: dateOnly,
      status: 'found',
      confidence: candidate.confidence,
      evidence: candidate.evidence.map((entry) => ({
        message_id: context.messageId,
        quote: entry.quote,
        start: entry.start,
        end: entry.end,
      })),
      suggested_playbook: candidate.suggested_playbook,
      job_id: null,
      summary: candidate.summary,
    },
  };
}

/**
 * Two claims are the same claim when they are about one company, of one kind,
 * for one amount, falling due in the same window. A monthly receipt and its
 * reminder say one thing; the day is the window because a company that states
 * a date twice states the same date.
 */
export function dedupeKey(item: LedgerItem): string {
  // A company charges one subscription at a time. Two receipts and a price-rise
  // notice state it three times at two different prices, and a map that listed
  // all three would add them up and tell a person they pay twice what they pay.
  // The scan reads newest first, so keying a subscription on its company alone
  // keeps the price in force and leaves the old one to the price_rise item,
  // which is where a change belongs.
  if (item.kind === 'subscription') return [item.company_id, item.kind].join('|');
  const due = item.due_at ? item.due_at.slice(0, 10) : '';
  return [
    item.company_id,
    item.kind,
    item.direction,
    item.amount_minor ?? '',
    item.currency ?? '',
    due,
  ].join('|');
}

/**
 * The admitted ledger, in the order the claims arrived, with the duplicates
 * removed and every refusal counted. The first of a duplicate pair is kept
 * because the scan reads newest first, so the surviving item cites the most
 * recent sentence that said it.
 */
export function admitAll(
  candidates: readonly { candidate: ExtractedItem; context: AdmissionContext }[],
): { items: LedgerItem[]; drops: DropCounts } {
  const drops = noDrops();
  const items: LedgerItem[] = [];
  const seen = new Set<string>();
  for (const entry of candidates) {
    const result = admit(entry.candidate, entry.context);
    if (!result.admitted) {
      drops[result.reason]++;
      continue;
    }
    const key = dedupeKey(result.item);
    if (seen.has(key)) {
      drops.duplicate++;
      continue;
    }
    seen.add(key);
    items.push(result.item);
  }
  return { items, drops };
}
