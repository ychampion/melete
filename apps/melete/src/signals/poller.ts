/**
 * Reading what changed in connected accounts.
 *
 * Something has to put a `mail.received` or a `calendar.event.changed` where a
 * waiting job or a standing run can hear it. This is that something. Once a
 * minute it looks for accounts that are due: a mailbox or calendar that some
 * live trigger listens to, whose job may use it. For each it reads what
 * changed since its cursor, through the connector's own read-only code, and
 * hands each observation to `TriggerService.deliver`, which dedupes and wakes.
 *
 * Properties it keeps:
 *
 * 1. **It only reads.** A connector's `signals` can list and fetch headers;
 *    nothing here sends, writes to the account, or proposes an effect.
 * 2. **One change is one event.** Every observation carries a key made of what
 *    it is about and its state (a message's id; an occurrence and the version
 *    of its fields), hashed to a fixed length, and `deliver` keeps one event
 *    per key, so a change read twice, by two polls or after a cursor reset, is
 *    delivered once.
 * 3. **Only what someone asked to hear.** An account is read only while a
 *    trigger listens for one of its kinds, and only for triggers whose job the
 *    connection serves under the shared-use rule. Delivery checks that rule
 *    again for each waiting job.
 * 4. **Quiet costs nothing.** An observation no trigger matches wakes nothing:
 *    no attempt, no model call.
 * 5. **One item never stops an account.** An item that cannot be delivered is
 *    skipped and reported, and the rest of the read goes on.
 * 6. **What an old credential read stays out.** A read remembers the
 *    connection's generation, and nothing it read is delivered or kept once a
 *    revocation or a switch of credential has moved it on.
 *
 * One instance at a time reads, under the `signal-poller` lease. What it reads
 * is decided from database rows alone, and an account whose connector this
 * instance has not opened is opened here or skipped, never forgotten.
 */
import { createHash } from 'node:crypto';
import {
  CALENDAR_EVENT_NAMES,
  isTerminal,
  jobState,
  MAIL_RECEIVED,
  producesEvent,
  triggerSpec,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { QUEUES } from '../jobs/queue.ts';
import {
  connectionServesJob,
  type JobConnectionAudience,
  jobConnectionAudience,
} from '../jobs/scopes.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import {
  type CalendarCursor,
  diffCalendar,
  type KeptOccurrence,
  mailDedupKey,
  mailObservation,
  type Observation,
  type OccurrenceFields,
  vanished,
} from './observations.ts';
import { CalendarTooLarge } from './occurrences.ts';
import type { Lookup, SignalSource } from './types.ts';

export type Stream = SignalSource['stream'];

/** How far ahead calendar occurrences are watched. */
export const CALENDAR_WINDOW_DAYS = 14;
/** Most new messages one read of a mailbox takes; the cursor stops after the last. */
export const MAIL_READ_LIMIT = 50;
/** The shortest and longest time between two reads of one account. */
export const MIN_POLL_SECONDS = 60;
export const MAX_POLL_SECONDS = 3600;
/** The longest a provider's own request to wait is honoured. */
export const MAX_RETRY_AFTER_SECONDS = 6 * 3600;
/** How long a claimed account stays out of other instances' reach. */
export const CLAIM_SECONDS = 600;
/** Most accounts one claim takes; a tick claims again until its time is up. */
export const ACCOUNTS_PER_CLAIM = 20;
/** How long one tick keeps claiming accounts. */
export const TICK_BUDGET_MS = 50_000;
/** How long one account's read may take before it is abandoned. */
export const READ_TIMEOUT_MS = 120_000;
/** How many accounts are read at once. */
export const READ_CONCURRENCY = 4;
/** Most occurrences a read looks up again because it no longer lists them. */
export const MAX_CONFIRMS = 20;
/**
 * How often an account watched by default, with no trigger asking for more,
 * is read. A trigger that asks for a shorter interval gets it.
 */
export const DEFAULT_WATCH_SECONDS = 300;

