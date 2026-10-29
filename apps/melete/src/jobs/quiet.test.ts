import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import type { Db as IDatabase, PgBoss } from 'pg-boss';
import { testDatabase } from '../../test/helpers/database.ts';
import { QUIET_QUEUES, startQueue } from './queue.ts';
import { DUE_SCAN_MS, startDueWaker, workQuiet } from './quiet.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const withDb = queue ? describe : describe.skip;
afterAll(async () => {
  await queue?.stop();
  await handle?.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function boss() {
  if (!queue) throw new Error('Postgres unavailable');
  return queue.boss;
}

/** A worker as the service starts them, recording when each job ran. */
async function worker(
  name: string,
  quiet: boolean,
  handler: (data: unknown) => unknown = () => {},
) {
  const ran: number[] = [];
  const work = async (jobs: { data: unknown }[]) => {
    for (const job of jobs) {
      ran.push(Date.now());
      await handler(job.data);
    }
  };
  const options = { batchSize: 1, pollingIntervalSeconds: 0.5 };
  let id: string;
  if (quiet) id = await workQuiet(boss(), name, options, work);
  else {
    await boss().createQueue(name);
    id = await boss().work(name, options, work);
  }
  const lastFetch = () =>
    boss()
      .getWipData()
      .find((wip) => wip.id === id)?.lastFetchedOn ?? null;
  return { ran, lastFetch, stop: () => boss().offWork(name) };
}

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(25);
  return check();
}

withDb('queues woken by notices', () => {
  test('the service queues that only take work from the queue are woken by notices', async () => {
    for (const name of QUIET_QUEUES) expect((await boss().getQueue(name))?.notify).toBe(true);
  });

  test('an idle worker on such a queue stops asking the database every half second', async () => {
    const quiet = await worker('test.quiet.idle', true);
    const loud = await worker('test.loud.idle', false);
    try {
      await sleep(1500);
      const quietBefore = quiet.lastFetch();
      const loudBefore = loud.lastFetch();
      await sleep(3000);
      expect(quietBefore).not.toBeNull();
      // The ordinary queue fetched again within the same three seconds; the quiet one did not.
      expect(quiet.lastFetch()).toBe(quietBefore);
      expect(loud.lastFetch()).not.toBe(loudBefore);
    } finally {
      await quiet.stop();
      await loud.stop();
    }
  }, 15_000);

  test('new work wakes the worker at once', async () => {
    const quiet = await worker('test.quiet.wake', true);
    try {
      await sleep(1500);
      const sent = Date.now();
      await boss().send('test.quiet.wake', { n: 1 });
      expect(await until(() => quiet.ran.length === 1, 3000)).toBe(true);
      expect((quiet.ran[0] ?? Number.POSITIVE_INFINITY) - sent).toBeLessThan(1000);
    } finally {
      await quiet.stop();
    }
  }, 15_000);

  test('a job with a start time runs when it is due, not at the next half-minute poll', async () => {
    const quiet = await worker('test.quiet.due', true);
    try {
      await sleep(1500);
      // Sent further ahead than the waker looks, so it is found before it is due.
      const due = Date.now() + DUE_SCAN_MS + 2000;
      await boss().send('test.quiet.due', { n: 1 }, { startAfter: new Date(due) });
      expect(await until(() => quiet.ran.length === 1, DUE_SCAN_MS + 6000)).toBe(true);
      const late = (quiet.ran[0] ?? Number.POSITIVE_INFINITY) - due;
      expect(late).toBeGreaterThanOrEqual(-50);
      expect(late).toBeLessThan(1000);
    } finally {
      await quiet.stop();
    }
  }, 20_000);

  test('a job due sooner than the waker looks runs within one look', async () => {
    const quiet = await worker('test.quiet.soon', true);
    try {
      await sleep(1500);
      const due = Date.now() + 1000;
      await boss().send('test.quiet.soon', { n: 1 }, { startAfter: new Date(due) });
      expect(await until(() => quiet.ran.length === 1, DUE_SCAN_MS + 4000)).toBe(true);
      expect((quiet.ran[0] ?? Number.POSITIVE_INFINITY) - due).toBeLessThan(DUE_SCAN_MS + 1000);
    } finally {
      await quiet.stop();
    }
  }, 20_000);

  test('many jobs due at the same moment all run then, not one per look', async () => {
    const quiet = await worker('test.quiet.together', true, () => sleep(20));
    try {
      await sleep(1500);
      const due = Date.now() + DUE_SCAN_MS + 2000;
      for (let n = 0; n < 10; n++)
        await boss().send('test.quiet.together', { n }, { startAfter: new Date(due) });
      expect(await until(() => quiet.ran.length === 10, DUE_SCAN_MS + 8000)).toBe(true);
      expect((quiet.ran.at(-1) ?? Number.POSITIVE_INFINITY) - due).toBeLessThan(1500);
    } finally {
      await quiet.stop();
    }
  }, 25_000);

  test('work sent while the worker is busy is done straight after', async () => {
    const quiet = await worker('test.quiet.burst', true, () => sleep(100));
    try {
      await sleep(1500);
      const sent = Date.now();
      await boss().insert(
        'test.quiet.burst',
        Array.from({ length: 10 }, (_, n) => ({ data: { n } })),
      );
      expect(await until(() => quiet.ran.length === 10, 8000)).toBe(true);
      expect((quiet.ran.at(-1) ?? Number.POSITIVE_INFINITY) - sent).toBeLessThan(3000);
    } finally {
      await quiet.stop();
    }
  }, 20_000);

  test('a retry after a failure runs within one look', async () => {
    let attempts = 0;
    const quiet = await worker('test.quiet.retry', true, () => {
      attempts++;
      if (attempts === 1) throw new Error('first try fails');
    });
    try {
      await sleep(1500);
      // A retry waits its delay, so the look straight after the failure finds nothing.
      await boss().send('test.quiet.retry', { n: 1 }, { retryLimit: 1, retryDelay: 2 });
      expect(await until(() => quiet.ran.length === 2, DUE_SCAN_MS + 6000)).toBe(true);
      const [first = 0, second = Number.POSITIVE_INFINITY] = quiet.ran;
      expect(second - first).toBeGreaterThanOrEqual(1900);
      expect(second - first).toBeLessThan(2000 + DUE_SCAN_MS + 1000);
    } finally {
      await quiet.stop();
    }
  }, 25_000);
});

/** Drive timer callbacks and database barriers explicitly, without stopwatch assertions. */
async function wakerHarness(
  run: (h: {
    hint: () => void;
    reconnect: () => void;
    fire: () => Promise<void>;
    flush: () => Promise<void>;
    pending: () => number[];
    scans: () => number;
    closes: () => number;
    rows: (value: { name: string; wait_ms: number }[]) => void;
    block: () => () => void;
    subscribe: () => void;
    stop: () => Promise<void>;
  }) => Promise<void>,
  listening: 'yes' | 'absent' | 'failed' | 'starting' = 'yes',
) {
  const timers = new Map<object, { callback: () => void; ms: number }>();
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms = 0,
  ) => {
    const timer = { unref() {} };
    timers.set(timer, { callback, ms });
    return timer;
  }) as unknown as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: object) => {
    timers.delete(timer);
  }) as unknown as typeof clearTimeout);
  let onHint = () => {};
  let onReconnect = () => {};
  let subscribe = () => {};
  let scans = 0;
  let closes = 0;
  let rows: { name: string; wait_ms: number }[] = [];
  let barrier: Promise<void> | undefined;
  const db: IDatabase = {
    async executeSql(text) {
      if (!text.includes('extract(epoch from min(start_after)')) return { rows: [] };
      scans++;
      const snapshot = rows;
      await barrier;
      barrier = undefined;
      return { rows: snapshot };
    },
    ...(listening === 'absent'
      ? {}
      : {
          async listen(_channel: string, hint: (payload: string) => void, reconnect: () => void) {
            onHint = () => hint('');
            onReconnect = reconnect;
            if (listening === 'failed') throw new Error('LISTEN unavailable');
            if (listening === 'starting')
              await new Promise<void>((resolve) => {
                subscribe = resolve;
              });
            reconnect();
            return {
              async close() {
                closes++;
              },
            };
          },
        }),
  };
  const waker = startDueWaker({ getDb: () => db } as PgBoss, { say: () => {} });
  const flush = async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  };
  try {
    await flush();
    await run({
      hint: () => onHint(),
      reconnect: () => onReconnect(),
      subscribe: () => subscribe(),
      flush,
      pending: () => [...timers.values()].map((t) => t.ms),
      scans: () => scans,
      closes: () => closes,
      rows: (value) => {
        rows = value;
      },
      block: () => {
        let release = () => {};
        barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        return release;
      },
      async fire() {
        const first = timers.entries().next().value;
        if (!first) throw new Error('No scheduled scan');
        timers.delete(first[0]);
        first[1].callback();
        await flush();
      },
      stop: () => waker.stop(),
    });
  } finally {
    subscribe();
    await waker.stop();
    timerSpy.mockRestore();
    clearSpy.mockRestore();
  }
}

