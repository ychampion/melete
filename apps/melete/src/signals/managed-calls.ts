/**
 * Counting calls made through a managed sign-in provider (Composio), which
 * charges for each one. Every call is counted for the person whose space the
 * connection is in, by calendar month, and the installation's monthly limit
 * (`MELETE_MANAGED_CALLS_MONTHLY_CAP`) is read against the month's total.
 *
 * The limit only ever slows watching: past it, a watched account is read once
 * an hour instead of every few minutes, and its reason is shown on the
 * account. Nothing here refuses a call, so a send the person approved, or a
 * search the agent makes, always goes ahead.
 */
import type { Sql } from 'postgres';

/** At or above this share of the limit, watching slows down. */
export const NEAR_SHARE = 0.8;

export type ManagedStanding = {
  state: 'ok' | 'near' | 'reached';
  used: number;
  cap: number | null;
};

/** What a person reads on a watched account while the limit slows it, in plain words. */
export const MANAGED_NEAR_WORDS =
  'This month’s calls through Composio are close to the limit set for this Melete, so this account is read less often until the month ends.';
export const MANAGED_REACHED_WORDS =
  'This month’s calls through Composio have reached the limit set for this Melete, so this account is read once an hour until the month ends. Sends you approve still go out.';

/** The calendar month in UTC, `YYYY-MM`. */
export const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

export class ManagedCallMeter {
  /** The person each space's calls count for, as read once. */
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly sql: Sql,
    readonly cap: number | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  private async ownerOf(spaceId: string): Promise<string | null> {
    const known = this.owners.get(spaceId);
    if (known) return known;
    const [row] = await this.sql`select coalesce(s.owner_principal_id,
        (select id from owner limit 1)) as principal
      from space s where s.id = ${spaceId}`;
    const principal = row?.principal ? String(row.principal) : null;
    if (principal) this.owners.set(spaceId, principal);
    return principal;
  }

  /** Count calls made for a connection in this space. */
  async charge(spaceId: string, calls = 1): Promise<void> {
    const principal = await this.ownerOf(spaceId);
    if (!principal) return;
    await this.sql`insert into managed_call (principal_id, month, calls)
      values (${principal}, ${monthOf(this.now())}, ${calls})
      on conflict (principal_id, month) do update
        set calls = managed_call.calls + excluded.calls, updated_at = now()`;
  }

  /** This month's total over the whole installation. */
  async used(): Promise<number> {
    const [row] = await this.sql`select coalesce(sum(calls), 0)::bigint as used
      from managed_call where month = ${monthOf(this.now())}`;
    return Number(row?.used ?? 0);
  }

  /** Where this month stands against the limit; always `ok` without one. */
  async standing(): Promise<ManagedStanding> {
    if (this.cap === null) return { state: 'ok', used: 0, cap: null };
    const used = await this.used();
    const state = used >= this.cap ? 'reached' : used >= this.cap * NEAR_SHARE ? 'near' : 'ok';
    return { state, used, cap: this.cap };
  }
}
