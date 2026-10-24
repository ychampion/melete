/**
 * The operator's caps on a provider whose account limits how many computers it
 * keeps and how many are awake at once, so this installation never asks for
 * more than the account allows. Both are unset by default: an installation
 * with no caps is given its provider unwrapped.
 *
 * The count lives in Postgres (`sandbox_provider_computer`,
 * `sandbox_provider_lease`) and every decision is made inside one short
 * transaction holding one advisory lock per adapter, so concurrent requests
 * from any number of service instances can never take more places than there
 * are. The lock is never held while the provider is called.
 *
 * - Making a computer reserves its place first; past the computer cap the
 *   request is refused and no computer is made. A create the provider refused
 *   frees its place; one whose answer was lost keeps it until the reservation
 *   goes stale, since the computer may exist.
 * - Any call that wakes a computer (a command, a file, a resume) first counts
 *   it awake. Past the awake cap it waits a little for a place, then is
 *   refused. A computer is never made, or swapped for another, to get round
 *   either cap.
 * - A computer counts as awake while a call holds it, or while it is not known
 *   to be asleep and was used within the provider's idle time. Putting it to
 *   sleep, or the provider reporting it asleep, frees its place, unless it was
 *   used after the sleep was asked for. Deleting it, or the provider reporting
 *   it gone, frees both places.
 * - Checking a computer counts it, so computers made before the caps were set
 *   are counted from their first check. Reconciliation forgets a counted
 *   computer that no live session names, so a removal whose count was lost
 *   does not hold a place forever.
 *
 * The refusals are plain sentences the agent passes on to the person.
 */
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { SandboxRefusal } from './manifest.ts';
import {
  SandboxAdapterRefusal,
  SandboxGone,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  SandboxStartRefused,
} from './types.ts';

export type ProviderCaps = {
  /** The most computers kept at the provider, asleep or awake; null for no cap. */
  maxComputers: number | null;
  /** The most awake at once; null for no cap. */
  maxAwake: number | null;
  /** How long the provider keeps an unused computer awake before it sleeps by itself. */
  idleSeconds: number;
  /** How long a wake waits for a place before it is refused. */
  waitMs?: number;
};

export const COMPUTERS_FULL =
  "This installation already has as many computers as its operator allows, so no new one was made and nothing ran. Tell the person: the operator can raise the limit, or remove agents' computers that are no longer used";

export const AWAKE_FULL =
  'Every computer this installation may run at once is in use right now, so this one could not start and nothing ran. Tell the person, and try again in a few minutes';

const RESERVED = 'reserved:';
/**
 * A reservation older than this belongs to a request that died, or to a create
 * whose answer was lost (any computer it made is removed by reconciliation, and
 * counted when it is next checked or used); its place is free.
 */
const RESERVATION_STALE_SECONDS = 15 * 60;
/**
 * A counted computer no live session names, made and unused for this long, is
 * one whose removal was not counted; reconciliation forgets it.
 */
const FORGOTTEN_SECONDS = 15 * 60;
const WAIT_STEP_MS = 2_000;
/** How long a call that is not a command may hold a computer awake. */
const CALL_HOLD_MS = 5 * 60_000;
/** Past a command's own timeout, how long it may still hold its computer. */
const COMMAND_GRACE_MS = 2 * 60_000;

/** The calls that make a provider wake a computer, by the handle they take first. */
const WAKING = new Set([
  'connect',
  'exec',
  'reattach',
  'putFiles',
  'listFiles',
  'getFile',
  'keepAlive',
  // Maritime's screen, actions and viewer links.
  'act',
  'screenshot',
  'viewerLink',
]);

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** The counts and the lock, for one adapter. */
export class ProviderCapLedger {
  constructor(
    private readonly sql: Sql,
    readonly adapter: string,
    readonly caps: ProviderCaps,
  ) {}

