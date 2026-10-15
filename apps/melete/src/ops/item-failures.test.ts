import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepTrash } from '../connectors/files-trash.ts';
import { stuckCheck } from '../health/monitor.ts';
import { sweepStagedWrites } from '../knowledge/staged.ts';
import { runDerivedWork } from '../memory/service.ts';
import { ItemFailures, STUCK_AFTER, stuckItems } from './item-failures.ts';

function clock() {
  let now = Date.parse('2026-10-14T09:00:00Z');
  return { now: () => now, pass: (ms: number) => (now += ms) };
}

describe('a background pass with an item that keeps failing', () => {
  test('waits twice as long after each failure, up to the longest wait', () => {
    const time = clock();
    const failures = new ItemFailures('test pass waits', {
      firstMs: 1_000,
      maxMs: 5_000,
      now: time.now,
      say: () => {},
    });
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const at = failures.failed('sp_one', new Error('no'));
      waits.push(at - time.now());
      expect(failures.due('sp_one')).toBe(false);
      expect(failures.waiting()).toEqual(['sp_one']);
      time.pass(at - time.now());
      expect(failures.due('sp_one')).toBe(true);
      expect(failures.waiting()).toEqual([]);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(failures.due('sp_other')).toBe(true);
  });

  test('is said on its 1st, 2nd, 4th and 8th failure and when it works again, naming it', () => {
    const said: string[] = [];
    const failures = new ItemFailures('test pass log', {
      firstMs: 1_000,
      maxMs: 1_000,
      say: (line) => said.push(line),
    });
    for (let i = 0; i < 9; i++) failures.failed('job_x', new Error('disk\nfull'), 'job_x in sp_y');
    expect(said).toHaveLength(4);
    expect(said[0]).toBe(
      'test pass log: job_x in sp_y failed (disk full); the others carry on, and it is tried again in 1 s',
    );
    expect(said[3]).toContain('failed 8 times in a row');
    failures.succeeded('job_x');
    expect(said[4]).toBe('test pass log: job_x in sp_y works again after 9 failed tries');
    // Something that never failed says nothing when it works.
    failures.succeeded('job_z');
    expect(said).toHaveLength(5);
  });

  test(`counts as stuck after ${STUCK_AFTER} failures in a row, until it works or is left behind`, () => {
    const time = clock();
    const failures = new ItemFailures('test pass stuck', {
      firstMs: 1_000,
      maxMs: 10_000,
      now: time.now,
      say: () => {},
    });
    for (let i = 1; i < STUCK_AFTER; i++) failures.failed('sp_a', new Error('no'));
    expect(failures.stuck()).toEqual([]);
    failures.failed('sp_a', new Error('still no'));
    failures.failed('sp_b', new Error('no'));
    expect(failures.stuck()).toMatchObject([
      { pass: 'test pass stuck', id: 'sp_a', failures: STUCK_AFTER, error: 'still no' },
    ]);
    expect(stuckItems().filter((item) => item.pass === 'test pass stuck')).toHaveLength(1);
    failures.succeeded('sp_a');
    expect(failures.stuck()).toEqual([]);
    // A space removed while it was failing is not listed for ever.
    for (let i = 0; i < STUCK_AFTER; i++) failures.failed('sp_gone', new Error('no'));
    expect(failures.stuck()).toHaveLength(1);
    time.pass(10_000 + 10_000);
    expect(failures.stuck()).toEqual([]);
  });

  test('never names the file a failed file call was about, only what failed and in which call', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'melete-item-failures-'));
    try {
      const error = await unlink(join(folder, "Sam Patel's divorce settlement.pdf")).catch(
        (reason: unknown) => reason,
      );
      const said: string[] = [];
      const failures = new ItemFailures('test pass names', {
        firstMs: 1_000,
        maxMs: 1_000,
        say: (line) => said.push(line),
      });
      for (let i = 0; i < STUCK_AFTER; i++) failures.failed('sp_files', error);
      const [stuck] = failures.stuck();
      for (const text of [...said, stuck?.error ?? '']) {
        expect(text).not.toContain('Sam Patel');
        expect(text).not.toContain(folder);
      }
      expect(stuck?.error).toStartWith('ENOENT');
      expect(stuck?.error).toContain('unlink');
      expect(said[0]).toContain('sp_files');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe("the operator's health detail", () => {
  test('lists the stuck items, ten at most, and counts the rest', () => {
    expect(stuckCheck([])).toEqual({ name: 'background_work', ok: true, detail: 'ok' });
    const item = (n: number) => ({
      pass: 'trash sweep',
      id: `sp_${n}`,
      failures: 3,
      since: '2026-10-14T09:00:00.000Z',
      retry_at: '2026-10-14T10:00:00.000Z',
      error: 'operation not permitted',
    });
    const check = stuckCheck(Array.from({ length: 12 }, (_, n) => item(n)));
    expect(check.ok).toBe(false);
    expect(check.detail).toStartWith(
      'trash sweep: sp_0 failed 3 times since 2026-10-14T09:00:00.000Z (operation not permitted); ',
    );
    expect(check.detail).toContain('sp_9 failed');
    expect(check.detail).not.toContain('sp_10 failed');
    expect(check.detail).toEndWith('; and 2 more');
  });

  test("a pass run once without a tracker of its own never takes the place of its loop's", async () => {
    // Stand-ins for the trackers the running loops keep, each with a stuck space.
    const loops = ['trash sweep', 'staged write sweep', 'memory background work'].map(
      (pass) => new ItemFailures(pass, { firstMs: 1_000, maxMs: 60_000, say: () => {} }),
    );
    const listed = () =>
      stuckItems()
        .filter((item) => item.id === 'sp_stuck_loop')
        .map((item) => item.pass)
        .sort();
    const folder = await mkdtemp(join(tmpdir(), 'melete-item-failures-'));
    try {
      for (const loop of loops)
        for (let i = 0; i < STUCK_AFTER; i++) loop.failed('sp_stuck_loop', new Error('no'));
      expect(listed()).toEqual(['memory background work', 'staged write sweep', 'trash sweep']);
      // Each pass run once, leaving its tracker out, as a caller that keeps none does.
      const absent = join(folder, 'absent');
      expect(await sweepTrash({ workRoot: absent, spacesRoot: absent }, 7)).toBe(0);
      expect(await sweepStagedWrites(absent)).toBe(0);
      const sql = () => Promise.reject(new Error('no database here'));
      await expect(
        runDerivedWork({ sql } as unknown as Parameters<typeof runDerivedWork>[0]),
      ).rejects.toThrow('no database here');
      expect(listed()).toEqual(['memory background work', 'staged write sweep', 'trash sweep']);
    } finally {
      for (const loop of loops) loop.succeeded('sp_stuck_loop');
      await rm(folder, { recursive: true, force: true });
    }
  });

  test('a tracker that is not reported is kept out of the health detail', () => {
    const loop = new ItemFailures('test pass slot', {
      firstMs: 1_000,
      maxMs: 1_000,
      say: () => {},
    });
    for (let i = 0; i < STUCK_AFTER; i++) loop.failed('sp_slot', new Error('no'));
    const once = new ItemFailures('test pass slot', {
      firstMs: 1_000,
      maxMs: 1_000,
      say: () => {},
      reported: false,
    });
    for (let i = 0; i < STUCK_AFTER; i++) once.failed('sp_once', new Error('no'));
    expect(stuckItems().filter((item) => item.pass === 'test pass slot')).toMatchObject([
      { id: 'sp_slot' },
    ]);
    loop.succeeded('sp_slot');
  });
});
