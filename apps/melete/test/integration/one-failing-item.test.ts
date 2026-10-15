/**
 * Background passes over many spaces, accounts, routines and rows, each with
 * one item that fails every time: the pass still does everything after it, and
 * the failing item waits out a pause instead of being tried, and said in the
 * log, on every pass. Against a real database.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRemovalService } from '../../src/account/removal.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { enqueue, provisionMemorySpace } from '../../src/memory/db.ts';
import type { MarkdownViews } from '../../src/memory/markdown.ts';
import { startJobRecompute } from '../../src/memory/recompute.ts';
import type { RestrictionJournal } from '../../src/memory/restore.ts';
import { type MemoryServiceOptions, runDerivedWork } from '../../src/memory/service.ts';
import { ItemFailures, stuckItems } from '../../src/ops/item-failures.ts';
import type { PrincipalService } from '../../src/principals/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { CHECK_SECONDS, SituationService } from '../../src/situations/service.ts';
import { type RemovalDeps, SpaceRemovalService } from '../../src/spaces/removal.ts';
import type { SpaceRemovalRow } from '../../src/spaces/schema.ts';
import type { BlobStore } from '../../src/storage/blob.ts';
import { BLOB_GRACE_MS, BlobCollector } from '../../src/storage/gc.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';
import { installationOwner } from './space-removal-fixture.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'one-failing-item-fixture-key-32b!' })
  : null;
const root = await mkdtemp(join(tmpdir(), 'melete-one-failing-'));
afterAll(async () => {
  await runner?.stop();
  await queue?.stop();
  await handle?.close();
  await rm(root, { recursive: true, force: true });
}, 30_000);
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

/** A space with memory set up and ready, owned by the installation's owner. */
async function memorySpace() {
  const { sql } = required(handle);
  const ownerId = await installationOwner(sql);
  const spaceId = newId('sp');
  await sql`insert into space (id, name, git_path) values (${spaceId}, 'Test space', ${`test/${spaceId}`})`;
  await provisionMemorySpace(sql, ownerId, spaceId);
  await sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
  return { ownerId, spaceId };
}

async function until(check: () => boolean | Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(20);
  return check();
}

