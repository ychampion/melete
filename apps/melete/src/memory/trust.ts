/**
 * E4. The trust class of a value, and where a person would be told it came from.
 *
 * Two rules do all the work. A source's class is decided by how it arrived, not
 * by what it says: the owner typing is `owner`, a connected account reporting is
 * `verified_connector`, a fetched page or somebody else's message is
 * `external_content`, and the model's own prose is `inferred`. A claim's class is
 * then the minimum over its sources, because a claim is only as trustworthy as
 * the weakest thing it rests on.
 *
 * The resolver is the seam the broker's admission rule holds. It is implemented
 * here, in memory, and handed to the broker; the broker never reads claims.
 */
import {
  isActionableTrust,
  type JsonValue,
  minimumOriginTrust,
  type OriginTrust,
  parseMemoryHandle,
  type SourceEvent,
  type TrustResolution,
  type TrustResolver,
} from '@melete/contracts';
import { lockSpace, type MemoryScope, type MemorySql, type MemoryTx } from './db.ts';

export type SourceOrigin = {
  source_type: SourceEvent['source_type'];
  author: 'owner' | 'external';
};

/** How it arrived, never what it says. Source content cannot raise its own class. */
export function originTrustOf({ source_type, author }: SourceOrigin): OriginTrust {
  switch (source_type) {
    case 'owner_edit':
      return 'owner';
    case 'message':
      return author === 'owner' ? 'owner' : 'external_content';
    case 'observation':
    case 'receipt':
      return 'verified_connector';
    case 'document':
      return 'external_content';
    case 'assistant':
      return 'inferred';
  }
}

/** A model's own conclusion never rises above `inferred`, whatever it cites. */
export function revisionTrust(
  kind: string,
  sources: readonly { origin_trust: OriginTrust }[],
): OriginTrust {
  if (!sources.length) return 'inferred';
  const fromSources = minimumOriginTrust(sources.map((s) => s.origin_trust));
  return kind === 'inferred' ? 'inferred' : fromSources;
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
export const describeDay = (instant: string): string => DAY.format(new Date(instant));

/** Written for a person reading an approval card, not for a log. */
export function describeOrigin(source: SourceOrigin & { event_at: string }): string {
  const day = describeDay(source.event_at);
  switch (source.source_type) {
    case 'owner_edit':
      return `something you wrote yourself on ${day}`;
    case 'message':
      return source.author === 'owner'
        ? `something you said on ${day}`
        : `a message someone else sent on ${day}`;
    case 'observation':
      return `a connected account's record from ${day}`;
    case 'receipt':
      return `a receipt from ${day}`;
    case 'document':
      return `a web page fetched on ${day}`;
    case 'assistant':
      return `Melete's own working notes from ${day}`;
  }
}

const NOUN: Record<string, string> = {
  email: 'this address',
  date: 'this date',
  amount: 'this amount',
};
/** "this address came from a web page fetched on 11 September". */
export function describeField(noun: string, source: SourceOrigin & { event_at: string }): string {
  return `${NOUN[noun] ?? 'this value'} came from ${describeOrigin(source)}`;
}

export type PayloadField = { field: string; value: string };
/** Flatten a canonical payload to the string leaves an approval card would show. */
export function payloadFields(value: JsonValue, path = ''): PayloadField[] {
  if (typeof value === 'string') return value.trim() ? [{ field: path || '<root>', value }] : [];
  if (typeof value === 'number' || typeof value === 'boolean')
    return [{ field: path || '<root>', value: String(value) }];
  if (Array.isArray(value))
    return value.flatMap((item, index) => payloadFields(item, `${path}[${index}]`));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) =>
      payloadFields(item as JsonValue, path ? `${path}.${key}` : key),
    );
  return [];
}

const normalize = (value: string) => value.trim().toLowerCase();
/** A field is placed when its value is the claim's content, or sits inside it verbatim. */
const placedIn = (content: string, value: string) => {
  const haystack = normalize(content);
  const needle = normalize(value);
  return needle.length > 2 && (haystack === needle || haystack.includes(needle));
};

type ResolvedHandle = {
  handle: string;
  content: string;
  origin_trust: OriginTrust;
  origin: SourceOrigin & { event_at: string };
  value_type: string;
};

