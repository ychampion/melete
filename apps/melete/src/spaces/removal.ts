/**
 * Removing a space.
 *
 * A plain `delete from space` cannot run: the memory tables hang off the space
 * without a cascade, and three constraints are `restrict`, which Postgres
 * checks immediately and does not satisfy from rows the same statement is
 * deleting. So removal is an ordered sweep, one phase at a time, each phase
 * idempotent and committed before the next begins.
 *
 * The fence runs inside the request, so the caller learns at once whether the
 * removal started; everything after it runs in the background and resumes from
 * the recorded phase if the process dies. A removal is reported finished only
 * after a verification pass re-counts every table, path and provider listing it
 * claimed to clear and finds nothing. A phase that could not be reached is not
 * a zero, and a removal carrying one reports itself blocked instead.
 */
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  EMPTY_COUNTS,
  type RemovalCounts,
  type RemovalPhase,
  removalCounts,
  removalIsClear,
  type SpaceRemoval,
  spaceRemoval as spaceRemovalContract,
} from '@melete/contracts';
import { and, eq, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Connector } from '../connectors/types.ts';
import type { Database } from '../db/client.ts';
import { connection, job, space, trigger } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { PolicyService } from '../jobs/policy.ts';
import type { JobService } from '../jobs/service.ts';
import type { RestrictionJournal } from '../memory/restore.ts';
import { spaceAuthority } from '../principals/authority.ts';
import {
  type BrowserSiteService,
  forgetBrowserProfilesForSpace,
} from '../workers/browser/sites.ts';
import { appendRemovalRecord } from './journal.ts';
import {
  clearJobWorkspaces,
  clearSpaceFiles,
  endSpaceAccess,
  type LeaseHold,
  sweepMemory,
  sweepOperational,
  sweepPrincipals,
} from './plan.ts';
import { type SpaceRemovalRow, spaceRemoval } from './schema.ts';
import { verifyRemoval, verifySpaceGone } from './verify.ts';

/**
 * A provider is reached for an adapter and the connection whose account holds
 * it: one space can hold sandboxes in more than one account, so an adapter
 * alone would reach into the wrong one. The provider type is the sandbox lane's
 * and is carried opaquely, because nothing here looks inside it.
 */
export type SandboxProviderFor = (adapter: string, connectionId: string) => unknown;

/**
 * The sandbox lane owns live workspaces and the snapshots a provider keeps for
 * them. This module never reaches into a provider itself; it asks for the two
 * things a removal needs, and believes the first only because of the second.
 */
export type SandboxTeardown = {
  /** Resolves the provider for an adapter in a given connection's account. */
  providerFor: SandboxProviderFor;
  /** Close every live session for the space and delete its provider-side snapshots. */
  destroyWorkspacesForSpace(
    spaceId: string,
    providerFor: SandboxProviderFor,
    signal: AbortSignal,
  ): Promise<{ closed: string[]; snapshotsDeleted: string[] }>;
  /**
   * What the provider still lists for the space. This is a different question
   * from what the call above reports it did, which is the whole reason it
   * exists: a removal is never finished on a provider's own account of itself.
   */
  listWorkspacesForSpace(
    spaceId: string,
    providerFor: SandboxProviderFor,
  ): Promise<{ sessions: string[]; snapshots: string[] }>;
};

/**
 * The service's browser sessions, which own the worker that holds a space's
 * Chromium profile open and the record of which sites it is signed in to.
 * `forgetBrowserProfilesForSpace` does all of it in the order it has to
 * happen: the worker exits, then the profile directory goes, then the site
 * rows. It leaves the space root itself alone, so the filesystem phase below
 * still owns it, which is why this runs first. Absent, there is no browser
 * worker and no profile, and any site rows go with the space's other rows.
 */
export type BrowserTeardown = { sites: BrowserSiteService };

/**
 * Engine session volumes kept past the attempt that made them, labelled by
 * job. The runtime already removes the home volume it makes for each attempt
 * when the attempt ends, and sweeps any it finds orphaned, so there are none
 * today and the phase records that. This is the shape a runtime that keeps a
 * home across attempts is wired into.
 *
 * Both calls take job ids and address volumes labelled by them. The
 * deployment's `runtime-home` volume is one volume shared by every space and
 * every job, so it is never what this clears: removing one space must not take
 * the engine's home out from under every other space on the installation.
 */
export type RuntimeHomeTeardown = {
  /** Remove the engine session volume each of these jobs kept. */
  removeHomesForJobs(
    jobIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ removed: string[] }>;
  /** What is still labelled for these jobs. The verification reads this. */
  listHomesForJobs(jobIds: readonly string[]): Promise<string[]>;
};

/**
 * Just enough of the connector registry to stop it answering for a space while
 * that space is being taken apart. `ConnectorRegistry` satisfies this as it is.
 */
export type ConnectorReleases = {
  get(connectionId: string): Connector | undefined;
  remove(connectionId: string, expected: Connector): Promise<void>;
};

