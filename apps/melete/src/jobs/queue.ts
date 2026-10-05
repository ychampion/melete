/**
 * The wake queue. pg-boss runs in the same Postgres as the state, so a job
 * transition and the enqueue of its next wake commit in one transaction.
 *
 * The runner registers bounded attempt and recovery workers after startup.
 */

import { type SchedulingClass, schedulingClass } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss } from 'pg-boss';
import { type VerifyingTls, verifyingTls } from '../db/tls.ts';
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
  /** Continues a bounded scan through observations already delivered to a watch. */
  triggerScan: 'melete.trigger-scan',
  /** Retries verify for actions that came back unknown. */
  reconcile: 'melete.reconcile',
  operation: 'melete.operation',
  /** Looks for a company writing back to a chase that is waiting on a reply. */
  companyReplies: 'melete.company-replies',
  /** Sends what a person's devices may be told, once a minute. */
  pushDispatch: 'melete.push-dispatch',
  /** Looks at the clocks that are due: deadlines and waits on a reply. */
  clockSweep: 'melete.clock-sweep',
  /** Texts and calls to a person's own number that are due: the reach-me ladder. */
  reachSweep: 'melete.reach-sweep',
} as const;

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
 * The queue's connection, with DATABASE_URL read as the service's own client
 * and libpq read it. pg-boss's driver reads `sslmode=require` as verify-full,
 * reads `sslrootcert=system` as a file named "system", and, like the service's
 * client, checks an IP-addressed server against "localhost". So, when no root
 * certificate file is named:
 * - `verify-ca`, `verify-full` and `sslrootcert=system` leave the URL, and the
 *   server is checked against the URL's own host (db/tls.ts), with Node's
 *   authorities plus NODE_EXTRA_CA_CERTS;
 * - `require` leaves the URL, and TLS is asked for without verifying the
 *   certificate, which is what `require` means to libpq.
 * Every other setting stays as written.
 */
export function queueConnection(connectionString: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: false } | VerifyingTls;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString };
  }
  const rootCert = url.searchParams.get('sslrootcert');
  if (rootCert !== null && rootCert !== 'system') return { connectionString };
  const verifying = verifyingTls(connectionString);
  if (verifying) {
    url.searchParams.delete('sslmode');
    url.searchParams.delete('sslrootcert');
    return { connectionString: url.toString(), ssl: verifying };
  }
  if (rootCert === 'system') {
    url.searchParams.delete('sslrootcert');
    return { connectionString: url.toString() };
  }
  if (url.searchParams.get('sslmode') !== 'require') return { connectionString };
  url.searchParams.delete('sslmode');
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
}

/**
 * Whether the queue creates its own schema: yes with one database role; no
 * with separate roles, where the database's setup step creates the schema for
 * the service's role, which may not create schemas (db/roles.ts).
 */
export const queueCreatesSchema = (env: { MELETE_EFFECTS_DATABASE_URL?: string | undefined }) =>
  !env.MELETE_EFFECTS_DATABASE_URL;

/**
 * Start pg-boss against the same connection string the service uses. The
 * tables are created on first start; nothing is scheduled here.
 */
export async function startQueue(
  connectionString: string,
  { createSchema = true }: { createSchema?: boolean } = {},
): Promise<QueueHandle> {
  const boss = new PgBoss({
    ...queueConnection(connectionString),
    schema: 'pgboss',
    max: 4,
    createSchema,
  });
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