/** Load exactly the revisions the manifest names, inside the caller's space. */
async function loadHandles(
  tx: MemoryTx,
  scope: MemoryScope,
  handles: readonly string[],
): Promise<ResolvedHandle[]> {
  const loaded: ResolvedHandle[] = [];
  for (const handle of new Set(handles)) {
    const parsed = parseMemoryHandle(handle);
    if (!parsed) continue;
    if (parsed.kind === 'source') {
      const [row] = await tx`select source_type, author, event_at, origin_trust from memory_sources
        where id = ${parsed.source_id} and space_id = ${scope.spaceId} and source_version = ${parsed.source_version} and state = 'active'`;
      if (!row) continue;
      const [body] =
        await tx`select content from memory_source_content where source_id = ${parsed.source_id}`;
      loaded.push({
        handle,
        content: (body?.content as string) ?? '',
        origin_trust: row.origin_trust as OriginTrust,
        origin: {
          source_type: row.source_type as SourceEvent['source_type'],
          author: row.author as 'owner' | 'external',
          event_at: new Date(row.event_at as Date).toISOString(),
        },
        value_type: 'text',
      });
      continue;
    }
    const [row] = await tx`select r.origin_trust, r.kind, c.key, b.content from memory_revisions r
      join memory_claims c on c.id = r.claim_id
      left join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
      where r.claim_id = ${parsed.claim_id} and r.revision = ${parsed.revision}
        and c.space_id = ${scope.spaceId} and not c.hidden and r.status <> 'retracted'
        and (${scope.role === 'owner'} or c.audience in ('space','public'))`;
    if (!row) continue;
    // The description names the weakest source, because that is the one that decided the class.
    const sources = await tx`select s.source_type, s.author, s.event_at, s.origin_trust
      from memory_references ref join memory_sources s on s.id = ref.source_id
      where ref.claim_id = ${parsed.claim_id} and ref.revision = ${parsed.revision} and s.state = 'active'`;
    const weakest = sources.find((s) => s.origin_trust === row.origin_trust) ?? sources[0] ?? null;
    loaded.push({
      handle,
      content: (row.content as string) ?? '',
      origin_trust: row.origin_trust as OriginTrust,
      origin: weakest
        ? {
            source_type: weakest.source_type as SourceEvent['source_type'],
            author: weakest.author as 'owner' | 'external',
            event_at: new Date(weakest.event_at as Date).toISOString(),
          }
        : { source_type: 'assistant', author: 'external', event_at: new Date(0).toISOString() },
      value_type: leafOf((row.key as string | null) ?? ''),
    });
  }
  return loaded;
}
const leafOf = (key: string) => (key ? key.slice(key.lastIndexOf('.') + 1) : 'text');

/**
 * Resolve each payload field to the revision it came from, with the sentence a
 * person would be shown. Fields nothing explains are named in `unresolved`; the
 * broker treats an untraceable recipient or amount as needing a fresh approval.
 */
export function createTrustResolver(
  sql: MemorySql,
  scopeFor: (spaceId: string) => Promise<MemoryScope>,
): TrustResolver {
  return {
    async resolve({ space_id, payload, handles }) {
      const scope = await scopeFor(space_id);
      if (scope.spaceId !== space_id) throw new Error('scope_denied');
      return sql.begin(async (tx) => {
        await lockSpace(tx, scope, false);
        const loaded = await loadHandles(tx, scope, handles);
        const fields: TrustResolution['fields'] = [];
        const unresolved: string[] = [];
        for (const { field, value } of payloadFields(payload as JsonValue)) {
          const match = loaded.find((item) => placedIn(item.content, value));
          if (!match) {
            unresolved.push(field);
            continue;
          }
          fields.push({
            field,
            value: value.slice(0, 1000),
            handle: match.handle,
            origin_trust: match.origin_trust,
            description: describeField(match.value_type, match.origin),
          });
        }
        const classes = fields.map((f) => f.origin_trust);
        return {
          fields,
          minimum_trust: classes.length ? minimumOriginTrust(classes) : 'inferred',
          actionable: classes.length > 0 && classes.every(isActionableTrust),
          unresolved: unresolved.slice(0, 64),
        };
      });
    },
  };
}
