import { expect } from 'bun:test';
import type { RuntimeAdapter } from '@melete/contracts';
import { owner, principal, space } from '../../src/db/schema.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import type { ProcedureScope } from '../../src/learning/contracts.ts';
import { EpisodeService } from '../../src/learning/episodes.ts';
import { newId, provisionMemorySpace } from '../../src/memory/db.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

export const learningScope: ProcedureScope = {
  task_family: 'organize-records',
  app: 'table-editor',
  app_version: '1.0',
  role: 'owner',
  audience: 'private',
};
export const wake = (row: JobRow) => ({
  job_id: row.id,
  expected_epoch: row.leaseEpoch,
  expected_version: row.stateVersion,
  reason: 'created' as const,
});

/** Await the database rollback before making assertions about a rejected transaction. */
export async function rejectsWith(operation: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}
export async function learningFixture(runtime: RuntimeAdapter = new StubRuntimeAdapter()) {
  const handle = await testDatabase();
  if (!handle) return null;
  const queue = await startQueue(handle.url);
  const jobs = new JobService(handle.db, queue.boss);
  const runner = new AttemptRunner(jobs, runtime, {
    key: 'learning-tests-capability-key-at-least-32',
    provider: 'fake',
    model: 'scripted-learning-v1',
  });
  const episodes = new EpisodeService(jobs, (id) => runner.interrupt(id));
  const ownerId = newId('own');
  await handle.db.insert(owner).values({ id: ownerId, email: `${ownerId}@example.test` });
  // Sessions and jobs now resolve identities through the principal table.
  await handle.db.insert(principal).values({ id: ownerId, email: `${ownerId}@example.test` });
  async function createSpace() {
    const spaceId = newId('sp');
    await handle?.db
      .insert(space)
      .values({ id: spaceId, name: 'Learning test', gitPath: `test/${spaceId}` });
    if (!handle) throw new Error('No database');
    await provisionMemorySpace(handle.sql, ownerId, spaceId);
    await handle.sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
    return spaceId;
  }
  const spaceId = await createSpace();
  return {
    handle,
    queue,
    jobs,
    runner,
    episodes,
    ownerId,
    spaceId,
    createSpace,
    async create(templateId = 'training-invoices', objective = 'Arrange the supplied records') {
      const row = await jobs.create({ space_id: spaceId, title: 'Arrange records', objective });
      await episodes.setScope(ownerId, row.id, { scope: learningScope, template_id: templateId });
      return row;
    },
    async close() {
      await runner.stop();
      await queue.stop();
      await handle.close();
    },
  };
}
