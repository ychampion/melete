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

/**
 * A scheduler whose work waits for its gate: `started` lists the work in the
 * order it got a slot, and `finish` lets the oldest running one end.
 */
function harness(capacity: number, perPerson?: number) {
  const scheduler = new FairScheduler(capacity, perPerson);
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const running = new Map<string, number>();
  let peak = 0;
  let personPeak = 0;
  const tasks: Promise<string>[] = [];
  const add = (name: string, person?: string, scheduling: SchedulingClass = 'interactive') =>
    tasks.push(
      scheduler.run(
        scheduling,
        async () => {
          started.push(name);
          peak = Math.max(peak, scheduler.activeCount);
          if (person) {
            running.set(person, (running.get(person) ?? 0) + 1);
            personPeak = Math.max(personPeak, running.get(person) ?? 0);
          }
          await new Promise<void>((resolve) => gates.set(name, resolve));
          if (person) running.set(person, (running.get(person) ?? 1) - 1);
          return name;
        },
        person,
      ),
    );
  /** Ends running work in the order it started, until everything has run. */
  const runAll = async () => {
    for (let index = 0; index < tasks.length; index++) {
      const name = started[index];
      if (!name) throw new Error('Scheduler failed to make progress');
      gates.get(name)?.();
      await Bun.sleep(0);
    }
    await Promise.all(tasks);
  };
  return {
    scheduler,
    started,
    add,
    runAll,
    peak: () => peak,
    personPeak: () => personPeak,
  };
}

test('one person alone may use every slot, in the order they asked', async () => {
  const run = harness(2);
  for (const name of ['a0', 'a1', 'a2', 'a3']) run.add(name, 'ann');
  expect(run.started).toEqual(['a0', 'a1']);
  await run.runAll();
  expect(run.started).toEqual(['a0', 'a1', 'a2', 'a3']);
  expect(run.peak()).toBe(2);
});

test('two people take turns: a long queue from one does not hold the other back', async () => {
  const run = harness(1);
  for (const name of ['a0', 'a1', 'a2', 'a3']) run.add(name, 'ann');
  for (const name of ['b0', 'b1']) run.add(name, 'ben');
  await run.runAll();
  expect(run.started).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'a3']);
});

test('five people: everyone who waits starts before the busiest person gets a third slot', async () => {
  const run = harness(2);
  for (const name of ['p0a', 'p0b', 'p0c', 'p0d', 'p0e']) run.add(name, 'p0');
  for (const person of ['p1', 'p2', 'p3', 'p4']) run.add(person, person);
  await run.runAll();
  expect(run.started).toEqual(['p0a', 'p0b', 'p1', 'p2', 'p3', 'p4', 'p0c', 'p0d', 'p0e']);
  expect(run.peak()).toBe(2);
});

test('a per-person limit holds one person to it while slots stay free for others', async () => {
  const run = harness(4, 1);
  for (const name of ['a0', 'a1', 'a2']) run.add(name, 'ann');
  run.add('b0', 'ben');
  // Two slots stay free: Ann's other work waits for her first to finish.
  expect(run.started).toEqual(['a0', 'b0']);
  expect(run.scheduler.activeCount).toBe(2);
  expect(run.scheduler.waitReason('ann')).toBe('person');
  expect(run.scheduler.waitReason('cat')).toBeNull();
  await run.runAll();
  expect(run.started).toEqual(['a0', 'b0', 'a1', 'a2']);
  expect(run.personPeak()).toBe(1);
});

test('a per-person limit equal to the capacity changes nothing, and the full house says so', async () => {
  const run = harness(2, 2);
  for (const name of ['a0', 'a1', 'a2']) run.add(name, 'ann');
  expect(run.started).toEqual(['a0', 'a1']);
  expect(run.scheduler.waitReason('ben')).toBe('installation');
  expect(run.scheduler.activeFor('ann')).toBe(2);
  await run.runAll();
  expect(run.started).toEqual(['a0', 'a1', 'a2']);
  expect(run.scheduler.activeFor('ann')).toBe(0);
});

