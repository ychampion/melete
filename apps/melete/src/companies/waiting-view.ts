/**
 * The "Waiting on" view: what companies owe the person and the replies nobody
 * has sent them, as one list, with the few worth chasing first picked out.
 *
 * Pure, over what the store already returns: the company map for each space
 * the person can see and their open awaited replies. The owed figure is the
 * map's own total, so Home and the company map never disagree about it.
 */
import {
  type AwaitedReply,
  type CompanyMap,
  type LedgerItemStatus,
  WAITING_ON_TOP,
  type WaitingOn,
  type WaitingOnEntry,
} from '@melete/contracts';
import { oneLine } from './handle.ts';
import { DEFAULT_CURRENCY } from './totals.ts';

const OPEN = new Set<LedgerItemStatus>(['found', 'handling', 'waiting']);

/**
 * Nothing is chasing it yet, so its button can start one. An item a connection
 * added has a button only when it offers a step, and the button opens the item
 * where that step's tool and input are shown; it never runs a step itself.
 */
const chaseable = (entry: WaitingOnEntry) =>
  entry.status === 'found' &&
  entry.job_id === null &&
  (entry.added_by === undefined || entry.next_step_label !== undefined);

export function waitingOnView(input: {
  maps: readonly CompanyMap[];
  replies: readonly AwaitedReply[];
  scan: WaitingOn['scan'];
}): WaitingOn {
  const currency = input.maps[0]?.currency ?? DEFAULT_CURRENCY;
  const owedMinor = input.maps
    .filter((map) => map.currency === currency)
    .reduce((sum, map) => sum + map.totals.owed_to_you_minor, 0);

  const owed: WaitingOnEntry[] = input.maps
    .flatMap((map) =>
      map.items
        .filter((item) => item.direction === 'owed_to_you' && OPEN.has(item.status))
        .map((item) => ({
          kind: 'owed' as const,
          id: item.id,
          who: map.companies.find((company) => company.id === item.company_id)?.name ?? 'A company',
          what: oneLine(item.summary, 500),
          amount_minor: item.amount_minor,
          currency: item.currency,
          due_at: item.due_at,
          sent_at: null,
          status: item.status,
          job_id: item.job_id,
          ...(item.source
            ? {
                added_by: item.source.label,
                ...(item.source.actions[0]
                  ? { next_step_label: item.source.actions[0].label }
                  : {}),
              }
            : {}),
        })),
    )
    // The most money first; an item with no figure after every one with one.
    .sort((a, b) => (b.amount_minor ?? -1) - (a.amount_minor ?? -1) || a.id.localeCompare(b.id));

  const replies: WaitingOnEntry[] = input.replies
    .filter((reply) => OPEN.has(reply.status))
    .map((reply) => ({
      kind: 'reply' as const,
      id: reply.id,
      who: oneLine(reply.to_name ?? reply.to, 320) || reply.to,
      what: oneLine(reply.evidence.quote, 500) || oneLine(reply.subject, 500) || 'Your message',
      amount_minor: null,
      currency: null,
      due_at: null,
      sent_at: reply.sent_at,
      status: reply.status,
      job_id: reply.job_id,
    }))
    // The longest wait first.
    .sort((a, b) => (a.sent_at ?? '').localeCompare(b.sent_at ?? '') || a.id.localeCompare(b.id));

  // Money and replies take turns, so neither crowds the other off the top.
  const money = owed.filter(chaseable);
  const words = replies.filter(chaseable);
  const top: WaitingOnEntry[] = [];
  for (let index = 0; top.length < WAITING_ON_TOP; index++) {
    const pair = [money[index], words[index]].filter(
      (entry): entry is WaitingOnEntry => entry !== undefined,
    );
    if (!pair.length) break;
    top.push(...pair.slice(0, WAITING_ON_TOP - top.length));
  }

  return { currency, owed_minor: owedMinor, owed, replies, top, scan: input.scan };
}
