/**
 * Whether the job that wrote a skill had read anything but the owner's own words.
 *
 * The decision is made from what the service recorded while the job ran, never
 * from the skill text: a skill that says it read nothing proves nothing. The
 * list of ways content reaches a job is closed, and each is checked here:
 *
 *  1. The objective. It is the owner's when the owner typed it, or when the
 *     experience layer composed it from what the owner typed there (a routine's
 *     instruction, a plan's milestone, a chat). A job built from a company's mail,
 *     or one that copied another job's objective, is not.
 *  2. The memory context of every attempt. Only `owner` items are clean.
 *  3. The files every attempt could read. Only a runtime that recorded a
 *     workspace belonging to this job alone is clean: until the lineage of a
 *     shared or persistent workspace is recorded, a file there may have been
 *     written by an earlier job from anything that job read.
 *  4. What woke the job. A schedule is Melete's own clock; a connector event (mail,
 *     a calendar feed, a webhook, a company's reply) or an operation's result is
 *     outside content.
 *  5. Legacy knowledge excerpts, and the knowledge records a later attempt is
 *     told have changed.
 *  6. Tools. A broker tool leaves an action, and the model reads its receipt. The
 *     receipt's `detail` is written by the connector, sometimes from what a
 *     remote server sent back, so a trust value found there proves nothing: until
 *     the broker records where a receipt came from itself, every action taints.
 *     A tool the broker never served to the attempt is the engine's own and
 *     leaves no receipt at all.
 *  7. A hole in the recorded history.
 *
 * A missing record is not a clean one: if the service cannot say what an
 * attempt read, the skill is tainted and the owner decides, so losing a record
 * can never make a skill live. A new way of feeding a job belongs on this list
 * before the skills of such a job can go live.
 */
import type { OriginTrust } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';

export const OWNER_CLEAN: OriginTrust = 'owner';
export type OriginDecision = { tainted: boolean; reason: string | null };

const tainted = (reason: string): OriginDecision => ({ tainted: true, reason });

type ContextItem = { origin_trust?: unknown };

/** Experience jobs whose objective is composed only from what the owner typed there. */
const OWNER_COMPOSED_KINDS = ['routine', 'milestone', 'chat', 'plan'];

/** The trigger events Melete raises itself. Anything else a trigger delivers came from outside. */
const OWN_TRIGGER_EVENTS = ['schedule_event'];

/** Named for the report, never quoted: a class name, not the content it carried. */
const WAKE_REASONS: Record<string, string> = {
  connector_event: 'external_origin:connector_event',
  operation_event: 'external_origin:operation_event',
};

/**
 * `verified_connector` is trusted enough to act on, and still not the owner's
 * own words: a calendar entry someone else wrote arrives that way. Skills the
 * engine writes from it are held, not refused.
 */
export function cleanTrust(value: unknown): boolean {
  return value === OWNER_CLEAN;
}

/** Named for the report, never quoted: a class name, not the content it described. */
const originReason = (value: unknown) =>
  typeof value === 'string' && value ? `external_origin:${value}` : 'trust_record_missing';

export async function originTaint(
  tx: Transaction,
  input: { spaceId: string; jobId: string },
): Promise<OriginDecision> {
  const memory = await tx.execute(
    sql`select revoked, restore_ready from memory_spaces where space_id = ${input.spaceId}`,
  );
  const space = memory[0];
  if (!space || space.revoked || !space.restore_ready) return tainted('trust_record_missing');

  const [writer] = await tx.execute(
    sql`select objective_origin, kind from job where id = ${input.jobId}`,
  );
  if (!writer) return tainted('trust_record_missing');
  if (
    writer.objective_origin !== 'owner_request' &&
    !OWNER_COMPOSED_KINDS.includes(String(writer.kind))
  )
    return tainted('external_origin:objective');

  const attempts = await tx.execute(
    sql`select a.id, c.items, l.versions->>'workspace' as workspace from attempt a
      left join memory_contexts c on c.attempt_id = a.id and c.space_id = ${input.spaceId}
      left join learning_attempt l on l.attempt_id = a.id
      where a.job_id = ${input.jobId}`,
  );
  if (!attempts.length) return tainted('trust_record_missing');
  for (const row of attempts) {
    if (!row.items) return tainted('trust_record_missing');
    for (const item of row.items as ContextItem[])
      if (!cleanTrust(item.origin_trust)) return tainted(originReason(item.origin_trust));
    if (row.workspace !== 'job') return tainted('workspace_lineage_unrecorded');
  }

  const wakes = await tx.execute(
    sql`select distinct coalesce(payload->'event'->>'kind', '') as kind from event
      where job_id = ${input.jobId} and type = 'notice' and payload->>'kind' = 'trigger_event'`,
  );
  for (const row of wakes) {
    const kind = String(row.kind);
    if (!OWN_TRIGGER_EVENTS.includes(kind))
      return tainted(WAKE_REASONS[kind] ?? 'external_origin:trigger_event');
  }

  // Legacy knowledge excerpts are inspectable source text, recorded as a notice.
  const knowledge = await tx.execute(
    sql`select 1 from event where job_id = ${input.jobId} and type = 'notice'
      and payload->>'kind' = 'legacy_knowledge_context'
      and coalesce(jsonb_array_length(payload->'record_ids'), 0) > 0 limit 1`,
  );
  if (knowledge.length) return tainted('external_origin:external_content');
  // A later attempt is told which knowledge records changed since the one before it.
  const named = await tx.execute(
    sql`select 1 from knowledge_record k where k.space_id = ${input.spaceId}
      and k.updated_at > (select min(ended_at) from attempt where job_id = ${input.jobId})
      and k.updated_at <= (select max(started_at) from attempt where job_id = ${input.jobId})
      limit 1`,
  );
  if (named.length) return tainted('external_origin:knowledge_update');

  const native = await tx.execute(
    sql`select 1 from event e where e.job_id = ${input.jobId} and e.type = 'tool_call_proposed'
      and not exists (
        select 1 from attempt_tool_context t, jsonb_array_elements(t.core || t.loaded) served
        where t.attempt_id = e.attempt_id and served->>'name' = e.payload->>'tool'
      ) limit 1`,
  );
  if (native.length) return tainted('unrecorded_tool');
  const gaps = await tx.execute(
    sql`select 1 from event where job_id = ${input.jobId}
      and (type = 'gap' or (type = 'notice' and payload->>'kind' = 'gap')) limit 1`,
  );
  if (gaps.length) return tainted('trust_record_missing');

  // Whatever the connector wrote into a receipt, including a claim of the owner's
  // trust, is not consulted.
  const acted = await tx.execute(sql`select 1 from action where job_id = ${input.jobId} limit 1`);
  if (acted.length) return tainted('action_receipt_unverified');
  return { tainted: false, reason: null };
}
