/**
 * One scan, end to end: read the mailbox, group it, choose what to read, ask
 * the extractor, check every claim against the stored text, add up what
 * survived, write it down.
 *
 * The order matters and is the whole design. Messages are stored before any
 * item quotes them, so a span is always checked against text that already
 * exists. Nothing the extractor returns is written; only what `admitAll`
 * admitted is. And the totals are computed from the written items rather than
 * carried out of the extraction, so the figure at the top of the map is the sum
 * of the sentences underneath it.
 */

import { evidenceHolds, type LedgerItem } from '@melete/contracts';
import type { CompanyExtractor } from './extract.ts';
import type { ScanMailbox } from './mailbox.ts';
import { messageText, type ScanMessage } from './messages.ts';
import { monthlySpendFrom, prefilter } from './prefilter.ts';
import type { CompanyStore, Owner, ScanRecord, StoredMessage } from './repository.ts';
import { type AdmissionContext, admitAll, noDrops } from './validate.ts';

export const DEFAULT_WINDOW_DAYS = 90;

export type ScanOptions = {
  store: CompanyStore;
  mailbox: ScanMailbox;
  extractor: CompanyExtractor;
  owner: Owner;
  now?: Date;
  windowDays?: number;
  /** How many messages to read from the mailbox before the window is applied. */
  readLimit?: number;
  /** At most this many messages per company reach the extractor. */
  maxCandidatesPerCompany?: number;
  /**
   * A scan row already opened by the caller. The route opens it so it can hand
   * the person an id before the work starts; the scan then fills that row in
   * rather than starting a second one.
   */
  scan?: ScanRecord;
};

export type ScanOutcome = ScanRecord & { counts: Record<string, number> };

/**
 * Run the scan. Failures are recorded on the scan row rather than thrown at the
 * caller: a scan that could not read the mailbox is a scan that failed, and the
 * person watching it should be told that and not be shown a stale map.
 */
