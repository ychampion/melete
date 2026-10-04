/**
 * Daily rollups of `model_usage`, and the figures read from them.
 *
 * `usage_day` holds one row per UTC day, person, space, class, tier and
 * purpose: calls, tokens (input, cached, cache writes, charged input, output)
 * and dollars. Each finished day is written once an hour until it is, by one
 * instance at a time, and can be written again at any time: a day's rows are
 * replaced from `model_usage` in one transaction, so they always match it.
 *
 * Background cost per active person-day is a person's background dollars on
 * a day they made any model call at all, read across people and days.
 */
import type { Sql } from 'postgres';

const DAY_MS = 86_400_000;
/** How far back a missing day is still written. */
const ROLLUP_LOOKBACK_DAYS = 35;

/** The UTC day of a moment, as YYYY-MM-DD. */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/**
 * Replaces one UTC day's rollup rows with what `model_usage` holds for that
 * day. Two writers of the same day take their turn on a lock for that day, so
 * the second replaces the first's rows rather than colliding with them.
 */
export async function rollupUsageDay(sql: Sql, day: string): Promise<number> {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || utcDay(start) !== day) throw new Error('invalid day');
  const end = new Date(start.getTime() + DAY_MS);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`usage_day:${day}`}))`;
    await tx`delete from usage_day where day = ${day}`;
    const rows = await tx`insert into usage_day (day, principal_id, space_id, class, tier, purpose,
        calls, input_tokens, cached_input_tokens, cache_write_tokens, charged_input_tokens,
        output_tokens, cost_usd)
      select ${day}, coalesce(principal_id, ''), coalesce(space_id, ''), class, tier, purpose,
        count(*)::int, coalesce(sum(input_tokens), 0), coalesce(sum(cached_input_tokens), 0),
        coalesce(sum(cache_write_tokens), 0), coalesce(sum(charged_input_tokens), 0),
        coalesce(sum(output_tokens), 0), round(coalesce(sum(cost_usd), 0)::numeric, 6)::float8
      from model_usage
      where created_at >= ${start.toISOString()}::timestamptz
        and created_at < ${end.toISOString()}::timestamptz
      group by 2, 3, class, tier, purpose
      returning day`;
    return rows.length;
  });
}

/**
 * Writes yesterday again (a call settled just before midnight may have been
 * recorded after the last pass), and every finished day from `since` (by
 * default five weeks back) that has calls and no rollup yet. Each day is
 * looked at once, by the `created_at` index: no row is read per call.
 */
export async function rollupFinishedDays(
  sql: Sql,
  now = new Date(),
  since?: string,
): Promise<string[]> {
  const today = new Date(`${utcDay(now)}T00:00:00.000Z`);
  const from = since
    ? new Date(`${since}T00:00:00.000Z`)
    : new Date(today.getTime() - ROLLUP_LOOKBACK_DAYS * DAY_MS);
  const missing = await sql`select to_char(d, 'YYYY-MM-DD') as day
    from generate_series(${from.toISOString()}::timestamptz,
      ${today.toISOString()}::timestamptz - interval '1 day', interval '1 day') as d
    where not exists (select 1 from usage_day u where u.day = to_char(d, 'YYYY-MM-DD'))
      and exists (select 1 from model_usage m
        where m.created_at >= d and m.created_at < d + interval '1 day')`;
  const days = new Set(missing.map((row) => String(row.day)));
  days.add(utcDay(new Date(today.getTime() - DAY_MS)));
  const written = [...days].sort();
  for (const day of written) await rollupUsageDay(sql, day);
  return written;
}

/**
 * Rolls up finished days now and every hour after, while this instance leads.
 * The first pass looks back five weeks; later ones look only from the day
 * before the last pass, which is all that can have changed since.
 */
export function startUsageRollup(
  sql: Sql,
  leads: () => boolean | Promise<boolean> = () => true,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  let since: string | undefined;
  const pass = () =>
    void Promise.resolve(leads())
      .then(async (leading) => {
        if (!leading) return;
        const now = new Date();
        await rollupFinishedDays(sql, now, since);
        since = utcDay(new Date(now.getTime() - DAY_MS));
      })
      .catch((error: unknown) =>
        say(`usage rollup failed: ${String((error as Error)?.message ?? error)}`),
      );
  pass();
  const timer = setInterval(pass, 60 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export type UsageDayPoint = { day: string; usd: number; background_usd: number; calls: number };

/**
 * One person's (or, with null, everyone's) last `days` UTC days, oldest first:
 * from the rollup where a day has one, and from `model_usage` for today and
 * any day not rolled up yet.
 */
export async function usageSeries(
  sql: Sql,
  personId: string | null,
  now = new Date(),
  days = 30,
): Promise<UsageDayPoint[]> {
  const today = new Date(`${utcDay(now)}T00:00:00.000Z`);
  const first = new Date(today.getTime() - (days - 1) * DAY_MS);
  const firstDay = utcDay(first);
  const rolled = await sql`select day,
      coalesce(sum(cost_usd), 0)::float8 as usd,
      coalesce(sum(cost_usd) filter (where class = 'background'), 0)::float8 as background_usd,
      coalesce(sum(calls), 0)::int as calls
    from usage_day
    where day >= ${firstDay} and day < ${utcDay(today)}
      and (${personId}::text is null or principal_id = ${personId})
    group by day`;
  const rolledDays = await sql`select distinct day from usage_day
    where day >= ${firstDay} and day < ${utcDay(today)}`;
  const covered = new Set(rolledDays.map((row) => String(row.day)));
  const live = await sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      coalesce(sum(cost_usd), 0)::float8 as usd,
      coalesce(sum(cost_usd) filter (where class = 'background'), 0)::float8 as background_usd,
      count(*)::int as calls
    from model_usage
    where created_at >= ${first.toISOString()}::timestamptz
      and (${personId}::text is null or principal_id = ${personId})
    group by 1`;
  const byDay = new Map<string, UsageDayPoint>();
  for (const row of rolled)
    byDay.set(String(row.day), {
      day: String(row.day),
      usd: round(Number(row.usd)),
      background_usd: round(Number(row.background_usd)),
      calls: Number(row.calls),
    });
  for (const row of live) {
    const day = String(row.day);
    if (covered.has(day)) continue;
    byDay.set(day, {
      day,
      usd: round(Number(row.usd)),
      background_usd: round(Number(row.background_usd)),
      calls: Number(row.calls),
    });
  }
  const series: UsageDayPoint[] = [];
  for (let index = 0; index < days; index++) {
    const day = utcDay(new Date(first.getTime() + index * DAY_MS));
    series.push(byDay.get(day) ?? { day, usd: 0, background_usd: 0, calls: 0 });
  }
  return series;
}

