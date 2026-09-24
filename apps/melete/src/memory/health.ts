import type { MemorySql } from './db.ts';

export type MemoryHealth = {
  status: 'ok' | 'waiting';
  waiting: number;
  /** Messages given up in the last day: refused calls, or an outage that outlasted the backoff. */
  failed: number;
  reason: 'provider_unavailable' | 'daily_budget' | null;
};

/**
 * What an operator needs to see about automatic memory: how many messages are
 * waiting to be read because the memory model's provider is not answering or
 * the daily reads are spent, and which of the two it is now. Counts only.
 */
export async function memoryHealth(sql: MemorySql): Promise<MemoryHealth> {
  const [row] = await sql`select count(*)::int as waiting,
      (array_agg(error_code order by retry_at desc))[1] as latest
    from memory_work where status = 'pending' and retry_at is not null
      and error_code in ('extraction_provider_unavailable', 'memory_daily_budget')`;
  const waiting = Number(row?.waiting ?? 0);
  const [gone] = await sql`select count(*)::int as failed from memory_work
    where status = 'rejected' and created_at > clock_timestamp() - interval '1 day'
      and (error_code in ('extraction_call_refused', 'extraction_provider_refused')
        or error_code like '%:given_up')`;
  return {
    status: waiting ? 'waiting' : 'ok',
    waiting,
    failed: Number(gone?.failed ?? 0),
    reason: !waiting
      ? null
      : row?.latest === 'memory_daily_budget'
        ? 'daily_budget'
        : 'provider_unavailable',
  };
}
