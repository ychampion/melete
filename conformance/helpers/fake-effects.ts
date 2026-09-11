import { type AttemptBundle, canonicalizePayload } from '@melete/contracts';
import { eq, sql } from 'drizzle-orm';
import { action } from '../../apps/melete/src/db/schema.ts';
import { newId } from '../../apps/melete/src/ids.ts';
import { withCapability } from '../../apps/melete/src/jobs/fence.ts';
import type { JobService } from '../../apps/melete/src/jobs/service.ts';

/** Count invocations independently of idempotency so a hidden replay cannot pass the test. */
export function fakeTool(jobs: JobService, key: string, connectionId: string) {
  return (callId: string, _args: unknown, bundle: AttemptBundle) =>
    withCapability(jobs, bundle.attempt.token, key, async (tx, claims) => {
      await tx.execute(
        sql`insert into fake_effect_counter(job_id, calls) values (${claims.job_id}, 1) on conflict (job_id) do update set calls = fake_effect_counter.calls + 1`,
      );
      const idempotencyKey = `${claims.job_id}:${callId}`;
      const [previous] = await tx
        .select()
        .from(action)
        .where(eq(action.idempotencyKey, idempotencyKey));
      if (previous) return { action_id: previous.id };
      const id = newId('act');
      const payload = { call_id: callId };
      await tx.insert(action).values({
        id,
        jobId: claims.job_id,
        attemptId: claims.attempt_id,
        connectionId,
        kind: 'test.send',
        effectClass: 'write_external',
        canonicalPayload: payload,
        payloadHash: canonicalizePayload(payload).hash,
        idempotencyKey,
        status: 'succeeded',
        dispatchedAt: new Date(),
        resolvedAt: new Date(),
        receipt: {
          action_id: id,
          connection_id: connectionId,
          external_ref: idempotencyKey,
          detail: { delivered: true },
          received_at: new Date().toISOString(),
          late: false,
        },
      });
      return { action_id: id };
    });
}
