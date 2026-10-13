/**
 * What an installation that other people reach over the internet needs beyond
 * starting: a public https address (sign-in and reset links, invites, app
 * sign-ins, texting), the web origin that matches it, somewhere to send alerts,
 * and the operator token that opens /health/detail.
 *
 * With `"hosted": true` in deploy/melete.deploy.json a missing one fails `check`
 * and `status`; otherwise each is a warning, because a private installation on
 * a laptop or a tailnet runs without them.
 *
 * A hosted installation also needs its cost guards, because its model key pays
 * for everyone: spending caps per person, for their background work and for
 * the whole installation, upload limits, a per-person computer limit and a
 * spending alert. These are judged only when it is hosted. A self-hosted
 * installation has no limits unless its operator sets them, and is never told
 * it should.
 */
import { HOSTED_STARTING_VALUES } from '../../../deploy/scripts/hosted-defaults.ts';
import type { DeployConfig } from './deploy-config.ts';
import type { Result } from './schema.ts';

const HOSTED_HINT =
  'Required once "hosted": true is set in deploy/melete.deploy.json; docs/DEPLOYMENT.md, "Hosting for other people".';

/** The origin of an http(s) address, or null when it is not one. */
export function originOf(value: string | undefined): string | null {
  try {
    const url = new URL(value?.trim() ?? '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function judgeHosted(config: DeployConfig, env: Record<string, string>): Result[] {
  const hosted = config.hosted === true;
  const missing = hosted ? ('fail' as const) : ('warn' as const);
  const note = hosted ? '' : ` ${HOSTED_HINT}`;
  const value = (name: string) => env[name]?.trim() ?? '';
  const results: Result[] = [];

  const publicUrl = value('MELETE_PUBLIC_URL');
  const publicOrigin = originOf(publicUrl);
  results.push(
    publicOrigin?.startsWith('https://')
      ? { id: 'hosted.public_url', level: 'ok', detail: `Public address ${publicOrigin}` }
      : {
          id: 'hosted.public_url',
          level: missing,
          detail: publicUrl
            ? `MELETE_PUBLIC_URL is ${publicOrigin ?? 'not a web address'}, not an https address, so sign-in links, invites and app sign-ins point nowhere people can reach.${note}`
            : `No MELETE_PUBLIC_URL, so there are no sign-in or reset links, invites, Google, Microsoft or MCP sign-ins, or texting.${note}`,
          fix: 'Run bun run melete set MELETE_PUBLIC_URL=https://your.domain MELETE_WEB_ORIGIN=https://your.domain',
        },
  );

  const webOrigin = value('MELETE_WEB_ORIGIN');
  if (publicOrigin)
    results.push(
      originOf(webOrigin) === publicOrigin
        ? { id: 'hosted.web_origin', level: 'ok', detail: `The web app accepts ${publicOrigin}.` }
        : {
            id: 'hosted.web_origin',
            level: missing,
            detail: webOrigin
              ? `MELETE_WEB_ORIGIN is ${webOrigin}, but MELETE_PUBLIC_URL is ${publicOrigin}; sign-in from the public address is refused.${note}`
              : `MELETE_WEB_ORIGIN is empty, so the web app does not accept sign-in at ${publicOrigin}.${note}`,
            fix: `Run bun run melete set MELETE_WEB_ORIGIN=${publicOrigin}`,
          },
    );

  const alerts = ['MELETE_ALERT_WEBHOOK_URL', 'MELETE_ALERT_EMAIL_TO'].filter((name) =>
    Boolean(value(name)),
  );
  results.push(
    alerts.length > 0
      ? { id: 'hosted.alerts', level: 'ok', detail: `Alerts go to ${alerts.join(' and ')}.` }
      : {
          id: 'hosted.alerts',
          level: missing,
          detail: `No alert target, so nobody hears when the database, disk or a service fails.${note}`,
          // A webhook's address works as its key and an SMTP URL holds a password, so
          // both are taken from the environment, where they are never printed.
          fix: 'Export the webhook address and run bun run melete set --from-env MELETE_ALERT_WEBHOOK_URL; or set MELETE_ALERT_EMAIL_TO, export MELETE_ALERT_SMTP_URL and run bun run melete set --from-env MELETE_ALERT_SMTP_URL (docs/DEPLOYMENT.md, "Alerts").',
        },
  );

  results.push(
    value('MELETE_OPERATOR_TOKEN').length >= 24
      ? { id: 'hosted.operator_token', level: 'ok', detail: 'MELETE_OPERATOR_TOKEN is set.' }
      : {
          id: 'hosted.operator_token',
          level: missing,
          detail: `No MELETE_OPERATOR_TOKEN, so /health/detail cannot be read from outside the host.${note}`,
          fix: 'Export a random value of 24 or more characters as MELETE_OPERATOR_TOKEN, then run bun run melete set --from-env MELETE_OPERATOR_TOKEN.',
        },
  );
  if (hosted) results.push(...judgeCostGuards(env));
  return results;
}

type Guard = {
  id: string;
  /** Every one of these must be set, or with `any` at least one. */
  names: string[];
  any?: true;
  /** What goes unbounded while it is missing. */
  risk: string;
  ok: string;
};

/** Each guard a hosted installation must set. */
export const COST_GUARDS: Guard[] = [
  {
    id: 'hosted.spend_person',
    names: ['MELETE_SPEND_PERSON_DAILY_USD', 'MELETE_SPEND_PERSON_MONTHLY_USD'],
    risk: 'one person can spend without limit on the model key you pay for',
    ok: 'Each person has a daily and a monthly spending cap.',
  },
  {
    id: 'hosted.spend_background',
    names: [
      'MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD',
      'MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD',
    ],
    risk: "one person's routines and watches can run up cost with nobody watching",
    ok: "Each person's background work has a daily and a monthly cap.",
  },
  {
    id: 'hosted.spend_installation',
    names: ['MELETE_SPEND_MONTHLY_USD'],
    risk: "everyone's spending together has no ceiling",
    ok: 'The installation has a monthly spending cap.',
  },
  {
    id: 'hosted.uploads',
    names: ['MELETE_ATTACHMENT_UPLOADS_AT_ONCE', 'MELETE_ATTACHMENT_UPLOADS_PER_WINDOW'],
    risk: 'one person can upload without limit and fill the disk',
    ok: 'Each person has an upload limit.',
  },
  {
    id: 'hosted.computers',
    names: ['MELETE_SANDBOX_MAX_CONCURRENT_PER_CONNECTION'],
    risk: 'one person can take every computer the installation runs',
    ok: 'Each person has a computer limit.',
  },
  {
    id: 'hosted.spend_alert',
    names: ['MELETE_ALERT_SPEND_HOURLY_MULTIPLE', 'MELETE_ALERT_SPEND_PERSON_PERCENT'],
    any: true,
    risk: 'nobody hears when spending jumps',
    ok: 'A jump in spending raises an alert.',
  },
];

const STARTING: Record<string, string | undefined> = HOSTED_STARTING_VALUES;

/** Whether a setting holds a positive number. */
const positive = (value: string | undefined) => {
  const text = value?.trim() ?? '';
  return text !== '' && Number.isFinite(Number(text)) && Number(text) > 0;
};

/**
 * The cost guards a hosted installation must set, each failing by name while
 * it is missing; the fix names a starting value from deploy/scripts/hosted-defaults.ts.
 */
export function judgeCostGuards(env: Record<string, string>): Result[] {
  return COST_GUARDS.map((guard): Result => {
    const unset = guard.names.filter((name) => !positive(env[name]));
    const met = guard.any ? unset.length < guard.names.length : unset.length === 0;
    if (met) return { id: guard.id, level: 'ok', detail: guard.ok };
    const wanted = guard.any ? guard.names.slice(0, 1) : unset;
    const named = guard.any
      ? `Neither ${guard.names.join(' nor ')} is`
      : `${unset.join(' and ')} ${unset.length === 1 ? 'is' : 'are'} not`;
    return {
      id: guard.id,
      level: 'fail',
      detail: `${named} set to a positive number, so ${guard.risk}. ${HOSTED_HINT}`,
      fix: `Run bun run melete set ${wanted.map((name) => `${name}=${STARTING[name] ?? '<value>'}`).join(' ')}, a starting value to tune.`,
    };
  });
}
