/**
 * Waiting for a quiet moment to update, through the service's busy report and
 * its drain (apps/melete/src/operator/drain.ts):
 *
 *   1. with --at HH:MM, wait until that time in the owner's time zone;
 *   2. ask the busy report until no attempt runs, no action is on its way, no
 *      long run is mid-shift, and nobody has been active for a few minutes;
 *   3. ask for a drain, so nothing new starts, and wait until it says drained.
 *
 * Past --max-wait (counted from --at) it cancels the drain it asked for and
 * says what was still running. It never stops any work itself. Background
 * processes in the agents' computers are reported but do not hold an update
 * back: they run in the computer, which a service restart leaves running.
 *
 * `melete deploy --when-quiet` runs this before it changes anything, and
 * `melete quiet` runs it alone for deploy/scripts/update.sh.
 */
import { webPort } from '../../../deploy/scripts/status.ts';
import type { Context } from './context.ts';
import { readInstallation } from './installation.ts';
import { EXIT, type ExitCode } from './schema.ts';

/** How long nobody may have been active. Activity is recorded to within five minutes. */
export const IDLE_MINUTES = 10;
export const DEFAULT_MAX_WAIT_MINUTES = 120;
const POLL_MS = 30_000;
/** The longest single sleep while waiting for --at, so a clock change is noticed. */
const AT_STEP_MS = 15 * 60_000;

export const QUIET_USAGE =
  'Usage: bun run melete quiet [--at HH:MM] [--max-wait <minutes>] | bun run melete quiet --cancel';

export class QuietRefusal extends Error {}

type Listed = { count: number; ids: string[] };

/** `GET /health/busy` (busyReportResponse in packages/contracts), the parts read here. */
export type BusyReportResponse = {
  running_attempts: Listed;
  actions_dispatching: Listed;
  live_processes: Listed;
  runs_mid_shift: Listed;
  last_activity_at: string | null;
  time_zone: string;
};

/** `/operator/drain` (drainStatusResponse in packages/contracts), the parts read here. */
export type DrainStatusResponse = {
  state: 'off' | 'draining' | 'drained' | 'timed_out';
  running_attempts: string[];
  starting_jobs: string[];
  dispatching_actions: string[];
};

export type QuietOptions = {
  /** HH:MM in the owner's time zone, or null to start at once. */
  at: string | null;
  maxWaitMinutes: number;
  idleMinutes?: number;
  pollMs?: number;
};

/** The service's quiet-update routes. */
export type QuietApi = {
  busy(): Promise<BusyReportResponse>;
  drain(limitMinutes: number): Promise<DrainStatusResponse>;
  drainStatus(): Promise<DrainStatusResponse>;
  cancel(): Promise<void>;
};

export type QuietClock = { now(): Date; sleep(ms: number): Promise<void> };

export type QuietResult = { quiet: true } | { quiet: false; running: string };

/** Takes --at and --max-wait out of `args`, returning them and what is left. */
export function quietArguments(args: readonly string[]): {
  at: string | null;
  maxWaitMinutes: number | null;
  rest: string[];
} {
  let at: string | null = null;
  let maxWaitMinutes: number | null = null;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const next = args[index + 1];
    if (arg === '--at') {
      if (!next || !/^([01]\d|2[0-3]):[0-5]\d$/.test(next))
        throw new QuietRefusal('--at takes a time of day as HH:MM, such as 03:00.');
      at = next;
      index += 1;
    } else if (arg === '--max-wait') {
      if (!next || !/^[1-9]\d{0,4}$/.test(next))
        throw new QuietRefusal('--max-wait takes a number of minutes, 1 or more.');
      maxWaitMinutes = Number(next);
      index += 1;
    } else rest.push(arg);
  }
  return { at, maxWaitMinutes, rest };
}

