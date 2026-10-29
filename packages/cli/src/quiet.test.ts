import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deployOptions, runDeploy } from './commands/deploy.ts';
import {
  type BusyReportResponse,
  type DrainStatusResponse,
  runQuiet,
  untilTimeOfDay,
  waitForQuiet,
} from './quiet.ts';
import { temporaryDeployDir } from './testing.ts';
import { deployRig } from './testing-engine.ts';

const TOKEN = 'operator-token-of-enough-length';
const none = { count: 0, ids: [] };

/** A clock that moves only when the code under test sleeps. */
function fakeClock(start: string) {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

type Call = { at: string; method: string; path: string; body?: unknown };

/**
 * The service's routes behind the web server, as a fetch: busy while `runningUntil`
 * says so, and a drain that settles after `drainPolls` reads, or never.
 */
function fakeService(
  clock: { now: () => Date },
  options: {
    runningUntil?: string;
    lastActivity?: string | null;
    drainPolls?: number;
    zone?: string;
  } = {},
) {
  const calls: Call[] = [];
  let drainReads = 0;
  let draining = false;
  const drain = (state: DrainStatusResponse['state']): DrainStatusResponse => ({
    state,
    running_attempts: state === 'drained' || state === 'off' ? [] : ['att_late'],
    starting_jobs: [],
    dispatching_actions: [],
  });
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+\/api/, '');
    calls.push({
      at: clock.now().toISOString(),
      method,
      path,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (path === '/health') return Response.json({ status: 'ok', database: 'ok' });
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`)
      return new Response(null, { status: 401 });
    if (path === '/health/busy') {
      const running =
        options.runningUntil !== undefined &&
        clock.now().getTime() < Date.parse(options.runningUntil);
      const report: BusyReportResponse = {
        running_attempts: running ? { count: 1, ids: ['att_1'] } : none,
        actions_dispatching: none,
        live_processes: { count: 1, ids: ['prc_dev_server'] },
        runs_mid_shift: none,
        last_activity_at: options.lastActivity ?? null,
        time_zone: options.zone ?? 'UTC',
      };
      return Response.json(report);
    }
    if (path === '/operator/drain') {
      if (method === 'DELETE') {
        draining = false;
        return Response.json(drain('off'));
      }
      if (method === 'POST') draining = true;
      if (!draining) return Response.json(drain('off'));
      drainReads += 1;
      const settled = options.drainPolls !== undefined && drainReads > options.drainPolls;
      return Response.json(drain(settled ? 'drained' : 'draining'));
    }
    return new Response(null, { status: 404 });
  };
  return { calls, fetch };
}

describe('the time of day', () => {
  test('is read in the given time zone', () => {
    // 10:00 UTC is 03:00 in Los Angeles in October.
    const now = new Date('2026-10-02T09:30:00Z');
    expect(untilTimeOfDay(now, 'America/Los_Angeles', '03:00')).toBe(30 * 60_000);
    expect(untilTimeOfDay(now, 'UTC', '09:30')).toBe(0);
    expect(untilTimeOfDay(now, 'UTC', '09:29')).toBe(86_400_000 - 60_000);
  });
});

describe('melete deploy --when-quiet', () => {
  test('waits for --at, pulls, then waits for quiet and drains before the switch', async () => {
    const deployDir = temporaryDeployDir();
    try {
      const rig = deployRig(deployDir, {}, {}, { MELETE_OPERATOR_TOKEN: TOKEN });
      const clock = fakeClock('2026-10-02T01:00:00Z');
      const service = fakeService(clock, {
        runningUntil: '2026-10-02T03:20:00Z',
        lastActivity: '2026-10-02T02:58:00Z',
        drainPolls: 2,
      });
      rig.context.now = clock.now;
      rig.context.sleep = clock.sleep;
      rig.context.fetch = service.fetch;
      // For each pull and each start: when it ran, and how many drains had been asked for.
      const pulls: { at: string; drains: number }[] = [];
      const starts: number[] = [];
      const run = rig.context.run;
      const drains = () => service.calls.filter((call) => call.method === 'POST').length;
      rig.context.run = (command, timeoutMs) => {
        const line = command.join(' ');
        if (line.startsWith('docker pull'))
          pulls.push({ at: clock.now().toISOString(), drains: drains() });
        if (/ (up|restart) /.test(line)) starts.push(drains());
        return run(command, timeoutMs);
      };
      const code = await runDeploy(
        rig.context,
        ['--checkout', '--when-quiet', '--at', '03:00', '--max-wait', '90'],
        false,
        rig.dependencies,
      );
      expect(rig.context.errors()).toBe('');
      expect(code).toBe(0);
      const quiet = service.calls.filter((call) => call.path !== '/health');
      // Nothing is asked of the busy report between the first look and 03:00.
      expect(quiet[0]).toMatchObject({ at: '2026-10-02T01:00:00.000Z', path: '/health/busy' });
      expect(quiet[1]?.at).toBe('2026-10-02T03:00:00.000Z');
      // Busy until 03:20; the drain is asked for once, with what is left of the 90 minutes.
      const post = quiet.find((call) => call.method === 'POST');
      expect(post?.at).toBe('2026-10-02T03:20:00.000Z');
      expect(post?.body).toEqual({ limit_minutes: 70 });
      expect(quiet.filter((call) => call.method === 'POST')).toHaveLength(1);
      // Every pull came at 03:00, before the wait for quiet and the drain, so
      // nothing new was held while they ran; every start and restart after it.
      expect(pulls).toHaveLength(3);
      for (const pull of pulls) expect(pull).toEqual({ at: '2026-10-02T03:00:00.000Z', drains: 0 });
      expect(starts.length).toBeGreaterThan(0);
      expect(starts.every((count) => count === 1)).toBe(true);
      // The drain was cancelled at the end.
      expect(quiet.at(-1)?.method).toBe('DELETE');
      expect(rig.state.restarts).toBe(1);
      expect(rig.context.printed()).toMatch(/ok\s+deploy\.quiet\s+Drained/);
      // A live process in an agent's computer survives the restart, so it does not hold the update.
      expect(rig.context.printed()).not.toContain('prc_dev_server');
    } finally {
      rmSync(join(deployDir, '..'), { recursive: true, force: true });
    }
  });

  test('on timeout cancels the drain and exits 1, with nothing running stopped or changed', async () => {
    const deployDir = temporaryDeployDir();
    try {
      const rig = deployRig(deployDir, {}, {}, { MELETE_OPERATOR_TOKEN: TOKEN });
      const clock = fakeClock('2026-10-02T03:00:00Z');
      // Quiet at once, but an attempt that started meanwhile never finishes.
      const service = fakeService(clock, {});
      rig.context.now = clock.now;
      rig.context.sleep = clock.sleep;
      rig.context.fetch = service.fetch;
      const code = await runDeploy(
        rig.context,
        ['--checkout', '--when-quiet', '--max-wait', '30'],
        false,
        rig.dependencies,
      );
      expect(code).toBe(1);
      const methods = service.calls.map((call) => call.method);
      expect(methods.filter((method) => method === 'POST')).toHaveLength(1);
      expect(methods.at(-1)).toBe('DELETE');
      expect(rig.context.printed()).toMatch(/fail\s+deploy\.quiet\s+No quiet moment.*att_late/);
      // The images were pulled before the wait, and are kept for the next run.
      expect(rig.state.pulls).toHaveLength(3);
      expect(rig.context.printed()).toContain('The pulled images wait, unused');
      // No container, process or attempt was stopped, removed or recreated, and
      // the installation still names the images it runs.
      expect(readFileSync(join(deployDir, '.env'), 'utf8')).toBe(rig.envBefore);
      expect(rig.state.ups).toBe(0);
      expect(rig.state.restarts).toBe(0);
      expect(rig.state.tagged).toEqual([]);
      expect(rig.state.removed).toEqual([]);
      expect(
        rig.state.calls.filter((call) => / (stop|kill|down|restart|rm|prune)( |$)/.test(call)),
      ).toEqual([]);
    } finally {
      rmSync(join(deployDir, '..'), { recursive: true, force: true });
    }
  });

  test('a service that cannot answer is found before the backup or any pull', async () => {
    const deployDir = temporaryDeployDir();
    try {
      const rig = deployRig(deployDir, {}, {}, { MELETE_OPERATOR_TOKEN: TOKEN });
      // A service from before the busy report answers its routes with 404.
      rig.context.fetch = async (url: string) =>
        url.endsWith('/api/health')
          ? Response.json({ status: 'ok', database: 'ok' })
          : new Response(null, { status: 404 });
      const code = await runDeploy(
        rig.context,
        ['--checkout', '--when-quiet'],
        false,
        rig.dependencies,
      );
      expect(code).toBe(1);
      expect(rig.context.printed()).toMatch(
        /fail\s+deploy\.quiet\s+GET \S+\/health\/busy answered 404.*Nothing was changed/,
      );
      expect(rig.state.pulls).toEqual([]);
      expect(rig.state.ups).toBe(0);
      expect(readFileSync(join(deployDir, '.env'), 'utf8')).toBe(rig.envBefore);
    } finally {
      rmSync(join(deployDir, '..'), { recursive: true, force: true });
    }
  });

  test('--at and --max-wait go with --when-quiet, and not with a dry run', () => {
    expect(() => deployOptions(['--at', '03:00'])).toThrow('go with --when-quiet');
    expect(() => deployOptions(['--when-quiet', '--dry-run'])).toThrow('nothing to wait for');
    expect(() => deployOptions(['--when-quiet', '--at', '3am'])).toThrow('HH:MM');
    expect(deployOptions(['--when-quiet', '--at', '03:00']).quiet).toEqual({
      at: '03:00',
      maxWaitMinutes: 120,
    });
  });
});

describe('waiting for quiet', () => {
  test('waits while someone was active in the last few minutes', async () => {
    const clock = fakeClock('2026-10-02T03:00:00Z');
    const service = fakeService(clock, { lastActivity: '2026-10-02T02:55:00Z', drainPolls: 0 });
    const api = {
      busy: async () =>
        (await (
          await service.fetch('http://127.0.0.1:3101/api/health/busy', {
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).json()) as BusyReportResponse,
      drain: async () => {
        service.calls.push({ at: clock.now().toISOString(), method: 'POST', path: 'drain' });
        return {
          state: 'drained',
          running_attempts: [],
          starting_jobs: [],
          dispatching_actions: [],
        } as DrainStatusResponse;
      },
      drainStatus: async () => {
        throw new Error('not read once drained');
      },
      cancel: async () => {},
    };
    const said: string[] = [];
    const result = await waitForQuiet(api, clock, { at: null, maxWaitMinutes: 60 }, (line) =>
      said.push(line),
    );
    expect(result).toEqual({ quiet: true });
    // Ten minutes after 02:55.
    expect(service.calls.find((call) => call.path === 'drain')?.at).toBe(
      '2026-10-02T03:05:00.000Z',
    );
    expect(said).toContain('Someone was active recently.');
  });

  test('melete quiet --time-only waits for --at, if given, and drains nothing', async () => {
    const deployDir = temporaryDeployDir();
    try {
      const rig = deployRig(deployDir, {}, {}, { MELETE_OPERATOR_TOKEN: TOKEN });
      const clock = fakeClock('2026-10-02T02:00:00Z');
      const service = fakeService(clock, { runningUntil: '2026-10-02T05:00:00Z' });
      rig.context.now = clock.now;
      rig.context.sleep = clock.sleep;
      rig.context.fetch = service.fetch;
      expect(await runQuiet(rig.context, ['--at', '03:00', '--time-only'])).toBe(0);
      expect(clock.now().toISOString()).toBe('2026-10-02T03:00:00.000Z');
      expect(service.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        'GET /health/busy',
      ]);
      // It takes no limit: the wait for quiet has its own.
      expect(await runQuiet(rig.context, ['--at', '03:00', '--time-only', '--max-wait', '5'])).toBe(
        2,
      );
      expect(service.calls).toHaveLength(1);
      // With no time, it only checks that the service answers.
      expect(await runQuiet(rig.context, ['--time-only'])).toBe(0);
      expect(clock.now().toISOString()).toBe('2026-10-02T03:00:00.000Z');
      expect(service.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        'GET /health/busy',
        'GET /health/busy',
      ]);
    } finally {
      rmSync(join(deployDir, '..'), { recursive: true, force: true });
    }
  });

  test('melete quiet refuses without the operator token, before asking anything', async () => {
    const deployDir = temporaryDeployDir();
    try {
      const rig = deployRig(deployDir);
      const service = fakeService(rig.context);
      rig.context.fetch = service.fetch;
      expect(await runQuiet(rig.context, [])).toBe(2);
      expect(rig.context.errors()).toContain('MELETE_OPERATOR_TOKEN');
      expect(service.calls).toEqual([]);
    } finally {
      rmSync(join(deployDir, '..'), { recursive: true, force: true });
    }
  });
});
