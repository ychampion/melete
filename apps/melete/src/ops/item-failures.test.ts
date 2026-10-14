import { describe, expect, test } from 'bun:test';
import { stuckCheck } from '../health/monitor.ts';
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
});
