/**
 * The service's view of its own health, and the operator's alerts when it
 * goes bad.
 *
 * `healthDetail` checks the database, the runtime that runs attempts, the job
 * queue (work that is due but has not been picked up) and the recent error
 * rate (attempts that failed or were lost, and model calls providers
 * refused). Where the operator asks for them, two spending checks join it:
 * the last hour's model spending against the installation's usual hour, and
 * one person's share of today's. `GET /health/detail` returns it to the
 * operator.
 *
 * `HealthMonitor` runs those checks on a timer and, when the service turns
 * unhealthy, sends an alert to the configured webhook and/or email address;
 * it repeats while the trouble lasts and says when it has cleared. It runs
 * inside the service, so it cannot report the service being down: pair it
 * with an external uptime check on `/health` (docs/DEPLOYMENT.md, "Alerts").
 */
import nodemailer from 'nodemailer';
import type { Sql } from 'postgres';
import type { Env } from '../env.ts';

export type HealthCheck = { name: string; ok: boolean; detail: string };
export type HealthDetail = {
  status: 'ok' | 'unhealthy';
  version: string;
  checks: HealthCheck[];
  time: string;
};

export type HealthProbes = {
  version: string;
  database: () => Promise<'ok' | 'unreachable' | 'not_configured'>;
  /** Resolves when the runtime answers; left out, there is no runtime to check. */
  runtime?: () => Promise<unknown>;
  sql?: Sql;
  /** The spending checks to run; each is left out unless set. */
  spend?: SpendAlerts;
};

export type SpendAlerts = {
  /** The last hour above this many times the median hour of the week before. */
  hourlyMultiple?: number;
  /** One person above this percent of today's spending, with others spending too. */
  personPercent?: number;
  /** Neither check fires below this many dollars. */
  minUsd: number;
};

export function spendAlertsFromEnv(env: Env): SpendAlerts | undefined {
  if (!env.MELETE_ALERT_SPEND_HOURLY_MULTIPLE && !env.MELETE_ALERT_SPEND_PERSON_PERCENT)
    return undefined;
  return {
    ...(env.MELETE_ALERT_SPEND_HOURLY_MULTIPLE
      ? { hourlyMultiple: env.MELETE_ALERT_SPEND_HOURLY_MULTIPLE }
      : {}),
    ...(env.MELETE_ALERT_SPEND_PERSON_PERCENT
      ? { personPercent: env.MELETE_ALERT_SPEND_PERSON_PERCENT }
      : {}),
    minUsd: env.MELETE_ALERT_SPEND_MIN_USD,
  };
}

const dollars = (value: number) => `$${value.toFixed(2)}`;

/** The last hour's spending against the usual hour. */
export function spendRateCheck(
  lastHourUsd: number,
  usualHourUsd: number,
  multiple: number,
  minUsd: number,
): HealthCheck {
  const high = lastHourUsd >= minUsd && lastHourUsd > multiple * usualHourUsd;
  return {
    name: 'spend_rate',
    ok: !high,
    detail: `${dollars(lastHourUsd)} on model calls in the last hour; the usual hour is ${dollars(usualHourUsd)}${high ? `, and the alert is set at ${multiple} times that` : ''}`,
  };
}

/** One person's share of today's spending. */
export function spendShareCheck(
  top: { personId: string; usd: number } | null,
  totalUsd: number,
  people: number,
  percent: number,
  minUsd: number,
): HealthCheck {
  const share = top && totalUsd > 0 ? (top.usd / totalUsd) * 100 : 0;
  const high = Boolean(top) && people > 1 && (top?.usd ?? 0) >= minUsd && share > percent;
  return {
    name: 'spend_share',
    ok: !high,
    detail: top
      ? `${top.personId} accounts for ${Math.round(share)}% (${dollars(top.usd)}) of today's ${dollars(totalUsd)} across ${people} ${people === 1 ? 'person' : 'people'}`
      : 'no model spending today',
  };
}