export type RemovalDeps = {
  db: Database;
  sql: Sql;
  jobs: JobService;
  journal: RestrictionJournal;
  roots: { spacesRoot: string; workRoot: string };
  sandboxes?: SandboxTeardown;
  browser?: BrowserTeardown;
  runtimeHomes?: RuntimeHomeTeardown;
  /** Left out, nothing is serving connectors in this process and none is released. */
  connectors?: ConnectorReleases;
  /**
   * The space a running browser worker mounts as its own, which cannot be
   * taken out from under it. Set from the deployment's browser configuration.
   */
  browserSpace?: string;
  /** How long a claimed removal holds its lease before another run may take it. */
  leaseMs?: number;
  /**
   * Stop these jobs and wait until the runtime has let go of them, so the
   * workspaces they held can be removed. The service passes its attempt
   * runner's; left out, nothing in this process is running a job.
   */
  stopJobs?: (jobIds: readonly string[]) => Promise<void>;
  /** The first pause before a removal that could not finish is tried again; it doubles each time. */
  retryMs?: number;
  /** Named so tests can watch a phase boundary without timing it. */
  onPhase?: (removalId: string, phase: RemovalPhase) => void;
};

const LEASE_MS = 60_000;
const RETRY_MS = 5_000;

/** States in which a removal no longer holds its space, so it is not the live one. */
const LIVE_EXCLUDED = ['complete', 'cleaning'] as const;

/** The phases after the fence, in the order they run. */
const SWEEP: readonly RemovalPhase[] = [
  'sessions',
  'journal',
  'sandboxes',
  'browser',
  'runtime',
  'files',
  'operational',
  'principals',
  'memory',
  'verify',
  'space',
];

export function removalView(row: SpaceRemovalRow): SpaceRemoval {
  return spaceRemovalContract.parse({
    id: row.id,
    space_id: row.spaceId,
    space_name: row.spaceName,
    kind: row.kind,
    state: row.state,
    phase: row.phase,
    counts: removalCounts.parse(row.counts ?? {}),
    blocked_reason: row.blockedReason,
    started_at: row.startedAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
  });
}

/** The run that asked no longer holds the removal: another run has it now. */
class LeaseLost extends Error {
  constructor() {
    super('another run holds this removal now');
  }
}

export class SpaceRemovalService {
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private resuming?: Promise<unknown>;
  private readonly inFlight = new Map<string, Promise<SpaceRemovalRow>>();

  constructor(readonly deps: RemovalDeps) {
    this.leaseMs = deps.leaseMs ?? LEASE_MS;
    this.retryMs = deps.retryMs ?? RETRY_MS;
  }

  /**
   * Start the sweep without waiting for it. The request that asked for the
   * removal has its answer as soon as the fence commits; the rest takes as
   * long as it takes, and survives this process either way.
   */
  dispatch(removalId: string, signal?: AbortSignal): void {
    void this.run(removalId, signal).catch((error) => {
      process.stderr.write(`space removal failed: ${describe(error)}\n`);
    });
  }

  /** The sweep this process is running for a removal, if it is running one. */
  settled(removalId: string): Promise<SpaceRemovalRow | undefined> {
    const running = this.inFlight.get(removalId);
    return running ? running.catch(() => this.byId(removalId)) : this.byId(removalId);
  }

