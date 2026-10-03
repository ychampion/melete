/**
 * The service's view of its own health, and the operator's alerts when it
 * goes bad.
 *
 * `healthDetail` checks the database, the runtime that runs attempts, the job
 * queue (work that is due but has not been picked up) and the recent error
 * rate (attempts that failed or were lost, and model calls providers
 * refused). `GET /health/detail` returns it to the operator.
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
};

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
  return {
    status: checks.every((check) => check.ok) ? 'ok' : 'unhealthy',
    version: probes.version,
    checks,
    time: new Date().toISOString(),
  };
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
    },
  ) {}

  /** One round of checks; returns the alert it sent, if any. */
  async tick(): Promise<Alert | null> {
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
