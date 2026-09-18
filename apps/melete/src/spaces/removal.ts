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
import {
  EMPTY_COUNTS,
  type RemovalCounts,
  type RemovalPhase,
  removalCounts,
  removalIsClear,
  type SpaceRemoval,
  spaceRemoval as spaceRemovalContract,
} from '@melete/contracts';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { connection, job, space, trigger } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { PolicyService } from '../jobs/policy.ts';
import type { JobService } from '../jobs/service.ts';
import type { RestrictionJournal } from '../memory/restore.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { appendRemovalRecord } from './journal.ts';
import {
  clearSpaceFiles,
  endSpaceAccess,
  sweepMemory,
  sweepOperational,
  sweepPrincipals,
} from './plan.ts';
import { type SpaceRemovalRow, spaceRemoval } from './schema.ts';
import { verifyRemoval, verifySpaceGone } from './verify.ts';

/**
 * The sandbox lane owns live workspaces and the snapshots a provider keeps for
 * them. This module never reaches into a provider itself; it asks for the two
 * things a removal needs and believes neither without re-listing afterwards.
 */
export type SandboxTeardown = {
  /** Close every live session for the space and delete its provider-side snapshots. */
  destroyWorkspacesForSpace(spaceId: string, signal?: AbortSignal): Promise<void>;
  /** What the provider still lists for the space. The verification pass reads this. */
  listWorkspacesForSpace(spaceId: string): Promise<{ sessions: string[]; snapshots: string[] }>;
};

/**
 * The browser lane owns the worker process that holds a space's Chromium
 * profile open, and the record of which sites that profile is signed in to.
 */
export type BrowserTeardown = {
  /** Stop the worker for the space. It must exit before the profile directory can go. */
  stop(spaceId: string): Promise<void>;
  /** The domains this space is signed in to. */
  sitesForSpace(spaceId: string): Promise<string[]>;
  /** Forget one site: its stored profile and its cookies. */
  forgetSite(spaceId: string, domain: string): Promise<void>;
};

export type RemovalDeps = {
  db: Database;
  sql: Sql;
  jobs: JobService;
  journal: RestrictionJournal;
  roots: { spacesRoot: string; workRoot: string };
  sandboxes?: SandboxTeardown;
  browser?: BrowserTeardown;
  /** How long a claimed removal holds its lease before another run may take it. */
  leaseMs?: number;
  /** Named so tests can watch a phase boundary without timing it. */
  onPhase?: (removalId: string, phase: RemovalPhase) => void;
};

const LEASE_MS = 60_000;

