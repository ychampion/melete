import { sql } from 'drizzle-orm';
import type { Transaction } from './transaction.ts';

/** Lease writes and admission share Postgres time with the recovery and wake scans. */
export async function databaseNow(tx: Transaction): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  return row?.now instanceof Date ? row.now : new Date(String(row?.now));
}
