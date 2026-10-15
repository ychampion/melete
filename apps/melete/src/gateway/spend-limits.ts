/**
 * Monthly dollar limits for one member or one space, set by the person who
 * runs the installation, and this month's spending grouped by space and by
 * member for `GET /usage`.
 *
 * A member's limit counts every call made for them, in any space, and takes
 * the place of the installation-wide monthly dollar limit for that member. A
 * space's budget counts every call made in the space, whoever asked. With no
 * row there is no limit, so an installation nobody configured stays uncapped.
 */
import type { Sql } from 'postgres';
import { periodBounds } from './spending.ts';

export type SpendLimitKind = 'member' | 'space';
export type SpendLimits = { member: Map<string, number>; space: Map<string, number> };

/** How long the limits read from the database are reused before they are read again. */
const LIMITS_TTL_MS = 2_000;

export class SpendLimitStore {
  private cached: { at: number; limits: SpendLimits } | null = null;
  private reading: Promise<SpendLimits> | null = null;
  /** Counts changes made here, so a read begun before one is not kept after it. */
  private generation = 0;

  constructor(
    private readonly sql: Sql,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every limit set, read again at most every two seconds. */
  async all(fresh = false): Promise<SpendLimits> {
    const at = this.now().getTime();
    if (!fresh && this.cached && at - this.cached.at < LIMITS_TTL_MS) return this.cached.limits;
    if (!fresh && this.reading) return this.reading;
    const generation = this.generation;
    const reading = this.read().then((limits) => {
      if (generation === this.generation) this.cached = { at: this.now().getTime(), limits };
      return limits;
    });
    this.reading = reading;
    try {
      return await reading;
    } finally {
      if (this.reading === reading) this.reading = null;
    }
  }

  private async read(): Promise<SpendLimits> {
    const rows = await this.sql`select kind, target_id, monthly_usd from spend_limit`;
    const limits: SpendLimits = { member: new Map(), space: new Map() };
    for (const row of rows) {
      const kind = row.kind === 'space' ? 'space' : 'member';
      limits[kind].set(String(row.target_id), Number(row.monthly_usd));
    }
    return limits;
  }

  /** Sets a monthly dollar limit, or with null clears it. */
  async set(
    kind: SpendLimitKind,
    targetId: string,
    monthlyUsd: number | null,
    setBy: string | null,
  ): Promise<void> {
    if (monthlyUsd === null)
      await this.sql`delete from spend_limit where kind = ${kind} and target_id = ${targetId}`;
    else
      await this.sql`insert into spend_limit (kind, target_id, monthly_usd, set_by, updated_at)
        values (${kind}, ${targetId}, ${monthlyUsd}, ${setBy}, now())
        on conflict (kind, target_id) do update set monthly_usd = excluded.monthly_usd,
          set_by = excluded.set_by, updated_at = excluded.updated_at`;
    this.generation++;
    this.cached = null;
    this.reading = null;
  }
}

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export type SpaceUsage = {
  space_id: string;
  name: string;
  kind: 'personal' | 'shared';
  calls: number;
  usd: number;
  tokens: number;
  budget_usd: number | null;
};

export type MemberUsage = {
  principal_id: string;
  name: string;
  calls: number;
  usd: number;
  tokens: number;
  limit_usd: number | null;
};

/**
 * This month's spending in each space the account may see it for: its own
 * space and the rooms it is an owner of now, and for the person who runs the
 * installation every room as well. Each with its budget, if one is set.
 */
export async function usageBySpace(
  sql: Sql,
  actor: string,
  installationOwner: boolean,
  limits: SpendLimits,
  now = new Date(),
): Promise<SpaceUsage[]> {
  const month = periodBounds(now).monthStart.toISOString();
  const rows = await sql`select s.id, s.name, s.kind,
        count(u.id)::int as calls,
        coalesce(sum(u.cost_usd), 0)::float8 as usd,
        coalesce(sum(u.input_tokens + u.output_tokens), 0)::float8 as tokens
      from space s
      left join model_usage u on u.space_id = s.id and u.created_at >= ${month}::timestamptz
      where s.removed_at is null and (
        (s.kind = 'personal'
          and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${actor})
        -- A room by who owns it now: whoever made it no longer sees it once they leave.
        or (s.kind = 'shared' and (${installationOwner} or exists (
          select 1 from space_membership m where m.space_id = s.id
            and m.principal_id = ${actor} and m.role = 'owner' and m.revoked_at is null
            and (m.expires_at is null or m.expires_at > now())))))
      group by s.id, s.name, s.kind
      order by usd desc, tokens desc, s.name, s.id
      limit 100`;
  return rows.map((row) => ({
    space_id: String(row.id),
    name: String(row.name),
    kind: row.kind === 'shared' ? 'shared' : 'personal',
    calls: Number(row.calls),
    usd: round(Number(row.usd)),
    tokens: Number(row.tokens),
    budget_usd: limits.space.get(String(row.id)) ?? null,
  }));
}

/**
 * This month's spending for each person and guest on the installation, with
 * their monthly limit if one is set. Only for the person who runs it.
 */
export async function usageByMember(
  sql: Sql,
  limits: SpendLimits,
  now = new Date(),
): Promise<MemberUsage[]> {
  const month = periodBounds(now).monthStart.toISOString();
  const rows = await sql`select p.id, p.display_name, p.email,
        count(u.id)::int as calls,
        coalesce(sum(u.cost_usd), 0)::float8 as usd,
        coalesce(sum(u.input_tokens + u.output_tokens), 0)::float8 as tokens
      from principal p
      left join model_usage u on u.principal_id = p.id and u.created_at >= ${month}::timestamptz
      where p.kind in ('person', 'guest')
      group by p.id, p.display_name, p.email
      order by usd desc, tokens desc, p.id
      limit 200`;
  return rows.map((row) => ({
    principal_id: String(row.id),
    name: row.display_name ? String(row.display_name) : String(row.email).split('@')[0] || '',
    calls: Number(row.calls),
    usd: round(Number(row.usd)),
    tokens: Number(row.tokens),
    limit_usd: limits.member.get(String(row.id)) ?? null,
  }));
}
