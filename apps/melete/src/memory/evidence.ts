import {
  type IngestSourceRequest,
  ingestSourceRequest,
  type SourceEvent,
  sourceEvent,
} from '@melete/contracts';
import {
  enqueue,
  iso,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  newId,
  stableId,
} from './db.ts';
import { originTrustOf } from './trust.ts';

export const EXTRACTOR_POLICY = 'memory-extract-v1';
export const SEGMENT_CHARACTERS = 16000;
export function toSource(row: Record<string, unknown>): SourceEvent {
  const author = (row.author as 'owner' | 'external' | undefined) ?? 'owner';
  return sourceEvent.parse({
    author,
    origin_trust:
      row.origin_trust ??
      originTrustOf({ source_type: row.source_type as SourceEvent['source_type'], author }),
    source_id: row.id,
    source_version: row.source_version,
    owner_id: row.owner_id,
    space_id: row.space_id,
    publisher: row.publisher,
    stream: row.stream,
    source_identity: row.source_identity,
    stream_sequence: row.stream_sequence,
    source_type: row.source_type,
    content_ref: row.state === 'active' ? `postgres:source/${row.id}` : null,
    event_at: iso(row.event_at as Date),
    ingested_at: iso(row.ingested_at as Date),
    audience: row.audience,
    state: row.state,
    eligibility_generation: row.eligibility_generation,
  });
}
export async function stageSegment(tx: MemoryTx, source: SourceEvent, length: number, start = 0) {
  const end = Math.min(length, start + SEGMENT_CHARACTERS);
  const id = stableId(source.source_id, source.source_version, start, EXTRACTOR_POLICY);
  await tx`insert into memory_work (id, space_id, source_id, policy_version, segment_start, segment_end, continuation)
    values (${id}, ${source.space_id}, ${source.source_id}, ${EXTRACTOR_POLICY}, ${start}, ${end}, ${end < length ? end : null}) on conflict do nothing`;
  await enqueue(tx, source.space_id, 'extract', id);
  return id;
}

/** Called in the caller's transaction so correction evidence and revisions commit together. */
export async function persistEvidence(
  tx: MemoryTx,
  scope: MemoryScope,
  input: IngestSourceRequest,
  ownerEdit = false,
) {
  const space = await lockSpace(tx, scope);
  await tx`insert into memory_streams (space_id, publisher, stream) values (${scope.spaceId}, ${scope.publisher}, ${input.stream}) on conflict do nothing`;
  await tx`select committed_sequence from memory_streams where space_id = ${scope.spaceId} and publisher = ${scope.publisher} and stream = ${input.stream} for update`;
  const [old] =
    await tx`select * from memory_sources where space_id = ${scope.spaceId} and publisher = ${scope.publisher} and stream = ${input.stream}
    and source_identity = ${input.source_identity} and source_version = ${input.source_version}`;
  if (old) {
    // A version denotes immutable bytes. A hidden replay is acknowledged without recovering content.
    if (old.state === 'active') {
      const [content] =
        await tx`select content from memory_source_content where source_id = ${old.id}`;
      // A forgotten span is blanked in the stored copy, so a replay of the same
      // bytes matches it once the same spans are blanked in the replay.
      const same =
        content?.content === input.text ||
        content?.content === (await visibleSourceText(tx, toSource(old), input.text));
      if (
        !same ||
        iso(old.event_at) !== iso(input.event_at) ||
        old.source_type !== (ownerEdit ? 'owner_edit' : input.source_type) ||
        old.author !== (ownerEdit ? 'owner' : input.author)
      )
        throw new MemoryError('source_version_conflict');
    }
    return {
      source: toSource(old),
      duplicate: true,
      committed_sequence: old.stream_sequence as number,
    };
  }
  const [stream] = await tx`update memory_streams set committed_sequence = committed_sequence + 1
    where space_id = ${scope.spaceId} and publisher = ${scope.publisher} and stream = ${input.stream} returning committed_sequence`;
  const [blocked] = await tx`select id from memory_suppressions where space_id = ${scope.spaceId}
    and publisher = ${scope.publisher} and stream = ${input.stream} and source_identity = ${input.source_identity} limit 1`;
  const state = blocked ? 'suppressed' : 'active';
  const sourceType = ownerEdit ? 'owner_edit' : input.source_type;
  const author = ownerEdit ? 'owner' : input.author;
  // The class is fixed here, from how the bytes arrived. Nothing downstream raises it.
  const trust = originTrustOf({ source_type: sourceType, author });
  const [row] =
    await tx`insert into memory_sources (id, space_id, owner_id, publisher, stream, source_identity, source_version, stream_sequence,
    source_type, event_at, audience, state, eligibility_generation, content_length, author, origin_trust, time_zone)
    values (${newId('src')}, ${scope.spaceId}, ${scope.ownerId}, ${scope.publisher}, ${input.stream}, ${input.source_identity}, ${input.source_version},
    ${stream?.committed_sequence}, ${sourceType}, ${input.event_at}, ${scope.audience}, ${state}, ${space.eligibility_generation}, ${input.text.length},
    ${author}, ${trust}, ${input.time_zone ?? null}) returning *`;
  if (!row) throw new MemoryError('source_not_persisted');
  const source = toSource(row);
  if (state === 'active') {
    await tx`insert into memory_source_content (source_id, content) values (${source.source_id}, ${input.text})`;
    await stageSegment(tx, source, input.text.length);
  }
  return { source, duplicate: false, committed_sequence: source.stream_sequence };
}
export async function ingest(sql: MemorySql, scope: MemoryScope, raw: unknown) {
  const input = ingestSourceRequest.parse(raw);
  return sql.begin((tx) => persistEvidence(tx, scope, input));
}
export async function loadEvidence(sql: MemorySql, scope: MemoryScope, sourceId: string) {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const [row] =
      await tx`select s.*, c.content from memory_sources s join memory_source_content c on c.source_id = s.id
      where s.id = ${sourceId} and s.space_id = ${scope.spaceId} and s.state = 'active'
      and (${scope.role === 'owner'} or s.audience in ('space','public'))`;
    if (!row) return null;
    const source = toSource(row);
    return { source, text: await visibleSourceText(tx, source, row.content as string) };
  });
}

/** Mask suppressed spans without moving UTF-16 offsets used by exact source references. */
export async function visibleSourceText(tx: MemoryTx, source: SourceEvent, text: string) {
  const suppressed =
    await tx`select start, "end", operation from memory_suppressions where space_id = ${source.space_id}
    and (source_id = ${source.source_id} or (operation = 'clear' and eligibility_cutoff >= ${source.eligibility_generation}))`;
  if (!suppressed.length) return text;
  const characters = text.split('');
  for (const span of suppressed) {
    if (span.start === null || span.end === null) return ' '.repeat(text.length);
    characters.fill(' ', span.start, span.end);
  }
  return characters.join('');
}
