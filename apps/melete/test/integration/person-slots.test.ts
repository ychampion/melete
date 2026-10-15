/**
 * A person's own limit on how many attempts they run at once holds their
 * further work back without holding anyone else's: a wake their limit holds
 * waits in the runner, not in one of the queue's few fetch workers, so other
 * people's wakes are still fetched and started while slots are free. Every
 * wake still runs, and runs once.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SchedulingClass } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { attempt, job, space } from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { appendEvent } from '../../src/events/store.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** A person with a personal space of their own. */
async function person(label: string) {
  const { handle } = fixture();
  const id = newId('own');
  await handle.sql`insert into principal (id, email) values (${id}, ${`${label}-${id}@example.test`})`;
  const spaceId = newId('sp');
  await handle.db.insert(space).values({
    id: spaceId,
    name: 'Personal',
    gitPath: `/spaces/${spaceId}`,
    ownerPrincipalId: id,
  });
  return { id, spaceId };
}

/** A job of this person's that stalls until released. */
async function stalling(
  title: string,
  owner: { id: string; spaceId: string },
  scheduling: SchedulingClass,
) {
  const { jobs, handle } = fixture();
  const row = await jobs.create({
    space_id: owner.spaceId,
    title,
    objective: 'Make bounded progress',
    scheduling_class: scheduling,
    constraints: { notes: JSON.stringify({ script: [{ type: 'stall', key: 'load' }] }) },
  });
  await handle.db.update(job).set({ principalId: owner.id }).where(eq(job.id, row.id));
  return row;
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('The runner did not progress');
    await Bun.sleep(20);
  }
}

withDb('a per-person limit holds one person, never the queue', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await resetTestRows(handle.sql, { retention: true });
  }, 60_000);
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 60_000);

  test("another person's wake starts while one person has many queued at their limit, and every wake runs once", async () => {
    const { jobs, handle } = fixture();
    const ann = await person('ann');
    const ben = await person('ben');
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const runtime = new StubRuntimeAdapter({
      onStall: async (_key, bundle) => {
        started.push(bundle.job.title);
        await new Promise<void>((resolve) => releases.set(bundle.job.title, resolve));
      },
    });
    // Four slots, two per person: each class queue has eight fetch workers.
    const runner = new AttemptRunner(jobs, runtime, {
      key: 'person-slots-test-signing-key-32bytes',
      concurrency: 4,
      concurrencyPerPerson: 2,
    });
    const annRoutines: string[] = [];
    for (let index = 0; index < 20; index++) {
      annRoutines.push(`ann-${index}`);
      await stalling(`ann-${index}`, ann, 'background');
    }
    // Ben's wake is the newest: the queue hands over all of Ann's first.
    await stalling('ben-0', ben, 'background');
    try {
      await runner.start();
      await eventually(() => started.includes('ben-0'));
      // Ann's routines are held to one of her two slots, keeping the other for
      // her chats, while Ben runs beside her; two slots stay free.
      expect(started.filter((title) => title.startsWith('ann-'))).toHaveLength(1);
      expect(runner.scheduler.activeFor(ann.id)).toBe(1);
      expect(runner.scheduler.activeCount).toBe(2);
      // Her chat is not held back by her own routines, and she stays at two.
      await stalling('ann-chat', ann, 'interactive');
      await eventually(() => started.includes('ann-chat'));
      expect(runner.scheduler.activeFor(ann.id)).toBe(2);
      // Let everything finish, one at a time: every wake runs, once.
      const released = new Set<string>();
      await eventually(async () => {
        for (const [title, release] of releases)
          if (!released.has(title)) {
            released.add(title);
            release();
          }
        return started.length === 22 && released.size === 22 && runner.scheduler.activeCount === 0;
      }, 60_000);
      expect([...started].sort()).toEqual([...annRoutines, 'ann-chat', 'ben-0'].sort());
      const attempts = await handle.db.select({ jobId: attempt.jobId }).from(attempt);
      expect(attempts).toHaveLength(22);
      expect(new Set(attempts.map((row) => row.jobId)).size).toBe(22);
    } finally {
      for (const release of releases.values()) release();
      await runner.stop();
    }
  }, 120_000);

  test('a wake held by its person is not queued twice when the recovery scan sends it again', async () => {
    const { jobs } = fixture();
    const ann = await person('ann');
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const runtime = new StubRuntimeAdapter({
      onStall: async (_key, bundle) => {
        started.push(bundle.job.title);
        await new Promise<void>((resolve) => releases.set(bundle.job.title, resolve));
      },
    });
    const runner = new AttemptRunner(jobs, runtime, {
      key: 'person-slots-test-signing-key-32bytes',
      concurrency: 4,
      concurrencyPerPerson: 1,
    });
    await stalling('first', ann, 'background');
    const held = await stalling('held', ann, 'background');
    try {
      await runner.start();
      await eventually(
        () => started.length === 1 && runner.scheduler.pendingCounts.background === 1,
      );
      // Its queue job is done, so the recovery scan sends the wake again; the
      // copy finds it already waiting here.
      await runner.recover();
      await Bun.sleep(1500);
      expect(runner.scheduler.pendingCounts.background).toBe(1);
      // Either wake can be fetched first; the other is the one held.
      releases.get(started[0] as string)?.();
      await eventually(() => started.length === 2);
      expect([...started].sort()).toEqual(['first', 'held']);
      expect((await jobs.get(held.id)).state).not.toBe('queued');
    } finally {
      for (const release of releases.values()) release();
      await runner.stop();
    }
  }, 60_000);

  test('a wake is the turn of whoever spoke last in a shared conversation, as spending charges it', async () => {
    const { jobs, handle } = fixture();
    const creator = await person('creator');
    const speaker = await person('speaker');
    const row = await stalling('room', creator, 'interactive');
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'person-slots-test-signing-key-32bytes',
    });
    // Nobody has written in it yet: whoever created it.
    expect(await runner.personForWake(row.id)).toBe(creator.id);
    await serviceTransaction(handle.db, (tx) =>
      appendEvent(tx, {
        jobId: row.id,
        type: 'notice',
        payload: { kind: 'user_message', text: 'Over to me', principal_id: speaker.id },
        dedupKey: `${row.id}:input:speaker`,
      }),
    );
    expect(await runner.personForWake(row.id)).toBe(speaker.id);
  });
});
