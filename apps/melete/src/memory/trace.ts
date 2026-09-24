/**
 * Memory's own work, told in the conversation it came from: "Remembered",
 * "Updated", "Forgot", and a plain answer when a request to forget could not
 * be acted on.
 *
 * A change is a `notice` whose payload is the memory tool notice the
 * conversation's tool projection reads (`kind: 'memory_tool'`, see
 * docs/TOOL-CALLS.md): the operation, a count, the plain label of the detail
 * and the value as the person said it. An answer is a `tool_trace` notice
 * carrying a finished tool call in the service's own words, with the person's
 * request quoted. Recall needs no notice here: the tool projection reads it
 * from the context record each attempt leaves.
 *
 * A notice goes only on the job the person's own message arrived on, whose
 * stream already holds that message, so it tells its reader nothing they did
 * not say. A forget names the detail and never repeats its value, and forgetting
 * a detail later clears the value from the notices that quoted it.
 */
import { createHash } from 'node:crypto';
import { EVENT_ORDER_LOCK } from '../db/transaction.ts';
import { memoryKeyLabel } from '../experience/evidence.ts';
import type { MemorySql } from './db.ts';

export const MEMORY_TOOL_NOTICE = 'memory_tool';
export const TOOL_TRACE_NOTICE = 'tool_trace';
const LABEL_LIMIT = 80;
const LABEL_COUNT = 20;
const VALUE_LIMIT = 200;
const TITLE_LIMIT = 120;
const SUMMARY_LIMIT = 160;
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
export type MemoryReplyNotice = {
  kind: typeof TOOL_TRACE_NOTICE;
  call: {
    id: string;
    kind: 'memory_forget';
    title: string;
    status: 'done';
    started_at: string;
    ended_at: string;
    input_summary: null;
    output_summary: { text: string; quote?: { text: string; from: 'message' } };
    detail: null;
    parent: null;
  };
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
  const value = input.value && input.op !== 'forget' ? clip(input.value, VALUE_LIMIT) : '';
  return {
    kind: MEMORY_TOOL_NOTICE,
    op: input.op,
    id: input.id.slice(0, ID_LIMIT),
    status: 'done',
    started_at: input.at.toISOString(),
    ended_at: input.at.toISOString(),
    count: input.keys.length,
    labels: labels.slice(0, LABEL_COUNT),
    // A forgotten value is not repeated back.
    value: value || null,
    memory_item_id: input.op === 'forget' ? null : input.claimId,
    parent: null,
  };
}

/**
 * A plain answer to a request to forget that was not acted on: nothing saved
 * matched, or it did not say which detail. The request itself is quoted.
 */
export function memoryReply(input: {
  id: string;
  text: string;
  quote?: string;
  at: Date;
}): MemoryReplyNotice {
  const quote = input.quote ? clip(input.quote, VALUE_LIMIT) : '';
  return {
    kind: TOOL_TRACE_NOTICE,
    call: {
      id: input.id.slice(0, ID_LIMIT),
      kind: 'memory_forget',
      title: clip('Checked what I remember', TITLE_LIMIT),
      status: 'done',
      started_at: input.at.toISOString(),
      ended_at: input.at.toISOString(),
      input_summary: null,
      output_summary: {
        text: clip(input.text, SUMMARY_LIMIT),
        ...(quote ? { quote: { text: quote, from: 'message' as const } } : {}),
      },
      detail: null,
      parent: null,
    },
  };
}

/**
 * The conversation's dedup key: one entry per job, id and status. The times are
 * left out, so an append retried a moment later still lands once.
 */
const dedupKey = (jobId: string, notice: MemoryToolNotice | MemoryReplyNotice) => {
  const { id, status } = 'call' in notice ? notice.call : notice;
  const digest = createHash('sha256')
    .update(JSON.stringify([id, status]))
    .digest('hex')
    .slice(0, 32);
  return `memory-tool:${jobId}:${digest}`;
};

/**
 * Append notices to a job's stream in their own short transaction, after the
 * memory change has committed: the event order lock, then the job row, as every
 * job writer takes them, and never a memory lock, so it cannot deadlock against
 * a job transaction. A retried append lands once.
 */
export async function appendMemoryNotices(
  sql: MemorySql,
  jobId: string,
  notices: readonly (MemoryToolNotice | MemoryReplyNotice)[],
) {
  if (!notices.length) return;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK})`;
    const [job] = await tx`select lease_epoch from job where id = ${jobId} for update`;
    if (!job) return;
    for (const notice of notices) {
      const [row] = await tx`insert into event (job_id, type, payload, dedup_key, epoch)
        values (${jobId}, 'notice', ${JSON.stringify(notice)}::text::jsonb,
          ${dedupKey(jobId, notice)}, ${job.lease_epoch})
        on conflict (dedup_key) do nothing returning seq`;
      if (row) await tx`select pg_notify('melete_events', ${String(row.seq)})`;
    }
  });
}
