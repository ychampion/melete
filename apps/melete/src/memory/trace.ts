/**
 * Memory's own work, told in the conversation it came from: "Remembered",
 * "Updated", "Forgot".
 *
 * Each change is a `notice` whose payload is the memory tool notice the
 * conversation's tool projection reads (`kind: 'memory_tool'`, see
 * docs/TOOL-CALLS.md): the operation, a count, the plain label of the detail
 * and the value as the person said it. Recall needs no notice here: the tool
 * projection reads it from the context record each attempt leaves.
 *
 * A notice goes only on the job the person's own message arrived on, whose
 * stream already holds that message, so it tells its reader nothing they did
 * not say. A forget names the detail and never repeats its value.
 */
import { EVENT_ORDER_LOCK } from '../db/transaction.ts';
import { memoryKeyLabel } from '../experience/evidence.ts';
import type { MemorySql } from './db.ts';

export const MEMORY_TOOL_NOTICE = 'memory_tool';
const LABEL_LIMIT = 80;
const VALUE_LIMIT = 200;
const ID_LIMIT = 200;

export type MemoryChange = 'write' | 'correct' | 'forget';

const clip = (value: string, limit: number) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
};

export type MemoryToolNotice = {
  kind: typeof MEMORY_TOOL_NOTICE;
  op: MemoryChange;
  id: string;
  status: 'done';
  started_at: string;
  ended_at: string;
  count: number;
  labels: string[];
  value: string | null;
  memory_item_id: string | null;
  parent: null;
};

/** One finished memory change, for the conversation it came from. */
export function memoryNotice(input: {
  op: MemoryChange;
  id: string;
  /** The keys of the details changed; a key label names each one. */
  keys: (string | null)[];
  value: string | null;
  claimId: string | null;
  at: Date;
}): MemoryToolNotice {
  const labels = [...new Set(input.keys.map((key) => clip(memoryKeyLabel(key), LABEL_LIMIT)))];
  return {
    kind: MEMORY_TOOL_NOTICE,
    op: input.op,
    id: input.id.slice(0, ID_LIMIT),
    status: 'done',
    started_at: input.at.toISOString(),
    ended_at: input.at.toISOString(),
    count: input.keys.length,
    labels: labels.slice(0, 20),
    // A forgotten value is not repeated back.
    value: input.value && input.op !== 'forget' ? clip(input.value, VALUE_LIMIT) : null,
    memory_item_id: input.op === 'forget' ? null : input.claimId,
    parent: null,
  };
}

/**
 * Append notices to a job's stream in their own short transaction, after the
 * memory change has committed. It takes the event order lock first, as every
 * event writer does, and never a memory lock, so it cannot deadlock against a
 * job transaction. A retried append lands once.
 */
export async function appendMemoryNotices(
  sql: MemorySql,
  jobId: string,
  notices: readonly MemoryToolNotice[],
) {
  if (!notices.length) return;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK})`;
    for (const notice of notices) {
      const [row] = await tx`insert into event (job_id, type, payload, dedup_key, epoch)
        values (${jobId}, 'notice', ${JSON.stringify(notice)}::text::jsonb,
          ${`memory-tool:${notice.id}:${notice.status}`}, (select lease_epoch from job where id = ${jobId}))
        on conflict (dedup_key) do nothing returning seq`;
      if (row) await tx`select pg_notify('melete_events', ${String(row.seq)})`;
    }
  });
}
