/**
 * The limits on use through Composio: unset means uncapped, each dimension's
 * cap is hard, a monthly credit lets use past a cap only while the estimated
 * overage stays within it, Composio's own larger count wins, the account cap
 * holds under concurrency, and many callers at once never pass a cap.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import type { ComposioClient } from '../connectors/composio.ts';
import { sweepManagedRemovals } from '../connectors/managed-accounts.ts';
import {
  CAP_WORDS,
  ComposioCapReached,
  ComposioMeter,
  type MeterSettings,
  meterSettings,
  periodOf,
} from './managed-calls.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
afterAll(() => handle?.close());

const RATES = { tool_calls: 0.0005, trigger_events: 0.005 };
const settings = (more: Partial<MeterSettings> = {}): MeterSettings => ({
  caps: {},
  ratesUsd: RATES,
  billingDay: 1,
  ...more,
});
const meter = (more: Partial<MeterSettings> = {}) => {
  if (!handle) throw new Error('Postgres unavailable');
  return new ComposioMeter(handle.sql, settings(more));
};
const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe('the billing period', () => {
  test('starts on the configured day, in UTC', () => {
    const at = Date.parse('2026-10-14T23:00:00Z');
    expect(periodOf(at, 1).start).toBe('2026-10-01');
    expect(periodOf(at, 15).start).toBe('2026-09-15');
    expect(periodOf(Date.parse('2026-01-03T00:00:00Z'), 5).start).toBe('2025-12-05');
    expect(periodOf(at, 14)).toMatchObject({
      start: '2026-10-14',
      to: Date.parse('2026-11-14T00:00:00Z'),
    });
  });

  test('settings come from the environment, unset meaning no limit', () => {
    const base = {
      MELETE_COMPOSIO_TOOL_CALL_USD: 0.0005,
      MELETE_COMPOSIO_TRIGGER_EVENT_USD: 0.005,
      MELETE_COMPOSIO_BILLING_DAY: 1,
    };
    expect(meterSettings(base)).toEqual({ caps: {}, ratesUsd: RATES, billingDay: 1 });
    // The older name still sets the tool-call cap; the new one wins over it.
    expect(meterSettings({ ...base, MELETE_MANAGED_CALLS_MONTHLY_CAP: 10 }).caps).toEqual({
      tool_calls: 10,
    });
    expect(
      meterSettings({
        ...base,
        MELETE_MANAGED_CALLS_MONTHLY_CAP: 10,
        MELETE_COMPOSIO_TOOL_CALLS_MONTHLY_CAP: 20,
        MELETE_COMPOSIO_TRIGGER_EVENTS_MONTHLY_CAP: 5,
        MELETE_COMPOSIO_ACCOUNTS_CAP: 3,
        MELETE_COMPOSIO_MONTHLY_CREDIT_USD: 25,
      }),
    ).toMatchObject({
      caps: { tool_calls: 20, trigger_events: 5 },
      accountsCap: 3,
      creditUsd: 25,
    });
  });
});

withDb('the Composio meter', () => {
  beforeEach(async () => {
    if (!handle) return;
    await handle.sql`delete from composio_usage`;
    await handle.sql`delete from managed_account_removal`;
  });

  test('with no limit set, nothing is ever refused, and every call is still counted', async () => {
    const open = meter();
    for (let i = 0; i < 25; i++) await open.reserve('tool_calls');
    for (let i = 0; i < 5; i++)
      expect(await open.record('trigger_events')).toEqual({ spent: false });
    expect(await open.spent('tool_calls')).toBe(false);
    expect(await open.withAccountSlot(async () => 'made')).toBe('made');
    const standing = await open.standing();
    expect(standing.dimensions.tool_calls).toEqual({ used: 25, cap: null, state: 'ok' });
    expect(standing.dimensions.trigger_events).toEqual({ used: 5, cap: null, state: 'ok' });
  });

  test('a tool-call cap is hard: the call past it is refused before it is sent, and a call given back frees its place', async () => {
    const capped = meter({ caps: { tool_calls: 3 } });
    const first = await capped.reserve('tool_calls');
    await capped.reserve('tool_calls');
    await capped.reserve('tool_calls');
    const past = await refused(capped.reserve('tool_calls'));
    expect(past).toBeInstanceOf(ComposioCapReached);
    expect((past as ComposioCapReached).message).toBe(CAP_WORDS.tool_calls);
    expect((past as ComposioCapReached).message).toContain('until the month resets');
    expect((await capped.standing()).dimensions.tool_calls).toEqual({
      used: 3,
      cap: 3,
      state: 'reached',
    });
    // A call Composio refused before running is given back.
    await capped.release(first);
    expect(await capped.spent('tool_calls')).toBe(false);
    await capped.reserve('tool_calls');
    expect(await refused(capped.reserve('tool_calls'))).toBeInstanceOf(ComposioCapReached);
  });

  test('a cap of zero refuses every call', async () => {
    const closed = meter({ caps: { tool_calls: 0, trigger_events: 0 } });
    expect(await refused(closed.reserve('tool_calls'))).toBeInstanceOf(ComposioCapReached);
    expect(await closed.spent('trigger_events')).toBe(true);
  });

  test('close to a cap, the standing says near', async () => {
    const capped = meter({ caps: { tool_calls: 10 } });
    for (let i = 0; i < 8; i++) await capped.reserve('tool_calls');
    expect((await capped.standing()).state).toBe('near');
  });

  test('with a credit, use goes past a cap only while the estimated overage stays within the credit, across dimensions', async () => {
    // Two free tool calls, then 0.0005 each; one free event, then 0.005 each; a credit of 0.01.
    const credited = meter({ caps: { tool_calls: 2, trigger_events: 1 }, creditUsd: 0.01 });
    for (let i = 0; i < 2; i++) await credited.reserve('tool_calls');
    // Ten calls past the cap cost 0.005, half the credit.
    for (let i = 0; i < 10; i++) await credited.reserve('tool_calls');
    expect((await credited.standing()).overageUsd).toBeCloseTo(0.005, 10);
    // An event past its free one costs 0.005: the credit is now spent exactly.
    expect(await credited.record('trigger_events')).toEqual({ spent: false });
    expect(await credited.record('trigger_events')).toEqual({ spent: true });
    expect((await credited.standing()).overageUsd).toBeCloseTo(0.01, 10);
    // Any further call would pass the credit, so it is refused.
    expect(await refused(credited.reserve('tool_calls'))).toBeInstanceOf(ComposioCapReached);
    const standing = await credited.standing();
    expect(standing.creditUsd).toBe(0.01);
    expect(standing.dimensions.tool_calls.state).toBe('reached');
    // Without the credit the same counts are past the cap long ago.
    expect(await meter({ caps: { tool_calls: 2 } }).spent('tool_calls')).toBe(true);
  });

  test('Composio’s own count is used when it is larger than Melete’s', async () => {
    const capped = meter({ caps: { tool_calls: 100 } });
    await capped.reserve('tool_calls');
    await capped.reconcile(async () => ({
      tool_calls: 99,
      trigger_events_delivered: 4,
      sessions: 7,
    }));
    const standing = await capped.standing();
    expect(standing.dimensions.tool_calls.used).toBe(99);
    expect(standing.dimensions.trigger_events.used).toBe(4);
    // A call made after Composio's report is added to it: 99 reported, then one more.
    await capped.reserve('tool_calls');
    expect((await capped.standing()).dimensions.tool_calls.used).toBe(100);
    expect(await refused(capped.reserve('tool_calls'))).toBeInstanceOf(ComposioCapReached);
    // A smaller report never takes the count below Melete's own.
    const again = meter({ caps: { tool_calls: 100 } });
    await again.reconcile(async () => ({ tool_calls: 1 }), 0);
    expect((await again.standing()).dimensions.tool_calls.used).toBe(2);
  });

  test('many callers at once, on two meters, never pass the cap', async () => {
    const cap = 40;
    const a = meter({ caps: { tool_calls: cap } });
    const b = meter({ caps: { tool_calls: cap } });
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        (i % 2 ? a : b).reserve('tool_calls').then(
          () => 'sent',
          (error: unknown) => (error instanceof ComposioCapReached ? 'refused' : 'error'),
        ),
      ),
    );
    expect(results.filter((r) => r === 'sent')).toHaveLength(cap);
    expect(results.filter((r) => r === 'refused')).toHaveLength(120 - cap);
    expect((await a.standing()).dimensions.tool_calls.used).toBe(cap);
  });

  test('the account cap holds while two sign-ins race for the last place', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const sql = handle.sql;
    const capped = meter({ accountsCap: 2 });
    await sql`insert into managed_account_removal (connected_account_id) values ('ca_existing1')`;
    const make = (id: string) => async () => {
      // Composio takes a moment to make the account; the slot is held meanwhile.
      await Bun.sleep(30);
      await sql`insert into managed_account_removal (connected_account_id) values (${id})`;
      return id;
    };
    const raced = await Promise.all(
      ['ca_racer01', 'ca_racer02', 'ca_racer03'].map((id) =>
        capped.withAccountSlot(make(id)).then(
          (made) => made,
          (error: unknown) => (error instanceof ComposioCapReached ? error.dimension : 'error'),
        ),
      ),
    );
    expect(raced.filter((r) => r.startsWith('ca_'))).toHaveLength(1);
    expect(raced.filter((r) => r === 'connected_accounts')).toHaveLength(2);
    expect((await capped.standing()).accounts).toEqual({ used: 2, cap: 2 });
  });

  test('the account lock is let go before Composio is called, and a held place is let go after', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const sql = handle.sql;
    const capped = meter({ accountsCap: 3 });
    // Two sign-ins at once: each waits inside `make` until the other is there too,
    // which only happens when neither holds the lock while Composio answers.
    let inside = 0;
    let most = 0;
    const make = (id: string) => async () => {
      inside += 1;
      most = Math.max(most, inside);
      for (let waited = 0; inside < 2 && waited < 2_000; waited += 10) await Bun.sleep(10);
      await sql`insert into managed_account_removal (connected_account_id) values (${id})`;
      inside -= 1;
      return id;
    };
    const made = await Promise.all([
      capped.withAccountSlot(make('ca_overlap1')),
      capped.withAccountSlot(make('ca_overlap2')),
    ]);
    expect(made).toEqual(['ca_overlap1', 'ca_overlap2']);
    expect(most).toBe(2);
    // Held places are gone; only the two accounts count.
    const held =
      await sql`select 1 from managed_account_removal where connected_account_id like 'slot_%'`;
    expect(held).toHaveLength(0);
    expect((await capped.standing()).accounts).toEqual({ used: 2, cap: 3 });
    // A sign-in whose call to Composio failed gives its place back.
    expect(
      await refused(
        capped.withAccountSlot(async () => {
          throw new Error('composio_unavailable');
        }),
      ),
    ).toBeInstanceOf(Error);
    expect((await capped.standing()).accounts).toEqual({ used: 2, cap: 3 });
  });

  test('a place a crash left held counts until it falls due, then goes without reaching Composio', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const sql = handle.sql;
    const capped = meter({ accountsCap: 1 });
    await sql`insert into managed_account_removal (connected_account_id, next_attempt_at)
      values ('slot_crashed', now() + interval '1 hour')`;
    expect(await refused(capped.withAccountSlot(async () => 'made'))).toBeInstanceOf(
      ComposioCapReached,
    );
    const untouchable = {
      removeAccount: async () => {
        throw new Error('a held place must never reach Composio');
      },
    } as unknown as ComposioClient;
    const due = Date.now() + 2 * 60 * 60_000;
    expect(await sweepManagedRemovals(sql, untouchable, due)).toEqual({
      removed: [],
      kept: [],
      failed: [],
    });
    expect(await capped.withAccountSlot(async () => 'made')).toBe('made');
  });

  test('the month turns over at the start of the billing day, in UTC; a call given back after it returns to its own month', async () => {
    let clock = Date.parse('2026-10-14T23:59:59.999Z');
    if (!handle) throw new Error('Postgres unavailable');
    const capped = new ComposioMeter(
      handle.sql,
      settings({ caps: { tool_calls: 2 }, billingDay: 15 }),
      () => clock,
    );
    const first = await capped.reserve('tool_calls');
    await capped.reserve('tool_calls');
    expect(first.period).toBe('2026-09-15');
    expect(await refused(capped.reserve('tool_calls'))).toBeInstanceOf(ComposioCapReached);
    // One millisecond later is a new month with its own count.
    clock = Date.parse('2026-10-15T00:00:00.000Z');
    const fresh = await capped.reserve('tool_calls');
    expect(fresh.period).toBe('2026-10-15');
    expect((await capped.standing()).dimensions.tool_calls).toMatchObject({ used: 1 });
    // The last month's call given back now leaves this month's count alone.
    await capped.release(first);
    expect((await capped.standing()).dimensions.tool_calls).toMatchObject({ used: 1 });
    const [old] = await handle.sql`select used from composio_usage
      where period = '2026-09-15' and dimension = 'tool_calls'`;
    expect(Number(old?.used)).toBe(1);
  });

  test('a limit lowered below this month’s use refuses every call at once, an approved one included', async () => {
    const generous = meter({ caps: { tool_calls: 10 } });
    for (let i = 0; i < 5; i++) await generous.reserve('tool_calls');
    const lowered = meter({ caps: { tool_calls: 3 } });
    expect(await refused(lowered.reserve('tool_calls'))).toBeInstanceOf(ComposioCapReached);
    expect(await lowered.spent('tool_calls')).toBe(true);
    expect((await lowered.standing()).dimensions.tool_calls).toEqual({
      used: 5,
      cap: 3,
      state: 'reached',
    });
    // Nothing was added by the refusals.
    expect((await generous.standing()).dimensions.tool_calls.used).toBe(5);
  });

  test('a call sent while Composio’s count is read is counted on top of it, never lost', async () => {
    const capped = meter({ caps: { tool_calls: 100 } });
    await capped.reserve('tool_calls');
    // Composio counts 50 (calls it ran that Melete gave back, say); while it
    // answers, one more call is sent, which its answer does not include.
    await capped.reconcile(async () => {
      await capped.reserve('tool_calls');
      return { tool_calls: 50 };
    }, 0);
    expect((await capped.standing()).dimensions.tool_calls.used).toBe(51);
    await capped.reserve('tool_calls');
    expect((await capped.standing()).dimensions.tool_calls.used).toBe(52);
  });
});
