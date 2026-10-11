import { describe, expect, test } from 'bun:test';
import { type Commits, quietLoop } from './quiet-loop.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A change source the test fires by hand. */
function commits() {
  const listeners = new Set<() => void>();
  const source: Commits = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    commit: () => {
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

describe('quiet loop', () => {
  test('while it finds nothing it looks less and less often, up to the idle wait', async () => {
    const changes = commits();
    const starts: number[] = [];
    const loop = quietLoop(
      async () => {
        starts.push(Date.now());
        return false;
      },
      { busyMs: 20, idleMs: 160, wakeOn: changes.source },
    );
    await sleep(900);
    await loop.stop();
    // Waits of 40, 80, 160, 160, ... ms: about seven passes, not the forty-five a 20 ms poll makes.
    expect(starts.length).toBeGreaterThanOrEqual(5);
    expect(starts.length).toBeLessThanOrEqual(9);
    const gaps = starts.slice(1).map((at, index) => at - (starts[index] ?? at));
    expect(Math.max(...gaps)).toBeLessThan(160 + 60);
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(150);
  });

  test('a committed change wakes it at once, however long it has been idle', async () => {
    const changes = commits();
    let work = 0;
    const done: number[] = [];
    const loop = quietLoop(
      async () => {
        if (!work) return false;
        work--;
        done.push(Date.now());
        return true;
      },
      { busyMs: 50, idleMs: 60_000, wakeOn: changes.source },
    );
    await sleep(400);
    work = 1;
    const committed = Date.now();
    changes.commit();
    await sleep(100);
    await loop.stop();
    expect(done).toHaveLength(1);
    expect((done[0] ?? Number.POSITIVE_INFINITY) - committed).toBeLessThan(60);
  });

  test('a burst of changes is looked at no more often than a busy loop would', async () => {
    const changes = commits();
    let passes = 0;
    const loop = quietLoop(
      async () => {
        passes++;
        return false;
      },
      { busyMs: 100, idleMs: 60_000, wakeOn: changes.source },
    );
    await sleep(150);
    const before = passes;
    for (let index = 0; index < 50; index++) {
      changes.commit();
      await sleep(5);
    }
    await sleep(120);
    await loop.stop();
    // 370 ms of changes allows at most four passes at one per 100 ms.
    expect(passes - before).toBeGreaterThanOrEqual(2);
    expect(passes - before).toBeLessThanOrEqual(5);
  });

  test('passes never overlap, and a change during a pass brings one more right after', async () => {
    const changes = commits();
    let active = 0;
    let most = 0;
    const starts: number[] = [];
    const loop = quietLoop(
      async () => {
        active++;
        most = Math.max(most, active);
        starts.push(Date.now());
        await sleep(60);
        active--;
        return false;
      },
      { busyMs: 100, idleMs: 60_000, wakeOn: changes.source },
    );
    await sleep(20);
    changes.commit();
    changes.commit();
    await sleep(250);
    await loop.stop();
    expect(most).toBe(1);
    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(95);
  });

  test('without a change source it keeps looking at the busy pace', async () => {
    let passes = 0;
    const loop = quietLoop(
      async () => {
        passes++;
        return false;
      },
      { busyMs: 20, idleMs: 60_000 },
    );
    await sleep(300);
    await loop.stop();
    expect(passes).toBeGreaterThanOrEqual(10);
  });

  test('a failing pass is reported and backs off like an empty one; stop unsubscribes', async () => {
    const changes = commits();
    const errors: unknown[] = [];
    const loop = quietLoop(
      async () => {
        throw new Error('database unavailable');
      },
      { busyMs: 20, idleMs: 80, wakeOn: changes.source, onError: (error) => errors.push(error) },
    );
    await sleep(400);
    await loop.stop();
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBeLessThanOrEqual(8);
    expect(changes.listeners.size).toBe(0);
    const after = errors.length;
    changes.commit();
    await sleep(100);
    expect(errors.length).toBe(after);
  });
});
