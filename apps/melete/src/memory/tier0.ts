/**
 * E3 Tier 0. The extractors that run before any model call.
 *
 * The facts that decide actions are the ones models fumble: when, who, how much.
 * So they are not asked of a model at all. Dates and times are resolved by a real
 * parser against the source's own event time and the owner's zone; addresses,
 * phone numbers, URLs and amounts are grammar; and a connector observation - a
 * calendar entry, a contact record, a receipt - becomes a `checked_fact` with no
 * model in the path.
 *
 * What Tier 0 cannot know is the subject: a date in a sentence does not say which
 * event it belongs to. That is the one thing Tier 1 is allowed to propose, and
 * `validate.ts` checks its proposal against the values found here.
 */

import {
  type ExtractionProposal,
  isMemoryKey,
  type SourceEvent,
  type SupportingSpan,
} from '@melete/contracts';
import * as chrono from 'chrono-node';

export type Tier0ValueType = 'date' | 'email' | 'phone' | 'url' | 'amount';
export type Tier0Value = {
  type: Tier0ValueType;
  /** UTF-16 offsets into the whole source text, matching the reference format. */
  start: number;
  end: number;
  text: string;
  /** The resolved form: an ISO instant, a lowercased address, digits, a currency amount. */
  value: string;
  currency?: string;
  granularity?: 'day' | 'minute';
};

/**
 * The zone's offset at one instant, computed from the platform's own tz database
 * rather than from a table we would have to keep up to date. An unknown zone
 * falls back to UTC rather than to the server's local time, which would make the
 * same evidence resolve differently on two machines.
 */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

export const DEFAULT_TIME_ZONE = 'UTC';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+/g;
const URL = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const AMOUNT =
  /(?:(?<symbol>[$£€¥])\s?(?<symbolled>\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|(?<coded>\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?(?<code>USD|EUR|GBP|JPY|INR|CAD|AUD|CHF))/g;
const PHONE = /\+\d[\d\s().-]{6,20}\d|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;
const SYMBOL_CURRENCY: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
};

export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export const normalizePhone = (value: string) => {
  const digits = value.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : digits.replace(/^\+/, '');
};

const overlaps = (values: readonly Tier0Value[], start: number, end: number) =>
  values.some((value) => value.start < end && value.end > start);

/**
 * Every typed value in one stretch of evidence, with exact spans. `offset` is
 * added to every span so a segment's values carry whole-source coordinates.
 */
export function tier0Values(
  text: string,
  reference: { eventAt: string; timeZone?: string },
  offset = 0,
): Tier0Value[] {
  const instant = new Date(reference.eventAt);
  const zone = reference.timeZone ?? DEFAULT_TIME_ZONE;
  const values: Tier0Value[] = [];
  // Dates first: a phone grammar would otherwise swallow "2026-08-10".
  for (const result of chrono.parse(text, {
    instant,
    timezone: zoneOffsetMinutes(zone, instant),
  })) {
    const certainMinute = result.start.isCertain('hour');
    values.push({
      type: 'date',
      start: offset + result.index,
      end: offset + result.index + result.text.length,
      text: result.text,
      value: result.start.date().toISOString(),
      granularity: certainMinute ? 'minute' : 'day',
    });
  }
  const scan = (pattern: RegExp, make: (match: RegExpExecArray) => Tier0Value | null) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const built = make(match);
      if (!built) continue;
      if (built.type !== 'date' && overlaps(values, built.start - offset, built.end - offset))
        continue;
      values.push(built);
    }
  };
  scan(EMAIL, (match) => ({
    type: 'email',
    start: offset + match.index,
    end: offset + match.index + match[0].length,
    text: match[0],
    value: normalizeEmail(match[0]),
  }));
  scan(URL, (match) => ({
    type: 'url',
    start: offset + match.index,
    end: offset + match.index + match[0].length,
    text: match[0],
    value: match[0],
  }));
  scan(AMOUNT, (match) => {
    const groups = match.groups ?? {};
    const currency = groups.symbol ? SYMBOL_CURRENCY[groups.symbol] : groups.code;
    const amount = groups.symbolled ?? groups.coded;
    if (!currency || !amount) return null;
    return {
      type: 'amount',
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      text: match[0],
      value: amount.replace(/,/g, ''),
      currency,
    };
  });
  scan(PHONE, (match) => ({
    type: 'phone',
    start: offset + match.index,
    end: offset + match.index + match[0].length,
    text: match[0],
    value: normalizePhone(match[0]),
  }));
  return values.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Resolve one date expression, or nothing. This is the only date authority. */
