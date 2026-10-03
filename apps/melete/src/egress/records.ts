/**
 * Writing what the egress guard saw to `egress_record`, and reading it back.
 *
 * The guard runs on sockets and never waits for Postgres: a record is queued
 * when a connection opens or is refused, completed when it closes, and a
 * coalesced refusal's count is written as it grows. A write that fails is
 * reported on stderr and the connection carries on, because the guard's
 * decisions do not depend on the record; the command's receipt takes its host
 * list from the guard itself. The queue is bounded: past `maxPending` writes in
 * flight, further writes are dropped and counted, and the first drop is logged.
 */
import type { Sql } from 'postgres';
import type { EgressVerdict } from './schema.ts';
import {
  type EgressHostCounters,
  type EgressHostSummary,
  type EgressTokenKind,
  hostCounters,
  summarize,
} from './tokens.ts';

export type EgressRecordOpen = {
  id: string;
  /** The session the computer serves; the space is read from it. */
  sessionId: string;
  jobId: string | null;
  attemptId: string | null;
  actionId: string | null;
  tokenKind: EgressTokenKind | null;
  host: string;
  port: number;
  verdict: EgressVerdict;
  reason: string | null;
  /** How many connections this record stands for; more than one once repeats are coalesced. */
  count: number;
  openedAt: Date;
  /** Set for a refusal, which is over as soon as it is recorded. */
  closedAt?: Date;
  /** The command-line account a `credentialed` tunnel used. */
  connectionId?: string | null;
};

export type EgressRecordClose = {
  bytesUp: number;
  bytesDown: number;
  closedAt: Date;
  /** For a credentialed tunnel: the requests that read, and the writes with their actions. */
  reads?: number;
  writes?: number;
  writeActionIds?: string[];
};

/** Where the guard sends what it saw. No call may throw or block the guard. */
export interface EgressRecordSink {
  opened(record: EgressRecordOpen): void;
  closed(id: string, totals: EgressRecordClose): void;
  /** A coalesced record now stands for this many connections. */
  counted(id: string, count: number): void;
}

/** Hosts and ports as they reach a column: bounded, and never a control character. */
const column = (value: string, max: number) => value.replace(/\p{Cc}/gu, '?').slice(0, max);

/** Writes in flight before further ones are dropped. */
export const DEFAULT_MAX_PENDING_RECORDS = 1_000;

export type EgressRecorder = EgressRecordSink & {
  /** Waits for every queued write; for shutdown and tests. */
  flush(): Promise<void>;
  /** Writes dropped because the queue was full. */
  readonly dropped: number;
};

