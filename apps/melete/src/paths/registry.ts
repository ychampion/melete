/**
 * Melete's record of what works at each service, kept per space, path and
 * kind of work, and the queries the path policy reads before it decides.
 */
import type { Query } from '../broker/records.ts';
import type { PathRecord } from './policy.ts';

export type PathOutcome = 'succeeded' | 'failed' | 'unknown' | 'handed';

/** The kind of work a job is part of: its intent's kind, or `other`. */
export async function taskKindOf(tx: Query, jobId: string): Promise<string> {
  const [row] = await tx`select i.kind from intent i
    where i.run_id = ${jobId}
      or i.run_id = (select parent_run_id from run_state where job_id = ${jobId})
    order by i.created_at desc limit 1`;
  return typeof row?.kind === 'string' ? row.kind : 'other';
}

/**
 * One piece of work: the conversation or run a job belongs to, and every step
 * of it. What one step left unsettled stops the others too.
 */
export async function workOf(tx: Query, jobId: string): Promise<string[]> {
  const [root] = await tx`select coalesce(
      (select parent_run_id from run_state where job_id = ${jobId}),
      (select experience_parent_id from job where id = ${jobId}),
      ${jobId}) as id`;
  const rootId = String(root?.id ?? jobId);
  const rows = await tx`select ${rootId}::text as id
    union select job_id from run_state where parent_run_id = ${rootId}
    union select id from job where experience_parent_id = ${rootId}
    union select ${jobId}::text`;
  return rows.map((row) => String(row.id));
}

/**
 * Record one outcome on one path. A success clears the run of misses; a new
 * try that did not get through adds to it, once, however it is settled later.
 */
export async function recordPathOutcome(
  tx: Query,
  input: {
    spaceId: string;
    service: string;
    taskKind: string;
    path: 'api' | 'browser' | 'person';
    outcome: PathOutcome;
    /** Counted as a new try: false when an earlier unknown is only now settled. */
    attempt: boolean;
    fault?: string | null;
  },
): Promise<void> {
  const ok = input.outcome === 'succeeded';
  const fault = ok ? null : (input.fault ?? input.outcome).slice(0, 300);
  await tx`insert into service_path (space_id, service_key, task_kind, path, attempts,
      successes, failures, unknowns, handed, streak, last_ok_at, last_fault, last_fault_at)
    values (${input.spaceId}, ${input.service}, ${input.taskKind}, ${input.path},
      ${input.attempt ? 1 : 0}, ${ok ? 1 : 0}, ${input.outcome === 'failed' ? 1 : 0},
      ${input.outcome === 'unknown' ? 1 : 0}, ${input.outcome === 'handed' ? 1 : 0},
      ${ok || !input.attempt ? 0 : 1}, ${ok ? new Date().toISOString() : null}, ${fault},
      ${ok ? null : new Date().toISOString()})
    on conflict (space_id, service_key, task_kind, path) do update set
      attempts = service_path.attempts + excluded.attempts,
      successes = service_path.successes + excluded.successes,
      failures = service_path.failures + excluded.failures,
      unknowns = service_path.unknowns + excluded.unknowns,
      handed = service_path.handed + excluded.handed,
      streak = case when ${ok} then 0 when ${input.attempt} then service_path.streak + 1
        else service_path.streak end,
      last_ok_at = coalesce(excluded.last_ok_at, service_path.last_ok_at),
      last_fault = coalesce(excluded.last_fault, service_path.last_fault),
      last_fault_at = coalesce(excluded.last_fault_at, service_path.last_fault_at),
      updated_at = now()`;
}

/** The record for one path at one service, or null when it has never been tried. */
export async function pathRecord(
  tx: Query,
  input: { spaceId: string; service: string; taskKind: string; path: 'api' | 'browser' },
): Promise<PathRecord | null> {
  const [row] = await tx`select attempts, successes, streak, last_fault_at from service_path
    where space_id = ${input.spaceId} and service_key = ${input.service}
      and task_kind = ${input.taskKind} and path = ${input.path}`;
  if (!row) return null;
  return {
    attempts: Number(row.attempts),
    successes: Number(row.successes),
    streak: Number(row.streak),
    last_fault_at: row.last_fault_at ? new Date(row.last_fault_at as string) : null,
  };
}
