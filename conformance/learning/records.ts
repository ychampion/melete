import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const row = z.record(z.string(), z.union([z.string(), z.number()]));
export const recordTask = z.strictObject({
  columns: z.array(z.string()).min(2).max(10),
  rows: z.array(row).min(2).max(20),
  key: z.string(),
  type: z.enum(['number', 'text', 'date']),
  direction: z.enum(['ascending', 'descending']),
  dateFormat: z.enum(['iso', 'dmy']).default('iso'),
});
export type RecordTask = z.infer<typeof recordTask>;
export type RecordCase = { template: string; task: RecordTask; expectedIds: string[] };
export const TASK_PREFIX =
  'Arrange the supplied records by the declared key, type and direction. Return only JSON with columns and rows.\n';
export const taskObjective = (task: RecordTask) => TASK_PREFIX + JSON.stringify(task);
export const recordOutput = z.strictObject({ columns: z.array(z.string()), rows: z.array(row) });
export type RecordOutput = z.infer<typeof recordOutput>;

/** Fixed expected row identities are fixture data; the grader does not reuse the runtime's sorting code. */
export function gradeRecords(value: RecordCase, summary: string): boolean {
  try {
    const output = recordOutput.parse(JSON.parse(summary));
    const expected = value.expectedIds.map((id) => value.task.rows.find((item) => item.id === id));
    return (
      expected.every(Boolean) &&
      isDeepStrictEqual(output.columns, value.task.columns) &&
      isDeepStrictEqual(output.rows, expected)
    );
  } catch {
    return false;
  }
}
