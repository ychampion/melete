import { expect, test } from 'bun:test';
import type { SchedulingClass } from '@melete/contracts';
import { FairScheduler } from './fair-scheduler.ts';

test('a continuously busy interactive class cannot take the next turns from waiting classes', async () => {
  const scheduler = new FairScheduler(2);
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  let peak = 0;
  const work = (name: string, scheduling: SchedulingClass) =>
    scheduler.run(scheduling, async () => {
      started.push(name);
      peak = Math.max(peak, scheduler.activeCount);
      await new Promise<void>((resolve) => gates.set(name, resolve));
      return name;
    });
  const tasks = [
    work('i0', 'interactive'),
    work('i1', 'interactive'),
    work('i2', 'interactive'),
    work('i3', 'interactive'),
    work('b0', 'background'),
    work('q0', 'quiet'),
    work('b1', 'background'),
    work('q1', 'quiet'),
  ];
  for (let index = 0; index < tasks.length; index++) {
    const name = started[index];
    if (!name) throw new Error('Scheduler failed to make progress');
    gates.get(name)?.();
    await Bun.sleep(0);
  }
  await Promise.all(tasks);
  expect(started).toEqual(['i0', 'i1', 'b0', 'q0', 'i2', 'b1', 'q1', 'i3']);
  expect(peak).toBe(2);
});

test('failures release capacity and stopping drains owned work without admitting pending work', async () => {
  const scheduler = new FairScheduler(1);
  const failed = scheduler.run('interactive', async () => {
    throw new Error('failed attempt');
  });
  const continued = scheduler.run('quiet', async () => 'progress');
  expect((await Promise.allSettled([failed, continued])).map((result) => result.status)).toEqual([
    'rejected',
    'fulfilled',
  ]);
  await scheduler.idle();
  let release = () => {};
  const active = scheduler.run(
    'background',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let pendingStarted = false;
  const pending = scheduler.run('quiet', async () => {
    pendingStarted = true;
  });
  const settled = Promise.allSettled([active, pending]);
  scheduler.close();
  release();
  await scheduler.idle();
  expect((await settled).map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(pendingStarted).toBe(false);
});
