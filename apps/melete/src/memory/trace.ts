/**
 * Memory's own work, told as tool entries in the conversation it came from:
 * "Remembered", "Updated" and "Forgot".
 *
 * The entry is a `notice` whose payload is `{ kind: 'tool_trace', call }`, the
 * shape the conversation's tool projection reads. `call` has the tool-call
 * fields (id, kind, title, status, times, summaries, detail, parent). Recall
 * needs no entry here: the tool projection reads it from the context record
 * each attempt leaves.
 *
 * An entry goes only on the job the person's own message arrived on, whose
 * stream already holds that message, so it tells its reader nothing they did
 * not say. The value is a quotation of their message, clipped; the service's
 * own words are the summary.
 */
import { EVENT_ORDER_LOCK } from '../db/transaction.ts';
import { memoryKeyLabel } from '../experience/evidence.ts';
import type { MemorySql } from './db.ts';

export const TOOL_TRACE = 'tool_trace';
const TITLE_LIMIT = 120;
const SUMMARY_LIMIT = 160;
const QUOTE_LIMIT = 200;
const ID_LIMIT = 200;

export type MemoryChange = 'remembered' | 'updated' | 'forgot';
const TITLES: Record<MemoryChange, string> = {
  remembered: 'Remembered',
  updated: 'Updated what I remember',
  forgot: 'Forgot',
};

const clip = (value: string, limit: number) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
};

export type MemoryTrace = {
  id: string;
  kind: 'memory_write';
  title: string;
  status: 'done';
  started_at: string;
  ended_at: string;
  input_summary: null;
  output_summary: {
    text: string;
    quote?: { text: string; from: 'message' };
  };
  detail: { type: 'memory'; id: string } | null;
  parent: null;
};

/** One memory change as a finished tool entry. */
export function memoryTrace(input: {
  change: MemoryChange;
  id: string;
  key: string | null;
  value: string | null;
  claimId: string | null;
  at: Date;
}): MemoryTrace {
  const label = clip(memoryKeyLabel(input.key), SUMMARY_LIMIT);
  const text = input.change === 'forgot' ? `No longer kept: ${label}` : label;
  const quoted = input.value ? clip(input.value, QUOTE_LIMIT) : '';
  return {
    id: input.id.slice(0, ID_LIMIT),
    kind: 'memory_write',
    title: clip(TITLES[input.change], TITLE_LIMIT),
    status: 'done',
    started_at: input.at.toISOString(),
    ended_at: input.at.toISOString(),
    input_summary: null,
    output_summary: {
      text: clip(text, SUMMARY_LIMIT),
      // A forgotten value is not repeated back.
      ...(quoted && input.change !== 'forgot'
        ? { quote: { text: quoted, from: 'message' as const } }
        : {}),
    },
    detail:
      input.claimId && input.change !== 'forgot' ? { type: 'memory', id: input.claimId } : null,
    parent: null,
  };
}

/**
 * Append entries to a job's stream in their own short transaction, after the
 * memory change has committed. It takes the event order lock first, as every
 * event writer does, and never a memory lock, so it cannot deadlock against a
 * job transaction. A retried append lands once.
 */
export async function appendMemoryTraces(
  sql: MemorySql,
  jobId: string,
  traces: readonly MemoryTrace[],
) {
  if (!traces.length) return;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK})`;
    for (const call of traces) {
      const [row] = await tx`insert into event (job_id, type, payload, dedup_key, epoch)
        values (${jobId}, 'notice', ${JSON.stringify({ kind: TOOL_TRACE, call })}::text::jsonb,
          ${`tool:${call.id}:${call.status}`}, (select lease_epoch from job where id = ${jobId}))
        on conflict (dedup_key) do nothing returning seq`;
      if (row) await tx`select pg_notify('melete_events', ${String(row.seq)})`;
    }
  });
}
