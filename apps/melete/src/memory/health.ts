import type { MemorySql } from './db.ts';

/** Why the latest message given up was not read, in words an operator can act on. */
export type MemoryFailure =
  | 'provider_auth'
  | 'provider_refused'
  | 'provider_unavailable'
  | 'provider_slow'
  | 'daily_budget'
  | 'unreadable_answer'
  | 'too_large'
  | 'no_memory_model'
  | 'other';

export type MemoryHealth = {
  status: 'ok' | 'waiting';
  waiting: number;
  /** Messages whose reading was given up in the last day, for any reason. */
  failed: number;
  reason: 'provider_unavailable' | 'provider_slow' | 'daily_budget' | null;
  /** Why the most recent of those was given up; null when none was. */
  failed_reason: MemoryFailure | null;
};

/**
 * The codes a message's reading ends on when the read itself failed. A message
 * kept private on purpose was not lost, and a change set the extractor proposed
 * but memory refused is recorded at /memory/rejections instead.
 */
export function isExtractionFailure(code: string): boolean {
  if (code.endsWith(':given_up')) return true;
  if (code === 'no_extraction_gateway') return true;
  return code.startsWith('extraction_') && code !== 'extraction_kept_private';
}

/** The readable reason for a failure code. */
export function describeFailure(code: string): MemoryFailure {
  const base = code.replace(/:given_up$/, '');
  switch (base) {
    case 'extraction_provider_auth':
      return 'provider_auth';
    case 'extraction_provider_refused':
      return 'provider_refused';
    case 'extraction_provider_unavailable':
      return 'provider_unavailable';
    case 'extraction_provider_timeout':
      return 'provider_slow';
    case 'memory_daily_budget':
      return 'daily_budget';
    case 'extraction_unreadable':
    case 'extraction_response_size':
      return 'unreadable_answer';
    case 'extraction_call_refused':
    case 'extraction_input_size':
    case 'extraction_budget':
      return 'too_large';
    case 'no_extraction_gateway':
      return 'no_memory_model';
    default:
      return 'other';
  }
}

/**
 * What an operator needs to see about automatic memory: how many messages are
 * waiting to be read because the memory model's provider is not answering or
 * the daily reads are spent, and which it is now: not answering, answering too
 * slowly, or out of reads; and how many were given up in the last day, and why
 * the latest was. Counts only.
 */
export async function memoryHealth(sql: MemorySql): Promise<MemoryHealth> {
  const [row] = await sql`select count(*)::int as waiting,
      (array_agg(error_code order by retry_at desc))[1] as latest
    from memory_work where status = 'pending' and retry_at is not null
      and error_code in ('extraction_provider_unavailable', 'extraction_provider_timeout', 'memory_daily_budget')`;
  const waiting = Number(row?.waiting ?? 0);
  const failures = await sql`select error_code, count(*)::int as n, max(created_at) as latest
    from memory_work
    where status = 'rejected' and error_code is not null
      and created_at > clock_timestamp() - interval '1 day'
    group by error_code`;
  const failed = failures.filter((f) => isExtractionFailure(String(f.error_code)));
  const latest = failed.reduce<(typeof failed)[number] | undefined>(
    (best, f) =>
      !best || new Date(f.latest).getTime() > new Date(best.latest).getTime() ? f : best,
    undefined,
  );
  return {
    status: waiting ? 'waiting' : 'ok',
    waiting,
    failed: failed.reduce((sum, f) => sum + Number(f.n), 0),
    reason: !waiting
      ? null
      : row?.latest === 'memory_daily_budget'
        ? 'daily_budget'
        : row?.latest === 'extraction_provider_timeout'
          ? 'provider_slow'
          : 'provider_unavailable',
    failed_reason: latest ? describeFailure(String(latest.error_code)) : null,
  };
}
