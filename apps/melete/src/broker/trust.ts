/**
 * Where the values in a payload came from.
 *
 * A payload is a flat set of bytes by the time it reaches admission, and an
 * address the owner typed is indistinguishable from an address the model lifted
 * out of a web page it read on Friday. This module restores that difference: it
 * picks the fields that decide where an external write lands or what a spend
 * costs, asks a resolver where each of them came from, and turns anything that
 * is not the owner or a verified connector into a warning in plain words.
 *
 * The resolver is injected. The memory lane owns the real one; what ships here
 * is a stub that answers from a table and defaults to `unknown`, because not
 * knowing is the answer that must behave like the dangerous one.
 */
import {
  type JsonObject,
  type JsonValue,
  type OriginField,
  type OriginFieldCategory,
  type OriginResolution,
  type OriginTrust,
  type OriginWarning,
  originResolution,
  warningsFor,
} from '@melete/contracts';
import type { Query } from './records.ts';

/**
 * Field names by what they decide. A name not in one of these sets carries no
 * gate: the body of a message can say anything, because it does not choose a
 * destination. Matching is on the key alone, at any depth.
 */
export const ORIGIN_FIELD_NAMES: Record<OriginFieldCategory, readonly string[]> = {
  recipient: [
    'to',
    'cc',
    'bcc',
    'recipient',
    'recipients',
    'attendees',
    'payee',
    'account',
    'account_id',
    'iban',
    'phone',
    'phone_number',
  ],
  destination: [
    'url',
    'endpoint',
    'host',
    'hostname',
    'domain',
    'destination',
    'webhook',
    'webhook_url',
    'link',
    'target_url',
    'address',
  ],
  amount: ['amount', 'amount_usd', 'total', 'price', 'cost', 'quantity', 'value_usd'],
  resource: [
    'resource',
    'resource_id',
    'path',
    'from_path',
    'to_path',
    'area',
    'to_area',
    'uid',
    'calendar',
    'mailbox',
    'folder',
    'file',
    'file_path',
    'key',
  ],
};

const CATEGORY_BY_NAME: ReadonlyMap<string, OriginFieldCategory> = new Map(
  Object.entries(ORIGIN_FIELD_NAMES).flatMap(([category, names]) =>
    names.map((name) => [name, category as OriginFieldCategory] as const),
  ),
);

const scalar = (value: JsonValue): string | null => {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

function walk(
  value: JsonValue,
  path: string,
  category: OriginFieldCategory | null,
  found: OriginField[],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`, category, found);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      const nested = CATEGORY_BY_NAME.get(key.toLowerCase()) ?? null;
      walk(
        (value as JsonObject)[key] as JsonValue,
        path === '' ? key : `${path}.${key}`,
        nested,
        found,
      );
    }
    return;
  }
  if (category === null) return;
  const text = scalar(value);
  if (text !== null) found.push({ path, category, value: text });
}

/**
 * Every value in a canonical payload that chooses a recipient, a destination,
 * an amount or a resource, in a stable order so two runs agree.
 */
export function collectOriginFields(payload: JsonObject, kind?: string): OriginField[] {
  const found: OriginField[] = [];
  walk(payload, '', null, found);
  if (kind === 'browser.submit') {
    const intent = payload.intent;
    const values =
      intent && typeof intent === 'object' && !Array.isArray(intent) ? intent.fields : null;
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      // A site controls its field names. An unfamiliar name must not hide a destination or amount.
      for (const [name, value] of Object.entries(values)) {
        const path = `intent.fields.${name}`;
        if (typeof value === 'string' && value && !found.some((field) => field.path === path))
          found.push({
            path,
            category: CATEGORY_BY_NAME.get(name.toLowerCase()) ?? 'resource',
            value,
          });
      }
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type TrustResolutionInput = {
  space_id: string;
  job_id: string;
  connection_id: string;
  kind: string;
  effect_class: string;
  canonical_payload: JsonObject;
  /** The fields the broker is gating. A resolver may answer for a subset. */
  fields: OriginField[];
};

/**
 * Where each value came from. The memory lane implements this against its own
 * records; the broker only ever asks, and treats silence as `unknown`.
 */
export interface TrustResolver {
  resolve(tx: Query, input: TrustResolutionInput): Promise<OriginResolution[]>;
}

const DESCRIPTIONS: Record<OriginTrust, string> = {
  owner: 'You supplied this value.',
  verified_connector: 'A connected account supplied this value.',
  external_content: 'This value came from content Melete read, not from you.',
  inferred: 'Melete inferred this value; you never supplied it.',
  unknown: 'Melete cannot say where this value came from.',
};

/** Plain words a person can act on, with the handle when there is one. */
export function describeOrigin(trust: OriginTrust, handle: string | null): string {
  return handle ? `${DESCRIPTIONS[trust]} It came from ${handle}.` : DESCRIPTIONS[trust];
}

export type TrustTableEntry = {
  origin_trust: OriginTrust;
  handle?: string | null;
  description?: string;
};
export type TrustTable = Map<string, TrustTableEntry> | Record<string, TrustTableEntry>;

const lookup = (table: TrustTable, value: string): TrustTableEntry | undefined => {
  const key = value.trim().toLowerCase();
  return table instanceof Map ? table.get(key) : table[key];
};

/**
 * The stub resolver: a table from value to origin, and `unknown` for everything
 * it has never heard of. Pass a `Map` and a test can change its mind between
 * the proposal and the admission, which is exactly the case that matters.
 */
export function createTableTrustResolver(
  table: TrustTable,
  options: { fallback?: OriginTrust } = {},
): TrustResolver {
  const fallback = options.fallback ?? 'unknown';
  return {
    async resolve(_tx, input) {
      return input.fields.map((field) => {
        const entry = lookup(table, field.value);
        const trust = entry?.origin_trust ?? fallback;
        const handle = entry?.handle ?? null;
        return originResolution.parse({
          ...field,
          origin_trust: trust,
          handle,
          description: entry?.description ?? describeOrigin(trust, handle),
        });
      });
    },
  };
}

/**
 * Ask the resolver, then fail closed: any gated field it did not answer for is
 * `unknown`, and any answer for a field that is not gated is discarded.
 */
export async function resolveOriginWarnings(
  tx: Query,
  resolver: TrustResolver | undefined,
  input: TrustResolutionInput,
): Promise<OriginWarning[]> {
  if (!resolver || input.fields.length === 0) return [];
  const answered = new Map<string, OriginResolution>();
  for (const resolution of await resolver.resolve(tx, input)) {
    const parsed = originResolution.parse(resolution);
    answered.set(parsed.path, parsed);
  }
  const resolutions = input.fields.map(
    (field) =>
      answered.get(field.path) ?? {
        ...field,
        origin_trust: 'unknown' as const,
        handle: null,
        description: describeOrigin('unknown', null),
      },
  );
  return warningsFor(resolutions);
}