withDb('one item that keeps failing', () => {
  test("memory's background work goes on for the spaces after a space whose work fails", async () => {
    const db = required(handle);
    // Ids sort in the order they are made, and spaces are taken in id order,
    // so the failing space comes first.
    const broken = await memorySpace();
    const fine = await memorySpace();
    for (const scope of [broken, fine])
      await db.sql.begin((tx) => enqueue(tx, scope.spaceId, 'markdown', 'views'));
    const built: string[] = [];
    const markdown = {
      cleanup: async () => {},
      build: async (scope: { spaceId: string }) => {
        built.push(scope.spaceId);
        if (scope.spaceId === broken.spaceId) throw new Error('the space folder refused');
      },
      proposals: async () => {},
    } as unknown as MarkdownViews;
    const said: string[] = [];
    const failures = new ItemFailures('memory background work', {
      firstMs: 60_000,
      maxMs: 60 * 60_000,
      say: (line) => said.push(line),
    });
    const options = {
      sql: db.sql,
      boss: required(queue).boss,
      journal: {} as RestrictionJournal,
      markdown,
    } satisfies MemoryServiceOptions;
    const mine = () => built.filter((id) => id === broken.spaceId || id === fine.spaceId);

    expect(await runDerivedWork(options, failures)).toBe(true);
    expect(mine()).toEqual([broken.spaceId, fine.spaceId]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(broken.spaceId);
    expect(said[0]).toContain('the space folder refused');

    // Within its pause the failing space is not tried, nor said again; the other still is.
    built.length = 0;
    await runDerivedWork(options, failures);
    expect(mine()).toEqual([fine.spaceId]);
    expect(said).toHaveLength(1);
  });

  test('a wake memory owes one job never holds up the wakes owed to the jobs after it', async () => {
    const db = required(handle);
    const scope = await memorySpace();
    await db.sql.begin((tx) => enqueue(tx, scope.spaceId, 'job_recompute', 'job_wake_broken'));
    await db.sql.begin((tx) => enqueue(tx, scope.spaceId, 'job_recompute', 'job_wake_fine'));
    const tried: string[] = [];
    const recompute = startJobRecompute(db.sql, async (jobId) => {
      tried.push(jobId);
      if (jobId === 'job_wake_broken') throw new Error('the job service refused');
    });
    try {
      expect(await until(() => tried.includes('job_wake_fine'), 3000)).toBe(true);
      // It is in its pause now: a few more passes do not ask for it again.
      await Bun.sleep(1000);
      expect(tried.filter((id) => id === 'job_wake_broken')).toHaveLength(1);
      const [done] = await db.sql`select completed_at from memory_outbox
        where kind = 'job_recompute' and target_id = 'job_wake_fine'`;
      expect(done?.completed_at).not.toBeNull();
    } finally {
      await recompute.stop();
    }
  });

  test('the account deletion pass finishes the accounts after one whose deletion fails', async () => {
    const sql = required(handle).sql;
    await installationOwner(sql);
    const removed = async () => {
      const id = newId('own');
      await sql`insert into principal (id, email)
        values (${id}, ${`removed+${id.toLowerCase()}@removed.invalid`})`;
      return id;
    };
    const stuck = await removed();
    const stuckSpace = newId('sp');
    await sql`insert into space (id, name, git_path, kind, owner_principal_id)
      values (${stuckSpace}, 'Held', ${`test/${stuckSpace}`}, 'personal', ${stuck})`;
    const others = [await removed(), await removed()];
    const spaces = {
      fence: async (_principal: string, spaceId: string) => ({ id: `rem_${spaceId}` }),
      dispatch: (removalId: string) => {
        if (removalId === `rem_${stuckSpace}`) throw new Error('the removal could not start');
      },
    } as unknown as SpaceRemovalService;
    const logged: string[] = [];
    const accounts = new AccountRemovalService({
      sql,
      spaces,
      principals: { revoke: async () => {} } as unknown as PrincipalService,
      log: (line) => logged.push(line),
    });
    await accounts.resume();
    const left = await sql`select id from principal where id = any(${[stuck, ...others]})`;
    expect(left.map((row) => row.id)).toEqual([stuck]);
    expect(logged.filter((line) => line.includes(stuck))).toHaveLength(1);
    // Within its pause the next pass leaves it alone.
    await accounts.resume();
    expect(logged.filter((line) => line.includes(stuck))).toHaveLength(1);
  });

  test('resuming space removals goes on past one whose run fails', async () => {
    const db = required(handle);
    const ids = [newId('rem'), newId('rem'), newId('rem')];
    for (const id of ids)
      await db.sql`insert into space_removal (id, space_id, space_name, git_path, kind, requested_by)
        values (${id}, ${newId('sp')}, 'Gone', 'test/gone', 'removed', 'prn_someone')`;
    const removals = new SpaceRemovalService({ db: db.db } as unknown as RemovalDeps);
    const [first, ...rest] = ids;
    const run = spyOn(removals, 'run').mockImplementation(async (id: string) => {
      if (id === first) throw new Error('the space folder refused');
      return { id } as SpaceRemovalRow;
    });
    try {
      const resumed = await removals.resume();
      expect(resumed.map((row) => row.id).filter((id) => ids.includes(id))).toEqual(rest);
      run.mockClear();
      await removals.resume();
      expect(run.mock.calls.map(([id]) => id)).not.toContain(first);
    } finally {
      run.mockRestore();
      await db.sql`delete from space_removal where id = any(${ids})`;
    }
  });

  test('a deadline whose check fails never holds up the deadlines due after it', async () => {
    const db = required(handle);
    const ownerId = await installationOwner(db.sql);
    const spaceId = newId('sp');
    await db.sql`insert into space (id, name, git_path) values (${spaceId}, 'Clocks', ${`test/${spaceId}`})`;
    const due = new Date(Date.now() - 60_000);
    const clocks = [newId('clk'), newId('clk'), newId('clk')];
    for (const [index, id] of clocks.entries())
      await db.sql`insert into clock (id, space_id, principal_id, rule, subject_key, title,
          due_at, lead_s, fire_at, "check")
        values (${id}, ${spaceId}, ${ownerId}, 'deadline.at_risk', ${`subject:${index}`}, 'Due',
          ${new Date(Date.now() + 3_600_000).toISOString()}::timestamptz, 3600,
          ${due.toISOString()}::timestamptz, '{}'::jsonb)`;
    const situations = new SituationService({
      jobs: required(jobs),
      triggers: { registerWait: async () => {} } as never,
      detectors: false,
    });
    const [broken = '', ...fine] = clocks;
    const checked: string[] = [];
    const check = spyOn(
      situations as unknown as { check: (entry: { id: string }) => Promise<string> },
      'check',
    ).mockImplementation(async (entry) => {
      checked.push(entry.id);
      if (entry.id === broken) throw new Error('the reading broke');
      await db.sql`update clock set state = 'met' where id = ${entry.id}`;
      return 'met';
    });
    try {
      await situations.sweep();
      expect(checked.filter((id) => clocks.includes(id)).sort()).toEqual([...clocks].sort());
      const [held] = await db.sql`select state, claimed_until from clock where id = ${broken}`;
      expect(held?.state).toBe('checking');
      // It waits out its pause before any sweep takes it again.
      expect(new Date(String(held?.claimed_until)).getTime()).toBeGreaterThan(Date.now() + 50_000);
      const settled = await db.sql`select state from clock where id = any(${fine})`;
      expect(settled.map((row) => row.state)).toEqual(['met', 'met']);
    } finally {
      check.mockRestore();
    }
  });

  test("a check that keeps failing waits out each doubled pause, not the sweep's claim", async () => {
    const db = required(handle);
    const ownerId = await installationOwner(db.sql);
    const spaceId = newId('sp');
    await db.sql`insert into space (id, name, git_path) values (${spaceId}, 'Clocks', ${`test/${spaceId}`})`;
    let now = Date.now();
    const id = newId('clk');
    await db.sql`insert into clock (id, space_id, principal_id, rule, subject_key, title,
        due_at, lead_s, fire_at, "check")
      values (${id}, ${spaceId}, ${ownerId}, 'deadline.at_risk', 'subject:failing', 'Due',
        ${new Date(now + 7_200_000).toISOString()}::timestamptz, 3600,
        ${new Date(now - 60_000).toISOString()}::timestamptz, '{}'::jsonb)`;
    const situations = new SituationService({
      jobs: required(jobs),
      triggers: { registerWait: async () => {} } as never,
      detectors: false,
      now: () => now,
    });
    const check = spyOn(
      situations as unknown as { check: (entry: { id: string }) => Promise<string> },
      'check',
    ).mockImplementation(async (entry) => {
      if (entry.id === id) throw new Error('the reading broke');
      return 'deferred';
    });
    const claimedUntil = async () => {
      const [row] = await db.sql`select claimed_until from clock where id = ${id}`;
      return new Date(String(row?.claimed_until)).getTime();
    };
    try {
      // The pause is written only over the claim this sweep made, matched to
      // the stored time, so a claim read back any less exactly would leave
      // every failed check retried as soon as its claim (CHECK_SECONDS) ran out.
      for (const minutes of [1, 2, 4, 8]) {
        await situations.sweep();
        expect(await claimedUntil()).toBe(now + minutes * 60_000);
        now += minutes * 60_000 + 1;
      }
    } finally {
      check.mockRestore();
    }
  });

  test('a check that fails after outliving its claim leaves the claim of the sweep that took over', async () => {
    const db = required(handle);
    const ownerId = await installationOwner(db.sql);
    const spaceId = newId('sp');
    await db.sql`insert into space (id, name, git_path) values (${spaceId}, 'Clocks', ${`test/${spaceId}`})`;
    const id = newId('clk');
    await db.sql`insert into clock (id, space_id, principal_id, rule, subject_key, title,
        due_at, lead_s, fire_at, "check")
      values (${id}, ${spaceId}, ${ownerId}, 'deadline.at_risk', 'subject:slow', 'Due',
        ${new Date(Date.now() + 3_600_000).toISOString()}::timestamptz, 3600,
        ${new Date(Date.now() - 60_000).toISOString()}::timestamptz, '{}'::jsonb)`;
    const deps = {
      jobs: required(jobs),
      triggers: { registerWait: async () => {} } as never,
      detectors: false,
    };
    // The second sweep runs once the first one's claim has run out.
    const slow = new SituationService(deps);
    const later = new SituationService({
      ...deps,
      now: () => Date.now() + (CHECK_SECONDS + 10) * 1000,
    });
    const gate = () => {
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    const [slowIn, slowOut, laterIn, laterOut] = [gate(), gate(), gate(), gate()];
    type Checks = { check: (entry: { id: string }) => Promise<string> };
    const slowCheck = spyOn(slow as unknown as Checks, 'check').mockImplementation(
      async (entry) => {
        if (entry.id !== id) return 'deferred';
        slowIn.open();
        await slowOut.opened;
        throw new Error('the reading took too long');
      },
    );
    const laterCheck = spyOn(later as unknown as Checks, 'check').mockImplementation(
      async (entry) => {
        if (entry.id !== id) return 'deferred';
        laterIn.open();
        await laterOut.opened;
        return 'deferred';
      },
    );
    const claim = async () => {
      const [row] = await db.sql`select state, claimed_until from clock where id = ${id}`;
      return { state: row?.state, until: new Date(String(row?.claimed_until)).getTime() };
    };
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    try {
      first = slow.sweep();
      await slowIn.opened;
      second = later.sweep();
      await laterIn.opened;
      const taken = await claim();
      expect(taken.state).toBe('checking');
      // The first check now fails, while the second sweep holds the clock.
      slowOut.open();
      await first;
      expect(await claim()).toEqual(taken);
    } finally {
      slowOut.open();
      laterOut.open();
      await Promise.allSettled([first, second]);
      slowCheck.mockRestore();
      laterCheck.mockRestore();
    }
  });

  test("a routine whose schedule cannot be registered never stops the other routines' schedules", async () => {
    const triggers = new TriggerService(required(jobs), required(runner));
    const scope = await memorySpace();
    const work = await required(jobs).create({
      space_id: scope.spaceId,
      title: 'Routines',
      objective: 'Routines',
    });
    const broken = newId('trg');
    const fine = newId('trg');
    await required(handle).sql`insert into trigger (id, job_id, kind, spec) values
      (${broken}, ${work.id}, 'schedule', ${JSON.stringify({ kind: 'schedule', cron: 'every so often', timezone: 'UTC' })}::jsonb),
      (${fine}, ${work.id}, 'schedule', ${JSON.stringify({ kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' })}::jsonb)`;
    await triggers.syncSchedules();
    const registered = await required(queue).boss.getSchedules(QUEUES.triggerSchedule);
    const keys = registered.map((schedule) => schedule.key);
    expect(keys).toContain(fine);
    expect(keys).not.toContain(broken);
    // The routine just saved still hears its own error.
    await expect(triggers.syncSchedules(broken)).rejects.toThrow();
  });

  test('a schedule whose removal failed is no longer stuck once it is removed', async () => {
    const triggers = new TriggerService(required(jobs), required(runner));
    const boss = required(queue).boss;
    const scope = await memorySpace();
    const work = await required(jobs).create({
      space_id: scope.spaceId,
      title: 'Routines',
      objective: 'Routines',
    });
    const stopped = newId('trg');
    await required(handle).sql`insert into trigger (id, job_id, kind, spec) values
      (${stopped}, ${work.id}, 'schedule', ${JSON.stringify({ kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' })}::jsonb)`;
    await triggers.syncSchedules();
    const keys = async () =>
      (await boss.getSchedules(QUEUES.triggerSchedule)).map((schedule) => schedule.key);
    expect(await keys()).toContain(stopped);
    await required(handle).sql`update trigger set enabled = false where id = ${stopped}`;
    const unschedule = boss.unschedule.bind(boss);
    const refused = spyOn(boss, 'unschedule').mockImplementation(async (name, key) => {
      if (key === stopped) throw new Error('the queue refused');
      return unschedule(name, key);
    });
    const listed = () => stuckItems().filter((item) => item.id === stopped);
    try {
      for (let i = 0; i < 3; i++) await triggers.syncSchedules();
      expect(listed()).toMatchObject([{ pass: 'routine schedules', failures: 3 }]);
    } finally {
      refused.mockRestore();
    }
    await triggers.syncSchedules();
    expect(await keys()).not.toContain(stopped);
    expect(listed()).toEqual([]);
  });

  test('blob collection deletes the blobs after one it cannot delete', async () => {
    const db = required(handle);
    const local = new LocalBlobStore(join(root, 'blobs'));
    const blobs = [];
    for (const text of ['first', 'second', 'third'])
      blobs.push(await local.put(new TextEncoder().encode(`${text} ${crypto.randomUUID()}`)));
    const stuck = blobs[0]?.key;
    const store: BlobStore = Object.create(local);
    store.delete = async (key) => {
      if (key === stuck) throw new Error('the disk refused');
      return local.delete(key);
    };
    const collector = new BlobCollector({
      sql: db.sql,
      store,
      now: () => new Date(Date.now() + BLOB_GRACE_MS + 86_400_000),
    });
    expect(await collector.collect()).toMatchObject({ deleted: 2 });
    for (const blob of blobs)
      expect(await local.head(blob.key)).toEqual(blob.key === stuck ? expect.anything() : null);
  });
});
