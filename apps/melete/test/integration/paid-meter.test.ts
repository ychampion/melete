/**
 * Paid search and reading calls charged to the job that made them: held on
 * its spending estimate before they are sent, settled at the credits used,
 * counted on the attempt and in the spending record, and the hosted reader
 * held to a few pages each turn.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { CapabilityClaims } from '@melete/contracts';
import {
  EXTRACT_CAP_REACHED,
  jobPaidMeter,
  MAX_EXTRACTS_PER_TURN,
  PAID_BUDGET_REFUSED,
} from '../../src/broker/paid-meter.ts';
import { recordId } from '../../src/broker/records.ts';
import {
  type PaidCall,
  PaidCallRefused,
  TAVILY_CREDIT_USD,
} from '../../src/connectors/web-search.ts';
import {
  GatewayError,
  type GatewayPrincipal,
  type GatewaySettlement,
  type GatewaySpending,
} from '../../src/gateway/types.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;

afterAll(async () => {
  await handle?.close();
});

function db() {
  if (!handle) throw new Error('Postgres unavailable');
  return handle.sql;
}

async function newAction(claims: CapabilityClaims, connectionId: string): Promise<string> {
  const id = recordId('act');
  await db()`insert into action (id, job_id, attempt_id, connection_id, kind,
      effect_class, canonical_payload, payload_hash, idempotency_key, status)
    values (${id}, ${claims.job_id}, ${claims.attempt_id}, ${connectionId}, 'web.fetch', 'read',
      '{}'::jsonb, ${'d'.repeat(64)}, ${id}, 'dispatched')`;
  return id;
}

async function job(budget: { max_usd_est?: number } = {}) {
  const seeded = await seedJob(db(), {
    scopes: ['web.fetch', 'web.search'],
    provider: 'web',
    budget,
  });
  const call = async (): Promise<PaidCall> => ({
    jobId: seeded.claims.job_id,
    spaceId: seeded.claims.space_id,
    attemptId: seeded.claims.attempt_id,
    actionId: await newAction(seeded.claims, seeded.connectionId),
  });
  return { ...seeded, call };
}

function recordingSpending(refuse?: string) {
  const recorded: { principal: GatewayPrincipal; settlement: GatewaySettlement }[] = [];
  const spending: GatewaySpending = {
    async admit() {
      if (refuse) throw new GatewayError(402, 'spending_limit_reached', refuse);
    },
    async record(principal, settlement) {
      recorded.push({ principal, settlement });
    },
  };
  return { spending, recorded };
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};

withDb('paid search and reading calls', () => {
  test('a call is held at its ceiling, settled at the credits used, and counted on the attempt and in the spending record', async () => {
    const seeded = await job();
    const { spending, recorded } = recordingSpending();
    const meter = jobPaidMeter(db(), spending);
    const call = await seeded.call();
    const hold = await meter.reserve(call, { provider: 'tavily', kind: 'extract', maxCredits: 2 });
    const [held] =
      await db()`select reserved, settled, action_id, kind from budget_ledger where id = ${hold.id}`;
    expect(held).toMatchObject({ kind: 'usd_est', action_id: call.actionId, settled: null });
    expect(Number(held?.reserved)).toBeCloseTo(2 * TAVILY_CREDIT_USD);
    await meter.settle(hold, 1);
    const [settled] = await db()`select settled from budget_ledger where id = ${hold.id}`;
    expect(Number(settled?.settled)).toBeCloseTo(TAVILY_CREDIT_USD);
    const [attempt] = await db()`select usage from attempt where id = ${call.attemptId}`;
    expect(attempt?.usage).toMatchObject({ tavily_credits: 1 });
    expect(Number((attempt?.usage as { usd_est?: number } | undefined)?.usd_est)).toBeCloseTo(
      TAVILY_CREDIT_USD,
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.settlement).toMatchObject({
      provider: 'tavily',
      modelRequested: 'extract',
    });
    expect(recorded[0]?.settlement.feeUsd).toBeCloseTo(TAVILY_CREDIT_USD);
    expect(recorded[0]?.principal.jobId).toBe(call.jobId);
    const notices = await db()`select payload->>'phase' as phase from event
      where job_id = ${call.jobId} and type = 'notice' order by seq`;
    expect(notices.map((row) => row.phase)).toEqual(['paid_api_request', 'paid_api_receipt']);
    // Credits beyond the hold are never charged.
    const second = await meter.reserve(await seeded.call(), {
      provider: 'tavily',
      kind: 'search',
      maxCredits: 1,
    });
    await meter.settle(second, 50);
    const [capped] = await db()`select settled from budget_ledger where id = ${second.id}`;
    expect(Number(capped?.settled)).toBeCloseTo(TAVILY_CREDIT_USD);
  });

  test('the hosted reader reads at most a few pages each turn; searches are not counted', async () => {
    const seeded = await job();
    const meter = jobPaidMeter(db());
    await db()`update attempt set turn_id = 'turn_one' where id = ${seeded.claims.attempt_id}`;
    for (let page = 0; page < MAX_EXTRACTS_PER_TURN; page += 1) {
      const hold = await meter.reserve(await seeded.call(), {
        provider: 'tavily',
        kind: 'extract',
        maxCredits: 2,
      });
      await meter.settle(hold, 0);
    }
    const capped = await refusal(
      meter.reserve(await seeded.call(), { provider: 'tavily', kind: 'extract', maxCredits: 2 }),
    );
    expect(capped).toBeInstanceOf(PaidCallRefused);
    expect((capped as Error).message).toBe(EXTRACT_CAP_REACHED);
    expect(EXTRACT_CAP_REACHED).toContain(`at most ${MAX_EXTRACTS_PER_TURN} pages each turn`);
    // A search still goes.
    const search = await meter.reserve(await seeded.call(), {
      provider: 'tavily',
      kind: 'search',
      maxCredits: 1,
    });
    await meter.settle(search, 1);
    // The next turn starts again.
    const nextAttempt = recordId('att');
    await db()`update job set lease_epoch = 2 where id = ${seeded.claims.job_id}`;
    await db()`insert into attempt (id, job_id, epoch, runtime_version, provider, model, turn_id)
      values (${nextAttempt}, ${seeded.claims.job_id}, 2, 'fake', 'fake', 'scripted', 'turn_two')`;
    const next = await seeded.call();
    const hold = await meter.reserve(
      { ...next, attemptId: nextAttempt },
      { provider: 'tavily', kind: 'extract', maxCredits: 2 },
    );
    await meter.settle(hold, 2);
  });

  test("a call over the job's spending limit, past a spending cap, or from a replaced attempt is refused", async () => {
    const tight = await job({ max_usd_est: 0.001 });
    const meter = jobPaidMeter(db());
    const overBudget = await refusal(
      meter.reserve(await tight.call(), { provider: 'tavily', kind: 'search', maxCredits: 1 }),
    );
    expect(overBudget).toBeInstanceOf(PaidCallRefused);
    expect((overBudget as Error).message).toBe(PAID_BUDGET_REFUSED);

    const seeded = await job();
    const capMessage = 'You have reached your spending limit for today. It resets at midnight UTC.';
    const capped = await refusal(
      jobPaidMeter(db(), recordingSpending(capMessage).spending).reserve(await seeded.call(), {
        provider: 'tavily',
        kind: 'search',
        maxCredits: 1,
      }),
    );
    expect(capped).toBeInstanceOf(PaidCallRefused);
    expect((capped as Error).message).toBe(capMessage);

    const call = await seeded.call();
    await db()`update job set lease_epoch = 5 where id = ${seeded.claims.job_id}`;
    const stale = await refusal(
      meter.reserve(call, { provider: 'tavily', kind: 'search', maxCredits: 1 }),
    );
    expect(stale).toBeInstanceOf(PaidCallRefused);
    const ledger = await db()`select id from budget_ledger where job_id in
      (${tight.claims.job_id}, ${seeded.claims.job_id})`;
    expect(ledger.length).toBe(0);
  });
});