  /**
   * Let the sweeps this process is running finish before it goes away: the
   * ones a request started and the ones the timer picked up.
   */
  async drain(): Promise<void> {
    await this.resuming;
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /**
   * Phase 1. One transaction: stamp the space, invalidate every capability
   * issued under the old generation, cancel every job and disable every
   * trigger, mark memory revoked, and write the record the sweep works from.
   *
   * Nothing after this may create work in the space, which is what makes the
   * rest of the sweep terminate. A write that lands anyway is caught by the
   * verification pass, and the removal reports blocked rather than finished.
   */
  async fence(actor: string, spaceId: string, confirmName: string): Promise<SpaceRemovalRow> {
    const jobs = this.deps.jobs;
    const result = await jobs.transaction(async (tx) => {
      const [parent] = await tx.select().from(space).where(eq(space.id, spaceId)).for('update');
      // The same answer authority gives for a space the caller cannot see, so
      // this route tells nobody whether a space id exists.
      if (!parent) throw new ServiceError('scope_denied', 'Space is not accessible.', 403);

      // A second request joins the removal already running rather than starting
      // a rival sweep. The partial unique index backs this up in the database.
      // It is read before authority is checked, because phase 2 revokes the
      // memberships: the person who asked has to be able to ask again and get
      // the same answer, and the record of who asked is what says they may.
      const [live] = await tx
        .select()
        .from(spaceRemoval)
        .where(
          and(
            eq(spaceRemoval.spaceId, spaceId),
            notInArray(spaceRemoval.state, [...LIVE_EXCLUDED]),
          ),
        );
      if (live) {
        if (live.requestedBy !== actor)
          throw new ServiceError('scope_denied', 'Space administration requires its owner.', 403);
        return live;
      }

      // The route guard has already refused a member; this refuses one again,
      // so the service is not safe only by virtue of where it is mounted.
      const access = await spaceAuthority(tx, spaceId, actor, true);
      if (access.role !== 'owner')
        throw new ServiceError('scope_denied', 'Space administration requires its owner.', 403);

      // The browser worker mounts this space's directory and keeps its profile
      // there; removing it would take the directory out from under a running
      // browser, and the worker could not start again without it.
      if (this.deps.browserSpace === spaceId)
        throw new ServiceError(
          'space_in_use',
          'The browser worker uses this space. Point MELETE_BROWSER_SPACE at another space and restart the browser worker before removing it.',
          409,
        );

      if (confirmName !== parent.name)
        throw new ServiceError(
          'confirmation_mismatch',
          'That is not the name of this space. Type the name exactly as it is shown.',
          400,
        );

      const closed = await closeSpace(tx, jobs, spaceId);
      const [row] = await tx
        .insert(spaceRemoval)
        .values({
          id: newId('rem'),
          spaceId,
          spaceName: parent.name,
          gitPath: parent.gitPath,
          providers: closed.providers,
          // A space of one's own is recreated the moment its account asks for
          // one, so it is emptied in place rather than removed.
          kind: parent.kind === 'personal' ? 'emptied' : 'removed',
          requestedBy: actor,
          state: 'pending',
          // The fence is done by the time the row exists; a removal the
          // startup replay queues again is written at `fence`, and its run
          // closes the space the same way before anything else.
          phase: 'sessions',
          epoch: parent.removalEpoch + 1,
          jobIds: closed.jobIds,
          connectionIds: closed.connectionIds,
          counts: EMPTY_COUNTS,
        })
        .returning();
      if (!row) throw new Error('space removal insert returned no row');
      // Stamped last. The row has been held for update since the top, so
      // nothing could be admitted in between, and the work above still runs
      // under the authority that the stamp withdraws from everyone.
      await tx
        .update(space)
        .set({ removedAt: new Date(), removalEpoch: parent.removalEpoch + 1 })
        .where(eq(space.id, spaceId));
      return { row, cancelled: closed.cancelled };
    });
    if ('cancelled' in result) {
      // The fence is committed before a potentially slow runtime is signalled.
      for (const id of result.cancelled) jobs.onCancelled?.(id);
      return result.row;
    }
    return result;
  }

  /** The record for a space, whether it is running, blocked or finished. */
  async current(spaceId: string): Promise<SpaceRemovalRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(spaceRemoval)
      .where(eq(spaceRemoval.spaceId, spaceId))
      .orderBy(sql`${spaceRemoval.startedAt} desc`)
      .limit(1);
    return row;
  }

