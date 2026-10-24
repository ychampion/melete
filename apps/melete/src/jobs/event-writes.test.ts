import { describe, expect, test } from 'bun:test';
import type { Transaction } from '../db/transaction.ts';
import { EventWrites } from './event-writes.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A transaction commits its rows together, only after its final gate opens. */
function database(
  options: {
    beforeBegin?: (call: number) => void;
    beforeCommit?: (call: number) => Promise<void>;
  } = {},
) {
  const committed: string[] = [];
  const batches: string[][] = [];
  let calls = 0;
  const transaction = async (operation: (tx: Transaction) => Promise<void>) => {
    const call = ++calls;
    options.beforeBegin?.(call);
    const rows: string[] = [];
    await operation({ rows } as unknown as Transaction);
    await options.beforeCommit?.(call);
    committed.push(...rows);
    batches.push(rows);
  };
  return { transaction, committed, batches, calls: () => calls };
}

function insert(tx: Transaction, value: string): void {
  (tx as unknown as { rows: string[] }).rows.push(value);
}

const unchanged = () => {};

describe('runtime writes sharing a transaction', () => {
  test('callers ready across adjacent microtasks share the collection window', async () => {
    const db = database();
    const writes = new EventWrites(db.transaction, () => 2);
    const first = writes.write(async (tx) => insert(tx, 'a'), unchanged);
    await Promise.resolve();
    const second = writes.write(async (tx) => insert(tx, 'b'), unchanged);
    await Promise.all([first, second]);
    expect(db.batches).toEqual([['a', 'b']]);
  });
  test('concurrent callers commit together, in order, and are acknowledged only after commit', async () => {
    const entered = gate();
    const commit = gate();
    const db = database({
      beforeCommit: async () => {
        entered.resolve();
        await commit.promise;
      },
    });
    const writes = new EventWrites(db.transaction);
    const acknowledged: string[] = [];
    const first = writes
      .write(async (tx) => insert(tx, 'a'), unchanged)
      .then(() => acknowledged.push('a'));
    const second = writes
      .write(async (tx) => insert(tx, 'b'), unchanged)
      .then(() => acknowledged.push('b'));
    await entered.promise;
    expect(db.calls()).toBe(1);
    expect(db.committed).toEqual([]);
    expect(acknowledged).toEqual([]);
    commit.resolve();
    await Promise.all([first, second]);
    expect(db.batches).toEqual([['a', 'b']]);
    expect(acknowledged).toEqual(['a', 'b']);
  });

  test('callers arriving during a transaction share the next transaction', async () => {
    const entered = gate();
    const commit = gate();
    const db = database({
      beforeCommit: async (call) => {
        if (call !== 1) return;
        entered.resolve();
        await commit.promise;
      },
    });
    const writes = new EventWrites(db.transaction);
    const first = writes.write(async (tx) => insert(tx, 'a'), unchanged);
    await entered.promise;
    const second = writes.write(async (tx) => insert(tx, 'b'), unchanged);
    const third = writes.write(async (tx) => insert(tx, 'c'), unchanged);
    expect(db.calls()).toBe(1);
    commit.resolve();
    await Promise.all([first, second, third]);
    expect(db.calls()).toBe(2);
    expect(db.batches).toEqual([['a'], ['b', 'c']]);
  });

  test('a failed caller rolls back shared state in reverse order and fails independently', async () => {
    const db = database();
    const writes = new EventWrites(db.transaction);
    const restored: string[] = [];
    const ran: string[] = [];
    let state = 0;
    const write = (name: string, fail = false) => {
      let before = 0;
      return writes.write(
        async (tx) => {
          ran.push(name);
          before = state;
          state++;
          insert(tx, name);
          if (fail) throw new Error('stale attempt');
        },
        () => {
          restored.push(name);
          state = before;
        },
      );
    };
    const results = await Promise.allSettled([write('a'), write('b', true), write('c')]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('stale attempt');
    expect(db.committed).toEqual(['a', 'c']);
    expect(db.calls()).toBe(4);
    expect(ran).toEqual(['a', 'b', 'a', 'b', 'c']);
    // c never ran in the shared transaction, so its cleanup must not run then.
    expect(restored).toEqual(['b', 'a', 'b']);
    expect(state).toBe(2);
  });

  test('a failed commit restores all operations before retrying them independently', async () => {
    const db = database({
      beforeCommit: async (call) => {
        if (call === 1) throw new Error('commit failed');
      },
    });
    const writes = new EventWrites(db.transaction);
    const restored: string[] = [];
    let state = 0;
    const write = (name: string) => {
      let before = 0;
      return writes.write(
        async (tx) => {
          before = state;
          state++;
          insert(tx, name);
        },
        () => {
          restored.push(name);
          state = before;
        },
      );
    };
    await Promise.all([write('a'), write('b')]);
    expect(restored).toEqual(['b', 'a']);
    expect(db.calls()).toBe(3);
    expect(db.committed).toEqual(['a', 'b']);
    expect(state).toBe(2);
  });

  test('a singleton failure is not retried and does not poison the next write', async () => {
    const db = database();
    const writes = new EventWrites(db.transaction);
    let restored = 0;
    const failed = writes.write(
      async (tx) => {
        insert(tx, 'lost');
        throw new Error('stale attempt');
      },
      () => restored++,
    );
    await expect(failed).rejects.toThrow('stale attempt');
    expect(db.calls()).toBe(1);
    expect(restored).toBe(1);
    await writes.write(async (tx) => insert(tx, 'kept'), unchanged);
    expect(db.calls()).toBe(2);
    expect(db.committed).toEqual(['kept']);
  });

  test('a transaction refused before it starts restores no operation state', async () => {
    const db = database({
      beforeBegin: (call) => {
        if (call === 1) throw new Error('connection closed');
      },
    });
    const writes = new EventWrites(db.transaction);
    let ran = 0;
    let restored = 0;
    const failed = writes.write(
      async () => {
        ran++;
      },
      () => {
        restored++;
      },
    );
    await expect(failed).rejects.toThrow('connection closed');
    expect(ran).toBe(0);
    expect(restored).toBe(0);
    await writes.write(async (tx) => insert(tx, 'next'), unchanged);
    expect(db.committed).toEqual(['next']);
  });

  test('a large queue is bounded and preserves order across commits', async () => {
    const db = database();
    const writes = new EventWrites(db.transaction);
    const values = Array.from({ length: 130 }, (_, index) => String(index));
    await Promise.all(
      values.map((value) => writes.write(async (tx) => insert(tx, value), unchanged)),
    );
    expect(db.calls()).toBe(3);
    expect(db.batches.map((batch) => batch.length)).toEqual([64, 64, 2]);
    expect(db.committed).toEqual(values);
  });
});
