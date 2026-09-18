/**
 * The gates. Everything the model says passes through here before anyone sees
 * it, and the rules are code rather than instructions in a prompt, because a
 * prompt is a request and this is a guarantee.
 *
 * Three of them:
 *   1. shape — the reply is the case file or it is nothing.
 *   2. quotes — a quote the paste does not contain is dropped. If that leaves
 *      no evidence at all, the case file says so and the odds come down.
 *   3. links — a link the search did not actually return is dropped.
 */
import type { Basis, CaseFile, DraftCaseFile, Evidence, LadderStep } from './schema.ts';
import { MAX_BASIS, MAX_EVIDENCE, MAX_LADDER } from './schema.ts';
import { fold, locate } from './text.ts';

/* ---------- shape ---------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const nullableStr = (value: unknown): value is string | null => value === null || str(value);
const int = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);
const nullableInt = (value: unknown): value is number | null => value === null || int(value);

/**
 * Accept the model's reply only if every field is present and the right type.
 * Null is returned instead of throwing so the caller reports one outcome code
 * for every kind of malformed reply.
 */
export function parseDraft(value: unknown): DraftCaseFile | null {
  if (!isRecord(value)) return null;
  if (!str(value.company) || !str(value.issue) || !str(value.melete_next)) return null;

  const entitlement = value.entitlement;
  if (!isRecord(entitlement)) return null;
  if (!str(entitlement.summary)) return null;
  if (!nullableInt(entitlement.amount_minor) || !nullableStr(entitlement.currency)) return null;
  if (!Array.isArray(entitlement.basis)) return null;
  const basis: DraftCaseFile['entitlement']['basis'] = [];
  for (const entry of entitlement.basis) {
    if (!isRecord(entry) || !str(entry.claim)) return null;
    if (entry.source_kind !== 'quote' && entry.source_kind !== 'url') return null;
    if (!nullableStr(entry.quote) || !nullableStr(entry.url) || !nullableStr(entry.title))
      return null;
    basis.push({
      claim: entry.claim,
      source_kind: entry.source_kind,
      quote: entry.quote,
      url: entry.url,
      title: entry.title,
    });
  }

  if (!Array.isArray(value.evidence)) return null;
  const evidence: DraftCaseFile['evidence'] = [];
  for (const entry of value.evidence) {
    if (!isRecord(entry) || !str(entry.quote) || !str(entry.why)) return null;
    evidence.push({ quote: entry.quote, why: entry.why });
  }

  const odds = value.odds;
  if (!isRecord(odds) || !str(odds.why) || !int(odds.expected_days)) return null;
  if (odds.level !== 'high' && odds.level !== 'medium' && odds.level !== 'low') return null;

  const message = value.message;
  if (!isRecord(message) || !str(message.subject) || !str(message.body)) return null;

  if (!Array.isArray(value.ladder) || value.ladder.length === 0) return null;
  const ladder: DraftCaseFile['ladder'] = [];
  for (const entry of value.ladder) {
    if (!isRecord(entry) || !str(entry.step) || !int(entry.day_offset)) return null;
    ladder.push({ day_offset: entry.day_offset, step: entry.step });
  }

  return {
    company: value.company,
    issue: value.issue,
    entitlement: {
      summary: entitlement.summary,
      amount_minor: entitlement.amount_minor,
      currency: entitlement.currency,
      basis,
    },
    evidence,
    odds: { level: odds.level, why: odds.why, expected_days: odds.expected_days },
    message: { subject: message.subject, body: message.body },
    ladder,
    melete_next: value.melete_next,
  };
}

/* ---------- links ---------- */

/**
 * Two addresses count as the same page when their scheme, host and path match
 * once the noise is off: case, `www.`, a trailing slash, the query and the
 * fragment. Anything that is not a parseable http(s) URL can never match.
 */
export function normaliseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

export type SearchSource = { url: string; title: string | null };

/** The set of pages the search really returned, ready for exact lookup. */
export function retrievedIndex(sources: SearchSource[]): Map<string, SearchSource> {
  const index = new Map<string, SearchSource>();
  for (const source of sources) {
    const key = normaliseUrl(source.url);
    if (key && !index.has(key)) index.set(key, source);
  }
  return index;
}

