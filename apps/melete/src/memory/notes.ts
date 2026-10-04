/**
 * The agent's own working notes: what it learned for itself in one chat and
 * wants in the next ("the plumber only takes calls before 9", "Maya's school
 * portal needs the district login"). A note is never the person's statement.
 *
 * - Written through the `notes.write` tool, in a person's own work only.
 * - Private to that person: read back only into their own work in the space it
 *   was written in, as the space's owner, the way private memory is. Never into
 *   a public compartment or for an agent set not to read memory.
 * - A note written in a private conversation is read back only into requests
 *   that stay on the person's own model, and only a local embedder reads it.
 * - Recalled labelled as the agent's own note, at `inferred` trust, so it is
 *   never repeated as something the person said or acted on as their word.
 * - Listed in Memory as Melete's note, where the person deletes it.
 */
import { type KnowledgeExcerpt, prefixedId } from '@melete/contracts';
import { MemoryError, type MemoryScope, type MemorySql, newId, stableEntityId } from './db.ts';
import { DENSE_RELATIVE_FLOOR, lexicalQuery } from './recall.ts';
import { cosine, EMBED_BATCH, type EmbeddingProvider, validateVector } from './views.ts';

export const NOTE_LIMIT = 2000;
/** Notes one person keeps in one space; the oldest go first past this. */
export const NOTES_KEPT = 500;
/** Notes one attempt is handed. */
export const NOTES_RECALLED = 5;
/**
 * What a note needs to be recalled by meaning alone: at least this cosine,
 * and nearly as close as the closest note (as for memory, `DENSE_RELATIVE_FLOOR`).
 */
const NOTE_SIMILARITY = 0.4;

export type AgentNote = {
  id: string;
  content: string;
  created_at: string;
  job_id: string | null;
  job_title: string | null;
};

/** The identity a note's vector was made under; a vector of another identity is never compared. */
export const embeddingIdentity = (embedding: EmbeddingProvider) =>
  `${embedding.model}@${embedding.version}:${embedding.dimensions}:${embedding.recipe}`;

/** What the agent is told a note is, in front of the note itself. */
export const NOTE_LABEL =
  'Your own note from an earlier chat, not something the person said. When you use it, say it is from your notes, and check it before relying on it:';

export async function writeNote(
  sql: MemorySql,
  input: {
    spaceId: string;
    principalId: string;
    jobId: string | null;
    content: string;
    privateOrigin: string | null;
    /** What makes writing it again the same note, such as the action that wrote it. */
    idempotencyKey?: string;
  },
): Promise<AgentNote> {
  const content = input.content.trim();
  if (!content || content.length > NOTE_LIMIT) throw new MemoryError('note_invalid');
  const id = input.idempotencyKey
    ? stableEntityId('note', 'agent-note', input.idempotencyKey)
    : newId('note');
  return sql.begin(async (tx) => {
    // One person's notes are capped under their own lock, so the cap holds under concurrency.
    await tx`select pg_advisory_xact_lock(hashtext(${`agent-notes:${input.spaceId}:${input.principalId}`}))`;
    const [row] =
      await tx`insert into memory_agent_notes (id, space_id, principal_id, job_id, content, private_origin)
      values (${id}, ${input.spaceId}, ${input.principalId}, ${input.jobId}, ${content}, ${input.privateOrigin})
      on conflict (id) do update set id = excluded.id
      returning created_at`;
    await tx`delete from memory_agent_notes where id in (
      select id from memory_agent_notes where space_id = ${input.spaceId} and principal_id = ${input.principalId}
      order by created_at desc, id desc offset ${NOTES_KEPT})`;
    return {
      id,
      content,
      created_at: new Date(String(row?.created_at)).toISOString(),
      job_id: input.jobId,
      job_title: null,
    };
  });
}

/** A person's notes in a space, newest first, as Memory lists them. */
export async function listNotes(
  sql: MemorySql,
  spaceId: string,
  principalId: string,
): Promise<AgentNote[]> {
  const rows = await sql`select n.id, n.content, n.created_at, n.job_id, j.title
    from memory_agent_notes n left join job j on j.id = n.job_id and j.space_id = n.space_id
    where n.space_id = ${spaceId} and n.principal_id = ${principalId}
    order by n.created_at desc, n.id desc limit ${NOTES_KEPT}`;
  return rows.map((row) => ({
    id: String(row.id),
    content: String(row.content),
    created_at: new Date(String(row.created_at)).toISOString(),
    job_id: row.job_id ? String(row.job_id) : null,
    job_title: row.title ? String(row.title) : null,
  }));
}

/** Delete one of a person's notes. False when they have no note by that id. */
export async function deleteNote(
  sql: MemorySql,
  spaceId: string,
  principalId: string,
  id: string,
): Promise<boolean> {
  const rows = await sql`delete from memory_agent_notes
    where id = ${id} and space_id = ${spaceId} and principal_id = ${principalId} returning id`;
  return rows.length > 0;
}

export type NoteRecallOptions = {
  query: string;
  jobId?: string | null;
  /** The attempt stays on the person's own model, so notes from private chats may be read back. */
  privateOrigin?: boolean;
  /** The agent answering may not read memory. */
  withheld?: boolean;
  /** Used for the query only when the caller allows it; notes it may not read are recalled by words. */
  embedding?: EmbeddingProvider;
};

/**
 * The notes one attempt is handed: those whose words match the request, then
 * those closest in meaning, at most `NOTES_RECALLED`, each labelled as the
 * agent's own. Nothing for a reader who is not the space's owner, for a public
 * compartment, or for an agent that may not read memory.
 */