/** The stream a watched account is read on, by provider: a mailbox's mail, a calendar's occurrences. */
export const WATCHED_PROVIDERS: Record<string, Stream> = { imap: 'mail', caldav: 'calendar' };

/**
 * Whether an account is watched when no trigger asks: as the space's owners
 * set it, and otherwise on in a person's own space and off in a room's.
 */
export function watchedByDefault(spaceKind: string, watchChanges: boolean | null): boolean {
  return watchChanges ?? spaceKind === 'personal';
}

/** Which stream a trigger's event name is read from. */
export function streamOf(eventName: string): Stream | null {
  if (eventName === MAIL_RECEIVED) return 'mail';
  if ((CALENDAR_EVENT_NAMES as readonly string[]).includes(eventName)) return 'calendar';
  return null;
}

type Readable = { signals?: SignalSource } | undefined;

export type SignalPollerDeps = {
  sql: Sql;
  triggers: Pick<TriggerService, 'deliver'> & { jobs: { boss: TriggerService['jobs']['boss'] } };
  /** The connectors this instance has open. */
  connectors: { get(id: string): Readable };
  /**
   * Opens a connection this instance has not opened yet, as one installed
   * through another instance. Without it such an account is skipped this time.
   */
  load?: (connectionId: string) => Promise<Readable>;
  /** Whether this instance is the one that reads now. Without it, it always is. */
  leads?: () => Promise<boolean>;
  now?: () => number;
  readTimeoutMs?: number;
  concurrency?: number;
};

type CursorRow = {
  connection_id: string;
  stream: Stream;
  space_id: string;
  cursor: unknown;
  interval_s: number;
  failures: number;
  /** Which provider, and which of its servers, the account is read from. */
  provider_key: string;
};

/** Failures in a row at one provider before its reads pause. */
export const BREAKER_THRESHOLD = 3;
/** The first pause, doubled each time it opens again without a read working in between. */
export const BREAKER_PAUSE_SECONDS = 300;

/**
 * Whether a failure says the provider itself is in trouble (it timed out, asked
 * to be left alone, or answered with a server error), not this one account.
 */
function providerTrouble(error: unknown): boolean {
  if (error instanceof ReadTimeout) return true;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

/** The provider an account is read from: its kind of connection, and the server where it names one. */
function providerKey(provider: string, configuration: Record<string, unknown> | null): string {
  const kind = typeof configuration?.kind === 'string' ? configuration.kind : '';
  const server = (() => {
    const mail = (configuration?.mail as { imap?: { host?: unknown } } | undefined)?.imap?.host;
    if (typeof mail === 'string') return mail.toLowerCase();
    const calendar = (configuration?.caldav as { calendar_url?: unknown } | undefined)
      ?.calendar_url;
    if (typeof calendar === 'string' && URL.canParse(calendar)) return new URL(calendar).host;
    return '';
  })();
  return `${provider}:${kind}:${server}`;
}

/** What one read is allowed to do while it runs. */
type ReadContext = { generation: number; abandoned: boolean };

const clampInterval = (seconds: number) =>
  Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(seconds)));

/**
 * Why a read failed, as a fixed code. An account's error can carry an
 * address, a subject or a token in its words, so only its shape is logged.
 */
function failureCode(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `status_${status}`;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'read_failed';
}

/** What the person is told about an account that could not be read, in plain words. */
function failureWords(error: unknown): string {
  if (error instanceof CalendarTooLarge) return error.message;
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 429 || status === 503)
    return 'The account asked Melete to slow down; it is read again when it allows.';
  if (status === 401 || status === 403)
    return 'The account refused the sign-in Melete holds for it; signing in again lets it be read.';
  if ((error as { code?: unknown } | null)?.code === 'read_timeout')
    return 'The account took too long to answer; it is read again later.';
  return 'The account could not be read; it is tried again later.';
}

class ReadTimeout extends Error {
  readonly code = 'read_timeout';
}
class ReadAbandoned extends Error {
  readonly code = 'read_abandoned';
}