export const HEALTH_LIMITS = {
  /** How long a runtime probe may take. */
  runtime_timeout_ms: 5_000,
  /** Work due this long ago and still not started means the queue is stuck. */
  queue_stuck_minutes: 10,
  /** The window the error rate is read over. */
  error_window_minutes: 15,
  /** Fewer outcomes than this in the window is too few to call a spike. */
  error_min_samples: 5,
  /** The share of failures in the window that counts as a spike. */
  error_rate: 0.5,
} as const;

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function healthDetail(
  probes: HealthProbes,
  limits: Record<keyof typeof HEALTH_LIMITS, number> = HEALTH_LIMITS,
): Promise<HealthDetail> {
  const checks: HealthCheck[] = [];
  const database = await probes.database().catch(() => 'unreachable' as const);
  checks.push({
    name: 'database',
    ok: database !== 'unreachable',
    detail: database === 'not_configured' ? 'not configured' : database,
  });
  if (probes.runtime) {
    const runtime = probes.runtime;
    const answered = await within(Promise.resolve().then(runtime), limits.runtime_timeout_ms)
      .then(() => null)
      .catch((error: unknown) => (error instanceof Error ? error.message : 'unreachable'));
    checks.push({
      name: 'runtime',
      ok: answered === null,
      detail: answered === null ? 'ok' : `not answering (${answered.slice(0, 120)})`,
    });
  }
  if (probes.sql && database === 'ok') {
    const sql = probes.sql;
    try {
      const [queue] = await sql`select count(*)::int as stuck from job
        where state = 'queued' and not paused and next_wake_at is not null
          and next_wake_at < now() - make_interval(mins => ${limits.queue_stuck_minutes})`;
      const stuck = Number(queue?.stuck ?? 0);
      checks.push({
        name: 'job_queue',
        ok: stuck === 0,
        detail:
          stuck === 0
            ? 'ok'
            : `${stuck} job${stuck === 1 ? '' : 's'} due more than ${limits.queue_stuck_minutes} minutes ago and not started`,
      });
      const [attempts] = await sql`select count(*)::int as ended,
          count(*) filter (where outcome = 'failed' or lease_status = 'lost')::int as failed
        from attempt where ended_at > now() - make_interval(mins => ${limits.error_window_minutes})`;
      const [calls] = await sql`select count(*)::int as total,
          count(*) filter (where status = 'failed')::int as failed
        from model_usage where created_at > now() - make_interval(mins => ${limits.error_window_minutes})`;
      const spike = (failed: number, total: number) =>
        total >= limits.error_min_samples && failed / total >= limits.error_rate;
      const attemptSpike = spike(Number(attempts?.failed ?? 0), Number(attempts?.ended ?? 0));
      const callSpike = spike(Number(calls?.failed ?? 0), Number(calls?.total ?? 0));
      checks.push({
        name: 'error_rate',
        ok: !attemptSpike && !callSpike,
        detail: `in the last ${limits.error_window_minutes} minutes: ${attempts?.failed ?? 0} of ${attempts?.ended ?? 0} attempts failed or were lost, ${calls?.failed ?? 0} of ${calls?.total ?? 0} model calls were refused by the provider`,
      });
    } catch (error) {
      checks.push({
        name: 'job_queue',
        ok: false,
        detail: `could not be read (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`,
      });
    }
  }
  if (probes.sql && database === 'ok' && probes.spend) {
    try {
      checks.push(...(await spendChecks(probes.sql, probes.spend)));
    } catch (error) {
      checks.push({
        name: 'spend',
        ok: false,
        detail: `spending could not be read (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`,
      });
    }
  }
  return {
    status: checks.every((check) => check.ok) ? 'ok' : 'unhealthy',
    version: probes.version,
    checks,
    time: new Date().toISOString(),
  };
}

/** The spending checks the operator asked for, read from `model_usage`. */
async function spendChecks(sql: Sql, spend: SpendAlerts): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  if (spend.hourlyMultiple !== undefined) {
    const [rate] = await sql`with hours as (
        select generate_series(date_trunc('hour', now()) - interval '168 hours',
          date_trunc('hour', now()) - interval '1 hour', interval '1 hour') as hour),
      spent as (
        select date_trunc('hour', created_at) as hour, sum(cost_usd) as usd from model_usage
        where created_at >= date_trunc('hour', now()) - interval '168 hours'
          and created_at < date_trunc('hour', now())
        group by 1)
      select
        (select coalesce(sum(cost_usd), 0) from model_usage
          where created_at > now() - interval '1 hour')::float8 as last_hour,
        (select percentile_cont(0.5) within group (order by coalesce(spent.usd, 0))
          from hours left join spent using (hour))::float8 as usual_hour`;
    checks.push(
      spendRateCheck(
        Number(rate?.last_hour ?? 0),
        Number(rate?.usual_hour ?? 0),
        spend.hourlyMultiple,
        spend.minUsd,
      ),
    );
  }
  if (spend.personPercent !== undefined) {
    const people = await sql`select principal_id, sum(cost_usd)::float8 as usd from model_usage
      where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
        and principal_id is not null
      group by principal_id order by usd desc`;
    const total = people.reduce((sum, row) => sum + Number(row.usd), 0);
    const [first] = people;
    checks.push(
      spendShareCheck(
        first ? { personId: String(first.principal_id), usd: Number(first.usd) } : null,
        total,
        people.length,
        spend.personPercent,
        spend.minUsd,
      ),
    );
  }
  return checks;
}

