/**
 * Updating an installation when it is quiet: the drain and the busy report.
 *
 * A drain stops this instance claiming new attempts. Messages still arrive and
 * queue, and timers, waits and watches keep their due work: each such job keeps
 * its wake, which the recovery scan sends again until an instance that is not
 * draining claims it (`AttemptRunner.hold`). Attempts already running may
 * finish, within the drain's limit. The drain says `drained` only when nothing
 * runs here, nothing is being claimed and no action is on its way to a
 * service; past its limit it says `timed_out` with what still runs, stops
 * nothing, and leaves the decision to the caller. It lives in this instance's
 * memory, so a restart ends it.
 *
 * The busy report counts what an update would interrupt across the
 * installation, and when anyone was last active, so `melete deploy
 * --when-quiet` can choose its moment.
 *
 * Both answer the operator's token (`MELETE_OPERATOR_TOKEN`), as
 * `/health/detail` does: they are for a program on the host, not a browser.
 */
import {
  type BusyReportResponse,
  busyReportResponse,
  type DrainState,
  type DrainStatusResponse,
  drainRequest,
  drainStatusResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { operatorAuthorized } from '../api/usage.ts';

export const DRAIN_PATH = '/operator/drain';
export const BUSY_PATH = '/health/busy';
export const DEFAULT_DRAIN_MINUTES = 10;
/** The most ids each part of the busy report lists; its count is the whole. */
const LISTED = 50;

/** The routes here, which carry no session: each checks the operator's token itself. */
export function quietUpdatePath(method: string, path: string): boolean {
  return (
    (path === DRAIN_PATH && ['GET', 'POST', 'DELETE'].includes(method)) ||
    (path === BUSY_PATH && method === 'GET')
  );
}

/** What the drain holds and reads: the attempt runner, where this process has one. */
export type DrainRunner = {
  hold(on: boolean): Promise<void>;
  inFlight(): { attempts: string[]; starting: string[] };
};

export type DrainDeps = {
  runner?: DrainRunner;
  /** Actions sent to their service that have not come back, across the installation. */
  dispatching: () => Promise<string[]>;
  now?: () => Date;
};

export class Drain {
  private current: { startedAt: Date; deadline: Date } | null = null;

  constructor(private readonly deps: DrainDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** Starts a drain, or gives the one under way a new limit from now. */
  async start(limitMinutes = DEFAULT_DRAIN_MINUTES): Promise<DrainStatusResponse> {
    const now = this.now();
    this.current = {
      startedAt: this.current?.startedAt ?? now,
      deadline: new Date(now.getTime() + limitMinutes * 60_000),
    };
    await this.deps.runner?.hold(true);
    return this.status();
  }

  async cancel(): Promise<DrainStatusResponse> {
    this.current = null;
    await this.deps.runner?.hold(false);
    return this.status();
  }

  async status(): Promise<DrainStatusResponse> {
    const current = this.current;
    const empty = { attempts: [], starting: [] };
    if (!current)
      return drainStatusResponse.parse({
        state: 'off',
        started_at: null,
        deadline: null,
        running_attempts: [],
        starting_jobs: [],
        dispatching_actions: [],
      });
    const { attempts, starting } = this.deps.runner?.inFlight() ?? empty;
    const dispatching = await this.deps.dispatching();
    // Read after the database answers, so an attempt claimed meanwhile is seen.
    const after = this.deps.runner?.inFlight() ?? empty;
    const running = [...new Set([...attempts, ...after.attempts])];
    const claiming = [...new Set([...starting, ...after.starting])];
    const busy = running.length > 0 || claiming.length > 0 || dispatching.length > 0;
    const state: DrainState = !busy
      ? 'drained'
      : this.now().getTime() >= current.deadline.getTime()
        ? 'timed_out'
        : 'draining';
    return drainStatusResponse.parse({
      state,
      started_at: current.startedAt.toISOString(),
      deadline: current.deadline.toISOString(),
      running_attempts: running,
      starting_jobs: claiming,
      dispatching_actions: dispatching,
    });
  }
}

/** Actions sent to their service that have not come back. */
export async function dispatchingActions(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from action where status = 'dispatched'`;
  return rows.map((row) => row.id);
}

type Listed = { count: number; ids: string[] };

const listed = (rows: readonly { id: string }[]): Listed => ({
  count: rows.length,
  ids: rows.slice(0, LISTED).map((row) => row.id),
});

/** What an update would interrupt now, across the installation, and when anyone was last active. */
export async function busyReport(sql: Sql, drain: DrainState): Promise<BusyReportResponse> {
  // An attempt whose lease ran out has nobody running it; recovery settles it.
  const attempts = await sql<{ id: string }[]>`select id from attempt
    where ended_at is null and (lease_expires_at is null or lease_expires_at > now())
    order by started_at, id`;
  const actions = await sql<{ id: string }[]>`select id from action
    where status = 'dispatched' order by dispatched_at, id`;
  const processes = await sql<{ id: string }[]>`select id from sandbox_process
    where state in ('starting', 'running') order by created_at, id`;
  const runs = await sql<{ id: string }[]>`select r.job_id as id from run_state r
    where r.finished_at is null and exists (select 1 from attempt t
      where t.job_id = r.job_id and t.ended_at is null
        and (t.lease_expires_at is null or t.lease_expires_at > now()))
    order by r.created_at, r.job_id`;
  const [seen] = await sql<{ at: Date | null }[]>`select max(last_seen_at) as at from principal
    where kind = 'person' and disabled_at is null`;
  // The owner's own time zone, from their personal space's profile.
  const [zone] = await sql<{ time_zone: string }[]>`select p.time_zone from experience_profile p
    join space s on s.id = p.space_id
    join owner o on o.id = s.owner_principal_id
    where s.kind = 'personal' and s.removed_at is null
    order by s.created_at limit 1`;
  return busyReportResponse.parse({
    running_attempts: listed(attempts),
    actions_dispatching: listed(actions),
    live_processes: listed(processes),
    runs_mid_shift: listed(runs),
    last_activity_at: seen?.at ? new Date(seen.at).toISOString() : null,
    time_zone: zone?.time_zone ?? 'UTC',
    drain,
    time: new Date().toISOString(),
  });
}

export function mountQuietUpdate(
  app: Hono,
  deps: { token: string | undefined; drain: Drain; busy: () => Promise<BusyReportResponse> },
): void {
  const refused = (c: Context) => {
    if (!deps.token)
      return c.json(
        {
          error: {
            code: 'not_found',
            message: 'Set MELETE_OPERATOR_TOKEN to drain this instance or read what is running.',
          },
        },
        404,
      );
    if (!operatorAuthorized(c.req.header('authorization'), deps.token))
      return c.json(
        { error: { code: 'unauthorized', message: 'The operator token is required.' } },
        401,
      );
    c.header('cache-control', 'no-store');
    return null;
  };
  app.get(BUSY_PATH, async (c) => refused(c) ?? c.json(await deps.busy()));
  app.get(DRAIN_PATH, async (c) => refused(c) ?? c.json(await deps.drain.status()));
  app.post(DRAIN_PATH, async (c) => {
    const refusal = refused(c);
    if (refusal) return refusal;
    const text = await c.req.text();
    const input = drainRequest.parse(text.trim() ? JSON.parse(text) : {});
    return c.json(await deps.drain.start(input.limit_minutes));
  });
  app.delete(DRAIN_PATH, async (c) => refused(c) ?? c.json(await deps.drain.cancel()));
}
