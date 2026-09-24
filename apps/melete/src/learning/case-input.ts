/**
 * The input a request carries with it.
 *
 * Some objectives are the work: a table to arrange arrives inside the request.
 * A check that has to compare what came back with what went in — `records_sorted`
 * with `preserve_rows` — can then run on the owner's own history and on the
 * episode the procedure was learned from, instead of failing for want of an
 * answer key it was never going to be given.
 *
 * A request that is prose carries nothing, and such a check fails on it: never
 * silently skipped, and never passed for free.
 */
import { recordTask, TASK_PREFIX } from '../../../../conformance/learning/records.ts';
import type { RecordRow } from './checks.ts';

export type CaseInput = { columns: string[]; rows: RecordRow[] };

export function caseInput(objective: string): CaseInput | undefined {
  if (!objective.startsWith(TASK_PREFIX)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(objective.slice(TASK_PREFIX.length));
  } catch {
    return undefined;
  }
  const parsed = recordTask.safeParse(value);
  if (!parsed.success) return undefined;
  return { columns: [...parsed.data.columns], rows: [...parsed.data.rows] };
}
