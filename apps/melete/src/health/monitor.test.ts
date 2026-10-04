import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mountHealthDetail } from '../api/usage.ts';
import { loadEnv } from '../env.ts';
import { failureCode } from '../memory/gateway.ts';
import {
  type Alert,
  alertSendersFromEnv,
  type HealthDetail,
  HealthMonitor,
  healthDetail,
  spendAlertsFromEnv,
  spendRateCheck,
  spendShareCheck,
  webhookSender,
} from './monitor.ts';

const healthy: HealthDetail = {
  status: 'ok',
  version: 'test',
  checks: [{ name: 'database', ok: true, detail: 'ok' }],
  time: '2026-10-03T12:00:00.000Z',
};
const unhealthy: HealthDetail = {
  status: 'unhealthy',
  version: 'test',
  checks: [
    { name: 'database', ok: false, detail: 'unreachable' },
    { name: 'runtime', ok: true, detail: 'ok' },
  ],
  time: '2026-10-03T12:01:00.000Z',
};

/** A monitor fed a script of results, on a clock the test moves. */
function scripted(results: HealthDetail[]) {
  const sent: Alert[] = [];
  let clock = 0;
  const monitor = new HealthMonitor({
    check: async () => {
      const next = results.shift();
      if (!next) throw new Error('script ran out');
      return next;
    },
    senders: [async (alert) => void sent.push(alert)],
    intervalMs: 60_000,
    repeatMs: 3_600_000,
    now: () => clock,
  });
  return {
    sent,
    tick: (at: number) => {
      clock = at;
      return monitor.tick();
    },
  };
}

