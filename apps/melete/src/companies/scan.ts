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

import type { LedgerItem } from '@melete/contracts';
import type { CompanyExtractor, ScanExtractor } from './extract.ts';
import { MAILBOX_UNREADABLE, MailboxUnreadable, type ScanMailbox } from './mailbox.ts';
import { messageText, type ScanMessage } from './messages.ts';
import { prefilter } from './prefilter.ts';
import type { CompanyStore, Owner, ScanRecord, StoredMessage } from './repository.ts';
import { type AdmissionContext, admitAll, noDrops } from './validate.ts';

export const DEFAULT_WINDOW_DAYS = 90;

export type ScanOptions = {
  store: CompanyStore;
  mailbox: ScanMailbox;
  extractor: CompanyExtractor;
  owner: Owner;
  /** The person's time zone, from their profile; a period in an email counts from their day. */
  timeZone?: string;
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
  /**
   * Model calls this person's scans may make in a day, across all their spaces.
   * Left out, a scan makes as many as it has messages to read.
   */
  dailyCalls?: number;
};

/** The window a daily allowance counts over. */
const DAY_MS = 24 * 60 * 60 * 1000;

export type ScanOutcome = ScanRecord & { counts: Record<string, number> };

/** Why a scan failed: the mailbox could not be read, or something after it went wrong. */
/**
 * What a failed scan says, from a fixed set. The mailbox's own sentence when it
 * said why it could not be read; otherwise one of these.
 */
export const SCAN_FAILED = {
  mailbox: "I couldn't read your mailbox.",
  after: 'This scan stopped before it finished. Scan again.',
} as const;

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
  let reason: string = SCAN_FAILED.mailbox;
  let session: ScanExtractor | undefined;
  let calls = 0;
  try {
    const messages = await options.mailbox.recent(options.readLimit ?? 50);
    reason = SCAN_FAILED.after;
    const grouped = prefilter(messages, {
      now,
      windowDays,
      maxCandidates: options.maxCandidatesPerCompany,
    });
    seen = grouped.counts.inWindow;
    Object.assign(counts, grouped.counts);

    // Stored first: a quote is only ever checked against text the store has.
    const stored: StoredMessage[] = [];
    const texts = new Map<string, string>();
    for (const group of grouped.companies) {
      for (const message of group.candidates) {
        const text = messageText(message);
        texts.set(message.messageId, text);
        stored.push({
          messageId: message.messageId,
          subject: message.subject,
          from: message.from,
          receivedAt: message.receivedAt,
          text,
        });
      }
    }
    await options.store.saveMessages(options.owner, record.id, stored);

    // A live extractor spends against a budget; this scan gets one of its own,
    // so no other scan, and no other person's, can use it up.
    session = await options.extractor.forScan?.();
    const extractor = session ?? options.extractor;
    // A message a model has already answered for is not asked about again: what
    // it said is in the store, and asking twice only spends twice.
    const alreadyRead = await options.store.extractedMessageIds(
      options.owner,
      stored.map((message) => message.messageId),
    );
    const allowance =
      options.dailyCalls === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(
            0,
            options.dailyCalls -
              (await options.store.modelCallsSince(
                options.owner.principalId,
                new Date(now.getTime() - DAY_MS),
              )),
          );
    const answered: string[] = [];
    const admitted: LedgerItem[] = [];
    for (const group of grouped.companies) {
      if (!group.candidates.length) continue;
      const companyId = await options.store.saveCompany(options.owner, record.id, {
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
        const text = texts.get(message.messageId) ?? messageText(message);
        // One message the extractor cannot read is one message missing from the
        // map, not a failed scan. This is the same judgement the contract makes
        // about a bad span: drop the one thing, count it, and keep the rest,
        // because a person is better served by most of their companies than by
        // an error where a map should be.
        if (alreadyRead.has(message.messageId)) {
          counts.already_read = (counts.already_read ?? 0) + 1;
          continue;
        }
        if (calls >= allowance) {
          counts.daily_allowance_reached = (counts.daily_allowance_reached ?? 0) + 1;
          continue;
        }
        calls += 1;
        let items: Awaited<ReturnType<CompanyExtractor['extract']>> = [];
        try {
          items = await extractor.extract({
            messageId: message.messageId,
            companyName: group.name,
            domain: group.domain,
            from: message.from,
            subject: message.subject,
            receivedAt: message.receivedAt,
            text,
            ...(options.timeZone ? { timeZone: options.timeZone } : {}),
          });
        } catch {
          counts.extractor_failed = (counts.extractor_failed ?? 0) + 1;
          continue;
        }
        // A call the provider never answered is asked again next time.
        if (!session?.unanswered?.has(message.messageId)) answered.push(message.messageId);
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
      // charge, so it can never exceed what the person can open and read. It
      // follows the map's own rule: standing charges only, in one currency, at
      // the price each one states. A one-off bill is not a month's spend, and
      // a monthly charge read out of a 90-day window is still that charge.
      const standing = result.items.filter(
        (item) =>
          item.kind === 'subscription' &&
          item.direction === 'you_pay' &&
          item.amount_minor !== null &&
          item.currency !== null,
      );
      const currency = standing[0]?.currency;
      const monthly = standing
        .filter((item) => item.currency === currency)
        .reduce((sum, item) => sum + (item.amount_minor ?? 0), 0);
      if (currency)
        await options.store.saveCompany(options.owner, record.id, {
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
    found = await options.store.saveItems(options.owner, record.id, admitted);
    await options.store.markExtracted(options.owner, answered);
    counts.proposed = admitted.length;
    await options.store.closeScan(options.owner, record.id, {
      status: 'done',
      messagesSeen: seen,
      itemsFound: found,
      counts,
      modelCalls: session ? calls : 0,
    });
    return { ...record, status: 'done', messagesSeen: seen, itemsFound: found, counts };
  } catch (error) {
    // The reason comes from a fixed set of the scan's own sentences. What a
    // transport or a store threw can carry a server's reply, an account name or
    // a sentence out of somebody's mail, and none of that is kept or shown.
    if (error instanceof MailboxUnreadable) reason = MAILBOX_UNREADABLE[error.reason];
    await options.store.closeScan(options.owner, record.id, {
      status: 'failed',
      messagesSeen: seen,
      itemsFound: found,
      counts,
      error: reason,
      modelCalls: session ? calls : 0,
    });
    return {
      ...record,
      status: 'failed',
      messagesSeen: seen,
      itemsFound: found,
      counts,
      error: reason,
    };
  } finally {
    await session?.close().catch(() => undefined);
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
