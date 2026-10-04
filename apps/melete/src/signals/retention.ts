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
import { CALENDAR_EVENT_NAMES, MAIL_EVENT_NAMES } from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';

const OBSERVATION_NAMES = [...MAIL_EVENT_NAMES, ...CALENDAR_EVENT_NAMES];
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
  const [found] = await q`select to_regclass('public.situation') is not null as present`;
  const situations = Boolean(found?.present);
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
      order by e.seq
      limit ${scope.limit ?? PRUNE_BATCH}
    )
    delete from event where seq in (select seq from doomed)`;
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
): Promise<number> {
  return (await leads()) ? expireObservations(sql, days) : 0;
}

/**
 * Runs the sweep now and then every six hours, on the instance that leads it;
 * the others skip the pass. Answers how to stop it.
 */
export function startObservationRetention(
  sql: Sql,
  days: number,
  leads: () => boolean | Promise<boolean> = () => true,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  const sweep = () =>
    void sweepObservations(sql, days, leads).catch(() => say('observation retention failed'));
  sweep();
  const timer = setInterval(sweep, 6 * 3600_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
