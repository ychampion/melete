import { expect, test } from 'bun:test';
import { STUCK_AFTER, stuckItems } from '../ops/item-failures.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobService } from './service.ts';
import { TriggerService } from './triggers.ts';

type Row = { id: string; jobId: string; enabled: boolean; spec: unknown };

/** A queue that refuses every change to its schedules, holding `schedules`, beside `rows`. */
function fakeJobs(rows: Row[], schedules: { key: string; cron: string; timezone: string }[]) {
  const queue = {
    schedules,
    getSchedules: async () => queue.schedules,
    schedule: async () => {
      throw new Error('connection reset');
    },
    unschedule: async () => {
      throw new Error('connection reset');
    },
  };
  const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
  return { queue, jobs: { db, boss: queue } as unknown as JobService };
}

async function quietly(run: () => Promise<void>) {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
}

const stuck = () => stuckItems().filter((item) => item.pass === 'routine schedules');

test('a failed unschedule leaves the health detail once another instance drops the schedule', async () => {
  // A schedule whose routine is gone.
  const { queue, jobs } = fakeJobs([], [{ key: 'trg_gone', cron: '0 9 * * *', timezone: 'UTC' }]);
  const triggers = new TriggerService(jobs, {} as AttemptRunner);
  await quietly(async () => {
    for (let pass = 0; pass < STUCK_AFTER; pass += 1) await triggers.syncSchedules();
    expect(stuck().map((item) => item.id)).toEqual(['trg_gone']);

    // Another instance unscheduled it: this one's next pass finds nothing to drop.
    queue.schedules = [];
    await triggers.syncSchedules();
    expect(stuck()).toEqual([]);
  });
});

test('a routine whose schedule never registers stays in the health detail', async () => {
  // Enabled, but not in the queue: the pass keeps trying it, so it is not forgotten.
  const spec = { kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' };
  const { jobs } = fakeJobs([{ id: 'trg_new', jobId: 'job_new', enabled: true, spec }], []);
  const triggers = new TriggerService(jobs, {} as AttemptRunner);
  await quietly(async () => {
    for (let pass = 0; pass < STUCK_AFTER; pass += 1) await triggers.syncSchedules();
    expect(stuck()).toMatchObject([{ id: 'trg_new of job_new', failures: STUCK_AFTER }]);
  });
});
