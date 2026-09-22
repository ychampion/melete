import { inArray } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { action } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { DiscriminationInput } from './discriminate.ts';
import type { EpisodeRow } from './episodes.ts';

/**
 * The recorded answers on either side of a correction, with the actions each came
 * with. Actions up to the correction belong to the answer the owner objected to;
 * the corrective job's actions, or this job's later ones, belong to the corrected one.
 */
export async function discriminationInput(
  db: Database | Transaction,
  source: EpisodeRow,
): Promise<DiscriminationInput> {
  const rows = await db
    .select({
      jobId: action.jobId,
      kind: action.kind,
      effectClass: action.effectClass,
      status: action.status,
      createdAt: action.createdAt,
    })
    .from(action)
    .where(
      inArray(action.jobId, [
        source.jobId,
        ...(source.correctiveJobId ? [source.correctiveJobId] : []),
      ]),
    );
  return {
    prior: source.priorOutput,
    corrected: source.correctedOutput,
    priorActions: rows.filter(
      (row) => row.jobId === source.jobId && row.createdAt <= source.createdAt,
    ),
    correctedActions: rows.filter((row) =>
      source.correctiveJobId
        ? row.jobId === source.correctiveJobId
        : row.jobId === source.jobId && row.createdAt > source.createdAt,
    ),
  };
}
