/**
 * The wake queue. pg-boss runs in the same Postgres as the state, so a job
 * transition and the enqueue of its next wake commit in one transaction.
 *
 * v0.1 skeleton: the queue is wired and named, and no handler is registered
 * yet. W1 adds the attempt worker, the cron trigger, and the recovery scan.
 */
import { PgBoss } from 'pg-boss';

/** The only queues v0.1 uses. Naming them here keeps the set closed. */
export const QUEUES = {
  /** One bounded attempt for one job. */
  attempt: 'melete.attempt',
  /** Re-enqueues jobs whose next_wake_at passed with no live wake. */
  recoveryScan: 'melete.recovery-scan',
  /** Polls connectors that carry a cursor instead of a webhook. */
  triggerPoll: 'melete.trigger-poll',
  /** Retries verify for actions that came back unknown. */
  reconcile: 'melete.reconcile',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const RECOVERY_SCAN_SECONDS = 60;

export type AttemptWake = {
  job_id: string;
  /** The epoch the wake was scheduled for; a stale wake is dropped, not run. */
  expected_epoch: number;
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
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  await boss.start();
  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue);
  }
  return { boss, stop: () => boss.stop({ graceful: true }) };
}