const shortCursor = (cursor: string) =>
  createHash('sha256').update(cursor).digest('hex').slice(0, 32);

export class SignalPoller {
  private started = false;
  /**
   * Per provider: failures in a row, and until when its reads are paused.
   * An outage or a rate limit at one provider pauses that provider's accounts
   * rather than holding the shared read slots on timeouts; the others go on.
   */
  private readonly breakers = new Map<
    string,
    { failures: number; openUntil: number; pause: number }
  >();

  /** Until when a provider's reads are paused, or null when they are not. */
  pausedUntil(providerKey: string): number | null {
    const breaker = this.breakers.get(providerKey);
    return breaker && breaker.openUntil > this.now() ? breaker.openUntil : null;
  }

  private providerFailed(providerKey: string, error: unknown) {
    if (!providerTrouble(error)) return;
    const breaker = this.breakers.get(providerKey) ?? { failures: 0, openUntil: 0, pause: 0 };
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_THRESHOLD) {
      breaker.pause = Math.min(
        MAX_POLL_SECONDS,
        breaker.pause ? breaker.pause * 2 : BREAKER_PAUSE_SECONDS,
      );
      const said = (error as { retryAfter?: unknown } | null)?.retryAfter;
      const pause =
        typeof said === 'number' && said > breaker.pause
          ? Math.min(MAX_RETRY_AFTER_SECONDS, said)
          : breaker.pause;
      breaker.openUntil = this.now() + pause * 1000;
      breaker.failures = 0;
      process.stderr.write(`signals: provider_paused ${pause}s\n`);
    }
    this.breakers.set(providerKey, breaker);
  }

  private providerWorked(providerKey: string) {
    this.breakers.delete(providerKey);
  }

  constructor(readonly deps: SignalPollerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The accounts some live trigger listens to, by stream, with the shortest
   * interval any of those triggers asked for. Decided from database rows
   * alone: the trigger, its job, and the connection's provider and sharing.
   */
  async demand(): Promise<Map<string, { spaceId: string; stream: Stream; seconds: number }>> {
    const rows = await this.deps.sql`
      select t.job_id, t.spec, j.state, c.id as connection_id, c.space_id, c.shared_use, c.provider
      from trigger t
        join job j on j.id = t.job_id
        join connection c on c.id = t.spec->>'connection_id'
      where t.enabled and t.kind in ('event', 'watch')
        and c.status = 'active' and c.space_id = j.space_id
        and t.spec->>'event_name' in ${this.deps.sql([MAIL_RECEIVED, ...CALENDAR_EVENT_NAMES])}
      order by c.id, t.job_id`;
    const wanted = new Map<string, { spaceId: string; stream: Stream; seconds: number }>();
    const audiences = new Map<string, JobConnectionAudience | null>();
    for (const row of rows) {
      const state = jobState.safeParse(row.state);
      if (!state.success || isTerminal(state.data)) continue;
      const spec = triggerSpec.safeParse(row.spec);
      if (!spec.success || spec.data.kind === 'schedule') continue;
      const stream = streamOf(spec.data.event_name);
      if (!stream || !producesEvent(String(row.provider), spec.data.event_name)) continue;
      const jobId = String(row.job_id);
      if (!audiences.has(jobId))
        audiences.set(jobId, await jobConnectionAudience(this.deps.sql, jobId));
      const audience = audiences.get(jobId);
      if (!audience || !connectionServesJob(audience, String(row.shared_use))) continue;
      const key = `${String(row.connection_id)} ${stream}`;
      const seconds = clampInterval(spec.data.poll_seconds);
      const before = wanted.get(key);
      wanted.set(key, {
        spaceId: String(row.space_id),
        stream,
        seconds: Math.min(before?.seconds ?? seconds, seconds),
      });
    }
    // Every connected mailbox and calendar a person keeps in their own space
    // is watched, with nothing set up; a room's, only when its owners say so.
    // What it reports still reaches only the work the connection serves.
    const watched = await this.deps.sql`
      select c.id, c.space_id, c.provider, c.watch_changes, s.kind
      from connection c join space s on s.id = c.space_id
      where c.status = 'active' and s.removed_at is null
        and c.provider in ${this.deps.sql(Object.keys(WATCHED_PROVIDERS))}`;
    for (const row of watched) {
      const watchChanges = row.watch_changes === null ? null : Boolean(row.watch_changes);
      if (!watchedByDefault(String(row.kind), watchChanges)) continue;
      const stream = WATCHED_PROVIDERS[String(row.provider)];
      if (!stream) continue;
      const key = `${String(row.id)} ${stream}`;
      const before = wanted.get(key);
      wanted.set(key, {
        spaceId: String(row.space_id),
        stream,
        seconds: Math.min(before?.seconds ?? DEFAULT_WATCH_SECONDS, DEFAULT_WATCH_SECONDS),
      });
    }
    return wanted;
  }

  /**
   * Keep one cursor for every account in demand, and none for any other. An
   * account nobody listens to any more loses its cursor and what was kept
   * about its calendar: when someone listens again, watching starts afresh.
   * A row is written only when it is new or its interval changed.
   */
  async refresh(): Promise<void> {
    const wanted = await this.demand();
    const { sql } = this.deps;
    const at = new Date(this.now()).toISOString();
    await sql.begin(async (tx) => {
      const existing = await tx`select connection_id, stream, interval_s from source_cursor`;
      const have = new Map(
        existing.map((row) => [`${row.connection_id} ${row.stream}`, Number(row.interval_s)]),
      );
      for (const row of existing) {
        if (wanted.has(`${row.connection_id} ${row.stream}`)) continue;
        await tx`delete from source_cursor
          where connection_id = ${row.connection_id} and stream = ${row.stream}`;
        if (row.stream === 'calendar')
          await tx`delete from subject_state
            where connection_id = ${row.connection_id} and type = 'calendar_occurrence'`;
      }
      for (const [key, value] of wanted) {
        if (have.get(key) === value.seconds) continue;
        const connectionId = key.split(' ')[0] ?? '';
        await tx`insert into source_cursor (connection_id, stream, space_id, interval_s, next_poll_at)
          values (${connectionId}, ${value.stream}, ${value.spaceId}, ${value.seconds}, ${at}::timestamptz)
          on conflict (connection_id, stream) do update set interval_s = excluded.interval_s
            where source_cursor.interval_s is distinct from excluded.interval_s`;
      }
    });
  }

  /** Take the accounts that are due, so no other instance reads them meanwhile. */
  private async claim(): Promise<CursorRow[]> {
    const at = new Date(this.now()).toISOString();
    const until = new Date(this.now() + CLAIM_SECONDS * 1000).toISOString();
    const rows = await this.deps.sql`
      update source_cursor s set next_poll_at = ${until}::timestamptz
      from (
        select connection_id, stream from source_cursor
        where next_poll_at <= ${at}::timestamptz
        order by next_poll_at
        limit ${ACCOUNTS_PER_CLAIM}
        for update skip locked
      ) due
      where s.connection_id = due.connection_id and s.stream = due.stream
      returning s.connection_id, s.stream, s.space_id, s.cursor, s.interval_s, s.failures,
        (select provider from connection c where c.id = s.connection_id) as provider,
        (select configuration from connection c where c.id = s.connection_id) as configuration`;
    return rows.map((row) => ({
      ...(row as unknown as CursorRow),
      provider_key: providerKey(
        String(row.provider ?? ''),
        (row.configuration as Record<string, unknown> | null) ?? null,
      ),
    }));
  }

  /** The scheduled work: one tick, when this instance leads. */
  async tick(): Promise<{ polled: number; delivered: number; failed: number } | null> {
    if (this.deps.leads && !(await this.deps.leads())) return null;
    return this.runOnce();
  }

  /** Refresh what is wanted, then read every account that is due, a few at a time. */
  async runOnce(): Promise<{ polled: number; delivered: number; failed: number }> {
    await this.refresh();
    const totals = { polled: 0, delivered: 0, failed: 0 };
    const began = Date.now();
    while (Date.now() - began < TICK_BUDGET_MS) {
      const claimed = await this.claim();
      if (!claimed.length) break;
      totals.polled += claimed.length;
      const queue = [...claimed];
      const workers = Array.from(
        { length: Math.min(this.deps.concurrency ?? READ_CONCURRENCY, queue.length) },
        async () => {
          for (let row = queue.shift(); row; row = queue.shift()) {
            const result = await this.readAccount(row);
            totals.delivered += result.delivered;
            if (result.failed) totals.failed += 1;
          }
        },
      );
      await Promise.all(workers);
      if (claimed.length < ACCOUNTS_PER_CLAIM) break;
    }
    return totals;
  }

  /** Put an account back for its next turn, with nothing else changed. */
  private async release(row: CursorRow, seconds: number) {
    await this.deps.sql`update source_cursor
      set next_poll_at = ${new Date(this.now() + seconds * 1000).toISOString()}::timestamptz
      where connection_id = ${row.connection_id} and stream = ${row.stream}`;
  }

  private async readAccount(row: CursorRow): Promise<{ delivered: number; failed: boolean }> {
    // Its provider is in trouble: left until the pause ends, with no failure counted.
    const paused = this.pausedUntil(row.provider_key);
    if (paused !== null) {
      await this.deps.sql`update source_cursor
        set next_poll_at = ${new Date(paused).toISOString()}::timestamptz,
          last_error = ${'The provider of this account is not answering for now; it is read again when it recovers.'}
        where connection_id = ${row.connection_id} and stream = ${row.stream}`;
      return { delivered: 0, failed: false };
    }
    let source: SignalSource | undefined;
    try {
      source = (
        this.deps.connectors.get(row.connection_id) ?? (await this.deps.load?.(row.connection_id))
      )?.signals;
    } catch {
      source = undefined;
    }
    // Not open here, and not openable: skipped this time, never forgotten.
    if (!source || source.stream !== row.stream) {
      await this.release(row, row.interval_s);
      return { delivered: 0, failed: false };
    }
    const [current] = await this.deps.sql`select generation, status from connection
      where id = ${row.connection_id}`;
    if (current?.status !== 'active') {
      await this.release(row, row.interval_s);
      return { delivered: 0, failed: false };
    }
    const context: ReadContext = { generation: Number(current.generation), abandoned: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = this.poll(row, source, context);
      // A read that outlives its time finishes on its own and is ignored.
      reading.catch(() => {});
      const read = await Promise.race([
        reading,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            context.abandoned = true;
            reject(new ReadTimeout('read timed out'));
          }, this.deps.readTimeoutMs ?? READ_TIMEOUT_MS);
        }),
      ]);
      await this.deps.sql`update source_cursor
        set cursor = ${JSON.stringify(read.cursor)}::jsonb, failures = 0, last_error = ${read.note ?? null},
          last_ok_at = ${new Date(this.now()).toISOString()}::timestamptz,
          next_poll_at = ${new Date(this.now() + row.interval_s * 1000).toISOString()}::timestamptz
        where connection_id = ${row.connection_id} and stream = ${row.stream}`;
      this.providerWorked(row.provider_key);
      return { delivered: read.delivered, failed: false };
    } catch (error) {
      context.abandoned = true;
      // The connection changed under the read: what it read is dropped, and
      // the next read starts from the account the connection now stands for.
      if (error instanceof ReadAbandoned) {
        await this.release(row, MIN_POLL_SECONDS);
        return { delivered: 0, failed: false };
      }
      // One account that cannot be read must not stop the rest. Its cursor
      // stays where it was, so nothing it holds is skipped, and it is tried
      // again later: when the provider says, or less often the longer it fails.
      const backoff = Math.min(
        MAX_POLL_SECONDS,
        row.interval_s * 2 ** Math.min(row.failures + 1, 6),
      );
      // A provider's own Retry-After, on a SourceError or a mailbox's own error.
      const said = (error as { retryAfter?: unknown } | null)?.retryAfter;
      const asked = typeof said === 'number' && said >= 0 ? said : null;
      const wait =
        error instanceof CalendarTooLarge
          ? MAX_POLL_SECONDS
          : asked !== null
            ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(asked, row.interval_s))
            : backoff;
      this.providerFailed(row.provider_key, error);
      await this.deps.sql`update source_cursor
        set failures = failures + 1, last_error = ${failureWords(error)},
          next_poll_at = ${new Date(this.now() + wait * 1000).toISOString()}::timestamptz
        where connection_id = ${row.connection_id} and stream = ${row.stream}`;
      process.stderr.write(
        `signals: read_failed ${failureCode(error)} ${row.connection_id} ${row.stream}\n`,
      );
      return { delivered: 0, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops a read whose connection changed, or that timed out, before it writes anything. */
  private async stillCurrent(row: CursorRow, context: ReadContext) {
    if (context.abandoned) throw new ReadAbandoned('read abandoned');
    const [current] = await this.deps.sql`select c.generation, c.status,
        exists (select 1 from source_cursor s
          where s.connection_id = c.id and s.stream = ${row.stream}) as wanted
      from connection c where c.id = ${row.connection_id}`;
    if (
      current?.status !== 'active' ||
      Number(current.generation) !== context.generation ||
      !current.wanted
    ) {
      context.abandoned = true;
      throw new ReadAbandoned('connection changed');
    }
  }

  /**
   * Deliver in order. An item that cannot be delivered is skipped and
   * reported, and the rest go on; a change to the connection itself stops the
   * whole read before the cursor moves.
   */
  private async deliverAll(
    connectionId: string,
    cursor: string,
    observations: Observation[],
    context: ReadContext,
  ) {
    let delivered = 0;
    let skipped = 0;
    for (const observation of observations) {
      if (context.abandoned) throw new ReadAbandoned('read abandoned');
      try {
        const result = await this.deps.triggers.deliver(
          {
            connection_id: connectionId,
            event_name: observation.event_name,
            cursor: shortCursor(cursor),
            dedup_key: observation.dedup_key,
            payload: observation.payload,
          },
          { generation: context.generation },
        );
        if (!result.duplicate) delivered += 1;
      } catch (error) {
        if (error instanceof ServiceError) {
          context.abandoned = true;
          throw new ReadAbandoned(error.code);
        }
        skipped += 1;
        process.stderr.write(
          `signals: item_skipped ${failureCode(error)} ${connectionId} ${observation.event_name}\n`,
        );
      }
    }
    // Every item failing says the store, not the items, is at fault.
    if (observations.length && skipped === observations.length)
      throw new Error('no item could be delivered');
    return delivered;
  }

  private async poll(
    row: CursorRow,
    source: SignalSource,
    context: ReadContext,
  ): Promise<{ cursor: object; delivered: number; note?: string | null }> {
    if (source.stream === 'mail') {
      const saved = (row.cursor as { value?: unknown } | null)?.value;
      const read = await source.changes(typeof saved === 'string' ? saved : null, {
        limit: MAIL_READ_LIMIT,
        now: this.now(),
        seen: async (key) => {
          const [found] = await this.deps.sql`select 1 from event
            where dedup_key = ${`connector:${row.connection_id}:${mailDedupKey(key)}`}`;
          return Boolean(found);
        },
      });
      const readAt = new Date(this.now()).toISOString();
      const observations: Observation[] = [];
      for (const message of read.messages) {
        try {
          observations.push(mailObservation(row.connection_id, message, readAt));
        } catch {
          process.stderr.write(`signals: item_skipped unreadable ${row.connection_id} mail\n`);
        }
      }
      await this.stillCurrent(row, context);
      return {
        cursor: { value: read.cursor },
        delivered: await this.deliverAll(row.connection_id, read.cursor, observations, context),
      };
    }
    const now = this.now();
    const window = {
      from: new Date(now).toISOString(),
      to: new Date(now + CALENDAR_WINDOW_DAYS * 86_400_000).toISOString(),
    };
    const read = await source.occurrences(window);
    const keptRows = await this.deps.sql`select subject_key, version, fields from subject_state
      where connection_id = ${row.connection_id} and type = 'calendar_occurrence'`;
    const kept = keptRows.map((entry) => ({
      subject_key: String(entry.subject_key),
      version: String(entry.version),
      fields: entry.fields as OccurrenceFields,
    })) as KeptOccurrence[];
    const saved = row.cursor as CalendarCursor;
    const previous = saved && typeof saved.window_end === 'string' ? saved : null;
    const input = { connectionId: row.connection_id, kept, read, previous, window, now };
    // Before anything is said about an occurrence the read no longer lists, it
    // is looked up again: moved out of the window is not cancelled.
    const confirmed = new Map<string, Lookup>();
    const unlisted = vanished(input);
    // A calendar that cannot look anything up can never say: nothing is said.
    if (!source.confirm) for (const entry of unlisted) confirmed.set(entry.subject_key, 'unknown');
    for (const entry of unlisted.slice(0, MAX_CONFIRMS)) {
      if (!source.confirm) break;
      try {
        confirmed.set(
          entry.subject_key,
          await source.confirm({
            uid: entry.fields.uid,
            occurrence: entry.fields.occurrence,
            ref: entry.fields.ref ?? null,
          }),
        );
      } catch {
        confirmed.set(entry.subject_key, 'failed');
      }
    }
    const diff = diffCalendar({ ...input, confirmed });
    await this.stillCurrent(row, context);
    const delivered = await this.deliverAll(
      row.connection_id,
      diff.window_end,
      diff.observations,
      context,
    );
    // What was kept moves only after everything it led to was delivered. A
    // stop in between reads the same differences next time, with the same
    // keys, so nothing is delivered twice and nothing is lost.
    await this.deps.sql.begin(async (tx) => {
      // Shared with other reads, exclusive of a revocation, a switch of
      // credential, or watching being turned off: if one of those committed
      // since this read began, nothing it found is kept.
      const [current] = await tx`select generation, status from connection
        where id = ${row.connection_id} for share`;
      const [wanted] = await tx`select 1 as present from source_cursor
        where connection_id = ${row.connection_id} and stream = ${row.stream}`;
      if (
        context.abandoned ||
        current?.status !== 'active' ||
        Number(current.generation) !== context.generation ||
        !wanted
      )
        throw new ReadAbandoned('connection changed');
      const at = new Date(now).toISOString();
      for (const entry of diff.upsert)
        await tx`insert into subject_state
            (subject_key, space_id, connection_id, type, fields, version, origin, last_changed_at)
          values (${entry.subject_key}, ${row.space_id}, ${row.connection_id}, 'calendar_occurrence',
            ${JSON.stringify(entry.fields)}::jsonb, ${entry.version}, 'external_content', ${at}::timestamptz)
          on conflict (subject_key) do update
            set fields = excluded.fields, version = excluded.version,
              last_changed_at = excluded.last_changed_at`;
      if (diff.remove.length)
        await tx`delete from subject_state
          where connection_id = ${row.connection_id} and subject_key in ${tx(diff.remove)}`;
    });
    return { cursor: { window_end: diff.window_end }, delivered, note: diff.note ?? null };
  }

  /** Reads on the service's own periodic scheduling, pg-boss, once a minute, when leading. */
  async start(): Promise<void> {
    if (this.started) return;
    const boss = this.deps.triggers.jobs.boss;
    await boss.work(QUEUES.triggerPoll, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async () => {
      await this.tick();
    });
    await boss.schedule(QUEUES.triggerPoll, '* * * * *', {});
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started)
      await this.deps.triggers.jobs.boss.offWork(QUEUES.triggerPoll, { wait: false });
    this.started = false;
  }
}