export function egressRecorder(
  sql: Sql,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  options: { maxPending?: number } = {},
): EgressRecorder {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_RECORDS;
  const inserts = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();
  let dropped = 0;
  let dropping = false;
  /** Whether there is room for one more write; a full queue drops it and says so once. */
  const room = () => {
    if (pending.size < maxPending) {
      if (dropping && pending.size === 0) {
        say(`egress records are being written again; ${dropped} were dropped in all`);
        dropping = false;
      }
      return true;
    }
    dropped += 1;
    if (!dropping) {
      dropping = true;
      say(
        `egress records are arriving faster than Postgres takes them; dropping until it catches up`,
      );
    }
    return false;
  };
  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };
  const failed = (what: string) => (error: unknown) =>
    say(`an egress record could not be ${what}: ${String((error as Error)?.message ?? error)}`);
  /** A later write to a record waits for its insert, if that is still in flight. */
  const after = (id: string, write: () => Promise<void>) => {
    if (!room()) return;
    track((inserts.get(id) ?? Promise.resolve()).then(write));
  };

  return {
    opened(record) {
      if (!room()) return;
      // The space comes from the session row, so a record can never name a
      // space other than the one its computer belongs to.
      const work = track(
        sql`insert into egress_record (id, session_id, space_id, job_id, attempt_id, action_id,
            token_kind, host, port, verdict, reason, count, opened_at, closed_at, connection_id)
          select ${record.id}::text, s.id, s.space_id, ${record.jobId}::text,
            ${record.attemptId}::text, ${record.actionId}::text, ${record.tokenKind}::text,
            ${column(record.host, 255)}::text, ${record.port}::int, ${record.verdict}::text,
            ${record.reason}::text, ${record.count}::int, ${record.openedAt.toISOString()}::timestamptz,
            ${record.closedAt?.toISOString() ?? null}::timestamptz,
            ${record.connectionId ?? null}::text
          from sandbox_session s where s.id = ${record.sessionId}`.then(
          () => {},
          failed('written'),
        ),
      );
      inserts.set(record.id, work);
      void work.finally(() => {
        if (inserts.get(record.id) === work) inserts.delete(record.id);
      });
    },
    closed(id, totals) {
      after(id, () =>
        sql`update egress_record set bytes_up = ${totals.bytesUp},
            bytes_down = ${totals.bytesDown}, closed_at = ${totals.closedAt.toISOString()},
            reads = ${totals.reads ?? 0}, writes = ${totals.writes ?? 0},
            write_action_ids = ${JSON.stringify((totals.writeActionIds ?? []).slice(0, 256))}::jsonb
          where id = ${id}`.then(() => {}, failed('completed')),
      );
    },
    counted(id, count) {
      after(id, () =>
        sql`update egress_record set count = greatest(count, ${count}::int) where id = ${id}`.then(
          () => {},
          failed('counted'),
        ),
      );
    },
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
    get dropped() {
      return dropped;
    },
  };
}

/** What one command reached, from its records: for a receipt read back after the fact. */
export async function egressHostsFor(sql: Sql, actionId: string): Promise<EgressHostSummary[]> {
  const rows = await sql<
    {
      host: string;
      tunnels: number;
      refused: number;
      bytes_up: number;
      bytes_down: number;
      credentialed: boolean;
      reads: number;
      writes: number;
    }[]
  >`select host,
      coalesce(sum(count) filter (where verdict in ('tunnel', 'credentialed', 'unattributed')), 0)::int
        as tunnels,
      coalesce(sum(count) filter (where verdict = 'refused'), 0)::int as refused,
      coalesce(sum(bytes_up), 0)::float8 as bytes_up,
      coalesce(sum(bytes_down), 0)::float8 as bytes_down,
      coalesce(bool_or(verdict = 'credentialed'), false) as credentialed,
      coalesce(sum(reads), 0)::int as reads,
      coalesce(sum(writes), 0)::int as writes
    from egress_record where action_id = ${actionId} and verdict <> 'suppressed'
    group by host order by host`;
  const hosts = new Map<string, EgressHostCounters>();
  for (const row of rows) {
    const counters = hostCounters(hosts, row.host);
    counters.tunnels += Number(row.tunnels);
    counters.refused += Number(row.refused);
    counters.bytesUp += Number(row.bytes_up);
    counters.bytesDown += Number(row.bytes_down);
    if (row.credentialed) {
      counters.credentialed = true;
      counters.reads = (counters.reads ?? 0) + Number(row.reads);
      counters.writes = (counters.writes ?? 0) + Number(row.writes);
    }
  }
  return summarize(hosts);
}

/** Removes records older than the retention period; answers how many went. */
export async function expireEgressRecords(sql: Sql, days: number): Promise<number> {
  const removed = await sql`delete from egress_record
    where opened_at < now() - make_interval(days => ${days})`;
  return removed.count;
}

/** Runs the retention sweep now and then hourly; answers how to stop it. */
export function startEgressRetention(
  sql: Sql,
  days: number,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  const sweep = () =>
    void expireEgressRecords(sql, days).catch((error: unknown) =>
      say(`egress record retention failed: ${String((error as Error)?.message ?? error)}`),
    );
  sweep();
  const timer = setInterval(sweep, 60 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
