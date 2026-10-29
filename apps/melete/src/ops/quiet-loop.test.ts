import { describe, expect, test } from 'bun:test';
import { type Commits, quietLoop } from './quiet-loop.ts';

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

/** Drain promise continuations between timer callbacks without waiting for wall time. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function manualClock() {
  let now = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    now: () => now,
    schedule(callback: () => void, ms: number) {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    async advance(ms: number) {
      const target = now + ms;
      await settled();
      for (;;) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > target) break;
        now = next.at;
        timers.delete(next);
        next.callback();
        await settled();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

describe('quiet loop', () => {
  test('while it finds nothing it looks less and less often, up to the idle wait', async () => {
    const changes = commits();
    const clock = manualClock();
    const starts: number[] = [];
    const loop = quietLoop(
      async () => {
        starts.push(clock.now());
        return false;
      },
      { busyMs: 20, idleMs: 160, wakeOn: changes.source, clock },
    );
    try {
      await clock.advance(900);
      expect(starts).toEqual([0, 40, 120, 280, 440, 600, 760]);
    } finally {
      await loop.stop();
    }
    expect(clock.pending()).toBe(0);
  });

  test('a committed change wakes it at once, however long it has been idle', async () => {
    const changes = commits();
    const clock = manualClock();
    let work = 0;
    const done: number[] = [];
    const loop = quietLoop(
      async () => {
        if (!work) return false;
        work--;
        done.push(clock.now());
        return true;
      },
      { busyMs: 50, idleMs: 60_000, wakeOn: changes.source, clock },
    );
    try {
      await clock.advance(60_000);
      work = 1;
      changes.commit();
      await clock.advance(0);
      expect(done).toEqual([60_000]);
    } finally {
      await loop.stop();
    }
  });

  test('a burst of changes is looked at no more often than a busy loop would', async () => {
    const changes = commits();
    const clock = manualClock();
    const starts: number[] = [];
    const loop = quietLoop(
      async () => {
        starts.push(clock.now());
        return false;
      },
      { busyMs: 100, idleMs: 60_000, wakeOn: changes.source, clock },
    );
    try {
      await clock.advance(150);
      for (let index = 0; index < 50; index++) {
        changes.commit();
        await clock.advance(5);
      }
      await clock.advance(120);
      expect(starts).toEqual([0, 150, 250, 350, 450]);
      // Even a burst just before the next allowed start cannot bring it forward.
      changes.commit();
      await clock.advance(0);
      expect(starts).toEqual([0, 150, 250, 350, 450]);
      await clock.advance(29);
      expect(starts).toEqual([0, 150, 250, 350, 450]);
      await clock.advance(1);
      expect(starts).toEqual([0, 150, 250, 350, 450, 550]);
    } finally {
      await loop.stop();
    }
  });

  test.each([60, 270])(
    'a change during a pass ending at %i ms waits for that pass and the busy interval',
    async (endsAt) => {
      const changes = commits();
      const clock = manualClock();
      const held = Promise.withResolvers<void>();
      const starts: number[] = [];
      const loop = quietLoop(
        async () => {
          starts.push(clock.now());
          if (starts.length === 1) await held.promise;
          return false;
        },
        { busyMs: 100, idleMs: 60_000, wakeOn: changes.source, clock },
      );
      try {
        await clock.advance(20);
        changes.commit();
        changes.commit();
        await clock.advance(endsAt - 20);
        expect(starts).toEqual([0]);
        held.resolve();
        await clock.advance(0);
        if (endsAt < 100) {
          expect(starts).toEqual([0]);
          await clock.advance(100 - endsAt - 1);
          expect(starts).toEqual([0]);
          await clock.advance(1);
        }
        expect(starts).toEqual([0, Math.max(100, endsAt)]);
      } finally {
        held.resolve();
        await loop.stop();
      }
    },
  );

  test('without a change source it keeps looking at the busy pace', async () => {
    const clock = manualClock();
    const starts: number[] = [];
    const loop = quietLoop(
      async () => {
        starts.push(clock.now());
        return false;
      },
      { busyMs: 20, idleMs: 60_000, clock },
    );
    try {
      await clock.advance(100);
      expect(starts).toEqual([0, 20, 40, 60, 80, 100]);
    } finally {
      await loop.stop();
    }
  });

  test('a failing pass is reported and backs off like an empty one; stop unsubscribes', async () => {
    const changes = commits();
    const clock = manualClock();
    const errors: unknown[] = [];
    const failure = new Error('database unavailable');
    const loop = quietLoop(
      async () => {
        throw failure;
      },
      {
        busyMs: 20,
        idleMs: 80,
        wakeOn: changes.source,
        onError: (error) => errors.push(error),
        clock,
      },
    );
    try {
      await clock.advance(400);
      expect(errors).toEqual(Array(6).fill(failure));
    } finally {
      await loop.stop();
    }
    expect(changes.listeners.size).toBe(0);
    expect(clock.pending()).toBe(0);
    changes.commit();
    await clock.advance(100);
    expect(errors).toHaveLength(6);
  });

  test('the default clock schedules another pass', async () => {
    const second = Promise.withResolvers<void>();
    let passes = 0;
    const loop = quietLoop(
      async () => {
        if (++passes === 2) second.resolve();
        return false;
      },
      { busyMs: 1, idleMs: 60_000 },
    );
    try {
      await second.promise;
      expect(passes).toBe(2);
    } finally {
      await loop.stop();
    }
  });
});