describe('operator alerts', () => {
  test('a healthy service sends nothing', async () => {
    const monitor = scripted([healthy, healthy, healthy]);
    for (const at of [0, 60_000, 120_000]) expect(await monitor.tick(at)).toBeNull();
    expect(monitor.sent).toEqual([]);
  });

  test('turning unhealthy alerts once, repeats after the interval, and says when it clears', async () => {
    const monitor = scripted([healthy, unhealthy, unhealthy, unhealthy, healthy, healthy]);
    await monitor.tick(0);
    await monitor.tick(60_000);
    await monitor.tick(120_000);
    await monitor.tick(3_700_000);
    await monitor.tick(3_760_000);
    await monitor.tick(3_820_000);
    expect(monitor.sent.map((alert) => alert.kind)).toEqual([
      'unhealthy',
      'unhealthy',
      'recovered',
    ]);
    expect(monitor.sent[0]?.subject).toBe('Melete is unhealthy: database');
    expect(monitor.sent[0]?.text).toContain('- database: unreachable');
    expect(monitor.sent[2]?.subject).toBe('Melete is healthy again');
  });

  test('an instance that does not hold the alert lease sends nothing', async () => {
    const sent: Alert[] = [];
    const monitor = new HealthMonitor({
      check: async () => unhealthy,
      senders: [async (alert) => void sent.push(alert)],
      intervalMs: 60_000,
      repeatMs: 3_600_000,
      leads: async () => false,
    });
    expect(await monitor.tick()).toBeNull();
    expect(sent).toEqual([]);
  });

  test('a spending limit reached in the memory gateway waits for the reset', () => {
    expect(
      failureCode(402, '{"error":{"code":"spending_limit_reached","message":"x"}}', null),
    ).toBe('spending_limit_reached');
  });

  test('a health check that throws is itself an alert', async () => {
    const monitor = scripted([]);
    const alert = await monitor.tick(0);
    expect(alert?.kind).toBe('unhealthy');
    expect(alert?.detail.checks[0]?.name).toBe('health_check');
  });

  test('the webhook receives JSON with the text chat tools show and every check', async () => {
    const received: Request[] = [];
    const send = webhookSender('https://hooks.example.net/melete', async (request) => {
      received.push(request);
      return new Response('ok');
    });
    await send({ kind: 'unhealthy', subject: 's', text: 'Melete is unhealthy', detail: unhealthy });
    expect(received[0]?.method).toBe('POST');
    expect(await received[0]?.json()).toEqual({
      text: 'Melete is unhealthy',
      status: 'unhealthy',
      service: 'melete',
      version: 'test',
      checks: unhealthy.checks,
      time: unhealthy.time,
    });
    const failing = webhookSender(
      'https://hooks.example.net/melete',
      async () => new Response('', { status: 500 }),
    );
    await expect(
      failing({ kind: 'unhealthy', subject: 's', text: 't', detail: unhealthy }),
    ).rejects.toThrow('webhook answered 500');
  });

  test('alerts are off until a webhook or an email address is configured', () => {
    expect(alertSendersFromEnv(loadEnv({}))).toHaveLength(0);
    expect(
      alertSendersFromEnv(loadEnv({ MELETE_ALERT_WEBHOOK_URL: 'https://hooks.example.net/x' })),
    ).toHaveLength(1);
    expect(() => loadEnv({ MELETE_ALERT_EMAIL_TO: 'ops@example.net' })).toThrow(
      'MELETE_ALERT_SMTP_URL',
    );
  });

  test('spending alerts are off until the operator sets one', () => {
    expect(spendAlertsFromEnv(loadEnv({}))).toBeUndefined();
    expect(spendAlertsFromEnv(loadEnv({ MELETE_ALERT_SPEND_HOURLY_MULTIPLE: '5' }))).toEqual({
      hourlyMultiple: 5,
      minUsd: 1,
    });
    expect(
      spendAlertsFromEnv(
        loadEnv({ MELETE_ALERT_SPEND_PERSON_PERCENT: '60', MELETE_ALERT_SPEND_MIN_USD: '2.5' }),
      ),
    ).toEqual({ personPercent: 60, minUsd: 2.5 });
  });

  test('an hour far above the usual one alerts, but not below the floor', () => {
    expect(spendRateCheck(6, 1, 5, 1)).toMatchObject({ name: 'spend_rate', ok: false });
    expect(spendRateCheck(4, 1, 5, 1).ok).toBe(true);
    // Below the floor, even a quiet installation's first spending is not an alert.
    expect(spendRateCheck(0.5, 0, 5, 1).ok).toBe(true);
    expect(spendRateCheck(1.5, 0, 5, 1).detail).toBe(
      '$1.50 on model calls in the last hour; the usual hour is $0.00, and the alert is set at 5 times that',
    );
  });

  test("one person's share of the day alerts only beside other people, and above the floor", () => {
    const top = { personId: 'own_a', usd: 9 };
    expect(spendShareCheck(top, 10, 3, 60, 1)).toMatchObject({ name: 'spend_share', ok: false });
    expect(spendShareCheck(top, 10, 3, 95, 1).ok).toBe(true);
    // The only person spending is all of it, which says nothing.
    expect(spendShareCheck(top, 9, 1, 60, 1).ok).toBe(true);
    expect(spendShareCheck({ personId: 'own_a', usd: 0.9 }, 1, 2, 60, 1).ok).toBe(true);
    expect(spendShareCheck(null, 0, 0, 60, 1)).toEqual({
      name: 'spend_share',
      ok: true,
      detail: 'no model spending today',
    });
  });

  test('spending that cannot be read is reported as such, and the job queue as itself', async () => {
    const sql = ((strings: TemplateStringsArray) =>
      strings.join('').includes('percentile_cont')
        ? Promise.reject(new Error('spending read failed'))
        : Promise.resolve([{ stuck: 0, ended: 0, failed: 0, total: 0 }])) as never;
    const detail = await healthDetail({
      version: 'test',
      database: async () => 'ok',
      sql,
      spend: { hourlyMultiple: 5, minUsd: 1 },
    });
    const checks = Object.fromEntries(detail.checks.map((check) => [check.name, check.ok]));
    expect(checks).toEqual({ database: true, job_queue: true, error_rate: true, spend: false });
    expect(detail.checks.at(-1)?.detail).toBe('spending could not be read (spending read failed)');
  });

  test('the detail checks the runtime with a time limit', async () => {
    const detail = await healthDetail(
      { version: 'test', database: async () => 'ok', runtime: () => new Promise(() => {}) },
      {
        runtime_timeout_ms: 50,
        queue_stuck_minutes: 10,
        error_window_minutes: 15,
        error_min_samples: 5,
        error_rate: 0.5,
      },
    );
    expect(detail.status).toBe('unhealthy');
    expect(detail.checks[1]).toMatchObject({ name: 'runtime', ok: false });
  });
});

describe('GET /health/detail', () => {
  const token = 'operator-token-0123456789abcdef';
  const app = (detail: HealthDetail, configured: string | null = token) => {
    const routes = new Hono();
    mountHealthDetail(routes, { token: configured ?? undefined, detail: async () => detail });
    return routes;
  };

  test('takes the operator token, and answers 503 while a check fails', async () => {
    const auth = { authorization: `Bearer ${token}` };
    expect((await app(healthy).request('/health/detail', { headers: auth })).status).toBe(200);
    const failing = await app(unhealthy).request('/health/detail', { headers: auth });
    expect(failing.status).toBe(503);
    expect(((await failing.json()) as HealthDetail).checks[0]?.ok).toBe(false);
    expect(
      (await app(healthy).request('/health/detail', { headers: { authorization: 'Bearer wrong' } }))
        .status,
    ).toBe(401);
    expect((await app(healthy, null).request('/health/detail')).status).toBe(404);
  });
});
