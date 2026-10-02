/**
 * Writing what the egress guard saw to `egress_record`, and reading it back.
 *
 * The guard runs on sockets and never waits for Postgres: a record is queued
 * when a connection opens or is refused and completed when it closes. A write
 * that fails is reported on stderr and the connection carries on, because the
 * guard's decisions do not depend on the record; the command's receipt takes
 * its host list from the guard itself.
 */
import type { Sql } from 'postgres';
import type { EgressVerdict } from './schema.ts';
import type { EgressHostSummary, EgressTokenKind } from './tokens.ts';

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
  openedAt: Date;
  /** Set for a refusal, which is over as soon as it is recorded. */
  closedAt?: Date;
};

export type EgressRecordClose = { bytesUp: number; bytesDown: number; closedAt: Date };

/** Where the guard sends what it saw. Neither call may throw or block the guard. */
export interface EgressRecordSink {
  opened(record: EgressRecordOpen): void;
  closed(id: string, totals: EgressRecordClose): void;
}

/** Hosts and ports as they reach a column: bounded, and never a control character. */
const column = (value: string, max: number) => value.replace(/\p{Cc}/gu, '?').slice(0, max);

export type EgressRecorder = EgressRecordSink & {
  /** Waits for every queued write; for shutdown and tests. */
  flush(): Promise<void>;
};

export function egressRecorder(
  sql: Sql,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): EgressRecorder {
  const inserts = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };
  const failed = (what: string) => (error: unknown) =>
    say(`an egress record could not be ${what}: ${String((error as Error)?.message ?? error)}`);

  return {
    opened(record) {
      // The space comes from the session row, so a record can never name a
      // space other than the one its computer belongs to.
      const work = track(
        sql`insert into egress_record (id, session_id, space_id, job_id, attempt_id, action_id,
            token_kind, host, port, verdict, reason, opened_at, closed_at)
          select ${record.id}::text, s.id, s.space_id, ${record.jobId}::text,
            ${record.attemptId}::text, ${record.actionId}::text, ${record.tokenKind}::text,
            ${column(record.host, 255)}::text, ${record.port}::int, ${record.verdict}::text,
            ${record.reason}::text, ${record.openedAt.toISOString()}::timestamptz,
            ${record.closedAt?.toISOString() ?? null}::timestamptz
          from sandbox_session s where s.id = ${record.sessionId}`.then(
          () => {},
          failed('written'),
        ),
      );
      if (!record.closedAt) inserts.set(record.id, work);
    },
    closed(id, totals) {
      const inserted = inserts.get(id) ?? Promise.resolve();
      inserts.delete(id);
      track(
        inserted.then(() =>
          sql`update egress_record set bytes_up = ${totals.bytesUp},
              bytes_down = ${totals.bytesDown}, closed_at = ${totals.closedAt.toISOString()}
            where id = ${id}`.then(() => {}, failed('completed')),
        ),
      );
    },
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

/** What one command reached, from its records: for a receipt read back after the fact. */
export async function egressHostsFor(sql: Sql, actionId: string): Promise<EgressHostSummary[]> {
  const rows = await sql<
    { host: string; tunnels: number; refused: number; bytes_up: number; bytes_down: number }[]
  >`select host,
      count(*) filter (where verdict <> 'refused')::int as tunnels,
      count(*) filter (where verdict = 'refused')::int as refused,
      coalesce(sum(bytes_up), 0)::float8 as bytes_up,
      coalesce(sum(bytes_down), 0)::float8 as bytes_down
    from egress_record where action_id = ${actionId}
    group by host order by host`;
  return rows.map((row) => ({
    host: row.host,
    tunnels: Number(row.tunnels),
    refused: Number(row.refused),
    bytes_up: Number(row.bytes_up),
    bytes_down: Number(row.bytes_down),
  }));
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
