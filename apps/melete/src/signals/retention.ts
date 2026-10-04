/**
 * How long what a connected account reported is kept when nothing used it.
 *
 * Every mail and calendar observation is a row in `event` with no job: a
 * sender and a subject line, a meeting's title, time and place. Work that
 * woke on one keeps its own copy, and a situation that cites one names it in
 * `because`. Everything else is kept for a while, so what reads recent
 * observations has them, and then removed. Removed with it is nothing anyone
 * holds: a row a job or a situation cites, or one a trigger still listening
 * has not read yet, is kept.
 */
import {
  CALENDAR_EVENT_NAMES,
  MAIL_EVENT_NAMES,
  MAIL_RECEIVED,
  SITUATION_KINDS,
} from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';

const OBSERVATION_NAMES = [...MAIL_EVENT_NAMES, ...CALENDAR_EVENT_NAMES];
const REPLY_OVERDUE = SITUATION_KINDS.replyOverdue;
/** How far back a wait on an answer looks for one, in days. */
export const REPLY_WINDOW_DAYS = 30;
/** How long a delivery key outlives its observation, by default, in days. */
export const TOMBSTONE_DAYS = 180;
/** Most rows one pass removes, so a large backlog goes over several passes. */
export const PRUNE_BATCH = 5_000;

type Query = Sql | TransactionSql;

/**
 * Removes the mail and calendar observations no job, situation or listening
 * trigger holds: those of one connection, those older than `before`, or both.
 * Answers how many went.
 */
export async function pruneObservations(
  q: Query,
  scope: { connectionId?: string; before?: Date; limit?: number },
): Promise<number> {
  const [found] = await q`select to_regclass('public.situation') is not null as situations,
      to_regclass('public.clock') is not null as clocks`;
  const situations = Boolean(found?.situations);
  const clocks = Boolean(found?.clocks);
  const removed = await q`
    with cited as (
      select h from event j,
        jsonb_array_elements_text(case when jsonb_typeof(j.payload->'because') = 'array'
          then j.payload->'because' else '[]'::jsonb end) h
      where j.job_id is not null and j.payload->>'kind' = 'trigger_event'
      ${situations ? q`union select h from situation s, jsonb_array_elements_text(s.because) h` : q``}
    ),
    doomed as (
      select e.seq from event e
      where e.job_id is null and e.payload->>'kind' = 'connector_event'
        and e.payload->>'event_name' in ${q(OBSERVATION_NAMES)}
        ${scope.connectionId ? q`and e.payload->>'connection_id' = ${scope.connectionId}` : q``}
        ${scope.before ? q`and e.created_at < ${scope.before.toISOString()}::timestamptz` : q``}
        and ('event:' || e.seq) not in (select h from cited)
        and not exists (
          select 1 from trigger t
          where t.enabled and t.kind in ('event', 'watch')
            and t.spec->>'connection_id' = e.payload->>'connection_id'
            and t.spec->>'event_name' = e.payload->>'event_name'
            and t.cursor ~ '^[0-9]+$' and t.cursor::bigint < e.seq)
        -- Mail an open wait on an answer may still be checked against: from
        -- when its message went out, while it is open.
        and not (e.payload->>'event_name' = ${MAIL_RECEIVED} and exists (
          select 1 from connection c
          where c.id = e.payload->>'connection_id'
            and (exists (select 1 from awaited_reply a
                  where a.space_id = c.space_id and a.status in ('found', 'handling', 'waiting')
                    and e.created_at >= a.sent_at)
              ${
                clocks
                  ? q`or exists (select 1 from clock k
                  where k.space_id = c.space_id and k.rule = ${REPLY_OVERDUE}
                    and k.state in ('armed', 'checking')
                    and e.created_at >= k.created_at - make_interval(days => ${REPLY_WINDOW_DAYS}))`
                  : q``
              })))
      order by e.seq
      limit ${scope.limit ?? PRUNE_BATCH}
    ),
    gone as (
      delete from event where seq in (select seq from doomed)
      returning dedup_key, payload->>'connection_id' as connection_id, created_at
    ),
    kept as (
      insert into observation_tombstone (dedup_key, connection_id, seen_at)
      select dedup_key, connection_id, created_at from gone
      where connection_id in (select id from connection)
      on conflict (dedup_key) do nothing
    )
    select count(*)::int as n from gone`;
  return Number(removed[0]?.n ?? 0);
}

/** Whether a delivery key was used before, by an observation kept or one already expired. */
export async function delivered(q: Query, dedupKey: string): Promise<boolean> {
  const [found] = await q`select 1 from event where dedup_key = ${dedupKey}
    union all select 1 from observation_tombstone where dedup_key = ${dedupKey}
    limit 1`;
  return Boolean(found);
}

/** Forgets delivery keys older than `days`; answers how many went. */
export async function expireTombstones(sql: Sql, days: number, now = Date.now()): Promise<number> {
  const removed = await sql`delete from observation_tombstone
    where seen_at < ${new Date(now - days * 86_400_000).toISOString()}::timestamptz`;
  return removed.count;
}

/** Removes observations older than `days` that nothing holds, batch by batch; answers how many went. */
export async function expireObservations(
  sql: Sql,
  days: number,
  now = Date.now(),
): Promise<number> {
  const before = new Date(now - days * 86_400_000);
  let total = 0;
  for (;;) {
    const removed = await pruneObservations(sql, { before });
    total += removed;
    if (removed < PRUNE_BATCH) return total;
  }
}

/** One pass of the sweep, made only by the instance that leads it; answers how many went. */
export async function sweepObservations(
  sql: Sql,
  days: number,
  leads: () => boolean | Promise<boolean>,
  tombstoneDays = TOMBSTONE_DAYS,
): Promise<number> {
  if (!(await leads())) return 0;
  const removed = await expireObservations(sql, days);
  await expireTombstones(sql, Math.max(tombstoneDays, days));
  return removed;
}

/**
 * Runs the sweep now and then every six hours, on the instance that leads it;
 * the others skip the pass. Answers how to stop it.
 */
export function startObservationRetention(
  sql: Sql,
  days: number,
  leads: () => boolean | Promise<boolean> = () => true,
  tombstoneDays = TOMBSTONE_DAYS,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  const sweep = () =>
    void sweepObservations(sql, days, leads, tombstoneDays).catch(() =>
      say('observation retention failed'),
    );
  sweep();
  const timer = setInterval(sweep, 6 * 3600_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
