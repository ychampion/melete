/**
 * Your usage: what the signed-in person's own model calls came to this month,
 * for Settings › Usage.
 *
 * `GET /usage/mine` answers with this month and today against the person's
 * own limits (none when the installation sets none), each UTC day of the
 * month so far, the split between chats and background work, how long the
 * computers of the spaces they own ran for background processes, and the
 * work their calls went to, newest first.
 *
 * Every figure is read for the account the session names and nobody else:
 * no parameter selects a person, a space owner never sees a member's calls,
 * and a guest's session is refused before it gets here. A piece of work is
 * listed only when it is the person's own, in a space they can still see.
 */
import { myUsageResponse, type UsageRun } from '@melete/contracts';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { periodBounds, type SpendingGuard } from '../gateway/spending.ts';
import { usageSeries } from '../gateway/usage-day.ts';

const RUN_LIMIT = 20;
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** What a piece of work came to, from its latest turn when it has one, else from its job. */
export function runOutcome(turnStatus: string | null, jobState: string): UsageRun['outcome'] {
  switch (turnStatus) {
    case 'done':
    case 'idle':
      return 'done';
    case 'needs_you':
    case 'paused':
      return 'needs_you';
    case 'failed':
    case 'stopped':
      return 'failed';
    case 'queued':
    case 'working':
    case 'streaming':
    case 'stalled':
      return 'working';
  }
  switch (jobState) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'waiting_for_input':
    case 'waiting_for_approval':
    case 'needs_reconciliation':
      return 'needs_you';
    default:
      return 'working';
  }
}

/** The thread to open for a piece of work: its own chat or routine, else the one that started it. */
export function runThread(row: {
  id: string;
  kind: string;
  parent_id: string | null;
  parent_kind: string | null;
}): string | null {
  const thread = (kind: string | null) => kind === 'chat' || kind === 'routine';
  if (thread(row.kind)) return row.id;
  if (row.parent_id && thread(row.parent_kind)) return row.parent_id;
  return null;
}

/** One person's own usage this month; `personId` is the session's account and nobody else's. */
export async function myUsage(
  sql: Sql,
  spending: SpendingGuard,
  personId: string,
  now: Date = new Date(),
) {
  const { monthStart } = periodBounds(now);
  const month = monthStart.toISOString();
  // The installation's own warnings are its runner's business; a reached one
  // still shows, since it holds this person's calls back too.
  const summary = await spending.summary(personId, false);
  const spent = summary.person ?? {
    month: { usd: 0, tokens: 0 },
    day: { usd: 0, tokens: 0 },
  };
  const limits = summary.limits;
  const set = (window: { usd: number | null; tokens: number | null }) =>
    window.usd !== null || window.tokens !== null;
  const background = limits.background ?? null;
  const capped =
    set(limits.person.month) ||
    set(limits.person.day) ||
    (background !== null && (set(background.month) || set(background.day)));
  const days = await usageSeries(sql, personId, now, now.getUTCDate());
  const kinds = (['interactive', 'background'] as const).map((usageClass) => {
    const rows = summary.by_purpose.filter((row) => row.class === usageClass);
    return {
      kind: usageClass === 'interactive' ? ('chats' as const) : ('background' as const),
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      usd: round(rows.reduce((sum, row) => sum + row.usd, 0)),
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    };
  });
  const [computer] = await sql`select coalesce(sum(a.seconds), 0)::float8 as seconds
    from sandbox_awake_day a join space s on s.id = a.space_id
    where a.day >= ${month.slice(0, 10)}::date
      and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${personId}`;
  return myUsageResponse.parse({
    month_start: summary.month_start,
    month_resets_at: summary.month_resets_at,
    day_resets_at: summary.day_resets_at,
    spent,
    background_spent: summary.background ?? {
      month: { usd: 0, tokens: 0 },
      day: { usd: 0, tokens: 0 },
    },
    caps: capped
      ? {
          month: limits.person.month,
          day: limits.person.day,
          background:
            background && (set(background.month) || set(background.day)) ? background : null,
        }
      : null,
    notice: summary.notice,
    days,
    kinds,
    computer_seconds: Math.round(Number(computer?.seconds ?? 0)),
    runs: await recentRuns(sql, personId, month),
  });
}

/**
 * The work this person's calls went to this month, newest first: only their
 * own jobs, in spaces they can still see. Calls of theirs in anyone else's
 * work still count in the totals, but that work is not listed.
 */
async function recentRuns(sql: Sql, personId: string, month: string): Promise<UsageRun[]> {
  const rows = await sql`with mine as (
      select job_id, max(created_at) as at, coalesce(sum(cost_usd), 0)::float8 as usd,
        bool_and(class = 'background') as background
      from model_usage
      where principal_id = ${personId} and job_id is not null
        and created_at >= ${month}::timestamptz
      group by job_id
    )
    select j.id, j.title, j.kind, j.state, m.at, m.usd, m.background,
      p.id as parent_id, p.kind as parent_kind,
      (select t.status from experience_turn t where t.job_id = j.id
        order by t.created_at desc, t.id desc limit 1) as turn_status
    from mine m
    join job j on j.id = m.job_id
    join space s on s.id = j.space_id
    left join job p on p.id = j.experience_parent_id and p.space_id = j.space_id
      and coalesce(p.principal_id, (select id from owner limit 1)) = ${personId}
    where s.removed_at is null
      and coalesce(j.principal_id, (select id from owner limit 1)) = ${personId}
      and ((s.kind = 'personal'
          and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${personId})
        or (s.kind = 'shared' and exists (select 1 from space_membership sm
          where sm.space_id = s.id and sm.principal_id = ${personId} and sm.revoked_at is null)))
    order by m.at desc, j.id desc
    limit ${RUN_LIMIT}`;
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    at: new Date(row.at as string | Date).toISOString(),
    outcome: runOutcome(row.turn_status ? String(row.turn_status) : null, String(row.state)),
    usd: round(Number(row.usd)),
    background: Boolean(row.background),
    conversation_id: runThread({
      id: String(row.id),
      kind: String(row.kind),
      parent_id: row.parent_id ? String(row.parent_id) : null,
      parent_kind: row.parent_kind ? String(row.parent_kind) : null,
    }),
  }));
}

export function mountMyUsage(
  app: Hono,
  deps: { spending: SpendingGuard; sql: Sql; now?: () => Date },
): void {
  app.get('/usage/mine', async (c) => {
    const actor = c.get('owner')?.id as string | undefined;
    if (!actor)
      return c.json(
        { error: { code: 'unauthorized', message: 'Sign in to see your usage.' } },
        401,
      );
    return c.json(await myUsage(deps.sql, deps.spending, actor, deps.now?.() ?? new Date()));
  });
}
