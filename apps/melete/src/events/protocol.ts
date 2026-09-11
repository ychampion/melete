import {
  eventReset,
  eventRetentionGap,
  type ResponsibilitySnapshot,
  responsibilitySnapshot,
} from '@melete/contracts';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { action, event, eventRetention, job } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { jobView } from '../jobs/service.ts';
import { requireJobAccess, visibleJob } from '../principals/authority.ts';

type Position = { cursor: number; epoch: number | null; retainedAfter: number };
export type StreamHandshake = Position & { frames: string[] };
export function controlFrame(type: 'reset' | 'gap', data: unknown, cursor?: number) {
  return `${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
export class EventProtocol {
  constructor(readonly db: Database) {}
  private async position(tx: Transaction, jobId?: string): Promise<Position> {
    const [head] = await tx
      .select({ seq: sql<number>`coalesce(max(${event.seq}), 0)::bigint` })
      .from(event);
    const [retention] = await tx
      .select()
      .from(eventRetention)
      .where(eq(eventRetention.id, 'global'));
    const [current] = jobId
      ? await tx.select({ epoch: job.leaseEpoch }).from(job).where(eq(job.id, jobId))
      : [];
    return {
      cursor: Number(head?.seq ?? 0),
      epoch: current?.epoch ?? null,
      retainedAfter: retention?.retainedAfter ?? 0,
    };
  }
  private async capture(
    tx: Transaction,
    position: Position,
    jobId?: string,
    principalId?: string,
  ): Promise<ResponsibilitySnapshot> {
    const jobs = await tx
      .select()
      .from(job)
      .where(and(jobId ? eq(job.id, jobId) : undefined, visibleJob(job.id, principalId)));
    const actions = await tx
      .select()
      .from(action)
      .where(
        and(jobId ? eq(action.jobId, jobId) : undefined, visibleJob(action.jobId, principalId)),
      );
    return responsibilitySnapshot.parse({
      cursor: position.cursor,
      epoch: position.epoch,
      jobs: jobs.map(jobView),
      actions: actions.map((row) => ({
        id: row.id,
        job_id: row.jobId,
        status: row.status,
        dispatched_at: row.dispatchedAt?.toISOString() ?? null,
        receipt: row.receipt,
      })),
    });
  }
  async snapshot(jobId?: string, principalId?: string) {
    return serviceTransaction(this.db, async (tx) => {
      if (jobId && principalId) await requireJobAccess(tx, jobId, principalId);
      return this.capture(tx, await this.position(tx, jobId), jobId, principalId);
    });
  }
  async handshake(
    after: number,
    jobId?: string,
    epoch?: number | null,
    resync = false,
    principalId?: string,
  ): Promise<StreamHandshake> {
    return serviceTransaction(this.db, async (tx) => {
      if (jobId && principalId) await requireJobAccess(tx, jobId, principalId);
      const position = await this.position(tx, jobId);
      let observedEpoch = epoch;
      if (jobId && after > 0 && observedEpoch === undefined) {
        const [prior] = await tx
          .select({ epoch: event.epoch })
          .from(event)
          .where(and(eq(event.jobId, jobId), lte(event.seq, after)))
          .orderBy(desc(event.seq))
          .limit(1);
        observedEpoch = prior?.epoch ?? null;
      }
      const reason = resync
        ? 'resync'
        : after < position.retainedAfter
          ? 'retention'
          : after > position.cursor
            ? 'cursor_ahead'
            : jobId && observedEpoch === null
              ? 'unknown_epoch'
              : jobId && observedEpoch !== undefined && observedEpoch !== position.epoch
                ? 'epoch_changed'
                : null;
      const frames: string[] = [];
      if (after < position.retainedAfter)
        frames.push(
          controlFrame(
            'gap',
            eventRetentionGap.parse({
              type: 'gap',
              reason: 'retention',
              after,
              retained_after: position.retainedAfter,
            }),
          ),
        );
      if (reason)
        frames.push(
          controlFrame(
            'reset',
            eventReset.parse({
              type: 'reset',
              reason,
              cursor: position.cursor,
              epoch: position.epoch,
              snapshot: await this.capture(tx, position, jobId, principalId),
            }),
            position.cursor,
          ),
        );
      return { ...position, frames };
    });
  }
  /** Limit transport replay only. Admission history and canonical tool identities remain durable. */
  async retainAfter(through: number) {
    if (!Number.isSafeInteger(through) || through < 0) throw new Error('Invalid retention cursor');
    return serviceTransaction(this.db, async (tx) => {
      const position = await this.position(tx);
      const retainedAfter = Math.max(position.retainedAfter, Math.min(through, position.cursor));
      await tx
        .insert(eventRetention)
        .values({ id: 'global', retainedAfter })
        .onConflictDoUpdate({ target: eventRetention.id, set: { retainedAfter } });
      await tx.execute(sql`select pg_notify('melete_events', ${String(retainedAfter)})`);
      return retainedAfter;
    });
  }
}