/** Milliseconds from `now` until the wall clock in `zone` next reads `at`; 0 when it reads it now. */
export function untilTimeOfDay(now: Date, zone: string, at: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const [hour, minute] = at.split(':').map(Number);
  const day = 86_400_000;
  const current =
    (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 +
    now.getUTCMilliseconds();
  const target = ((hour ?? 0) * 3600 + (minute ?? 0) * 60) * 1000;
  return (((target - current) % day) + day) % day;
}

const named = (what: string, list: Listed) =>
  list.count > 0 ? [`${list.count} ${what} (${list.ids.join(', ')})`] : [];

/** What keeps the installation from being quiet, in words; empty when nothing does. */
export function stillBusy(busy: BusyReportResponse): string[] {
  return [
    ...named('running attempt(s)', busy.running_attempts),
    ...named('action(s) on their way to a service', busy.actions_dispatching),
    ...named('long run(s) mid-shift', busy.runs_mid_shift),
  ];
}

function stillDraining(status: DrainStatusResponse): string {
  return [
    ...(status.running_attempts.length
      ? [`running attempt(s) ${status.running_attempts.join(', ')}`]
      : []),
    ...(status.starting_jobs.length ? [`starting job(s) ${status.starting_jobs.join(', ')}`] : []),
    ...(status.dispatching_actions.length
      ? [`action(s) on their way ${status.dispatching_actions.join(', ')}`]
      : []),
  ].join('; ');
}

export async function waitForQuiet(
  api: QuietApi,
  clock: QuietClock,
  options: QuietOptions,
  say: (line: string) => void,
): Promise<QuietResult> {
  const pollMs = options.pollMs ?? POLL_MS;
  const idleMs = (options.idleMinutes ?? IDLE_MINUTES) * 60_000;
  if (options.at) {
    const zone = (await api.busy()).time_zone;
    let left = untilTimeOfDay(clock.now(), zone, options.at);
    if (left > 0) say(`Waiting until ${options.at} (${zone}).`);
    while (left > 0) {
      await clock.sleep(Math.min(left, AT_STEP_MS));
      const next = untilTimeOfDay(clock.now(), zone, options.at);
      // Wrapped round to tomorrow: the time has been reached, or skipped by a clock change.
      if (next === 0 || next > left) break;
      left = next;
    }
  }
  const deadline = clock.now().getTime() + options.maxWaitMinutes * 60_000;
  let busy: string[] = [];
  for (;;) {
    const report = await api.busy();
    busy = stillBusy(report);
    const last = report.last_activity_at ? Date.parse(report.last_activity_at) : null;
    const idle = last === null || clock.now().getTime() - last >= idleMs;
    if (busy.length === 0 && idle) break;
    if (clock.now().getTime() >= deadline)
      return {
        quiet: false,
        running: busy.length ? busy.join('; ') : `someone was active at ${report.last_activity_at}`,
      };
    say(busy.length ? `Still running: ${busy.join('; ')}.` : 'Someone was active recently.');
    await clock.sleep(pollMs);
  }
  const left = Math.max(
    1,
    Math.min(24 * 60, Math.ceil((deadline - clock.now().getTime()) / 60_000)),
  );
  say('Quiet now. Draining: nothing new starts until the update restarts the service.');
  try {
    let status = await api.drain(left);
    for (;;) {
      if (status.state === 'drained') return { quiet: true };
      if (status.state === 'timed_out' || clock.now().getTime() >= deadline) {
        // Nothing is stopped: the work goes on, and so does everything held.
        await api.cancel();
        return { quiet: false, running: stillDraining(status) || 'work that started meanwhile' };
      }
      await clock.sleep(Math.min(pollMs, 5_000));
      status = await api.drainStatus();
    }
  } catch (error) {
    // A drain left on would hold new work until a restart nobody is about to make.
    await api.cancel().catch(() => {});
    throw error;
  }
}

/** The routes through the web server on this machine, with the operator's token from deploy/.env. */
export function serviceQuietApi(context: Context): QuietApi {
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const env = installation.env ?? {};
  const token = env.MELETE_OPERATOR_TOKEN?.trim() ?? '';
  if (token.length < 24)
    throw new QuietRefusal(
      'Waiting for a quiet moment needs MELETE_OPERATOR_TOKEN in deploy/.env. Export a random value of 24 or more characters as MELETE_OPERATOR_TOKEN, run bun run melete set --from-env MELETE_OPERATOR_TOKEN, and recreate the service.',
    );
  const base = `http://127.0.0.1:${webPort(env)}/api`;
  const call = async (method: string, path: string, body?: object) => {
    let response: Response;
    try {
      response = await context.fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new QuietRefusal(
        `${method} ${base}${path} did not answer (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    if (!response.ok)
      throw new QuietRefusal(
        `${method} ${base}${path} answered ${response.status}${response.status === 404 ? ': the service has no MELETE_OPERATOR_TOKEN, or is older than this command' : ''}.`,
      );
    return response.json();
  };
  return {
    busy: async () => (await call('GET', '/health/busy')) as BusyReportResponse,
    drain: async (limitMinutes) =>
      (await call('POST', '/operator/drain', {
        limit_minutes: limitMinutes,
      })) as DrainStatusResponse,
    drainStatus: async () => (await call('GET', '/operator/drain')) as DrainStatusResponse,
    cancel: async () => {
      await call('DELETE', '/operator/drain');
    },
  };
}

/**
 * `melete quiet`: wait for a quiet moment and drain, then exit 0 and leave the
 * drain on for the update that follows; its restart ends it. `--cancel` ends a
 * drain by hand.
 */
export async function runQuiet(
  context: Context,
  args: readonly string[],
  api: (context: Context) => QuietApi = serviceQuietApi,
): Promise<ExitCode> {
  try {
    const parsed = quietArguments(args);
    const cancel = parsed.rest.length === 1 && parsed.rest[0] === '--cancel';
    if (parsed.rest.length > 0 && !(cancel && !parsed.at && parsed.maxWaitMinutes === null))
      throw new QuietRefusal(`quiet takes no ${parsed.rest.join(' ')}. ${QUIET_USAGE}`);
    const service = api(context);
    if (cancel) {
      await service.cancel();
      context.out('The drain is off; held work starts now.\n');
      return EXIT.ok;
    }
    context.interruptHint?.(
      'A drain may be on, holding new work: run bun run melete quiet --cancel to let it go.',
    );
    const result = await waitForQuiet(
      service,
      context,
      { at: parsed.at, maxWaitMinutes: parsed.maxWaitMinutes ?? DEFAULT_MAX_WAIT_MINUTES },
      (line) => context.out(`${line}\n`),
    );
    context.interruptHint?.(null);
    if (!result.quiet) {
      context.err(
        `No quiet moment within the wait; the drain is off and nothing was stopped. Still running: ${result.running}.\n`,
      );
      return EXIT.failed;
    }
    context.out('Drained. Nothing runs now, and new work waits for the restart.\n');
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof QuietRefusal)) throw error;
    context.err(`${error.message}\n`);
    return EXIT.refused;
  }
}