describe('due waker interleavings', () => {
  test('idle scans keep the five-second bound; repeated hints coalesce and find the deadline', async () => {
    await wakerHarness(async (h) => {
      expect(h.scans()).toBe(1);
      expect(h.pending()).toEqual([DUE_SCAN_MS]);
      for (let i = 0; i < 20; i++) h.hint();
      expect(h.pending()).toEqual([0]);
      h.rows([{ name: 'scheduled', wait_ms: 250 }]);
      await h.fire();
      expect(h.scans()).toBe(2);
      expect(h.pending()).toEqual([250]);
      await h.stop();
      expect(h.pending()).toEqual([]);
      expect(h.closes()).toBe(1);
      h.hint();
      h.reconnect();
      await h.flush();
      expect(h.scans()).toBe(2);
    });
  });

  test('a hint during a scan survives its older empty snapshot', async () => {
    await wakerHarness(async (h) => {
      const release = h.block();
      h.hint();
      await h.fire();
      h.rows([{ name: 'scheduled', wait_ms: 200 }]);
      h.hint();
      h.hint();
      release();
      await h.flush();
      expect(h.pending()).toEqual([0]);
      await h.fire();
      expect(h.pending()).toEqual([200]);
      expect(h.scans()).toBe(3);
    });
  });

  test('reconnect scans for missed work', async () => {
    await wakerHarness(async (h) => {
      h.rows([{ name: 'missed', wait_ms: 100 }]);
      h.reconnect();
      await h.fire();
      expect(h.pending()).toEqual([100]);
    });
  });

  test.each(['absent', 'failed'] as const)(
    '%s listener retains the normal fallback',
    async (mode) => {
      await wakerHarness(async (h) => {
        expect(h.pending()).toEqual([DUE_SCAN_MS]);
        h.rows([{ name: 'missed', wait_ms: -100 }]);
        await h.fire();
        expect(h.scans()).toBe(2);
        expect(h.pending()).toEqual([1000]);
      }, mode);
    },
  );

  test('startup subscribes before scanning and stop closes a late subscription', async () => {
    await wakerHarness(async (h) => {
      expect(h.scans()).toBe(0);
      expect(h.pending()).toEqual([]);
      const stopped = h.stop();
      h.subscribe();
      await stopped;
      expect(h.closes()).toBe(1);
      expect(h.scans()).toBe(0);
      expect(h.pending()).toEqual([]);
    }, 'starting');
  });

  test('the first subscribed scan recovers an already queued deadline', async () => {
    await wakerHarness(async (h) => {
      h.rows([{ name: 'already_queued', wait_ms: 150 }]);
      h.hint();
      expect(h.scans()).toBe(0);
      h.subscribe();
      await h.flush();
      expect(h.scans()).toBe(1);
      expect(h.pending()).toEqual([150]);
    }, 'starting');
  });

  test('stop awaits a scan already in progress', async () => {
    await wakerHarness(async (h) => {
      const release = h.block();
      h.hint();
      await h.fire();
      let stopped = false;
      const stopping = h.stop().then(() => {
        stopped = true;
      });
      await h.flush();
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(h.pending()).toEqual([]);
    });
  });
});
