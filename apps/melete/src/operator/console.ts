/**
 * The operator console: the web app's way for the installation's owner to
 * run a Melete other people use, as the operator's `melete account` command
 * does on the host. Everyone's accounts with their spending against their
 * caps; inviting, disabling, enabling, resetting and deleting; each person's
 * own caps; the installation at a glance; and the record of every change.
 *
 * It makes nothing new where the service already has it. An invite is the
 * operator command's (`inviteAccount`), a reset is its one-time link
 * (`issuePasswordReset`), disabling ends access the way every other way does
 * (`disableAccount`, then `endAccess`), deleting is the account deletion
 * every account has (`AccountRemovalService`), and spending is read from the
 * spending guard and `model_usage`.
 *
 * The routes check the caller is the installation's owner (`routes.ts`); the
 * service checks the account it acts on again, inside each change.
 */
import type {
  OperatorAuditEntry,
  OperatorCaps,
  OperatorOneTimeLink,
  OperatorOverview,
  OperatorPeople,
  OperatorPerson,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { disableAccount, enableAccount, INVITE_MINUTES, inviteAccount } from '../account/cli.ts';
import { type AccountRemovalService, removedEmail } from '../account/removal.ts';
import { ServiceError } from '../api/errors.ts';
import { issuePasswordReset, RESET_MINUTES, resetUrl } from '../api/password.ts';
import type { Env } from '../env.ts';
import {
  type AccountMail,
  type AccountMailer,
  inviteMail,
  passwordResetMail,
} from '../experience/account-mail.ts';
import {
  checkPersonCaps,
  limitsWithCaps,
  NO_OWN_CAPS,
  type PersonCaps,
  PersonLimitStore,
} from '../gateway/person-limits.ts';
import {
  periodBounds,
  type SpendingGuard,
  type SpendingLimits,
  spendingLimitsFromEnv,
} from '../gateway/spending.ts';
import type { HealthDetail } from '../health/monitor.ts';
import { listOperatorActions, type OperatorActor, recordOperatorAction } from './audit.ts';
import { MAX_BACKUP_AGE_HOURS, newestBackupAt } from './backup-note.ts';

export type DiskReading = { free_mb: number | null; floor_mb: number; ok: boolean };

export type OperatorConsoleDeps = {
  sql: Sql;
  env: Env;
  /** Deletes accounts; without it, deleting is refused. */
  accounts?: AccountRemovalService;
  /** The spending guard the service admits model calls with; its per-person caps are edited here. */
  spending?: SpendingGuard;
  /** Sends invites and resets; without it, or without a web address, links are passed on by hand. */
  mailer?: AccountMailer;
  /** Closes the live connections of computers that disabling an account disconnected. */
  devicesEnded?: (principalId: string, deviceIds: string[]) => Promise<void>;
  health: () => Promise<HealthDetail>;
  /** Free disk against the floor; null when the floor is off. */
  disk?: () => DiskReading | null;
  version: string;
  now?: () => Date;
};

type PersonRow = {
  id: string;
  email: string;
  display_name: string | null;
  kind: string;
  created_at: Date | string;
  disabled_at: Date | string | null;
  signs_in: boolean;
  is_owner: boolean;
  sessions: number;
  last_active: Date | string | null;
};

const iso = (value: Date | string) => new Date(value).toISOString();
const cents = (value: number) => Math.round(value * 100) / 100;
const dollars = (value: number | null) => (value === null ? 'none' : `$${value.toFixed(2)}`);

const CAP_NAMES: Record<keyof PersonCaps, string> = {
  day_usd: 'Daily',
  month_usd: 'Monthly',
  background_day_usd: 'Background daily',
  background_month_usd: 'Background monthly',
};

/** A sentence for each cap that changed, as the record keeps it. */
export function describeCapChange(before: PersonCaps, after: PersonCaps): string {
  const changed = (Object.keys(CAP_NAMES) as (keyof PersonCaps)[])
    .filter((key) => before[key] !== after[key])
    .map((key) => {
      const was = before[key] === null ? 'the installation’s' : dollars(before[key]);
      const now = after[key] === null ? 'the installation’s' : dollars(after[key]);
      return `${CAP_NAMES[key]} cap: ${was} → ${now}`;
    });
  return changed.length ? changed.join('; ') : 'No change';
}

export class OperatorConsole {
  readonly overrides: PersonLimitStore;
  private readonly limits: SpendingLimits;

  constructor(readonly deps: OperatorConsoleDeps) {
    this.overrides = deps.spending?.overrides ?? new PersonLimitStore(deps.sql);
    this.limits = deps.spending?.limits ?? spendingLimitsFromEnv(deps.env);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Whether this account is the installation's owner. */
  async isOwner(principalId: string | undefined): Promise<boolean> {
    if (!principalId) return false;
    const [row] = await this.deps.sql`select 1 from owner where id = ${principalId}`;
    return Boolean(row);
  }

  /** The people with an account here, as `person_spend_limit`, `model_usage` and `session` read now. */
  private async rows(only?: string): Promise<PersonRow[]> {
    const { sql } = this.deps;
    return sql<PersonRow[]>`select p.id, p.email, p.display_name, p.kind, p.created_at,
        p.disabled_at,
        (p.password_hash is not null or p.passkey is not null
          or exists (select 1 from principal_identity i where i.principal_id = p.id)) as signs_in,
        exists (select 1 from owner o where o.id = p.id) as is_owner,
        (select count(*)::int from session s
          where coalesce(s.principal_id, s.owner_id) = p.id and s.expires_at > now()) as sessions,
        greatest(
          (select max(s.created_at) from session s where coalesce(s.principal_id, s.owner_id) = p.id),
          (select max(u.created_at) from model_usage u where u.principal_id = p.id)) as last_active
      from principal p
      where p.kind in ('person', 'guest')
        ${only ? sql`and p.id = ${only}` : sql``}
        -- A deleted account whose row has to stay, because a room someone
        -- else owns still names it, is not an account any more.
        and (p.email <> 'removed+' || lower(p.id) || '@removed.invalid'
          or exists (select 1 from space_removal r where r.requested_by = p.id
            and r.state <> 'complete')
          or exists (select 1 from space s where s.owner_principal_id = p.id))
      order by p.created_at, p.id`;
  }

  /** This month's and today's spending of everyone who spent, by person. */
  private async spendByPerson(only?: string) {
    const { sql } = this.deps;
    const { monthStart, dayStart } = periodBounds(this.now());
    const rows = await sql<
      { principal_id: string; month_usd: number; day_usd: number; background_month_usd: number }[]
    >`select principal_id,
        coalesce(sum(cost_usd), 0)::float8 as month_usd,
        coalesce(sum(cost_usd) filter (where created_at >= ${dayStart.toISOString()}::timestamptz), 0)::float8 as day_usd,
        coalesce(sum(cost_usd) filter (where class = 'background'), 0)::float8 as background_month_usd
      from model_usage
      where created_at >= ${monthStart.toISOString()}::timestamptz and principal_id is not null
        ${only ? sql`and principal_id = ${only}` : sql``}
      group by principal_id`;
    return new Map(rows.map((row) => [String(row.principal_id), row]));
  }

  private effective(caps: PersonCaps): OperatorCaps {
    const limits = limitsWithCaps(this.limits, caps);
    return {
      day_usd: limits.person.day.usd,
      month_usd: limits.person.month.usd,
      background_day_usd: limits.background?.day.usd ?? null,
      background_month_usd: limits.background?.month.usd ?? null,
    };
  }

  private present(
    row: PersonRow,
    spend: Map<string, { month_usd: number; day_usd: number; background_month_usd: number }>,
    own: PersonCaps,
  ): OperatorPerson {
    const removing = row.email === removedEmail(row.id);
    const spent = spend.get(row.id);
    return {
      id: row.id,
      email: removing ? null : row.email,
      display_name: row.display_name,
      kind: row.kind === 'guest' ? 'guest' : 'person',
      owner: row.is_owner,
      status: removing
        ? 'removing'
        : row.disabled_at
          ? 'disabled'
          : row.signs_in
            ? 'active'
            : 'invited',
      created_at: iso(row.created_at),
      last_active_at: row.last_active ? iso(row.last_active) : null,
      sessions: Number(row.sessions),
      spend: {
        day_usd: cents(Number(spent?.day_usd ?? 0)),
        month_usd: cents(Number(spent?.month_usd ?? 0)),
        background_month_usd: cents(Number(spent?.background_month_usd ?? 0)),
      },
      caps: { own, effective: this.effective(own) },
    };
  }

  /** Whether invites and resets can go out by email. */
  private canEmail(): boolean {
    return Boolean(this.deps.mailer && this.deps.env.MELETE_PUBLIC_URL);
  }

  async people(): Promise<OperatorPeople> {
    const [rows, spend, own] = await Promise.all([
      this.rows(),
      this.spendByPerson(),
      this.overrides.all(),
    ]);
    return {
      people: rows.map((row) => this.present(row, spend, own.get(row.id) ?? NO_OWN_CAPS)),
      installation: {
        day_usd: this.limits.installation.day.usd,
        month_usd: this.limits.installation.month.usd,
      },
      defaults: this.effective(NO_OWN_CAPS),
      can_email: this.canEmail(),
    };
  }

  /** One person, or 404. */
  async person(id: string): Promise<OperatorPerson> {
    const [row] = await this.rows(id);
    if (!row) throw new ServiceError('not_found', 'There is no account like that here.', 404);
    const [spend, own] = await Promise.all([this.spendByPerson(id), this.overrides.of(id)]);
    return this.present(row, spend, own);
  }

  /** A person who can still be changed: not being deleted. */
  private async changeable(id: string): Promise<OperatorPerson & { email: string }> {
    const person = await this.person(id);
    if (person.status === 'removing' || person.email === null)
      throw new ServiceError('not_found', 'That account is being deleted.', 404);
    return { ...person, email: person.email };
  }

  /**
   * Mails a link when the installation can; the link works either way, so a
   * failure is told to the owner, who passes the link on themselves.
   */
  private async mail(build: (link: string) => AccountMail, link: string | null) {
    if (!this.deps.mailer || !link) return { emailed: false, mail_problem: null };
    try {
      await this.deps.mailer.send(build(link));
      return { emailed: true, mail_problem: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0]?.slice(0, 160) : '';
      return {
        emailed: false,
        mail_problem: `The email didn’t go out${reason ? ` (${reason})` : ''}. Copy the link and send it yourself.`,
      };
    }
  }

  private linkFor(token: string): string | null {
    const url = this.deps.env.MELETE_PUBLIC_URL;
    return url ? resetUrl(url, token) : null;
  }

  async invite(
    actor: NonNullable<OperatorActor>,
    email: string,
  ): Promise<{ person: OperatorPerson; invite: OperatorOneTimeLink }> {
    const made = await inviteAccount(this.deps.sql, email);
    if (!made.ok)
      throw new ServiceError(
        made.reason === 'taken' ? 'account_exists' : 'validation_failed',
        made.reason === 'taken' ? 'Someone already has an account with that email.' : made.message,
        made.reason === 'taken' ? 409 : 400,
      );
    const link = this.linkFor(made.token);
    const days = INVITE_MINUTES / 1440;
    const sent = await this.mail((url) => inviteMail(made.email, url, days, actor.email), link);
    await recordOperatorAction(this.deps.sql, {
      actor,
      action: 'invited',
      target: { id: made.id, email: made.email },
      detail: sent.emailed ? 'Invite emailed' : 'Invite link to pass on',
    });
    return {
      person: await this.person(made.id),
      invite: {
        purpose: 'invite',
        link,
        code: made.token,
        expires_at: made.expiresAt.toISOString(),
        ...sent,
      },
    };
  }

  /**
   * A new one-time link to choose a password. Someone who never chose one
   * gets their invite again, which signs them straight in; anyone else gets a
   * reset, which ends their sessions once it is used.
   */
  async sendReset(
    actor: NonNullable<OperatorActor>,
    id: string,
  ): Promise<{ person: OperatorPerson; reset: OperatorOneTimeLink }> {
    const person = await this.changeable(id);
    if (person.status === 'disabled')
      throw new ServiceError(
        'account_disabled',
        'This account is disabled. Enable it first, then send the link.',
        409,
      );
    const invite = person.status === 'invited';
    const via = invite ? 'invite' : 'operator';
    const issued = await this.deps.sql.begin((tx) => issuePasswordReset(tx, id, via));
    const link = this.linkFor(issued.token);
    const sent = await this.mail(
      (url) =>
        invite
          ? inviteMail(person.email, url, INVITE_MINUTES / 1440, actor.email)
          : passwordResetMail(person.email, url, RESET_MINUTES.operator),
      link,
    );
    await recordOperatorAction(this.deps.sql, {
      actor,
      action: invite ? 'invite_resent' : 'reset_sent',
      target: { id, email: person.email },
      detail: sent.emailed ? 'Link emailed' : 'Link to pass on',
    });
    return {
      person,
      reset: {
        purpose: invite ? 'invite' : 'reset',
        link,
        code: issued.token,
        expires_at: issued.expiresAt.toISOString(),
        ...sent,
      },
    };
  }

  async setDisabled(
    actor: NonNullable<OperatorActor>,
    id: string,
    disabled: boolean,
  ): Promise<OperatorPerson> {
    const person = await this.changeable(id);
    if (person.owner)
      throw new ServiceError(
        'owner_kept',
        'Your own account runs this Melete, so it can’t be disabled here.',
        409,
      );
    if (disabled) {
      const devices = await disableAccount(this.deps.sql, id);
      await this.deps
        .devicesEnded?.(id, devices)
        .catch((error: unknown) =>
          process.stderr.write(
            `operator: a disabled account's computers were not all disconnected (${error instanceof Error ? error.message : 'error'})\n`,
          ),
        );
    } else await enableAccount(this.deps.sql, id);
    if ((person.status === 'disabled') !== disabled)
      await recordOperatorAction(this.deps.sql, {
        actor,
        action: disabled ? 'disabled' : 'enabled',
        target: { id, email: person.email },
        ...(disabled ? { detail: `Signed out of ${person.sessions} session(s)` } : {}),
      });
    return this.person(id);
  }

  async setCaps(
    actor: NonNullable<OperatorActor>,
    id: string,
    caps: PersonCaps,
  ): Promise<OperatorPerson> {
    const person = await this.changeable(id);
    const problem = checkPersonCaps(this.limits, caps);
    if (problem) throw new ServiceError('caps_out_of_range', problem, 400);
    const before = person.caps.own;
    await this.overrides.set(this.deps.sql, id, caps);
    const detail = describeCapChange(before, caps);
    if (detail !== 'No change')
      await recordOperatorAction(this.deps.sql, {
        actor,
        action: 'caps_changed',
        target: { id, email: person.email },
        detail,
      });
    return this.person(id);
  }

  private removals(): AccountRemovalService {
    if (!this.deps.accounts)
      throw new ServiceError('unavailable', 'Deleting accounts isn’t available here.', 503);
    return this.deps.accounts;
  }

  removalPreview(actor: NonNullable<OperatorActor>, id: string) {
    return this.removals().preview(actor.id, id);
  }

  async remove(actor: NonNullable<OperatorActor>, id: string, confirmEmail: string) {
    const person = await this.changeable(id);
    const removal = await this.removals().remove(actor.id, id, confirmEmail);
    await recordOperatorAction(this.deps.sql, {
      actor,
      action: 'removed',
      target: { id, email: person.email },
      detail: 'Account and its spaces deleted',
    });
    return removal;
  }

  audit(limit = 100): Promise<OperatorAuditEntry[]> {
    return listOperatorActions(this.deps.sql, limit);
  }

  async overview(): Promise<OperatorOverview> {
    const { sql, env } = this.deps;
    const now = this.now();
    const { nextMonth } = periodBounds(now);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const [people, [counts], spend, backup, health] = await Promise.all([
      this.rows(),
      sql<{ runs: number; computers: number }[]>`select
        (select count(*)::int from attempt where ended_at is null and lease_status = 'active') as runs,
        (select count(*)::int from sandbox_session where status in ('opening', 'ready')) as computers`,
      this.installationSpend(now),
      newestBackupAt(sql),
      this.deps.health(),
    ]);
    const live = people.filter((row) => row.email !== removedEmail(row.id));
    const computersPer = env.MELETE_SANDBOX_MAX_CONCURRENT_PER_CONNECTION;
    return {
      version: this.deps.version,
      spend: {
        ...spend,
        day_cap_usd: this.limits.installation.day.usd,
        month_cap_usd: this.limits.installation.month.usd,
        month_resets_at: nextMonth.toISOString(),
      },
      people: {
        total: live.length,
        active: live.filter(
          (row) => !row.disabled_at && row.last_active && new Date(row.last_active) >= weekAgo,
        ).length,
        invited: live.filter((row) => !row.disabled_at && !row.signs_in).length,
        disabled: live.filter((row) => row.disabled_at).length,
      },
      runs: {
        used: Number(counts?.runs ?? 0),
        limit: env.MELETE_ATTEMPT_CONCURRENCY,
        per_person: env.MELETE_ATTEMPT_CONCURRENCY_PER_PERSON ?? null,
      },
      computers: {
        used: Number(counts?.computers ?? 0),
        limit: env.MELETE_SANDBOX_MAX_CONCURRENT,
        // At or above the installation's limit, only the installation's holds.
        per_person:
          computersPer !== undefined && computersPer < env.MELETE_SANDBOX_MAX_CONCURRENT
            ? computersPer
            : null,
      },
      backup: {
        newest_at: backup ? backup.toISOString() : null,
        max_age_hours: MAX_BACKUP_AGE_HOURS,
      },
      disk: this.deps.disk?.() ?? null,
      health: { status: health.status, checks: health.checks },
    };
  }

  private async installationSpend(now: Date) {
    const { monthStart, dayStart } = periodBounds(now);
    const [row] = await this.deps.sql<{ month_usd: number; day_usd: number }[]>`select
        coalesce(sum(cost_usd), 0)::float8 as month_usd,
        coalesce(sum(cost_usd) filter (where created_at >= ${dayStart.toISOString()}::timestamptz), 0)::float8 as day_usd
      from model_usage where created_at >= ${monthStart.toISOString()}::timestamptz`;
    return {
      month_usd: cents(Number(row?.month_usd ?? 0)),
      day_usd: cents(Number(row?.day_usd ?? 0)),
    };
  }
}
