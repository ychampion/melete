import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AttemptWake } from '../jobs/queue.ts';
import { AttemptRunner } from '../jobs/runner.ts';
import type { JobService } from '../jobs/service.ts';
import { StubRuntimeAdapter } from '../runtime/stub.ts';
import type { OperatorConsole } from './console.ts';
import { BUSY_PATH, DRAIN_PATH, Drain, type DrainRunner, mountQuietUpdate } from './drain.ts';
import { mountOperatorConsole } from './routes.ts';

const TOKEN = 'operator-token-of-enough-length';

function fakeRunner(inFlight: { attempts: string[]; starting: string[] }) {
  const held: boolean[] = [];
  const runner: DrainRunner = {
    hold: async (on) => {
      held.push(on);
    },
    inFlight: () => inFlight,
  };
  return { runner, held };
}

describe('the drain', () => {
  test('is never drained while an action is dispatching, an attempt runs or one is starting', async () => {
    const inFlight = { attempts: [] as string[], starting: [] as string[] };
    let dispatching = ['act_1'];
    const { runner, held } = fakeRunner(inFlight);
    const drain = new Drain({ runner, dispatching: async () => dispatching });
    expect((await drain.status()).state).toBe('off');
    expect((await drain.start()).state).toBe('draining');
    expect(held).toEqual([true]);
    dispatching = [];
    inFlight.starting = ['job_1'];
    expect((await drain.status()).starting_jobs).toEqual(['job_1']);
    inFlight.starting = [];
    inFlight.attempts = ['att_1'];
    expect((await drain.status()).state).toBe('draining');
    inFlight.attempts = [];
    expect((await drain.status()).state).toBe('drained');
    expect((await drain.cancel()).state).toBe('off');
    expect(held).toEqual([true, false]);
  });

  test('sees an attempt claimed while the database was being asked', async () => {
    const inFlight = { attempts: [] as string[], starting: [] as string[] };
    const { runner } = fakeRunner(inFlight);
    const drain = new Drain({
      runner,
      dispatching: async () => {
        inFlight.attempts = ['att_late'];
        return [];
      },
    });
    await drain.start();
    const status = await drain.status();
    expect(status.state).toBe('draining');
    expect(status.running_attempts).toEqual(['att_late']);
  });

  test('past its limit is timed_out, with what still runs, and stops nothing', async () => {
    let now = new Date('2026-10-28T03:00:00Z');
    const { runner, held } = fakeRunner({ attempts: ['att_1'], starting: [] });
    const drain = new Drain({ runner, dispatching: async () => [], now: () => now });
    const started = await drain.start(5);
    expect(started.deadline).toBe('2026-10-28T03:05:00.000Z');
    now = new Date('2026-10-28T03:05:00Z');
    const status = await drain.status();
    expect(status.state).toBe('timed_out');
    expect(status.running_attempts).toEqual(['att_1']);
    expect(held).toEqual([true]);
  });
});

describe('the runner under a drain', () => {
  /** A runner whose claims wait until the test settles them, each as nothing to run. */
  function claimingRunner() {
    const runner = new AttemptRunner({} as JobService, new StubRuntimeAdapter(), {
      key: 'drain-test-signing-key-32-bytes-long',
    });
    const claims: Array<() => void> = [];
    Object.assign(runner, {
      claim: () => new Promise<null>((resolve) => claims.push(() => resolve(null))),
    });
    return { runner, claims };
  }
  const wake: AttemptWake = {
    job_id: 'job_1',
    expected_epoch: 0,
    expected_version: 1,
    reason: 'input',
  };

  test('counts a job as starting until its last claim is done', async () => {
    const { runner, claims } = claimingRunner();
    // Two wakes for one job, such as a stale one and the current one, claim at once.
    const first = runner.handleWake(wake);
    const second = runner.handleWake({ ...wake, expected_version: 2, reason: 'recovery' });
    expect(claims).toHaveLength(2);
    expect(runner.inFlight().starting).toEqual(['job_1']);
    claims[0]?.();
    await first;
    // The second claim may still start an attempt, so the drain must not read as drained.
    expect(runner.inFlight().starting).toEqual(['job_1']);
    claims[1]?.();
    await second;
    expect(runner.inFlight()).toEqual({ attempts: [], starting: [] });
  });

  test('claims nothing while held, and claims again once let go', async () => {
    const { runner, claims } = claimingRunner();
    await runner.hold(true);
    await runner.handleWake(wake);
    expect(claims).toHaveLength(0);
    expect(runner.inFlight()).toEqual({ attempts: [], starting: [] });
    await runner.hold(false);
    const pending = runner.handleWake(wake);
    expect(claims).toHaveLength(1);
    claims[0]?.();
    await pending;
  });
});

describe('the drain and busy routes', () => {
  /** The operator console's routes too, behind a signed-in owner's session. */
  function app(token: string | undefined) {
    const routes = new Hono();
    routes.use('*', async (c, next) => {
      c.set('owner' as never, { id: 'p_owner', email: 'owner@example.test' } as never);
      c.set('sessionDigest' as never, 'digest' as never);
      await next();
    });
    mountOperatorConsole(routes, { isOwner: async () => true } as unknown as OperatorConsole);
    const { runner } = fakeRunner({ attempts: [], starting: [] });
    const drain = new Drain({ runner, dispatching: async () => [] });
    mountQuietUpdate(routes, {
      token,
      drain,
      busy: async () => ({
        running_attempts: { count: 0, ids: [] },
        actions_dispatching: { count: 0, ids: [] },
        live_processes: { count: 0, ids: [] },
        runs_mid_shift: { count: 0, ids: [] },
        last_activity_at: null,
        time_zone: 'UTC',
        drain: 'off',
        time: new Date().toISOString(),
      }),
    });
    return routes;
  }
  const calls = [
    ['GET', BUSY_PATH],
    ['GET', DRAIN_PATH],
    ['POST', DRAIN_PATH],
    ['DELETE', DRAIN_PATH],
  ] as const;

  test('refuse a caller without the operator token, even the owner signed in', async () => {
    const routes = app(TOKEN);
    for (const [method, path] of calls) {
      expect((await routes.request(path, { method })).status).toBe(401);
      const wrong = { method, headers: { authorization: 'Bearer not-the-operator-token' } };
      expect((await routes.request(path, wrong)).status).toBe(401);
    }
  });

  test('answer 404 where no operator token is set', async () => {
    const routes = app(undefined);
    for (const [method, path] of calls)
      expect(
        (await routes.request(path, { method, headers: { authorization: `Bearer ${TOKEN}` } }))
          .status,
      ).toBe(404);
  });

  test('drain, report and cancel for the operator', async () => {
    const routes = app(TOKEN);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const busy = await routes.request(BUSY_PATH, { headers: auth });
    expect(busy.status).toBe(200);
    expect(busy.headers.get('cache-control')).toBe('no-store');
    const started = await routes.request(DRAIN_PATH, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ limit_minutes: 30 }),
    });
    expect(started.status).toBe(200);
    expect(((await started.json()) as { state: string }).state).toBe('drained');
    // No body is the default limit.
    expect((await routes.request(DRAIN_PATH, { method: 'POST', headers: auth })).status).toBe(200);
    const cancelled = await routes.request(DRAIN_PATH, { method: 'DELETE', headers: auth });
    expect(((await cancelled.json()) as { state: string }).state).toBe('off');
  });
});