export async function runScan(options: ScanOptions): Promise<ScanOutcome> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const record = options.scan ?? (await options.store.openScan(options.owner));
  const counts: Record<string, number> = { ...noDrops() };
  let seen = 0;
  let found = 0;
  try {
    const messages = await options.mailbox.recent(options.readLimit ?? 50);
    const grouped = prefilter(messages, {
      now,
      windowDays,
      maxCandidates: options.maxCandidatesPerCompany,
    });
    seen = grouped.counts.inWindow;
    Object.assign(counts, grouped.counts);

    // Stored first: a quote is only ever checked against text the store has.
    //
    // A Message-ID is chosen by whoever sent the mail, so two messages can
    // claim the same one. The store keeps one row per id, so a scan that read
    // both would admit a figure from one and leave the other's text for the
    // person to open — the figure and its own sentence disagreeing, which is
    // the one thing this module promises cannot happen. The second message
    // under an id is therefore refused here and counted, before anything reads
    // it, and the survivor is the first the prefilter ordered: newest wins.
    const stored: StoredMessage[] = [];
    const claimed = new Set<string>();
    for (const group of grouped.companies) {
      for (const message of group.candidates) {
        if (claimed.has(message.messageId)) {
          counts.duplicate_message_id = (counts.duplicate_message_id ?? 0) + 1;
          continue;
        }
        claimed.add(message.messageId);
        stored.push({
          messageId: message.messageId,
          subject: message.subject,
          from: message.from,
          receivedAt: message.receivedAt,
          text: messageText(message),
        });
      }
    }
    await options.store.saveMessages(options.owner, stored);

    // And then read back what the store actually kept, rather than trusting the
    // copy in hand to match it. From here on the extractor sees the stored
    // string and admission checks the stored string, so "the text the model
    // read" and "the text the person opens" are one value, not two that agree.
    const texts = await options.store.storedTexts(
      options.owner,
      stored.map((message) => message.messageId),
    );

    const admitted: LedgerItem[] = [];
    for (const group of grouped.companies) {
      if (!group.candidates.length) continue;
      const companyId = await options.store.saveCompany(options.owner, {
        name: group.name,
        domain: group.domain,
        monthly_spend_minor: null,
        currency: null,
        first_seen_at: group.firstSeenAt,
        last_seen_at: group.lastSeenAt,
        message_count: group.messageCount,
      });
      const proposed: {
        candidate: Awaited<ReturnType<CompanyExtractor['extract']>>[number];
        context: AdmissionContext;
      }[] = [];
      for (const message of group.candidates) {
        // Only the stored string will do. A message the store does not hold —
        // because it lost a Message-ID clash, or because the write did not land
        // — is one nothing can be checked against, so it is not read at all.
        const text = texts.get(message.messageId);
        if (text === undefined) {
          counts.text_not_stored = (counts.text_not_stored ?? 0) + 1;
          continue;
        }
        // One message the extractor cannot read is one message missing from the
        // map, not a failed scan. This is the same judgement the contract makes
        // about a bad span: drop the one thing, count it, and keep the rest,
        // because a person is better served by most of their companies than by
        // an error where a map should be.
        let items: Awaited<ReturnType<CompanyExtractor['extract']>> = [];
        try {
          items = await options.extractor.extract({
            messageId: message.messageId,
            companyName: group.name,
            domain: group.domain,
            from: message.from,
            subject: message.subject,
            receivedAt: message.receivedAt,
            text,
          });
        } catch {
          counts.extractor_failed = (counts.extractor_failed ?? 0) + 1;
          continue;
        }
        for (const candidate of items)
          proposed.push({
            candidate,
            context: {
              spaceId: options.owner.spaceId,
              principalId: options.owner.principalId,
              companyId,
              messageId: message.messageId,
              messageText: text,
            },
          });
      }
      const result = admitAll(proposed);
      for (const [reason, value] of Object.entries(result.drops))
        counts[reason] = (counts[reason] ?? 0) + value;
      admitted.push(...result.items);

      // A company's monthly figure is derived from what it was admitted to
      // charge, so it can never exceed what the person can open and read.
      const spend = result.items
        .filter((item) => item.direction === 'you_pay' && item.amount_minor !== null)
        .map((item) => item.amount_minor ?? 0);
      const currency = result.items.find(
        (item) => item.direction === 'you_pay' && item.currency,
      )?.currency;
      const monthly = monthlySpendFrom(spend, windowDays);
      if (monthly !== null && currency)
        await options.store.saveCompany(options.owner, {
          id: companyId,
          name: group.name,
          domain: group.domain,
          monthly_spend_minor: monthly,
          currency,
          first_seen_at: group.firstSeenAt,
          last_seen_at: group.lastSeenAt,
          message_count: group.messageCount,
        });
    }
    // The last gate, and the one that makes the promise structural rather than
    // procedural: before a single row is written, every admitted item is
    // checked once more against the text the store holds for the message it
    // cites, read fresh. Admission already checked the same string, so this
    // should never drop anything — and that is the point. If some future change
    // lets the text a span was measured against drift from the text a person
    // opens, items stop being written instead of being written wrong.
    const finalTexts = await options.store.storedTexts(
      options.owner,
      admitted.flatMap((item) => item.evidence.map((entry) => entry.message_id)),
    );
    const writable = admitted.filter((item) =>
      item.evidence.every((entry) => {
        const text = finalTexts.get(entry.message_id);
        return text !== undefined && evidenceHolds(text, entry);
      }),
    );
    counts.evidence_after_store = admitted.length - writable.length;
    found = await options.store.saveItems(options.owner, record.id, writable);
    counts.proposed = writable.length;
    await options.store.closeScan(options.owner, record.id, {
      status: 'done',
      messagesSeen: seen,
      itemsFound: found,
      counts,
    });
    return { ...record, status: 'done', messagesSeen: seen, itemsFound: found, counts };
  } catch (error) {
    // The reason is a short phrase for the person, never a stack or a sentence
    // out of somebody's mail.
    const reason = error instanceof Error ? error.message.slice(0, 200) : 'scan failed';
    await options.store.closeScan(options.owner, record.id, {
      status: 'failed',
      messagesSeen: seen,
      itemsFound: found,
      counts,
      error: reason,
    });
    return {
      ...record,
      status: 'failed',
      messagesSeen: seen,
      itemsFound: found,
      counts,
      error: reason,
    };
  }
}

/** Messages a scan would read, without running one. Used by the demo seed. */
export function scanPlan(
  messages: readonly ScanMessage[],
  now: Date,
  windowDays = DEFAULT_WINDOW_DAYS,
) {
  return prefilter(messages, { now, windowDays });
}
