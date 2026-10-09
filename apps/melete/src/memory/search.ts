/**
 * `memory.search`: the agent asks memory itself, mid-turn.
 *
 * An attempt is handed the few details recalled for the person's latest
 * message. A model that reads that short list as everything memory holds says
 * "I can't find that" about a detail memory has, and takes back a true answer
 * it gave a moment ago. This tool lets it look before it denies anything.
 *
 * It reads through the same recall as the attempt's own context, so every
 * eligibility rule holds here too: a forgotten or blocked detail, a source
 * that was removed, a public compartment and an agent set not to read memory
 * all return nothing. What memory learned in a private conversation is never
 * returned by a search, whatever model the attempt runs on: the attempt's own
 * recall decides that, with the model in hand.
 */
import type { CapabilityClaims } from '@melete/contracts';
import { z } from 'zod';
import { MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { onceForQueries } from './embedding.ts';
import { recallNotes } from './notes.ts';
import { recall } from './recall.ts';
import type { EmbeddingProvider } from './views.ts';

/** The most saved details one search returns. */
export const SEARCH_LIMIT = 8;

export const memorySearchInput = z.strictObject({ query: z.string().trim().min(1).max(200) });

export type MemorySearchOptions = {
  sql: MemorySql;
  scopeForJob: (jobId: string) => Promise<MemoryScope>;
  embedding?: EmbeddingProvider;
  /** Whether this job's words may be read by a cloud embedder; left out, they never are. */
  embedsQuery?: (jobId: string, text: string) => Promise<boolean>;
};

export type MemorySearchResult = {
  status: 'found' | 'nothing_saved' | 'unavailable' | 'not_available_here';
  details: { detail: string; about: string; saved_on: string; disputed?: true }[];
  notes: string[];
  guidance: string;
};

export const SEARCH_GUIDANCE = {
  found:
    'These are saved details that match. They are what the person told Melete, and they hold unless the person corrects them. Use them, and never take back an answer one of them supports.',
  nothing_saved:
    "Nothing saved matches these words. Try other words once if the person's wording might differ. If there is still nothing, say you don't have it saved; never say they never told you, and never take back an answer you already gave from what you were handed.",
  unavailable:
    'Memory could not be searched just now. Say you could not check; never say the detail does not exist or was never saved.',
  not_available_here:
    'This conversation does not read memory, so nothing was searched. Do not say what memory holds either way.',
} as const;

/** Search the job's memory for an attempt, under the attempt's own rules. */
export async function searchMemory(
  options: MemorySearchOptions,
  claims: Pick<CapabilityClaims, 'job_id'>,
  input: unknown,
): Promise<MemorySearchResult> {
  const { query } = memorySearchInput.parse(input);
  const jobId = claims.job_id;
  const none = (status: 'unavailable' | 'not_available_here'): MemorySearchResult => ({
    status,
    details: [],
    notes: [],
    guidance: SEARCH_GUIDANCE[status],
  });
  let scope: MemoryScope;
  try {
    scope = await options.scopeForJob(jobId);
  } catch (error) {
    // A space still replaying its removals, or one this job no longer reaches.
    if (error instanceof MemoryError) return none('unavailable');
    throw error;
  }
  // The turn's own agent decides, as it does for the attempt's recall.
  const [persona] = await options.sql`select a.reads_memory, j.constraints from job j
    left join experience_turn t on t.id = j.current_turn_id
    left join agent a on a.id = coalesce(t.agent_id, j.agent_id) and a.space_id = j.space_id
    where j.id = ${jobId} and j.space_id = ${scope.spaceId}`;
  if (!persona) return none('not_available_here');
  if (
    persona.reads_memory === false ||
    (persona.constraints as { public_compartment?: boolean } | null)?.public_compartment === true
  )
    return none('not_available_here');
  const embedding =
    options.embedding &&
    (options.embedding.local || (await options.embedsQuery?.(jobId, query)) === true)
      ? onceForQueries(options.embedding)
      : undefined;
  const result = await recall(
    options.sql,
    scope,
    { job_id: jobId, query, path: 'investigative', limit: SEARCH_LIMIT },
    { ...(embedding ? { embedding } : {}), privateOrigin: false },
  );
  const notes = await recallNotes(options.sql, scope, {
    query,
    jobId,
    privateOrigin: false,
    ...(embedding ? { embedding } : {}),
  }).catch(() => []);
  if (result.status === 'unavailable' && !notes.length) return none('unavailable');
  const details = result.items.map((item) => ({
    detail: item.content,
    about: item.domain_key,
    saved_on: item.recorded_at.slice(0, 10),
    ...(item.disputed ? { disputed: true as const } : {}),
  }));
  const found = details.length > 0 || notes.length > 0;
  return {
    status: found ? 'found' : 'nothing_saved',
    details,
    notes: notes.map((note) => note.excerpt),
    guidance: SEARCH_GUIDANCE[found ? 'found' : 'nothing_saved'],
  };
}
