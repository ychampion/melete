/**
 * What the scan decides before any model is asked anything.
 *
 * Grouping by sender domain and choosing which messages are worth reading is
 * arithmetic over headers and a word list, so it is done here and is the same
 * on every run. Two things follow from that. The model is shown a small,
 * already-chosen set rather than a mailbox, which is what keeps a scan cheap;
 * and the counts a scan reports — messages seen, withheld, candidates — are
 * facts about the mailbox rather than about the model's mood.
 *
 * Nothing in this file logs message content. Counts leave; sentences do not.
 */

import {
  displayName,
  nameFromDomain,
  type ScanMessage,
  scanSenderDomain,
  withheldFromScan,
} from './messages.ts';

/**
 * The words that make a message worth extracting from. Each one names something
 * a person could act on: money moving, a date arriving, a commitment made.
 * They are matched on word boundaries against subject and body together.
 */
export const CANDIDATE_PATTERNS: readonly RegExp[] = [
  /\breceipts?\b/i,
  /\binvoices?\b/i,
  /\borders?\b/i,
  /\bsubscriptions?\b/i,
  /\brenew(?:s|ed|ing|al|als)?\b/i,
  /\btrials?\b/i,
  /\bpric(?:e|es|ing)\b/i,
  /\bcharg(?:e|es|ed)\b/i,
  /\brefunds?\b/i,
  /\bcredits?\b/i,
  /\bcancel(?:s|led|ling|lation)?\b/i,
  /\bdelay(?:s|ed)?\b/i,
  /\bdeposits?\b/i,
  /\bwarrant(?:y|ies)\b/i,
  /\bcompensation\b/i,
  /\bpayments?\b/i,
  /\bdue\b/i,
  /\boverdue\b/i,
  /\bwithin \w+(?: \w+)? days?\b/i,
  /\bwe (?:will|'ll)\b/i,
  /\byour data\b/i,
  /\bpersonal data\b/i,
  /\bdata (?:we hold|retention|deletion)\b/i,
];

/** Why a message was selected, for the counts a scan reports. */
export type CandidateReason = (typeof CANDIDATE_PATTERNS)[number]['source'];

export type PrefilterOptions = {
  /** Messages older than this are not read. The scan's window, in days. */
  windowDays: number;
  /** The instant the window is measured back from. */
  now: Date;
  /** At most this many messages are extracted from, newest first. */
  maxCandidates?: number;
};

export type CompanyGroup = {
  domain: string;
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
  messageCount: number;
  /** Messages selected for extraction, newest first. */
  candidates: ScanMessage[];
  /** How many of this company's messages carried an unsubscribe header. */
  marketingCount: number;
};

export type PrefilterResult = {
  companies: CompanyGroup[];
  counts: {
    seen: number;
    inWindow: number;
    withheld: number;
    noSender: number;
    candidates: number;
    companies: number;
  };
};

/** True when a message says something a ledger item could be made of. */
export function isCandidate(message: ScanMessage): boolean {
  const text = `${message.subject}\n${message.text}`;
  return CANDIDATE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Group a mailbox by company and choose what to read. Withheld mail is counted
 * and dropped before anything else looks at it, so an authentication code never
 * reaches a company group, let alone a model.
 */
export function prefilter(
  messages: readonly ScanMessage[],
  options: PrefilterOptions,
): PrefilterResult {
  const cutoff = options.now.getTime() - options.windowDays * 86_400_000;
  const groups = new Map<string, CompanyGroup>();
  const counts = {
    seen: messages.length,
    inWindow: 0,
    withheld: 0,
    noSender: 0,
    candidates: 0,
    companies: 0,
  };
  for (const message of messages) {
    const at = Date.parse(message.receivedAt);
    if (!Number.isFinite(at) || at < cutoff) continue;
    counts.inWindow++;
    if (withheldFromScan(message)) {
      counts.withheld++;
      continue;
    }
    const domain = scanSenderDomain(message);
    if (!domain) {
      counts.noSender++;
      continue;
    }
    const existing = groups.get(domain);
    const group: CompanyGroup = existing ?? {
      domain,
      name: displayName(message.from) ?? nameFromDomain(domain),
      firstSeenAt: message.receivedAt,
      lastSeenAt: message.receivedAt,
      messageCount: 0,
      candidates: [],
      marketingCount: 0,
    };
    group.messageCount++;
    if (message.unsubscribe) group.marketingCount++;
    if (message.receivedAt < group.firstSeenAt) group.firstSeenAt = message.receivedAt;
    if (message.receivedAt > group.lastSeenAt) group.lastSeenAt = message.receivedAt;
    // A signed display name beats a name derived from the domain, whenever one arrives.
    if (!existing || (group.name === nameFromDomain(domain) && displayName(message.from)))
      group.name = displayName(message.from) ?? group.name;
    if (isCandidate(message)) group.candidates.push(message);
    groups.set(domain, group);
  }
  const companies = [...groups.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  for (const group of companies) {
    group.candidates.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    if (options.maxCandidates !== undefined)
      group.candidates = group.candidates.slice(0, options.maxCandidates);
    counts.candidates += group.candidates.length;
  }
  counts.companies = companies.length;
  return { companies, counts };
}