export type Alert = {
  kind: 'unhealthy' | 'recovered';
  subject: string;
  text: string;
  detail: HealthDetail;
};
export type AlertSender = (alert: Alert) => Promise<void>;

function alertText(kind: Alert['kind'], detail: HealthDetail): { subject: string; text: string } {
  const failing = detail.checks.filter((check) => !check.ok);
  if (kind === 'recovered')
    return {
      subject: 'Melete is healthy again',
      text: `Melete ${detail.version} is healthy again as of ${detail.time}.`,
    };
  return {
    subject: `Melete is unhealthy: ${failing.map((check) => check.name).join(', ')}`,
    text: [
      `Melete ${detail.version} is unhealthy as of ${detail.time}.`,
      ...failing.map((check) => `- ${check.name}: ${check.detail}`),
    ].join('\n'),
  };
}

/** A JSON POST with `text` (which chat webhooks show), `status` and the checks. */
export function webhookSender(
  url: string,
  transport: (request: Request) => Promise<Response> = (request) => fetch(request),
): AlertSender {
  return async (alert) => {
    const response = await transport(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: alert.text,
          status: alert.kind,
          service: 'melete',
          version: alert.detail.version,
          checks: alert.detail.checks,
          time: alert.detail.time,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      }),
    );
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`webhook answered ${response.status}`);
  };
}

export function emailSender(options: { smtpUrl: string; to: string; from: string }): AlertSender {
  return async (alert) => {
    const smtp = nodemailer.createTransport(options.smtpUrl, {
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    } as never);
    try {
      await smtp.sendMail({
        from: options.from,
        to: options.to,
        subject: alert.subject,
        text: alert.text,
      });
    } finally {
      smtp.close();
    }
  };
}

/** The senders the environment configures; empty when alerts are off. */
export function alertSendersFromEnv(env: Env): AlertSender[] {
  const senders: AlertSender[] = [];
  if (env.MELETE_ALERT_WEBHOOK_URL) senders.push(webhookSender(env.MELETE_ALERT_WEBHOOK_URL));
  if (env.MELETE_ALERT_EMAIL_TO && env.MELETE_ALERT_SMTP_URL)
    senders.push(
      emailSender({
        smtpUrl: env.MELETE_ALERT_SMTP_URL,
        to: env.MELETE_ALERT_EMAIL_TO,
        from: env.MELETE_ALERT_EMAIL_FROM ?? env.MELETE_ALERT_EMAIL_TO,
      }),
    );
  return senders;
}

export class HealthMonitor {
  private unhealthySince: number | null = null;
  private lastSent = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;

  constructor(
    private readonly options: {
      check: () => Promise<HealthDetail>;
      senders: AlertSender[];
      intervalMs: number;
      repeatMs: number;
      now?: () => number;
      onError?: (error: Error) => void;
      /** Whether this instance sends the alerts now, when several share the database. */
      leads?: () => Promise<boolean>;
    },
  ) {}

  /** One round of checks; returns the alert it sent, if any. */
  async tick(): Promise<Alert | null> {
    // One instance alerts for all of them.
    if (this.options.leads && !(await this.options.leads().catch(() => false))) return null;
    const now = this.options.now?.() ?? Date.now();
    let detail: HealthDetail;
    try {
      detail = await this.options.check();
    } catch (error) {
      detail = {
        status: 'unhealthy',
        version: 'unknown',
        checks: [
          {
            name: 'health_check',
            ok: false,
            detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
          },
        ],
        time: new Date(now).toISOString(),
      };
    }
    let kind: Alert['kind'] | null = null;
    if (detail.status === 'unhealthy') {
      if (this.unhealthySince === null || now - this.lastSent >= this.options.repeatMs)
        kind = 'unhealthy';
      this.unhealthySince ??= now;
    } else if (this.unhealthySince !== null) {
      kind = 'recovered';
      this.unhealthySince = null;
    }
    if (!kind) return null;
    const alert: Alert = { kind, ...alertText(kind, detail), detail };
    this.lastSent = now;
    for (const send of this.options.senders)
      await send(alert).catch((error: unknown) =>
        this.options.onError?.(error instanceof Error ? error : new Error('alert not sent')),
      );
    return alert;
  }

  start(): void {
    if (this.timer || !this.options.senders.length) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.tick().finally(() => {
        this.running = undefined;
      });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
