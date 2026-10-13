/**
 * The cost guards an installation for other people starts with. Every one is
 * unset on a self-hosted installation, which has no limits unless its
 * operator sets them; `init --hosted` writes these, and `check` and `status`
 * fail a hosted installation while any of them is missing
 * (packages/cli/src/hosted.ts).
 *
 * They are starting points to tune, not recommendations for every install:
 * dollars are estimated from the price table, per UTC day and month.
 */
export const HOSTED_STARTING_VALUES = {
  /** What one person's model calls may cost in a day and a month. */
  MELETE_SPEND_PERSON_DAILY_USD: '2',
  MELETE_SPEND_PERSON_MONTHLY_USD: '20',
  /** The part of that their routines, watches and other unattended work may use. */
  MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD: '0.5',
  MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD: '5',
  /** Everyone together, in a month. */
  MELETE_SPEND_MONTHLY_USD: '200',
  /** Uploads one person may have under way at once, and may start in ten minutes. */
  MELETE_ATTACHMENT_UPLOADS_AT_ONCE: '3',
  MELETE_ATTACHMENT_UPLOADS_PER_WINDOW: '30',
  /** Computers one person may have running at once. */
  MELETE_SANDBOX_MAX_CONCURRENT_PER_CONNECTION: '1',
  /** An alert when an hour's model spending is four times the usual hour. */
  MELETE_ALERT_SPEND_HOURLY_MULTIPLE: '4',
} as const satisfies Record<string, string>;