test('people share within each class, and the classes still take turns', async () => {
  const run = harness(1);
  run.add('first', 'ann', 'quiet');
  for (const name of ['ai0', 'ai1']) run.add(name, 'ann', 'interactive');
  run.add('bi0', 'ben', 'interactive');
  run.add('ab0', 'ann', 'background');
  run.add('bq0', 'ben', 'quiet');
  await run.runAll();
  // Interactive, background and quiet in turn; within interactive Ben's one
  // turn comes before Ann's second.
  expect(run.started).toEqual(['first', 'bi0', 'ab0', 'bq0', 'ai0', 'ai1']);
});

test('a per-person limit must be a positive whole number', () => {
  expect(() => new FairScheduler(4, 0)).toThrow('per-person');
  expect(() => new FairScheduler(4, 1.5)).toThrow('per-person');
  expect(new FairScheduler(4).perPerson).toBe(Number.POSITIVE_INFINITY);
});

test("a person's own routines never hold back their chat, and never take them past the limit", async () => {
  const run = harness(4, 2);
  run.add('r0', 'ann', 'background');
  run.add('r1', 'ann', 'background');
  run.add('r2', 'ann', 'quiet');
  // Background and quiet work leave one of her two slots to her chats.
  expect(run.started).toEqual(['r0']);
  expect(run.scheduler.waitReason('ann', 'quiet')).toBe('person');
  expect(run.scheduler.waitReason('ann', 'interactive')).toBeNull();
  run.add('c0', 'ann', 'interactive');
  run.add('c1', 'ann', 'interactive');
  // Her chat starts at once; her second waits, as she is at her limit of two.
  expect(run.started).toEqual(['r0', 'c0']);
  expect(run.scheduler.activeFor('ann')).toBe(2);
  expect(run.scheduler.activeFor('ann', 'background')).toBe(1);
  expect(run.scheduler.waitReason('ann', 'interactive')).toBe('person');
  await run.runAll();
  expect([...run.started].sort()).toEqual(['c0', 'c1', 'r0', 'r1', 'r2']);
  expect(run.personPeak()).toBe(2);
});

test('with a limit of one, a chat waits for a routine of the same person', () => {
  const scheduler = new FairScheduler(4, 1);
  const never = () => new Promise<void>(() => {});
  scheduler.run('background', never, 'ann').catch(() => {});
  expect(scheduler.activeFor('ann')).toBe(1);
  expect(scheduler.waitReason('ann', 'interactive')).toBe('person');
  expect(scheduler.waitReason('ben', 'interactive')).toBeNull();
  scheduler.close();
});

test('work given no person waits its turn like anyone else, and is held to the limit', async () => {
  const run = harness(1);
  run.add('a0', 'ann');
  run.add('a1', 'ann');
  run.add('b0', 'ben');
  run.add('n0');
  await run.runAll();
  // Not ahead of Ben, who has not started anything either.
  expect(run.started).toEqual(['a0', 'b0', 'n0', 'a1']);

  const limited = harness(4, 1);
  for (const name of ['n0', 'n1', 'n2']) limited.add(name);
  limited.add('a0', 'ann');
  expect(limited.started).toEqual(['n0', 'a0']);
  expect(limited.scheduler.waitReason(undefined)).toBe('person');
  await limited.runAll();
  expect(limited.started).toEqual(['n0', 'a0', 'n1', 'n2']);
});

test('whether a wake would be held by its own person, counting what of theirs already waits', () => {
  const scheduler = new FairScheduler(1, 3);
  const never = () => new Promise<void>(() => {});
  scheduler.run('background', never, 'ann').catch(() => {});
  // One running, nothing of hers waiting: a second routine fits under her limit.
  expect(scheduler.heldByOwnLimit('background', 'ann')).toBe(false);
  scheduler.run('background', never, 'ann').catch(() => {});
  // Her second waits for the installation's slot. A third routine would wait
  // for her own limit, which keeps one slot for chats; a chat would not.
  expect(scheduler.heldByOwnLimit('quiet', 'ann')).toBe(true);
  expect(scheduler.heldByOwnLimit('interactive', 'ann')).toBe(false);
  scheduler.run('interactive', never, 'ann').catch(() => {});
  // With a chat of hers also waiting, she has all three: anything more waits for her.
  expect(scheduler.heldByOwnLimit('interactive', 'ann')).toBe(true);
  expect(scheduler.heldByOwnLimit('background', 'ben')).toBe(false);
  expect(new FairScheduler(1).heldByOwnLimit('background', 'ann')).toBe(false);
  scheduler.close();
});