export type BackgroundCostPerPersonDay = {
  /** Days a person made at least one model call, summed over people. */
  person_days: number;
  median_usd: number;
  p95_usd: number;
  mean_usd: number;
  /** Background dollars over the same person-days, by tier and by purpose. */
  by_tier: Record<string, number>;
  by_purpose: Record<string, number>;
};

/** The nearest-rank percentile of sorted values; 0 for none. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

/**
 * Background cost per active person-day over the rolled-up days in
 * [`from`, `to`) (YYYY-MM-DD): each person-day with any call counts once,
 * with its background dollars, zero included.
 */
export async function backgroundCostPerPersonDay(
  sql: Sql,
  from: string,
  to: string,
): Promise<BackgroundCostPerPersonDay> {
  const rows = await sql`select principal_id, day,
      coalesce(sum(cost_usd) filter (where class = 'background'), 0)::float8 as background_usd
    from usage_day where day >= ${from} and day < ${to} and principal_id <> ''
    group by principal_id, day`;
  const values = rows.map((row) => Number(row.background_usd)).sort((a, b) => a - b);
  const split = await sql`select tier, purpose, coalesce(sum(cost_usd), 0)::float8 as usd
    from usage_day where day >= ${from} and day < ${to} and principal_id <> ''
      and class = 'background'
    group by tier, purpose`;
  const byTier: Record<string, number> = {};
  const byPurpose: Record<string, number> = {};
  for (const row of split) {
    const usd = Number(row.usd);
    byTier[String(row.tier)] = round((byTier[String(row.tier)] ?? 0) + usd);
    byPurpose[String(row.purpose)] = round((byPurpose[String(row.purpose)] ?? 0) + usd);
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    person_days: values.length,
    median_usd: round(percentile(values, 0.5)),
    p95_usd: round(percentile(values, 0.95)),
    mean_usd: values.length ? round(total / values.length) : 0,
    by_tier: byTier,
    by_purpose: byPurpose,
  };
}