  async byId(removalId: string): Promise<SpaceRemovalRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(spaceRemoval)
      .where(eq(spaceRemoval.id, removalId));
    return row;
  }

  /**
   * Phases 2 to 11. Each phase is recorded before it starts and its result is
   * committed before the next one begins, so a crash resumes at a boundary and
   * repeats at most one phase.
   *
   * One run per removal in this process: asking while one runs is handed that
   * run. Across processes the lease decides, and it is renewed while a phase
   * takes its time rather than only between phases.
   */
  run(removalId: string, signal?: AbortSignal): Promise<SpaceRemovalRow> {
    const running = this.inFlight.get(removalId);
    if (running) return running;
    const started = this.sweep(removalId, signal).finally(() => this.inFlight.delete(removalId));
    this.inFlight.set(removalId, started);
    return started;
  }

  private async sweep(removalId: string, signal?: AbortSignal): Promise<SpaceRemovalRow> {
    // The run's own name for the lease, not the process's: two runs in one
    // process are as much rivals as two runs in two.
    const token = newId('rem');
    const claimed = await this.claim(removalId, token);
    if (!claimed) {
      const row = await this.byId(removalId);
      if (!row) throw new ServiceError('not_found', 'Removal not found.', 404);
      return row;
    }
    const lost = new AbortController();
    const beat = setInterval(
      () => {
        void this.renew(removalId, token).then(
          (held) => {
            if (!held) lost.abort();
          },
          () => undefined,
        );
      },
      Math.max(25, Math.floor(this.leaseMs / 3)),
    );
    try {
      if (claimed.state === 'cleaning') return await this.cleanUp(claimed, token);
      return await this.sweepHeld(claimed, token, lost.signal, signal);
    } catch (error) {
      // Another run has the removal now. This one stops where it is and writes
      // nothing more: whatever it would have written is that run's to write.
      if (error instanceof LeaseLost) return (await this.byId(removalId)) ?? claimed;
      throw error;
    } finally {
      clearInterval(beat);
    }
  }

  private async sweepHeld(
    claimed: SpaceRemovalRow,
    token: string,
    lost: AbortSignal,
    signal?: AbortSignal,
  ): Promise<SpaceRemovalRow> {
    let row = claimed;
    if (row.phase === 'fence') row = await this.closeRequeued(row, token);
    // A removal the verification stopped goes round the whole sweep again
    // rather than asking the same question twice: what it found may be a row
    // written after its phase ran, or a provider that could not answer then and
    // can now, and only the phase that owns it can clear it. Every phase is
    // safe to repeat.
    const from = row.phase === 'fence' || row.phase === 'verify' ? 'sessions' : row.phase;
    const started = SWEEP.indexOf(from);
    const remaining = SWEEP.slice(started < 0 ? 0 : started);
    let counts: RemovalCounts = removalCounts.parse(row.counts ?? {});
    const phaseSignal = signal ? AbortSignal.any([signal, lost]) : lost;
    for (const phase of remaining) {
      if (lost.aborted) throw new LeaseLost();
      if (signal?.aborted) return this.release(row.id, token);
      row = await this.enter(row.id, token, phase);
      this.deps.onPhase?.(row.id, phase);
      try {
        counts = await this.perform(row, token, phase, counts, phaseSignal);
      } catch (error) {
        if (error instanceof LeaseLost || lost.aborted) throw new LeaseLost();
        return this.block(row.id, token, phase, counts, describe(error));
      }
      if (phase === 'verify' && !removalIsClear(counts) && !this.onlyWorkspacesLeft(row, counts))
        return this.block(row.id, token, phase, counts, unclearReason(counts));
      await this.record(row.id, token, counts);
    }
    return this.finish(row.id, token, counts);
  }

  /**
   * A removal the startup replay queued again after a restore. The restored
   * database has its jobs, triggers and connections back, and its capabilities
   * were issued under the old generations, so the space is closed exactly as
   * the fence closes one before anything in it is taken apart.
   */
  private async closeRequeued(row: SpaceRemovalRow, token: string): Promise<SpaceRemovalRow> {
    const jobs = this.deps.jobs;
    const { closed, updated } = await jobs.transaction(async (tx) => {
      const held = await tx.execute(
        sql`select id from space_removal where id = ${row.id} and lease_owner = ${token} for update`,
      );
      if (!held.length) throw new LeaseLost();
      const closed = await closeSpace(tx, jobs, row.spaceId);
      const [updated] = await tx
        .update(spaceRemoval)
        .set({
          phase: 'sessions',
          jobIds: [...new Set([...row.jobIds, ...closed.jobIds])],
          connectionIds: closed.connectionIds,
          providers: closed.providers,
        })
        .where(this.held(row.id, token))
        .returning();
      if (!updated) throw new LeaseLost();
      return { closed, updated };
    });
    for (const id of closed.cancelled) jobs.onCancelled?.(id);
    return updated;
  }

  /** One phase. Every branch is safe to run twice. */
  private async perform(
    row: SpaceRemovalRow,
    token: string,
    phase: RemovalPhase,
    counts: RemovalCounts,
    signal?: AbortSignal,
  ): Promise<RemovalCounts> {
    const { sql: raw, roots } = this.deps;
    const emptied = row.kind === 'emptied';
    // Every destructive transaction starts by holding the removal for this
    // run; a run that has lost it deletes nothing more.
    const hold = this.holdFor(row.id, token);
    switch (phase) {
      case 'sessions':
        // Access to the space ends before anything in it is destroyed, and
        // nobody is signed out of their account to achieve it.
        await endSpaceAccess(raw, row.spaceId, emptied, hold);
        return counts;
      case 'journal':
        // Before any data goes, and retained apart from database snapshots, so
        // restoring a backup from before the removal does not undo it.
        await appendRemovalRecord(raw, this.deps.journal, row);
        return counts;
      case 'sandboxes':
        return this.tearDownSandboxes(row, counts, signal);
      case 'browser':
        return this.tearDownBrowser(row, counts);
      case 'runtime':
        return this.tearDownRuntimeHomes(row, counts, signal);
      case 'files':
        // Files cannot be held inside a transaction, so the lease is asked for
        // just before they go. The worker holding the profile has exited by
        // now: on Windows the directory cannot be removed while Chromium has
        // it open.
        await raw.begin(hold);
        // The fence cancelled every job, and a cancelled job's runtime can
        // still be tearing down with its workspace open, so it is stopped and
        // waited for first, and again before each retry.
        await this.deps.stopJobs?.(row.jobIds);
        await clearSpaceFiles(
          { spacesRoot: roots.spacesRoot, workRoot: roots.workRoot },
          row.spaceId,
          row.jobIds,
          emptied,
          async () => {
            await this.deps.stopJobs?.(row.jobIds);
            if (this.deps.browser)
              await forgetBrowserProfilesForSpace(this.deps.browser, row.spaceId);
          },
        );
        return counts;
      case 'operational':
        await sweepOperational(raw, row.spaceId, row.jobIds, hold);
        return counts;
      case 'principals':
        // The registry stops answering for these connections before their rows
        // go, so nothing is still serving a connector for a space that is
        // halfway gone. Recreating one is refused separately, by the removal
        // stamp the default-connection query reads.
        await this.releaseConnectors(row.connectionIds);
        await sweepPrincipals(raw, row.spaceId, hold);
        return counts;
      case 'memory':
        await sweepMemory(raw, row.spaceId, hold);
        return counts;
      case 'verify':
        return verifyRemoval(raw, {
          spaceId: row.spaceId,
          jobIds: row.jobIds,
          emptied,
          spacesRoot: roots.spacesRoot,
          workRoot: roots.workRoot,
          omitted: counts.omitted,
          // The provider re-listing is carried forward from its own phase
          // rather than repeated here; see tearDownSandboxes.
          providers: counts.providers,
          connectionIds: row.connectionIds,
          connectors: this.deps.connectors,
          cleared: counts.cleared,
        });
      case 'space':
        if (emptied) {
          // The row, its id and its membership stay; the space is present and
          // empty, and usable again from the next request. Reopening it is the
          // one write a run that has lost the lease must never make.
          await raw.begin(async (tx) => {
            await hold(tx);
            await tx`update space set removed_at = null where id = ${row.spaceId}`;
          });
          return counts;
        }
        await raw.begin(async (tx) => {
          await hold(tx);
          await tx`delete from space_membership where space_id = ${row.spaceId}`;
          await tx`delete from space where id = ${row.spaceId}`;
        });
        // Checked after the fact and folded into the same counts, so the one
        // rule that lets a removal finish covers the space row too.
        return {
          ...counts,
          tables: { ...counts.tables, ...(await verifySpaceGone(raw, row.spaceId)) },
        };
      default:
        return counts;
    }
  }

  private async tearDownSandboxes(
    row: SpaceRemovalRow,
    counts: RemovalCounts,
    signal?: AbortSignal,
  ): Promise<RemovalCounts> {
    const sandboxes = this.deps.sandboxes;
    if (!sandboxes) {
      // Nothing to reach means nothing to prove. Something to reach and no way
      // to reach it means this removal can never be reported as finished.
      const present = await tableExists(this.deps.sql, 'sandbox_session');
      const held = present ? await countRows(this.deps.sql, 'sandbox_session', row.spaceId) : 0;
      return omit(counts, 'sandboxes', held > 0 ? 'capability_absent' : 'not_applicable');
    }
    const aborts = new AbortController();
    signal?.addEventListener('abort', () => aborts.abort(), { once: true });
    const destroyed = await sandboxes.destroyWorkspacesForSpace(
      row.spaceId,
      sandboxes.providerFor,
      aborts.signal,
    );
    // Asked again, here rather than in the verification phase, because a
    // provider is reached through the connection whose account holds it and
    // phase 8 deletes those rows. This is still a second, independent question
    // — what is left, not what the call above says it did — and its answer is
    // carried forward into the counts that decide whether this can finish.
    const left = await sandboxes.listWorkspacesForSpace(row.spaceId, sandboxes.providerFor);
    const went = cleared(counts, {
      sandbox_sessions_closed: destroyed.closed.length,
      sandbox_snapshots_deleted: destroyed.snapshotsDeleted.length,
    });
    return {
      ...went,
      providers: {
        ...went.providers,
        sandbox_sessions: left.sessions.length,
        sandbox_snapshots: left.snapshots.length,
      },
    };
  }

  /**
   * Nothing makes an engine session volume yet, so today this phase proves
   * there is nothing to make and says so. When the work that makes them lands,
   * it wires `runtimeHomes` and this clears them by the job ids the fence
   * captured, in the one place in the order where that is safe.
   */
  private async tearDownRuntimeHomes(
    row: SpaceRemovalRow,
    counts: RemovalCounts,
    signal?: AbortSignal,
  ): Promise<RemovalCounts> {
    const homes = this.deps.runtimeHomes;
    if (!homes) return omit(counts, 'runtime', 'not_applicable');
    const removed = await homes.removeHomesForJobs(row.jobIds, signal);
    const left = await homes.listHomesForJobs(row.jobIds);
    const went = cleared(counts, { runtime_homes_removed: removed.removed.length });
    return { ...went, providers: { ...went.providers, runtime_homes: left.length } };
  }

  /** Whatever the registry is still holding for these connections, closed. */
  private async releaseConnectors(connectionIds: readonly string[]): Promise<void> {
    const registry = this.deps.connectors;
    if (!registry) return;
    for (const id of connectionIds) {
      const connector = registry.get(id);
      if (connector) await registry.remove(id, connector);
    }
  }

  private async tearDownBrowser(
    row: SpaceRemovalRow,
    counts: RemovalCounts,
  ): Promise<RemovalCounts> {
    // One call, which stops the worker, removes the profile directory and
    // deletes the site rows in that order. It is idempotent and silent for a
    // space that never browsed, and for a deployment with no browser worker,
    // and it leaves the space root for the filesystem phase below, which is
    // why it has to run before it.
    const forgotten = await forgetBrowserProfilesForSpace(this.deps.browser, row.spaceId);
    // What went, which is a different record from what is left: the site rows
    // being zero afterwards is proved by the verification walk, and this is
    // what the finished account says about the profile that went with them.
    return cleared(counts, { signed_in_sites: forgotten.rows });
  }

  /**
   * Take the removal, or leave it to whoever holds it. A lease that has expired
   * is free: the run that held it is gone, or stalled for longer than its
   * heartbeat, and its last phase was committed.
   */
  private async claim(removalId: string, token: string): Promise<SpaceRemovalRow | undefined> {
    const [row] = await this.deps.db
      .update(spaceRemoval)
      .set({
        // A removal left cleaning stays cleaning: its run only cleans.
        state: sql`case when ${spaceRemoval.state} = 'cleaning' then 'cleaning' else 'running' end`,
        leaseOwner: token,
        leaseExpiresAt: new Date(Date.now() + this.leaseMs),
        attempts: sql`${spaceRemoval.attempts} + 1`,
        blockedReason: null,
      })
      .where(
        and(
          eq(spaceRemoval.id, removalId),
          ne(spaceRemoval.state, 'complete'),
          // No run holds a removal with no owner; its time is only when the
          // timer next tries it, and asking directly does not wait for that.
          or(
            isNull(spaceRemoval.leaseOwner),
            isNull(spaceRemoval.leaseExpiresAt),
            sql`${spaceRemoval.leaseExpiresAt} < now()`,
          ),
        ),
      )
      .returning();
    return row;
  }

  /** The heartbeat. False once another run has the removal. */
  private async renew(removalId: string, token: string): Promise<boolean> {
    const [row] = await this.deps.db
      .update(spaceRemoval)
      .set({ leaseExpiresAt: new Date(Date.now() + this.leaseMs) })
      .where(this.held(removalId, token))
      .returning({ id: spaceRemoval.id });
    return row !== undefined;
  }

  private held(removalId: string, token: string) {
    return and(eq(spaceRemoval.id, removalId), eq(spaceRemoval.leaseOwner, token));
  }

  /** The removal row, held for this run for the rest of the caller's transaction. */
  private holdFor(removalId: string, token: string): LeaseHold {
    return async (tx) => {
      const [row] = await tx`select id from space_removal
        where id = ${removalId} and lease_owner = ${token} for update`;
      if (!row) throw new LeaseLost();
    };
  }

  /** Every write after the claim goes through here, and only while this run holds the lease. */
  private async write(
    removalId: string,
    token: string,
    values: Partial<typeof spaceRemoval.$inferInsert>,
  ): Promise<SpaceRemovalRow> {
    const [row] = await this.deps.db
      .update(spaceRemoval)
      .set(values)
      .where(this.held(removalId, token))
      .returning();
    if (!row) throw new LeaseLost();
    return row;
  }

  private enter(removalId: string, token: string, phase: RemovalPhase): Promise<SpaceRemovalRow> {
    return this.write(removalId, token, {
      phase,
      leaseExpiresAt: new Date(Date.now() + this.leaseMs),
    });
  }

  private async record(removalId: string, token: string, counts: RemovalCounts): Promise<void> {
    await this.write(removalId, token, {
      counts,
      leaseExpiresAt: new Date(Date.now() + this.leaseMs),
    });
  }

  private async block(
    removalId: string,
    token: string,
    phase: RemovalPhase,
    counts: RemovalCounts,
    reason: string,
  ): Promise<SpaceRemovalRow> {
    return this.write(removalId, token, {
      state: 'blocked',
      phase,
      counts,
      blockedReason: reason,
      leaseOwner: null,
      leaseExpiresAt: await this.retryAt(removalId),
    });
  }

  /**
   * When the timer next tries a removal that could not finish: soon after the
   * first try, and further apart each time, up to a few minutes.
   */
  private async retryAt(removalId: string): Promise<Date> {
    const [row] = await this.deps.db
      .select({ attempts: spaceRemoval.attempts })
      .from(spaceRemoval)
      .where(eq(spaceRemoval.id, removalId));
    const tries = Math.max(1, row?.attempts ?? 1);
    const pause = Math.min(this.retryMs * 2 ** (tries - 1), this.leaseMs * 5);
    return new Date(Date.now() + pause);
  }

  private onlyWorkspacesLeft(row: SpaceRemovalRow, counts: RemovalCounts): boolean {
    return onlyHeldWorkspacesLeft(row, this.deps.roots.workRoot, counts);
  }

  /**
   * An emptied space that is open again, with workspaces still to remove. Only
   * those are tried: the space directory is in use, and nothing else of the
   * removal is repeated.
   */
  private async cleanUp(row: SpaceRemovalRow, token: string): Promise<SpaceRemovalRow> {
    const workRoot = this.deps.roots.workRoot;
    await this.deps.sql.begin(this.holdFor(row.id, token));
    await this.deps.stopJobs?.(row.jobIds);
    const held = await clearJobWorkspaces(workRoot, row.jobIds, async () => {
      await this.deps.stopJobs?.(row.jobIds);
    });
    const counts = removalCounts.parse({ ...(row.counts ?? {}), paths: held });
    return this.finish(row.id, token, counts);
  }

  private release(removalId: string, token: string): Promise<SpaceRemovalRow> {
    return this.write(removalId, token, {
      state: 'pending',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /**
   * `complete` is written in one place, and only after a clear verification.
   * An emptied space whose only leftovers are held workspaces is `cleaning`.
   */
  private async finish(
    removalId: string,
    token: string,
    counts: RemovalCounts,
  ): Promise<SpaceRemovalRow> {
    const [row] = await this.deps.db
      .select()
      .from(spaceRemoval)
      .where(eq(spaceRemoval.id, removalId));
    if (row && this.onlyWorkspacesLeft(row, counts))
      return this.write(removalId, token, {
        state: 'cleaning',
        phase: 'space',
        counts,
        blockedReason: unclearReason(counts),
        leaseOwner: null,
        leaseExpiresAt: await this.retryAt(removalId),
      });
    if (!removalIsClear(counts))
      return this.block(removalId, token, 'verify', counts, unclearReason(counts));
    return this.write(removalId, token, {
      state: 'complete',
      phase: 'space',
      counts,
      blockedReason: null,
      finishedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /**
   * Startup and every minute after. A removal whose process died, and one a
   * restored backup brought back, are the same case: an unfinished row whose
   * lease has expired.
   */
  async resume(signal?: AbortSignal): Promise<SpaceRemovalRow[]> {
    const ready = await this.deps.db
      .select({ id: spaceRemoval.id })
      .from(spaceRemoval)
      .where(
        and(
          ne(spaceRemoval.state, 'complete'),
          or(isNull(spaceRemoval.leaseExpiresAt), sql`${spaceRemoval.leaseExpiresAt} < now()`),
        ),
      )
      .orderBy(spaceRemoval.startedAt);
    const finished: SpaceRemovalRow[] = [];
    for (const entry of ready) {
      if (signal?.aborted) break;
      // One this process is already running is left to that run.
      if (this.inFlight.has(entry.id)) continue;
      finished.push(await this.run(entry.id, signal));
    }
    return finished;
  }

  /**
   * Resume now and every lease period after, without holding up whoever
   * started it: a removal waiting on a provider or a held file can take a
   * while, and nothing else has to wait for it.
   */
  start(signal?: AbortSignal): void {
    if (this.timer) return;
    const pass = () => {
      if (this.resuming) return;
      this.resuming = this.resume(signal)
        .catch(() => process.stderr.write('space removal resume failed\n'))
        .finally(() => {
          this.resuming = undefined;
        });
    };
    pass();
    this.timer = setInterval(pass, Math.min(this.leaseMs, this.retryMs));
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Nothing is left of an emptied space but workspaces that stopped work still
 * holds open, so the space can open again: its rows and its directory have
 * gone, and those workspaces belong to jobs it no longer has.
 *
 * Each leftover has to be exactly the workspace of one of the jobs captured at
 * the fence. Anything else under the work root, a job created in the reopened
 * space included, is not this removal's to wait for. The work root is matched
 * as written and as it really resolves, since the recount names a workspace
 * one way and the removal the other.
 */
export function onlyHeldWorkspacesLeft(
  removal: Pick<SpaceRemovalRow, 'kind' | 'jobIds'>,
  workRoot: string,
  counts: RemovalCounts,
): boolean {
  if (removal.kind !== 'emptied' || counts.paths.length === 0) return false;
  const roots = new Set([resolve(workRoot)]);
  try {
    roots.add(realpathSync(workRoot));
  } catch {
    // A work root that does not exist holds no workspace; the written form is enough.
  }
  const workspaces = new Set(
    removal.jobIds.flatMap((id) => [...roots].map((root) => join(root, id))),
  );
  return (
    counts.paths.every((path) => workspaces.has(resolve(path))) &&
    removalIsClear({ ...counts, paths: [] })
  );
}

/**
 * What closes a space, for the fence and for a removal queued again after a
 * restore: every capability issued under the old generation is invalidated,
 * memory stops serving, every job is cancelled and every trigger disabled, and
 * what the later phases need to find again is captured. The caller holds the
 * space row for update and stamps it.
 */
async function closeSpace(tx: Transaction, jobs: JobService, spaceId: string) {
  const [parent] = await tx
    .select({ policyGeneration: space.policyGeneration })
    .from(space)
    .where(eq(space.id, spaceId))
    .for('update');
  const generation = (parent?.policyGeneration ?? 0) + 1;
  await tx.update(space).set({ policyGeneration: generation }).where(eq(space.id, spaceId));
  // Memory stops serving before anything of it is destroyed, and stays
  // stopped through a restore: `restore_ready` is what gates serving.
  await tx.execute(
    sql`update memory_spaces set revoked = true, restore_ready = false,
      policy_generation = policy_generation + 1, access_generation = access_generation + 1
      where space_id = ${spaceId}`,
  );
  await tx.execute(
    sql`update memory_contexts set invalidated_at = now(), items = '[]'::jsonb
      where space_id = ${spaceId} and invalidated_at is null`,
  );
  await tx.execute(
    sql`update memory_prepared set stale = true, content = null where space_id = ${spaceId}`,
  );
  await new PolicyService(jobs).invalidateInTransaction(
    tx,
    spaceId,
    generation,
    null,
    'policy_changed',
  );
  const cancelled = await cancelEveryJob(tx, jobs, spaceId);
  // Every job, not only the cancelled ones: the filesystem sweep needs the
  // ids of jobs whose workspaces are still on disk, and the rows are gone
  // by the time it runs.
  const all = await tx.select({ id: job.id }).from(job).where(eq(job.spaceId, spaceId));
  // Captured because phase 8 deletes these rows, and the finished report has
  // to name the services where a key of theirs keeps working.
  const providers = await tx
    .selectDistinct({ provider: connection.provider, label: connection.label })
    .from(connection)
    .where(eq(connection.spaceId, spaceId))
    .orderBy(connection.provider, connection.label);
  // The ids too: the connector registry and a sandbox provider are both
  // addressed by connection id, and phase 8 deletes the rows that carry it.
  const connections = await tx
    .select({ id: connection.id })
    .from(connection)
    .where(eq(connection.spaceId, spaceId))
    .orderBy(connection.id);
  return {
    cancelled,
    jobIds: all.map((entry) => entry.id),
    connectionIds: connections.map((entry) => entry.id),
    providers,
  };
}

/** Every non-terminal job, cancelled with a named reason, and its triggers disabled. */
async function cancelEveryJob(
  tx: Transaction,
  jobs: JobService,
  spaceId: string,
): Promise<string[]> {
  const rows = await tx.select().from(job).where(eq(job.spaceId, spaceId)).orderBy(job.id);
  const cancelled: string[] = [];
  for (const row of rows) {
    await tx.update(trigger).set({ enabled: false }).where(eq(trigger.jobId, row.id));
    if (TERMINAL.has(row.state)) continue;
    // The bumped lease epoch is the fence a stalled attempt meets when it wakes.
    await jobs.move(tx, row, { kind: 'cancelled' }, { payload: { reason: 'space_removed' } });
    cancelled.push(row.id);
  }
  return cancelled;
}

const TERMINAL = new Set(['done', 'cancelled', 'failed']);

function omit(
  counts: RemovalCounts,
  phase: RemovalPhase,
  reason: 'not_applicable' | 'capability_absent',
): RemovalCounts {
  return { ...counts, omitted: { ...counts.omitted, [phase]: reason } };
}

/**
 * Record what a phase removed, added to what earlier passes removed, so a
 * removal that went round twice still accounts for the first time. Nothing
 * here can stop a removal finishing.
 */
function cleared(counts: RemovalCounts, went: Record<string, number>): RemovalCounts {
  const total = { ...counts.cleared };
  for (const [name, count] of Object.entries(went)) total[name] = (total[name] ?? 0) + count;
  return { ...counts, cleared: total };
}

async function tableExists(raw: Sql, name: string): Promise<boolean> {
  const [row] = await raw<
    { present: boolean }[]
  >`select to_regclass(${`public.${name}`}) is not null as present`;
  return row?.present === true;
}

async function countRows(raw: Sql, name: string, spaceId: string): Promise<number> {
  const [row] = await raw<{ count: number }[]>`select count(*)::int as count
    from ${raw(name)} where space_id = ${spaceId}`;
  return Number(row?.count ?? 0);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What is still there, named, so a blocked removal says which thing stopped it. */
function unclearReason(counts: RemovalCounts): string {
  const held = Object.entries(counts.tables)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${table} (${count})`);
  const unreachable = Object.entries(counts.omitted)
    .filter(([, reason]) => reason !== 'not_applicable')
    .map(([phase]) => phase);
  const parts: string[] = [];
  if (unreachable.length) parts.push(`could not reach: ${unreachable.join(', ')}`);
  if (held.length) parts.push(`rows remain in ${held.join(', ')}`);
  if (counts.paths.length) parts.push(`files remain at ${counts.paths.join(', ')}`);
  const providers = Object.entries(counts.providers)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} (${count})`);
  if (providers.length) parts.push(`a provider still lists ${providers.join(', ')}`);
  return parts.join('; ') || 'the verification pass could not prove the space was cleared';
}
