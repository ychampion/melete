/**
 * The wake queue. pg-boss runs in the same Postgres as the state, so a job
 * transition and the enqueue of its next wake commit in one transaction.
 *
 * The runner registers bounded attempt and recovery workers after startup.
 */

import { type SchedulingClass, schedulingClass } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss } from 'pg-boss';
import type { Transaction } from '../db/transaction.ts';

/** The only queues v0.1 uses. Naming them here keeps the set closed. */
export const QUEUES = {
  /** One bounded attempt for one job. */
  attempt: 'job.wake.interactive',
  background: 'job.wake.background',
  quiet: 'job.wake.quiet',
  legacyAttempt: 'job.wake',
  /** Re-enqueues jobs whose next_wake_at passed with no live wake. */
  recoveryScan: 'melete.recovery-scan',
  /** Polls connectors that carry a cursor instead of a webhook. */
  triggerPoll: 'melete.trigger-poll',
  /** A persisted schedule occurrence, converted to a job wake after matching the wait. */
  triggerSchedule: 'job.trigger',
  /** Retries verify for actions that came back unknown. */
  reconcile: 'melete.reconcile',
  operation: 'melete.operation',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const ATTEMPT_QUEUES: Record<SchedulingClass, string> = {
  interactive: QUEUES.attempt,
  background: QUEUES.background,
  quiet: QUEUES.quiet,
};
export const attemptQueue = (value: string) => ATTEMPT_QUEUES[schedulingClass.parse(value)];

export const RECOVERY_SCAN_SECONDS = 60;

export type AttemptWake = {
  job_id: string;
  /** The epoch the wake was scheduled for; a stale wake is dropped, not run. */
  expected_epoch: number;
  /** A timer from an earlier wait must not wake a later wait in the same epoch. */
  expected_version: number;
  reason: 'created' | 'input' | 'approval' | 'timer' | 'event' | 'recovery';
};

export type QueueHandle = {
  boss: PgBoss;
  stop: () => Promise<void>;
};

/**
 * Start pg-boss against the same connection string the service uses. The
 * schema is created on first start; nothing is scheduled here.
 */
export async function startQueue(connectionString: string): Promise<QueueHandle> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', max: 4 });
  boss.on('error', (error) => process.stderr.write(`pg-boss: ${error.message}\n`));
  try {
    await boss.start();
    for (const queue of Object.values(QUEUES)) {
      await boss.createQueue(queue);
    }
  } catch (error) {
    await boss.stop({ graceful: false });
    throw error;
  }
  return { boss, stop: () => boss.stop({ graceful: true, timeout: 1000 }) };
}

/** The Drizzle adapter executes enqueue SQL on the very same transaction client. */
export async function enqueueWake(
  boss: PgBoss,
  tx: Transaction,
  wake: AttemptWake,
  at: Date,
  scheduling: SchedulingClass = 'interactive',
): Promise<string | null> {
  return boss.send(attemptQueue(scheduling), wake, {
    db: fromDrizzle(tx, sql),
    startAfter: at,
    retryLimit: 0,
    expireInSeconds: 1800,
  });
}
