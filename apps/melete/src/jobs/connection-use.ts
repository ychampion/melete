import { TERMINAL_STATES } from '@melete/contracts';
import { type SQL, sql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';

/**
 * Which jobs a change to one connection reaches: the work that could still be
 * holding what that connection gave it.
 *
 * A job reaches a mailbox, a calendar, a Drive or an MCP server only through
 * the broker and through the events that connection reports, and each of
 * those leaves a row naming it: an action on it (reads included), an action
 * whose payload names it (a share sent from that mailbox), a trigger listening
 * on it, an event it delivered, or a situation it raised. Every call made
 * later checks again that the connection is active, so a job with none of
 * those rows holds nothing of it and cannot start using it now.
 *
 * Any other kind of connection is used in ways no row records reliably: a
 * command-line account's key is used by the egress relay inside tunnels the
 * agent's computer opens, the sandbox is the computer itself, a paired device
 * or the browser keeps sessions of its own. Those, and any kind added later,
 * answer `null`: every job is reached.
 */
const RECORDED_USE_PROVIDERS: ReadonlySet<string> = new Set(['imap', 'caldav', 'drive', 'mcp']);

const rows = <T>(result: unknown) => result as unknown as T[];

/**
 * The ids of the jobs in the connection's space that used it, with every job
 * linked to one of them; null when its use cannot be told job by job. Read
 * before anything the connection reported is deleted.
 */
export async function jobsReachedBy(
  tx: Transaction,
  source: { id: string; spaceId: string; provider: string },
): Promise<string[] | null> {
  if (!RECORDED_USE_PROVIDERS.has(source.provider)) return null;
  const { id, spaceId } = source;
  // What Melete noticed in it reaches jobs by the situation's id, not the connection's.
  const raised = rows<{ id: string }>(
    await tx.execute(sql`select id from situation where space_id = ${spaceId}
      and (connection_id = ${id} or strpos(evidence::text, ${id}) > 0)`),
  ).map((row) => row.id);
  const named = (column: SQL) =>
    sql.join(
      [id, ...raised].map((value) => sql`strpos(${column}::text, ${value}) > 0`),
      sql` or `,
    );
  // A calendar change is checked against every calendar the person connected,
  // so a job that proposed one may have been told about this calendar's events.
  const calendar = source.provider === 'caldav' ? sql`or a.kind like 'calendar.%'` : sql``;
  const used = rows<{ job_id: string }>(
    await tx.execute(sql`
      select a.job_id from action a join job j on j.id = a.job_id
        where j.space_id = ${spaceId}
          and (a.connection_id = ${id} or strpos(a.canonical_payload::text, ${id}) > 0 ${calendar})
      union
      select t.job_id from trigger t join job j on j.id = t.job_id
        where j.space_id = ${spaceId} and strpos(t.spec::text, ${id}) > 0
      union
      select e.job_id from event e join job j on j.id = e.job_id
        where j.space_id = ${spaceId}
          -- A fence names the connection that caused it; it is not a use of it.
          and e.type not in ('context_invalidated', 'attempt_ended')
          and (${named(sql`e.payload`)})
      union
      select t.job_id from attempt t join job j on j.id = t.job_id
        where j.space_id = ${spaceId}
          and (t.trigger_id in (select id from trigger where strpos(spec::text, ${id}) > 0)
            ${
              raised.length
                ? sql`or t.situation_id in (${sql.join(
                    raised.map((value) => sql`${value}`),
                    sql`, `,
                  )})`
                : sql``
            })`),
  ).map((row) => row.job_id);
  return linkedJobs(tx, spaceId, used);
}

/**
 * The jobs given, with every job linked to one of them however far: a job
 * started from a conversation and that conversation, a run and its helpers,
 * a plan and its milestones. What one of them read can have reached the
 * others, so they are reached together.
 */
async function linkedJobs(tx: Transaction, spaceId: string, seeds: string[]): Promise<string[]> {
  if (!seeds.length) return [];
  const links = rows<{ a: string; b: string }>(
    await tx.execute(sql`
      select id as a, experience_parent_id as b from job
        where space_id = ${spaceId} and experience_parent_id is not null
      union all
      select id, plan_id from job where space_id = ${spaceId} and plan_id is not null
      union all
      select job_id, parent_run_id from run_state
        where space_id = ${spaceId} and parent_run_id is not null
      union all
      select job_id, conversation_id from run_state
        where space_id = ${spaceId} and conversation_id is not null
      union all
      select m.plan_id, m.child_job_id from plan_milestone m join job p on p.id = m.plan_id
        where p.space_id = ${spaceId} and m.child_job_id is not null`),
  );
  const neighbours = new Map<string, string[]>();
  for (const { a, b } of links) {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  const reached = new Set(seeds);
  const queue = [...seeds];
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const other of neighbours.get(next) ?? [])
      if (!reached.has(other)) {
        reached.add(other);
        queue.push(other);
      }
  return [...reached].sort();
}

/**
 * The work a connection change did not reach keeps going: the attempts of its
 * unfinished jobs that were current until now are moved onto the space's new
 * policy generation, and onto the connection's new generation (or without it,
 * once revoked). Only attempts that were current are moved; one already stale
 * stays stale.
 */
export async function carryForward(
  tx: Transaction,
  input: {
    spaceId: string;
    policyGeneration: number;
    connectionId: string;
    /** The connection's generation before the change and after it; null once revoked. */
    from: number;
    to: number | null;
    reached: readonly string[];
  },
): Promise<void> {
  const { spaceId, policyGeneration, connectionId, from, to, reached } = input;
  const generations =
    to === null
      ? sql`connection_generations - ${connectionId}::text`
      : sql`jsonb_set(connection_generations, array[${connectionId}::text], to_jsonb(${to}::int))`;
  await tx.execute(sql`update attempt set policy_generation = ${policyGeneration},
      connection_generations = case when connection_generations ? ${connectionId}::text
        then ${generations} else connection_generations end
    where job_id in (select id from job where space_id = ${spaceId}
        and state not in ${sql.raw(`(${TERMINAL_STATES.map((state) => `'${state}'`).join(', ')})`)}
        ${
          reached.length
            ? sql`and id not in (${sql.join(
                reached.map((jobId) => sql`${jobId}`),
                sql`, `,
              )})`
            : sql``
        })
      and policy_generation = ${policyGeneration - 1}
      and (not connection_generations ? ${connectionId}::text
        or connection_generations->>${connectionId}::text = ${String(from)})`);
}