/** The phases after the fence, in the order they run. */
const SWEEP: readonly RemovalPhase[] = [
  'sessions',
  'journal',
  'sandboxes',
  'browser',
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

export class SpaceRemovalService {
  private readonly leaseMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private readonly instance = newId('rem');
  private readonly inFlight = new Map<string, Promise<SpaceRemovalRow>>();

  constructor(readonly deps: RemovalDeps) {
    this.leaseMs = deps.leaseMs ?? LEASE_MS;
  }

  /**
   * Start the sweep without waiting for it. The request that asked for the
   * removal has its answer as soon as the fence commits; the rest takes as
   * long as it takes, and survives this process either way.
   */
  dispatch(removalId: string, signal?: AbortSignal): void {
    if (this.inFlight.has(removalId)) return;
    const running = this.run(removalId, signal)
      .catch((error) => {
        process.stderr.write(`space removal failed: ${describe(error)}\n`);
        return this.byId(removalId).then((row) => {
          if (!row) throw error;
          return row;
        });
      })
      .finally(() => this.inFlight.delete(removalId));
    this.inFlight.set(removalId, running);
  }

  /** The sweep this process is running for a removal, if it is running one. */
  settled(removalId: string): Promise<SpaceRemovalRow | undefined> {
    return this.inFlight.get(removalId) ?? this.byId(removalId);
  }

  /** Let the sweeps this process started finish before it goes away. */
  async drain(): Promise<void> {
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
      if (!parent) throw new ServiceError('not_found', 'Space not found.', 404);

      // A second request joins the removal already running rather than starting
      // a rival sweep. The partial unique index backs this up in the database.
      // It is read before authority is checked, because phase 2 revokes the
      // memberships: the person who asked has to be able to ask again and get
      // the same answer, and the record of who asked is what says they may.
      const [live] = await tx
        .select()
        .from(spaceRemoval)
        .where(and(eq(spaceRemoval.spaceId, spaceId), ne(spaceRemoval.state, 'complete')));
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

      if (confirmName !== parent.name)
        throw new ServiceError(
          'confirmation_mismatch',
          'That is not the name of this space. Type the name exactly as it is shown.',
          400,
        );

      const generation = parent.policyGeneration + 1;
      await tx
        .update(space)
        .set({ removedAt: new Date(), policyGeneration: generation })
        .where(eq(space.id, spaceId));
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
      // Captured here because phase 8 deletes these rows, and the finished
      // report has to name the services where a key of theirs keeps working.
      const providers = await tx
        .selectDistinct({ provider: connection.provider, label: connection.label })
        .from(connection)
        .where(eq(connection.spaceId, spaceId))
        .orderBy(connection.provider, connection.label);
      const [row] = await tx
        .insert(spaceRemoval)
        .values({
          id: newId('rem'),
          spaceId,
          spaceName: parent.name,
          gitPath: parent.gitPath,
          providers,
          // A space of one's own is recreated the moment its account asks for
          // one, so it is emptied in place rather than removed.
          kind: parent.kind === 'personal' ? 'emptied' : 'removed',
          requestedBy: actor,
          state: 'pending',
          phase: 'fence',
          jobIds: all.map((entry) => entry.id),
          counts: EMPTY_COUNTS,
        })
        .returning();
      if (!row) throw new Error('space removal insert returned no row');
      return { row, cancelled };
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
   */
  async run(removalId: string, signal?: AbortSignal): Promise<SpaceRemovalRow> {
    const claimed = await this.claim(removalId);
    if (!claimed) {
      const row = await this.byId(removalId);
      if (!row) throw new ServiceError('not_found', 'Removal not found.', 404);
      return row;
    }
    let row = claimed;
    const started = SWEEP.indexOf(row.phase === 'fence' ? 'sessions' : row.phase);
    const remaining = SWEEP.slice(started < 0 ? 0 : started);
    let counts: RemovalCounts = removalCounts.parse(row.counts ?? {});
    for (const phase of remaining) {
      if (signal?.aborted) return this.release(row.id);
      row = await this.enter(row.id, phase);
      this.deps.onPhase?.(row.id, phase);
      try {
        counts = await this.perform(row, phase, counts, signal);
      } catch (error) {
        return this.block(row.id, phase, counts, describe(error));
      }
      if (phase === 'verify' && !removalIsClear(counts))
        return this.block(row.id, phase, counts, unclearReason(counts));
      await this.record(row.id, counts);
    }
    return this.finish(row.id, counts);
  }

  /** One phase. Every branch is safe to run twice. */
  private async perform(
    row: SpaceRemovalRow,
    phase: RemovalPhase,
    counts: RemovalCounts,
    signal?: AbortSignal,
  ): Promise<RemovalCounts> {
    const { sql: raw, roots } = this.deps;
    const emptied = row.kind === 'emptied';
    switch (phase) {
      case 'sessions':
        // Access to the space ends before anything in it is destroyed, and
        // nobody is signed out of their account to achieve it.
        await endSpaceAccess(raw, row.spaceId, emptied);
        return counts;
      case 'journal':
        // Before any data goes, and retained apart from database snapshots, so
        // restoring a backup from before the removal does not undo it.
        await appendRemovalRecord(raw, this.deps.journal, row.spaceId);
        return counts;
      case 'sandboxes':
        return this.tearDownSandboxes(row, counts, signal);
      case 'browser':
        return this.tearDownBrowser(row, counts);
      case 'files':
        // The worker holding the profile has exited by now: on Windows the
        // directory cannot be removed while Chromium has it open.
        await clearSpaceFiles(
          { spacesRoot: roots.spacesRoot, workRoot: roots.workRoot },
          row.spaceId,
          row.jobIds,
          emptied,
          this.deps.browser
            ? () => this.deps.browser?.stop(row.spaceId) ?? Promise.resolve()
            : undefined,
        );
        return counts;
      case 'operational':
        await sweepOperational(raw, row.spaceId, row.jobIds);
        return counts;
      case 'principals':
        await sweepPrincipals(raw, row.spaceId);
        return counts;
      case 'memory':
        await sweepMemory(raw, row.spaceId);
        return counts;
      case 'verify':
        return verifyRemoval(raw, {
          spaceId: row.spaceId,
          jobIds: row.jobIds,
          emptied,
          spacesRoot: roots.spacesRoot,
          workRoot: roots.workRoot,
          omitted: counts.omitted,
          sandboxes: this.deps.sandboxes,
        });
      case 'space':
        if (emptied) {
          // The row, its id and its membership stay; the space is present and
          // empty, and usable again from the next request.
          await raw`update space set removed_at = null where id = ${row.spaceId}`;
          return counts;
        }
        await raw`delete from space_membership where space_id = ${row.spaceId}`;
        await raw`delete from space where id = ${row.spaceId}`;
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
    const present = await tableExists(this.deps.sql, 'sandbox_session');
    if (!this.deps.sandboxes) {
      // Nothing to reach means nothing to prove. Something to reach and no way
      // to reach it means this removal can never be reported as finished.
      const held = present ? await countRows(this.deps.sql, 'sandbox_session', row.spaceId) : 0;
      return omit(counts, 'sandboxes', held > 0 ? 'capability_absent' : 'not_applicable');
    }
    await this.deps.sandboxes.destroyWorkspacesForSpace(row.spaceId, signal);
    return counts;
  }

  private async tearDownBrowser(
    row: SpaceRemovalRow,
    counts: RemovalCounts,
  ): Promise<RemovalCounts> {
    if (!this.deps.browser) {
      const present = await tableExists(this.deps.sql, 'browser_site_profile');
      const held = present
        ? await countRows(this.deps.sql, 'browser_site_profile', row.spaceId)
        : 0;
      return omit(counts, 'browser', held > 0 ? 'capability_absent' : 'not_applicable');
    }
    await this.deps.browser.stop(row.spaceId);
    for (const domain of await this.deps.browser.sitesForSpace(row.spaceId))
      await this.deps.browser.forgetSite(row.spaceId, domain);
    return counts;
  }

  /**
   * Take the removal, or leave it to whoever holds it. A lease that has expired
   * is free: the process that held it is gone and its phase was committed.
   */
  private async claim(removalId: string): Promise<SpaceRemovalRow | undefined> {
    const [row] = await this.deps.db
      .update(spaceRemoval)
      .set({
        state: 'running',
        leaseOwner: this.instance,
        leaseExpiresAt: new Date(Date.now() + this.leaseMs),
        attempts: sql`${spaceRemoval.attempts} + 1`,
        blockedReason: null,
      })
      .where(
        and(
          eq(spaceRemoval.id, removalId),
          ne(spaceRemoval.state, 'complete'),
          or(
            isNull(spaceRemoval.leaseExpiresAt),
            sql`${spaceRemoval.leaseExpiresAt} < now()`,
            eq(spaceRemoval.leaseOwner, this.instance),
          ),
        ),
      )
      .returning();
    return row;
  }

  private async enter(removalId: string, phase: RemovalPhase): Promise<SpaceRemovalRow> {
    const [row] = await this.deps.db
      .update(spaceRemoval)
      .set({ phase, leaseExpiresAt: new Date(Date.now() + this.leaseMs) })
      .where(eq(spaceRemoval.id, removalId))
      .returning();
    if (!row) throw new Error('claimed removal disappeared');
    return row;
  }

  private async record(removalId: string, counts: RemovalCounts): Promise<void> {
    await this.deps.db
      .update(spaceRemoval)
      .set({ counts, leaseExpiresAt: new Date(Date.now() + this.leaseMs) })
      .where(eq(spaceRemoval.id, removalId));
  }

  private async block(
    removalId: string,
    phase: RemovalPhase,
    counts: RemovalCounts,
    reason: string,
  ): Promise<SpaceRemovalRow> {
    const [row] = await this.deps.db
      .update(spaceRemoval)
      .set({
        state: 'blocked',
        phase,
        counts,
        blockedReason: reason,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(spaceRemoval.id, removalId))
      .returning();
    if (!row) throw new Error('claimed removal disappeared');
    return row;
  }

  private async release(removalId: string): Promise<SpaceRemovalRow> {
    const [row] = await this.deps.db
      .update(spaceRemoval)
      .set({ state: 'pending', leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(spaceRemoval.id, removalId), ne(spaceRemoval.state, 'complete')))
      .returning();
    if (row) return row;
    const current = await this.byId(removalId);
    if (!current) throw new Error('claimed removal disappeared');
    return current;
  }

  /** `complete` is written in one place, and only after a clear verification. */
  private async finish(removalId: string, counts: RemovalCounts): Promise<SpaceRemovalRow> {
    if (!removalIsClear(counts))
      return this.block(removalId, 'verify', counts, unclearReason(counts));
    const [row] = await this.deps.db
      .update(spaceRemoval)
      .set({
        state: 'complete',
        phase: 'space',
        counts,
        blockedReason: null,
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(spaceRemoval.id, removalId))
      .returning();
    if (!row) throw new Error('claimed removal disappeared');
    return row;
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
      finished.push(await this.run(entry.id, signal));
    }
    return finished;
  }

  start(signal?: AbortSignal): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.resume(signal).catch(() => process.stderr.write('space removal resume failed\n'));
    }, this.leaseMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
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