/* ---------- assembly ---------- */

export type GateCounts = {
  /** Quotes the paste did not contain. */
  quotesDropped: number;
  /** Links the search did not return. */
  urlsDropped: number;
  /** Basis entries dropped because their only source failed a gate. */
  basisDropped: number;
};

export type Gated = { file: CaseFile; counts: GateCounts };

const NO_EVIDENCE =
  'Nothing in what you pasted states this outright, so there is no sentence to quote back. ' +
  'The message below asks the company for its own record of it instead.';

const LOWER: Record<CaseFile['odds']['level'], CaseFile['odds']['level']> = {
  high: 'medium',
  medium: 'low',
  low: 'low',
};

/**
 * Run every gate and build the case file the page renders. `pasted` is the raw
 * text the person typed; it is folded here and never leaves this call.
 */
export function gate(draft: DraftCaseFile, pasted: string, sources: SearchSource[]): Gated {
  const haystack = fold(pasted);
  const retrieved = retrievedIndex(sources);
  const counts: GateCounts = { quotesDropped: 0, urlsDropped: 0, basisDropped: 0 };

  const evidence: Evidence[] = [];
  const seen = new Set<number>();
  for (const entry of draft.evidence) {
    const found = locate(haystack, entry.quote);
    if (!found) {
      counts.quotesDropped += 1;
      continue;
    }
    if (seen.has(found.start)) continue;
    seen.add(found.start);
    evidence.push({ quote: found.quote, start: found.start, end: found.end, why: entry.why });
    if (evidence.length === MAX_EVIDENCE) break;
  }
  evidence.sort((a, b) => a.start - b.start);

  const shown = new Set(evidence.map((entry) => entry.start));
  const basis: Basis[] = [];
  for (const entry of draft.entitlement.basis) {
    if (basis.length === MAX_BASIS) break;
    if (entry.source_kind === 'quote') {
      const found = entry.quote ? locate(haystack, entry.quote) : null;
      if (!found) {
        counts.quotesDropped += 1;
        counts.basisDropped += 1;
        continue;
      }
      basis.push({
        claim: entry.claim,
        source: {
          kind: 'quote',
          quote: found.quote,
          start: found.start,
          end: found.end,
          // The same sentence under two headings reads as padding, so the card
          // points at the one below instead of printing it twice.
          alsoEvidence: shown.has(found.start),
        },
      });
      continue;
    }
    const key = entry.url ? normaliseUrl(entry.url) : null;
    const source = key ? retrieved.get(key) : undefined;
    if (!source) {
      counts.urlsDropped += 1;
      counts.basisDropped += 1;
      continue;
    }
    basis.push({
      claim: entry.claim,
      // The search's own title, not the model's: the address is verified, and
      // a verified address under a label like "Official Refund Law" is worse
      // than no link at all.
      source: { kind: 'url', url: source.url, title: source.title ?? entry.title },
    });
  }

  const ladder: LadderStep[] = draft.ladder
    .slice(0, MAX_LADDER)
    .map((step) => ({ dayOffset: Math.max(0, step.day_offset), step: step.step }))
    .sort((a, b) => a.dayOffset - b.dayOffset);

  const bare = evidence.length === 0;
  const currency = draft.entitlement.amount_minor === null ? null : draft.entitlement.currency;

  return {
    counts,
    file: {
      company: draft.company,
      issue: draft.issue,
      entitlement: {
        summary: draft.entitlement.summary,
        amountMinor: draft.entitlement.amount_minor,
        currency: currency ? currency.toUpperCase() : null,
        basis,
      },
      evidence,
      noEvidenceNote: bare ? NO_EVIDENCE : null,
      odds: {
        level: bare ? LOWER[draft.odds.level] : draft.odds.level,
        why: draft.odds.why,
        expectedDays: Math.max(1, draft.odds.expected_days),
      },
      message: draft.message,
      ladder,
      meleteNext: draft.melete_next,
    },
  };
}
