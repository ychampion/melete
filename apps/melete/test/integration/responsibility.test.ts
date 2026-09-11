import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { OperationRegistration } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { backgroundOperation, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { OperationService } from '../../src/jobs/operations.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';
import { processFault } from '../helpers/process-fault.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
let spaceId = '';
function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}
async function createJob() {
  return fixture().jobs.create({
    space_id: spaceId,
    title: 'Responsibility',
    objective: 'Durable progress',
  });
}
withDb('responsibility protocol', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await handle.sql`truncate "space" cascade`;
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  });
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  for (const kind of ['timer', 'remote_task', 'local_process'] as const) {
    test(`${kind}: deaths at registration, claim, rearm and settlement preserve recovery truth`, async () => {
      const { handle, queue, jobs } = fixture();
      const job = await createJob();
      const inspected: string[] = [];
      const service = new OperationService(jobs, undefined, async (ref) => {
        inspected.push(ref);
        return { finished: true };
      });
      for (const phase of ['registration', 'claim', 'rearm', 'settlement']) {
        const registration: OperationRegistration = {
          operation_key: `${kind}-${phase}`,
          kind,
          ...(kind === 'remote_task' ? { remote_ref: `accepted:${phase}` } : {}),
        };
        const marker = await processFault(
          fileURLToPath(new URL('../helpers/operation-child.ts', import.meta.url)),
          { url: handle.url, jobId: job.id, registration, phase },
          90,
        );
        const id = marker.replace('OPERATION:', '');
        await handle.db
          .update(backgroundOperation)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(backgroundOperation.id, id));
        await queue.boss.deleteAllJobs(QUEUES.operation);
        await service.recover();
        const recovered = await service.get(id);
        if (phase === 'settlement') expect(recovered.state).toBe('settled');
        else if (kind === 'local_process') {
          expect(recovered.state).toBe('interrupted');
          expect(recovered.substrateDisposition).toBe('local_process_interrupted');
          expect(await service.claim(id, recovered.version)).toBeNull();
          await expect(service.rearm(id, recovered.version, new Date())).rejects.toMatchObject({
            code: 'stale_operation',
          });
        } else {
          const wakes =
            await handle.sql`select * from pgboss.job where name = ${QUEUES.operation} and data->>'id' = ${id}`;
          expect(wakes).toHaveLength(1);
          await service.handleWake({ id, version: recovered.version });
          expect((await service.get(id)).state).toBe('settled');
          await service.handleWake({ id, version: recovered.version });
        }
      }
      expect(inspected).toHaveLength(kind === 'remote_task' ? 3 : 0);
    }, 30_000);
  }

  test('uncertain external work is visible and never automatically dispatched', async () => {
    const { jobs } = fixture();
    const row = await createJob();
    const service = new OperationService(jobs, undefined, async () => {
      throw new Error('Must not dispatch');
    });
    const op = await service.register(row.id, { operation_key: 'uncertain', kind: 'remote_task' });
    await service.recover();
    expect((await service.get(op.id)).substrateDisposition).toBe('external_uncertain');
    expect((await service.get(op.id)).state).toBe('unknown');
    expect(await service.claim(op.id, op.version)).toBeNull();
    expect(
      (await service.register(row.id, { operation_key: 'uncertain', kind: 'remote_task' })).id,
    ).toBe(op.id);
    await expect(
      service.register(row.id, { operation_key: 'uncertain', kind: 'timer' }),
    ).rejects.toMatchObject({ code: 'operation_conflict' });
  });

  test('operation settlement before wait registration wakes once from the persisted event', async () => {
    const { jobs } = fixture();
    const row = await createJob();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'operation-test-capability-key-32bytes',
    });
    const triggers = new TriggerService(jobs, runner);
    const service = new OperationService(jobs, runner);
    const trigger = await triggers.create(row.id, {
      kind: 'schedule',
      cron: '* * * * *',
      timezone: 'UTC',
    });
    const op = await service.register(row.id, {
      operation_key: 'early-timer',
      kind: 'timer',
      trigger_id: trigger.id,
    });
    await service.handleWake({ id: op.id, version: op.version });
    const claimed = await runner.claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'created',
    });
    if (!claimed) throw new Error('Attempt not claimed');
    const updated = await runner.commitOutcome(claimed.claims, {
      kind: 'waiting_for_event_or_time',
      wait: { kind: 'event', trigger_id: trigger.id, deadline_at: null },
    });
    expect(updated.state).toBe('queued');
    expect(updated.substrateDisposition).toBe('timer_or_event');
    const after = await service.get(op.id);
    await service.settle(op.id, after.version - 1, { fired_at: op.dueAt.toISOString() });
    expect((await jobs.get(row.id)).stateVersion).toBe(updated.stateVersion);
  });
});
