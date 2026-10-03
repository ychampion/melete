/**
 * Singleton background work runs only where this instance leads it: the blob
 * collector, egress record retention and the process monitor each ask their
 * lease first, and an instance that does not hold it touches nothing.
 */
import { describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { startEgressRetention } from '../egress/records.ts';
import { startEpisodeRetention } from '../learning/retention.ts';
import { ProcessMonitor } from '../sandbox/process-monitor.ts';
import type { BlobStore } from '../storage/blob.ts';
import { BlobCollector } from '../storage/gc.ts';

/** A database that counts every query it is asked and answers none. */
function countingSql() {
  const calls: string[] = [];
  const query = (strings: TemplateStringsArray) => {
    calls.push(strings.join('?'));
    return Promise.resolve(Object.assign([], { count: 0 }));
  };
  // Raw fragments are counted when they are used, inside the query that holds them.
  const sql = Object.assign(query, { unsafe: (text: string) => text }) as unknown as Sql;
  return { sql, calls };
}

/** A store that counts how often it is listed, and holds nothing. */
function countingStore() {
  let listed = 0;
  const store = {
    list() {
      listed += 1;
      return (async function* () {})();
    },
  } as unknown as BlobStore;
  return { store, listed: () => listed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('singleton work and the leader lease', () => {
  for (const leading of [false, true])
    test(`the blob collector ${leading ? 'collects' : 'does nothing'} when this instance ${leading ? 'leads' : 'does not lead'}`, async () => {
      const { sql } = countingSql();
      const { store, listed } = countingStore();
      const collector = new BlobCollector({
        sql,
        store,
        firstPassDelayMs: 0,
        intervalMs: 60_000,
        leads: () => leading,
      });
      collector.start();
      await settle();
      await collector.stop();
      expect(listed()).toBe(leading ? 1 : 0);
    });

  for (const leading of [false, true])
    test(`egress record retention ${leading ? 'expires records' : 'deletes nothing'} when this instance ${leading ? 'leads' : 'does not lead'}`, async () => {
      const { sql, calls } = countingSql();
      const stop = startEgressRetention(
        sql,
        30,
        () => {},
        () => Promise.resolve(leading),
      );
      await settle();
      stop();
      expect(calls.filter((query) => query.includes('delete from egress_record'))).toHaveLength(
        leading ? 1 : 0,
      );
    });

  for (const leading of [false, true])
    test(`episode retention ${leading ? 'expires episodes' : 'touches nothing'} when this instance ${leading ? 'leads' : 'does not lead'}`, async () => {
      let opened = 0;
      const sql = {
        begin: async () => {
          opened += 1;
          return 0;
        },
      } as never;
      const stop = startEpisodeRetention(sql, () => leading, 5);
      await settle();
      stop();
      expect(opened > 0).toBe(leading);
    });

  for (const leading of [false, true])
    test(`the process monitor ${leading ? 'reads its watches' : 'reads nothing'} when this instance ${leading ? 'leads' : 'does not lead'}`, async () => {
      const { sql, calls } = countingSql();
      const monitor = new ProcessMonitor({
        sql,
        processes: {} as never,
        providers: () => ({}) as never,
        wakes: { deliver: async () => undefined, processEnded: async () => 0 },
        leads: () => leading,
      });
      await monitor.pass(new AbortController().signal).catch(() => undefined);
      expect(calls.length > 0).toBe(leading);
    });
});
