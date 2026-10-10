/**
 * What an installation that other people reach over the internet needs beyond
 * starting: a public https address (sign-in and reset links, invites, app
 * sign-ins, texting), the web origin that matches it, somewhere to send alerts,
 * and the operator token that opens /health/detail.
 *
 * With `"hosted": true` in deploy/melete.deploy.json a missing one fails `check`
 * and `status`; otherwise each is a warning, because a private installation on
 * a laptop or a tailnet runs without them.
 */
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
          fix: 'Run bun run melete set MELETE_ALERT_WEBHOOK_URL=https://..., or MELETE_ALERT_EMAIL_TO with MELETE_ALERT_SMTP_URL (docs/DEPLOYMENT.md, "Alerts").',
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
  return results;
}
