/**
 * The recorder's queue, without Postgres: a database that never answers holds
 * at most `maxPending` writes, and the rest are dropped, counted and said once.
 */
import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { egressRecorder } from './records.ts';

test('writes past the queue bound are dropped and counted, and the drop is said once', () => {
  let queries = 0;
  // Every query waits forever, as a database that has stopped answering does.
  const stalled = (() => {
    queries += 1;
    return new Promise(() => {});
  }) as unknown as Sql;
  const lines: string[] = [];
  const recorder = egressRecorder(stalled, (line) => lines.push(line), { maxPending: 3 });
  for (let each = 0; each < 10; each += 1)
    recorder.opened({
      id: `egr_${each}`,
      sessionId: 'sbx_a',
      jobId: null,
      attemptId: null,
      actionId: null,
      tokenKind: null,
      host: 'blocked.example',
      port: 443,
      verdict: 'refused',
      reason: 'host_not_connected',
      count: 1,
      openedAt: new Date(),
      closedAt: new Date(),
    });
  recorder.counted('egr_0', 7);
  recorder.closed('egr_1', { bytesUp: 1, bytesDown: 1, closedAt: new Date() });
  expect(queries).toBe(3);
  expect(recorder.dropped).toBe(9);
  expect(lines).toEqual([
    'egress records are arriving faster than Postgres takes them; dropping until it catches up',
  ]);
});