export function parseTier0Date(
  text: string,
  reference: { eventAt: string; timeZone?: string },
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const instant = new Date(reference.eventAt);
  const zone = reference.timeZone ?? DEFAULT_TIME_ZONE;
  const parsed = chrono.parse(trimmed, {
    instant,
    timezone: zoneOffsetMinutes(zone, instant),
  });
  const first = parsed[0];
  // A partial match means the string holds something besides a date; the whole
  // string is the claim's content, so a partial parse is not a parse.
  if (!first || first.text.trim().length < trimmed.length) return null;
  return first.start.date().toISOString();
}

// --------------------------------------------------------------------------
// Connector observations
// --------------------------------------------------------------------------

/**
 * The shape a connector writes when it reports what it saw. It is data, not
 * prose: a calendar entry, a contact record or a receipt, already structured,
 * with the slug the space uses for that subject.
 */
export type ConnectorObservation =
  | {
      kind: 'calendar_event';
      slug: string;
      summary?: string;
      start?: string;
      location?: string;
    }
  | { kind: 'contact'; slug: string; name?: string; email?: string; phone?: string }
  | { kind: 'receipt'; slug: string; amount?: string; currency?: string; paid_at?: string };

export function parseObservation(text: string): ConnectorObservation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  const slug = record.slug;
  if (typeof slug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) return null;
  if (kind !== 'calendar_event' && kind !== 'contact' && kind !== 'receipt') return null;
  return record as ConnectorObservation;
}

/**
 * The span of one field's value inside the observation text. The quote is the
 * exact bytes, including quotes, so the same verbatim check that guards a model
 * proposal guards this one.
 */
function fieldSpan(text: string, value: string): { start: number; end: number } | null {
  const encoded = JSON.stringify(value);
  const index = text.indexOf(encoded);
  return index < 0 ? null : { start: index, end: index + encoded.length };
}

export type Tier0Proposal = Extract<ExtractionProposal, { op: 'add' }> & { key: string };

/**
 * Turn a connector observation into claims. No model is called, the key comes
 * from the observation's own slug and the registry, and the value is the
 * connector's structured field rather than a guess about a sentence.
 */
export function observationProposals(
  source: SourceEvent,
  text: string,
  reference: { timeZone?: string; offset?: number } = {},
): Tier0Proposal[] {
  const offset = reference.offset ?? 0;
  if (source.source_type !== 'observation' && source.source_type !== 'receipt') return [];
  const observation = parseObservation(text);
  if (!observation) return [];
  const proposals: Tier0Proposal[] = [];
  const add = (key: string, raw: string, content: string) => {
    if (!isMemoryKey(key)) return;
    const span = fieldSpan(text, raw);
    if (!span) return;
    const sources: SupportingSpan[] = [
      {
        source_id: source.source_id,
        source_version: source.source_version,
        start: offset + span.start,
        end: offset + span.end,
        quote: text.slice(span.start, span.end),
      },
    ];
    proposals.push({
      op: 'add',
      expected_revision: null,
      domain_key: key,
      key,
      content,
      kind: 'checked_fact',
      factual_status: 'checked',
      valid_from: source.event_at,
      valid_until: null,
      sources,
    });
  };
  if (observation.kind === 'calendar_event') {
    if (observation.start) {
      const resolved =
        parseTier0Date(observation.start, {
          eventAt: source.event_at,
          timeZone: reference.timeZone,
        }) ?? null;
      if (resolved) add(`event.${observation.slug}.date`, observation.start, resolved);
    }
    if (observation.location)
      add(`event.${observation.slug}.location`, observation.location, observation.location);
  }
  if (observation.kind === 'contact') {
    if (observation.email)
      add(
        `contact.${observation.slug}.email`,
        observation.email,
        normalizeEmail(observation.email),
      );
    if (observation.phone)
      add(
        `contact.${observation.slug}.phone`,
        observation.phone,
        normalizePhone(observation.phone),
      );
  }
  if (observation.kind === 'receipt' && observation.paid_at) {
    const resolved = parseTier0Date(observation.paid_at, {
      eventAt: source.event_at,
      timeZone: reference.timeZone,
    });
    // The registry has no shape for a money amount yet; growing it is a reviewed
    // commit, so the receipt contributes its date and its amount stays evidence.
    if (resolved) add(`event.${observation.slug}.date`, observation.paid_at, resolved);
  }
  return proposals;
}