export async function recallNotes(
  sql: MemorySql,
  scope: MemoryScope,
  options: NoteRecallOptions,
): Promise<KnowledgeExcerpt[]> {
  if (options.withheld || scope.role !== 'owner' || !scope.principalId) return [];
  if (options.jobId) {
    const [job] =
      await sql`select constraints from job where id = ${options.jobId} and space_id = ${scope.spaceId}`;
    if (!job || (job.constraints as { public_compartment?: boolean })?.public_compartment)
      return [];
  }
  const rows = await sql`select id, content, created_at, private_origin, embedding, embedding_model
    from memory_agent_notes where space_id = ${scope.spaceId} and principal_id = ${scope.principalId}
      and (${options.privateOrigin === true} or private_origin is null)
    order by created_at desc, id desc limit ${NOTES_KEPT}`;
  if (!rows.length) return [];
  const scores = new Map<string, number>();
  const query = lexicalQuery(options.query);
  if (query) {
    const matched =
      await sql`select id, ts_rank_cd(to_tsvector('simple', content), to_tsquery('simple', ${query})) as score
      from memory_agent_notes where id = any(${rows.map((row) => String(row.id))}::text[])
        and to_tsvector('simple', content) @@ to_tsquery('simple', ${query})`;
    for (const row of matched) scores.set(String(row.id), 1 + Number(row.score));
  }
  const embedding = options.embedding;
  if (embedding && options.query.trim()) {
    const identity = embeddingIdentity(embedding);
    const vectors = rows.filter(
      (row) => row.embedding_model === identity && Array.isArray(row.embedding),
    );
    const screened = vectors.length
      ? embedding.screen
        ? await embedding.screen(scope.spaceId, [options.query]).catch(() => null)
        : [options.query]
      : null;
    const text = screened?.[0];
    if (text) {
      const vector = await embedding
        .embed([text], AbortSignal.timeout(2000), {
          purpose: 'query',
          call: { spaceId: scope.spaceId, jobId: options.jobId ?? null, actor: scope.principalId },
        })
        .then((made) => made[0] ?? null)
        .catch(() => null);
      if (vector && vector.length === embedding.dimensions) {
        const similar = vectors.map((row) => ({
          id: String(row.id),
          similarity: cosine(vector, row.embedding as number[]),
        }));
        const best = Math.max(0, ...similar.map((entry) => entry.similarity));
        for (const { id, similarity } of similar)
          if (similarity >= NOTE_SIMILARITY && similarity >= best * DENSE_RELATIVE_FLOOR)
            scores.set(id, Math.max(scores.get(id) ?? 0, similarity));
      }
    }
  }
  return rows
    .filter((row) => scores.has(String(row.id)))
    .sort((a, b) => (scores.get(String(b.id)) ?? 0) - (scores.get(String(a.id)) ?? 0))
    .slice(0, NOTES_RECALLED)
    .map((row) => noteKnowledge(String(row.id), String(row.content), String(row.created_at)));
}

/** A note as the agent receives it: its own, at inferred trust, never the person's word. */
export function noteKnowledge(id: string, content: string, createdAt: string): KnowledgeExcerpt {
  const at = new Date(createdAt).toISOString();
  return {
    path: `memory/notes/${id}`,
    excerpt: `${NOTE_LABEL}\n${content}\nWritten ${at}.`,
    key: null,
    origin_trust: 'inferred',
    disputed: false,
    provenance: {
      id: prefixedId('k').parse(`k_${id.replace(/^note_/, '')}`),
      asserted_by: 'agent',
      observed_at: at,
      status: 'agent_note',
    },
  };
}

/**
 * Embed notes that have no vector under this embedding yet: each note shortly
 * after it is written, and every older note once an embedding is configured.
 * A cloud embedder never reads a note from a private conversation, nor one in
 * a space marked private. Returns how many were embedded.
 */
export async function embedNotes(
  sql: MemorySql,
  embedding: EmbeddingProvider,
  limit = EMBED_BATCH,
): Promise<number> {
  const identity = embeddingIdentity(embedding);
  const rows = await sql`select id, space_id, principal_id, job_id, content from memory_agent_notes
    where (embedding_model is distinct from ${identity})
      and (${embedding.local === true} or private_origin is null)
    order by created_at limit ${limit}`;
  let embedded = 0;
  // One call per person and space, so each call is charged to whose notes it read.
  const groups = new Map<string, { spaceId: string; principalId: string; notes: typeof rows }>();
  for (const row of rows) {
    const key = `${row.space_id}\u0000${row.principal_id}`;
    const group = groups.get(key) ?? {
      spaceId: String(row.space_id),
      principalId: String(row.principal_id),
      notes: [] as unknown as typeof rows,
    };
    group.notes.push(row);
    groups.set(key, group);
  }
  for (const { spaceId, principalId, notes } of groups.values()) {
    const texts = embedding.screen
      ? await embedding.screen(
          spaceId,
          notes.map((row) => String(row.content)),
        )
      : notes.map((row) => String(row.content));
    if (!texts) {
      // Nothing from this space may leave: marked so it is not asked again for this embedding.
      await sql`update memory_agent_notes set embedding_model = ${identity}, embedding = null
        where id = any(${notes.map((row) => String(row.id))}::text[])`;
      continue;
    }
    const vectors = await embedding.embed(texts, AbortSignal.timeout(15000), {
      purpose: 'document',
      call: { spaceId, actor: principalId },
    });
    if (vectors.length !== notes.length) throw new MemoryError('embedding_space_mismatch');
    for (let i = 0; i < notes.length; i++) {
      const vector = vectors[i] ?? [];
      validateVector(vector, embedding.dimensions);
      await sql`update memory_agent_notes set embedding_model = ${identity},
        embedding = ${JSON.stringify(vector)}::text::jsonb where id = ${String(notes[i]?.id)}`;
      embedded++;
    }
  }
  return embedded;
}
