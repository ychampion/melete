import { expect, test } from 'bun:test';
import { STUCK_AFTER, stuckItems } from '../ops/item-failures.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobService } from './service.ts';
import { TriggerService } from './triggers.ts';

/** A queue holding one schedule whose routine is gone, and refusing to drop it. */
function fakeJobs() {
  const queue = {
    schedules: [{ key: 'trg_gone', cron: '0 9 * * *', timezone: 'UTC' }],
    getSchedules: async () => queue.schedules,
    schedule: async () => {},
    unschedule: async () => {
      throw new Error('connection reset');
    },
  };
  const db = { select: () => ({ from: () => ({ where: async () => [] }) }) };
  return { queue, jobs: { db, boss: queue } as unknown as JobService };
}

test('a failed unschedule leaves the health detail once another instance drops the schedule', async () => {
  const { queue, jobs } = fakeJobs();
  const triggers = new TriggerService(jobs, {} as AttemptRunner);
  const stuck = () => stuckItems().filter((item) => item.pass === 'routine schedules');
  const quiet = process.stderr.write;
  process.stderr.write = () => true;
  try {
    for (let pass = 0; pass < STUCK_AFTER; pass += 1) await triggers.syncSchedules();
    expect(stuck().map((item) => item.id)).toEqual(['trg_gone']);

    // Another instance unscheduled it: this one's next pass finds nothing to drop.
    queue.schedules = [];
    await triggers.syncSchedules();
    expect(stuck()).toEqual([]);
  } finally {
    process.stderr.write = quiet;
  }
});
