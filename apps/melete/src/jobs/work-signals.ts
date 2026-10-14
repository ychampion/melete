/**
 * What an attempt is about, read when it is claimed, for choosing its model by
 * the kind of work (MELETE_MODEL_ROUTES, `gateway/work-routes.ts`).
 *
 * One statement inside the claim's transaction. Each part reads by the job's
 * own index (`event_job_seq_idx`, `attempt_job_epoch_idx`) or stops at two
 * rows, so the cost is bounded by the job's own history, never the table's.
 */
import { engineContextWindow, engineSettingsFromEnvironment } from '@melete/runtime-hermes';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import type { Transaction } from '../db/transaction.ts';
import { type WorkKind, type WorkSignals, workKinds } from '../gateway/work-routes.ts';
import { HISTORY_SUMMARY_KIND } from './history-summary.ts';

/** How many of the job's latest attempts' tool calls count as what it has been doing. */
const RECENT_ATTEMPTS = 3;
/** At most this many of those calls are read. */
const RECENT_TOOL_CALLS = 50;
/** A rough count of the bytes one token of a conversation takes. */
const BYTES_PER_TOKEN = 4;

type Row = {
  message: unknown;
  tools: unknown;
  summarised: unknown;
  bytes: unknown;
  members: unknown;
};

/**
 * The signals for one job's next attempt. `contextWindow` is the window of
 * the model the attempt would otherwise run on, in tokens; the conversation's
 * size is measured against it.
 */
export async function workSignals(
  tx: Database | Transaction,
  job: { id: string; spaceId: string; audience?: string | null },
  usageClass: 'interactive' | 'background',
  contextWindow: number,
): Promise<WorkSignals> {
  const rows = (await tx.execute(sql`
    select
      (select e.payload from event e
        where e.job_id = ${job.id} and e.type = 'notice' and e.payload->>'kind' = 'user_message'
        order by e.seq desc limit 1) as message,
      (select coalesce(array_agg(t.tool), '{}') from (
        select e.payload->>'tool' as tool from event e
        where e.job_id = ${job.id} and e.type = 'tool_call_proposed'
          and e.attempt_id in (
            select a.id from attempt a where a.job_id = ${job.id}
            order by a.epoch desc limit ${RECENT_ATTEMPTS})
        order by e.seq desc limit ${RECENT_TOOL_CALLS}) t) as tools,
      exists (select 1 from event e
        where e.job_id = ${job.id} and e.type = 'notice'
          and e.payload->>'kind' = ${HISTORY_SUMMARY_KIND}) as summarised,
      (select coalesce(sum(octet_length(e.payload::text)), 0) from event e
        where e.job_id = ${job.id}
          and (e.type = 'tool_result'
            or (e.type = 'notice' and e.payload->>'kind' = 'user_message')))
      + (select coalesce(sum(octet_length(a.outcome_detail::text)), 0) from attempt a
        where a.job_id = ${job.id}) as bytes,
      (select count(*) from (
        select m.principal_id from space_membership m
        where m.space_id = ${job.spaceId} and m.revoked_at is null and m.role <> 'agent'
          and (m.expires_at is null or m.expires_at > now())
        union
        select s.owner_principal_id from space s
        where s.id = ${job.spaceId} and s.owner_principal_id is not null
        limit 2) people) as members
  `)) as unknown as Row[];
  const row = rows[0];
  const message =
    row?.message && typeof row.message === 'object'
      ? (row.message as { text?: unknown; attachments?: unknown })
      : {};
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.flatMap((file) =>
        file && typeof file === 'object' && typeof (file as { kind?: unknown }).kind === 'string'
          ? [(file as { kind: string }).kind]
          : [],
      )
    : [];
  const bytes = Number(row?.bytes ?? 0);
  return {
    usageClass,
    shared: job.audience === 'room' || Number(row?.members ?? 0) > 1,
    tools: Array.isArray(row?.tools)
      ? row.tools.filter((tool): tool is string => typeof tool === 'string')
      : [],
    attachments,
    summarised: row?.summarised === true,
    contextShare:
      contextWindow > 0 && Number.isFinite(bytes) ? bytes / BYTES_PER_TOKEN / contextWindow : 0,
    message: typeof message.text === 'string' ? message.text : '',
  };
}

/**
 * The kinds of work a job's next attempt is, in precedence order, measured
 * against the context window of the model it would otherwise run on, as the
 * engine will be configured for it.
 */
export async function attemptWorkKinds(
  tx: Database | Transaction,
  job: { id: string; spaceId: string; audience?: string | null },
  usageClass: 'interactive' | 'background',
  otherwise: { model: string },
): Promise<WorkKind[]> {
  const window = engineContextWindow(
    otherwise.model,
    engineSettingsFromEnvironment().contextWindowLimit,
  );
  return workKinds(await workSignals(tx, job, usageClass, window));
}
