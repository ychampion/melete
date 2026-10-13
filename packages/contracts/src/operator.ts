/**
 * The operator console: what the installation's owner sees and does in the
 * web app to run a Melete other people use. Everyone's accounts, their
 * spending against their caps, the installation's health and limits, and a
 * record of every change the owner made. Every route answers the owner
 * alone: 401 without a session, 403 to any other account.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

/** A dollar amount; a function, so each use is its own schema in the published document. */
const dollars = () => z.number().nonnegative();

/**
 * A person's own dollar caps. Null keeps the installation's per-person cap
 * for that period. Each is a positive amount in whole cents, at most the
 * installation's own cap for the same period; a day's cap may not pass the
 * month's, and background work may not pass what the person may spend in all.
 */
export const operatorCaps = z
  .strictObject({
    day_usd: z.number().positive().max(1_000_000).nullable(),
    month_usd: z.number().positive().max(1_000_000).nullable(),
    background_day_usd: z.number().positive().max(1_000_000).nullable(),
    background_month_usd: z.number().positive().max(1_000_000).nullable(),
  })
  .meta({ id: 'OperatorCaps' });
export type OperatorCaps = z.infer<typeof operatorCaps>;

/**
 * New caps for a person: all four, each a dollar amount or null to keep the
 * installation's. Amounts outside the rules in `operatorCaps` answer 400
 * `caps_out_of_range` with a sentence saying which and why.
 */
export const operatorCapsRequest = z.strictObject({
  day_usd: z.number().nullable(),
  month_usd: z.number().nullable(),
  background_day_usd: z.number().nullable(),
  background_month_usd: z.number().nullable(),
});

export const operatorPerson = z
  .strictObject({
    id: prefixedId(ID_PREFIXES.owner),
    /** Null once the account is being deleted: its email is wiped first. */
    email: z.email().nullable(),
    display_name: z.string().nullable(),
    kind: z.enum(['person', 'guest']),
    /** The installation's owner: it can't be disabled or deleted here. */
    owner: z.boolean(),
    /**
     * `invited`: has not chosen a password yet. `disabled`: can't sign in.
     * `removing`: being deleted.
     */
    status: z.enum(['active', 'invited', 'disabled', 'removing']),
    created_at: timestamp,
    /** The last time they signed in or used a model, whichever is later. */
    last_active_at: timestamp.nullable(),
    /** Browser sessions still signed in. */
    sessions: z.number().int().nonnegative(),
    spend: z.strictObject({
      day_usd: dollars(),
      month_usd: dollars(),
      background_month_usd: dollars(),
    }),
    caps: z.strictObject({
      /** The caps of their own the owner set; null keeps the installation's. */
      own: operatorCaps,
      /** What holds for them now, own or the installation's; null is no cap. */
      effective: operatorCaps,
    }),
  })
  .meta({ id: 'OperatorPerson' });
export type OperatorPerson = z.infer<typeof operatorPerson>;

export const operatorPeople = z.strictObject({
  people: z.array(operatorPerson),
  /** The installation's caps every person's own caps have to stay within. */
  installation: z.strictObject({ day_usd: dollars().nullable(), month_usd: dollars().nullable() }),
  /** The per-person caps anyone without caps of their own has. */
  defaults: operatorCaps,
  /** Whether invites and reset links can be emailed: account mail and a web address are set. */
  can_email: z.boolean(),
});
export type OperatorPeople = z.infer<typeof operatorPeople>;

export const operatorInviteRequest = z.strictObject({ email: z.email().max(254) });

/**
 * A one-time link that sets a password: an invite's, or a reset's. Always
 * returned, so the owner can pass it on themselves; `emailed` says whether it
 * was also mailed. `link` is null when the installation has no web address,
 * and the code goes on the sign-in page's "Forgot your password?" instead.
 */
export const operatorOneTimeLink = z
  .strictObject({
    purpose: z.enum(['invite', 'reset']),
    link: z.string().nullable(),
    code: z.string(),
    expires_at: timestamp,
    emailed: z.boolean(),
    /** Why it was not mailed, when mailing was tried and failed, in a sentence. */
    mail_problem: z.string().nullable(),
  })
  .meta({ id: 'OperatorOneTimeLink' });
export type OperatorOneTimeLink = z.infer<typeof operatorOneTimeLink>;

export const operatorInviteResponse = z.strictObject({
  person: operatorPerson,
  invite: operatorOneTimeLink,
});
export const operatorResetResponse = z.strictObject({
  person: operatorPerson,
  reset: operatorOneTimeLink,
});
export const operatorPersonResponse = z.strictObject({ person: operatorPerson });

export const operatorAction = z.enum([
  'invited',
  'invite_resent',
  'reset_sent',
  'disabled',
  'enabled',
  'caps_changed',
  'removed',
]);
export type OperatorAction = z.infer<typeof operatorAction>;

/** One change the owner made, or the operator's command on the host did. No link or code is ever kept. */
export const operatorAuditEntry = z.strictObject({
  id: z.string(),
  at: timestamp,
  action: operatorAction,
  /** Null for the operator's command on the host. */
  actor: z.strictObject({ id: z.string().nullable(), email: z.string().nullable() }),
  target: z.strictObject({ id: z.string().nullable(), email: z.string().nullable() }),
  detail: z.string().nullable(),
});
export type OperatorAuditEntry = z.infer<typeof operatorAuditEntry>;
export const operatorAudit = z.strictObject({ entries: z.array(operatorAuditEntry) });

const usedOf = z
  .strictObject({
    used: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    /** How many one person may use at once; null when only the installation's limit holds. */
    per_person: z.number().int().positive().nullable(),
  })
  .meta({ id: 'OperatorUsedOf' });

export const operatorOverview = z.strictObject({
  version: z.string(),
  spend: z.strictObject({
    day_usd: dollars(),
    month_usd: dollars(),
    day_cap_usd: dollars().nullable(),
    month_cap_usd: dollars().nullable(),
    month_resets_at: timestamp,
  }),
  people: z.strictObject({
    total: z.number().int().nonnegative(),
    /** Signed in or used a model in the last 7 days. */
    active: z.number().int().nonnegative(),
    invited: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
  }),
  /** Agent runs going now, against how many may run at once. */
  runs: usedOf,
  /** Agents' computers running now, against how many may. */
  computers: usedOf,
  backup: z.strictObject({
    /** When the newest backup the operator's command noted was taken; null when none was. */
    newest_at: timestamp.nullable(),
    /** Over this many hours old counts as stale. */
    max_age_hours: z.number().int().positive(),
  }),
  /** Free disk on the fullest of the service's directories; null when it is not measured. */
  disk: z
    .strictObject({
      free_mb: z.number().int().nonnegative().nullable(),
      floor_mb: z.number().int().nonnegative(),
      ok: z.boolean(),
    })
    .nullable(),
  health: z.strictObject({
    status: z.enum(['ok', 'unhealthy']),
    checks: z.array(z.strictObject({ name: z.string(), ok: z.boolean(), detail: z.string() })),
  }),
});
export type OperatorOverview = z.infer<typeof operatorOverview>;