  private async locked<T>(work: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`sandbox-provider-caps:${this.adapter}`}))`;
      await tx`delete from sandbox_provider_lease
        where adapter = ${this.adapter} and until < now()`;
      await tx`delete from sandbox_provider_computer
        where adapter = ${this.adapter} and computer_id like ${`${RESERVED}%`}
          and created_at < now() - make_interval(secs => ${RESERVATION_STALE_SECONDS})`;
      return work(tx);
    })) as T;
  }

  /** Awake: held by a call, or not known to be asleep and used within the idle time. */
  private async awakeCount(tx: TransactionSql): Promise<number> {
    const [row] = await tx`select count(*)::int as awake from sandbox_provider_computer c
      where c.adapter = ${this.adapter}
        and ((not c.asleep
            and c.active_at > now() - make_interval(secs => ${this.caps.idleSeconds}))
          or exists (select 1 from sandbox_provider_lease l
            where l.adapter = c.adapter and l.computer_id = c.computer_id))`;
    return Number(row?.awake ?? 0);
  }

  /** The database's clock now, for telling a sleep from a wake that came after it was asked. */
  async clock(): Promise<Date> {
    const [row] = await this.sql`select clock_timestamp() as at`;
    return row?.at as Date;
  }

  /** Counts as the operator would read them, for tests and status. */
  async counts(): Promise<{ computers: number; awake: number }> {
    return this.locked(async (tx) => {
      const [row] = await tx`select count(*)::int as computers from sandbox_provider_computer
        where adapter = ${this.adapter}`;
      return { computers: Number(row?.computers ?? 0), awake: await this.awakeCount(tx) };
    });
  }

  /**
   * Take a place for a computer about to be made, awake. Returns the
   * reservation, or the refusal when either cap is reached.
   */
  async reserve(): Promise<{ reservation: string } | { full: 'computers' | 'awake' }> {
    return this.locked(async (tx) => {
      if (this.caps.maxComputers !== null) {
        const [row] = await tx`select count(*)::int as computers from sandbox_provider_computer
          where adapter = ${this.adapter}`;
        if (Number(row?.computers ?? 0) >= this.caps.maxComputers) return { full: 'computers' };
      }
      if (this.caps.maxAwake !== null && (await this.awakeCount(tx)) >= this.caps.maxAwake)
        return { full: 'awake' };
      const reservation = `${RESERVED}${randomUUID()}`;
      await tx`insert into sandbox_provider_computer (adapter, computer_id, asleep, active_at)
        values (${this.adapter}, ${reservation}, false, now())`;
      return { reservation };
    });
  }

  /** The computer was made: its reservation becomes it. */
  async made(reservation: string, computerId: string): Promise<void> {
    await this.locked(async (tx) => {
      await tx`delete from sandbox_provider_computer
        where adapter = ${this.adapter} and computer_id = ${reservation}`;
      await tx`insert into sandbox_provider_computer (adapter, computer_id, asleep, active_at)
        values (${this.adapter}, ${computerId}, false, now())
        on conflict (adapter, computer_id) do update set asleep = false, active_at = now()`;
    });
  }

  /** Nothing was made (or nothing can be told): the reservation's place is freed. */
  async release(reservation: string): Promise<void> {
    await this.sql`delete from sandbox_provider_computer
      where adapter = ${this.adapter} and computer_id = ${reservation}`;
  }

  /**
   * Hold a computer awake for one call. Returns the lease, or null when it is
   * not awake already and every awake place is taken. A computer this ledger
   * has not seen (made before the caps were set) is counted from now on.
   */
  async hold(computerId: string, holdMs: number): Promise<string | null> {
    return this.locked(async (tx) => {
      const [row] = await tx`select c.asleep,
          c.active_at > now() - make_interval(secs => ${this.caps.idleSeconds}) as recent,
          exists (select 1 from sandbox_provider_lease l
            where l.adapter = c.adapter and l.computer_id = c.computer_id) as leased
        from sandbox_provider_computer c
        where c.adapter = ${this.adapter} and c.computer_id = ${computerId}`;
      const awake =
        row !== undefined && ((!row.asleep && row.recent === true) || row.leased === true);
      if (
        !awake &&
        this.caps.maxAwake !== null &&
        (await this.awakeCount(tx)) >= this.caps.maxAwake
      )
        return null;
      await tx`insert into sandbox_provider_computer (adapter, computer_id, asleep, active_at)
        values (${this.adapter}, ${computerId}, false, now())
        on conflict (adapter, computer_id) do update set asleep = false, active_at = now()`;
      const lease = randomUUID();
      await tx`insert into sandbox_provider_lease (id, adapter, computer_id, until)
        values (${lease}, ${this.adapter}, ${computerId},
          now() + make_interval(secs => ${Math.ceil(holdMs / 1000)}))`;
      return lease;
    });
  }

  /** The call ended: the computer was last used now. */
  async unhold(lease: string, computerId: string): Promise<void> {
    await this.sql`delete from sandbox_provider_lease where id = ${lease}`;
    await this.sql`update sandbox_provider_computer set active_at = now()
      where adapter = ${this.adapter} and computer_id = ${computerId} and not asleep`;
  }

  /**
   * The provider put the computer to sleep, or reported it asleep, in answer
   * to a request made at `asked` (the database's clock). A computer a call
   * holds now, or used after `asked`, was woken again since, and stays
   * counted until it is idle. A computer not counted yet is counted, asleep.
   */
  async asleep(computerId: string, asked: Date): Promise<void> {
    await this.sql`insert into sandbox_provider_computer as c
        (adapter, computer_id, asleep, active_at)
      values (${this.adapter}, ${computerId}, true, null)
      on conflict (adapter, computer_id) do update set asleep = true, active_at = null
        where (c.active_at is null or c.active_at <= ${asked})
          and not exists (select 1 from sandbox_provider_lease l
            where l.adapter = c.adapter and l.computer_id = c.computer_id)`;
  }

  /** The provider reported the computer running: it is awake now, and counted. */
  async seen(computerId: string): Promise<void> {
    await this.sql`insert into sandbox_provider_computer as c
        (adapter, computer_id, asleep, active_at)
      values (${this.adapter}, ${computerId}, false, now())
      on conflict (adapter, computer_id) do update
        set asleep = false, active_at = greatest(c.active_at, now())`;
  }

  async gone(computerIds: readonly string[]): Promise<void> {
    if (!computerIds.length) return;
    await this.sql`delete from sandbox_provider_lease
      where adapter = ${this.adapter} and computer_id in ${this.sql(computerIds)}`;
    await this.sql`delete from sandbox_provider_computer
      where adapter = ${this.adapter} and computer_id in ${this.sql(computerIds)}`;
  }

  /**
   * Forget counted computers that no live session names and that nothing has
   * made or used for a while: their removal happened without being counted.
   * Returns the ids forgotten.
   */
  async forget(live: (computerId: string) => boolean): Promise<string[]> {
    const rows = await this.sql<{ computer_id: string }[]>`
      select computer_id from sandbox_provider_computer c
      where c.adapter = ${this.adapter} and c.computer_id not like ${`${RESERVED}%`}
        and c.created_at < now() - make_interval(secs => ${FORGOTTEN_SECONDS})
        and (c.active_at is null
          or c.active_at < now() - make_interval(secs => ${FORGOTTEN_SECONDS}))
        and not exists (select 1 from sandbox_provider_lease l
          where l.adapter = c.adapter and l.computer_id = c.computer_id)`;
    const forgotten = rows.map((row) => row.computer_id).filter((id) => !live(id));
    await this.gone(forgotten);
    return forgotten;
  }
}

/**
 * A failure that proves no computer was made: refused before the provider was
 * asked, or answered with a refusal (4xx other than a timeout). Anything else,
 * a lost answer above all, may have made one.
 */
function nothingMade(error: unknown): boolean {
  if (
    error instanceof SandboxAdapterRefusal ||
    error instanceof SandboxRefusal ||
    error instanceof SandboxStartRefused
  )
    return true;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}

const idOf = (handle: unknown): string | null =>
  typeof handle === 'string'
    ? handle
    : handle && typeof (handle as SandboxHandle).providerSandboxId === 'string'
      ? (handle as SandboxHandle).providerSandboxId
      : null;

/**
 * The provider with the operator's caps in front of it, or the provider
 * itself when neither cap is set. Every other method, an adapter's own extras
 * included, passes through unchanged.
 */
export function cappedSandboxProvider<P extends SandboxProvider>(
  inner: P,
  options: { sql: Sql; caps: ProviderCaps },
): P {
  const { caps } = options;
  if (caps.maxComputers === null && caps.maxAwake === null) return inner;
  const ledger = new ProviderCapLedger(options.sql, inner.capabilities.adapter, caps);
  const waitMs = caps.waitMs ?? 30_000;

  /** Wait for an awake place for `computerId`, or refuse with the sentence. */
  async function holding<T>(
    computerId: string,
    holdMs: number,
    signal: AbortSignal | undefined,
    refusal: () => Error,
    work: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + waitMs;
    let lease = await ledger.hold(computerId, holdMs);
    while (!lease) {
      if (Date.now() + WAIT_STEP_MS > deadline) throw refusal();
      await delay(WAIT_STEP_MS, signal);
      lease = await ledger.hold(computerId, holdMs);
    }
    try {
      return await work();
    } catch (error) {
      // Removed under the call (by a destroy that raced it, say): the hold
      // above counted it again, so it is forgotten again here.
      if (error instanceof SandboxGone) await ledger.gone([computerId]).catch(() => {});
      throw error;
    } finally {
      // A lease that cannot be removed now ends by itself at its `until`; until
      // then the computer is counted awake, which errs on the cap's side.
      await ledger.unhold(lease, computerId).catch(() => {});
    }
  }

  const wrapped: Partial<SandboxProvider> = {
    async create(spec: SandboxSpec, signal: AbortSignal) {
      const deadline = Date.now() + waitMs;
      let taken = await ledger.reserve();
      while ('full' in taken) {
        // A full computer count is refused at once; a full awake count may free up.
        if (taken.full === 'computers')
          throw new SandboxRefusal('provider_capacity', COMPUTERS_FULL);
        if (Date.now() + WAIT_STEP_MS > deadline)
          throw new SandboxRefusal('provider_capacity', AWAKE_FULL);
        await delay(WAIT_STEP_MS, signal);
        taken = await ledger.reserve();
      }
      let handle: SandboxHandle;
      try {
        handle = await inner.create(spec, signal);
      } catch (error) {
        // Refused: nothing was made, the place is free. Otherwise a computer
        // may have been made before its answer was lost; it keeps its place
        // until the reservation goes stale, and reconciliation removes it.
        // A release that fails leaves the same stale reservation.
        if (nothingMade(error)) await ledger.release(taken.reservation).catch(() => {});
        throw error;
      }
      await ledger.made(taken.reservation, handle.providerSandboxId);
      return handle;
    },
  };
  if (inner.resume) {
    const resume = inner.resume.bind(inner);
    wrapped.resume = (
      resumeRef: string,
      spec: SandboxSpec,
      signal: AbortSignal,
      ...rest: unknown[]
    ) =>
      holding(
        resumeRef,
        CALL_HOLD_MS,
        signal,
        () => new SandboxRefusal('provider_capacity', AWAKE_FULL),
        () =>
          (resume as (...args: unknown[]) => Promise<SandboxHandle>)(
            resumeRef,
            spec,
            signal,
            ...rest,
          ),
      );
  }
  if (inner.pause) {
    const pause = inner.pause.bind(inner);
    wrapped.pause = async (handle, signal) => {
      const asked = await ledger.clock();
      let result: Awaited<ReturnType<typeof pause>>;
      try {
        result = await pause(handle, signal);
      } catch (error) {
        if (error instanceof SandboxGone) await ledger.gone([handle.providerSandboxId]);
        throw error;
      }
      await ledger.asleep(handle.providerSandboxId, asked);
      return result;
    };
  }
  wrapped.destroy = async (handle, signal) => {
    await inner.destroy(handle, signal);
    await ledger.gone([handle.providerSandboxId]);
  };
  wrapped.inspect = async (handle, signal) => {
    const asked = await ledger.clock();
    const state = await inner.inspect(handle, signal);
    if (state === 'gone') await ledger.gone([handle.providerSandboxId]);
    else if (state === 'paused') await ledger.asleep(handle.providerSandboxId, asked);
    else await ledger.seen(handle.providerSandboxId);
    return state;
  };
  wrapped.reconcile = async (project, live, signal, connection) => {
    const destroyed = await inner.reconcile(project, live, signal, connection);
    await ledger.gone(destroyed);
    await ledger.forget((id) => live.has(id));
    return destroyed;
  };

  return new Proxy(inner, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property in wrapped)
        return wrapped[property as keyof SandboxProvider];
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || !WAKING.has(property))
        return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => {
        const computerId = idOf(args[0]);
        if (!computerId) return value.apply(target, args);
        const spec = args[1] as { timeoutMs?: unknown } | undefined;
        const holdMs =
          property === 'exec' && typeof spec?.timeoutMs === 'number'
            ? spec.timeoutMs + COMMAND_GRACE_MS
            : CALL_HOLD_MS;
        const signal = args.find((arg): arg is AbortSignal => arg instanceof AbortSignal);
        return holding(
          computerId,
          holdMs,
          signal,
          () => new SandboxAdapterRefusal(AWAKE_FULL),
          () => value.apply(target, args) as Promise<unknown>,
        );
      };
    },
  }) as P;
}
