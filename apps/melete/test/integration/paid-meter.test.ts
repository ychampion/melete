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
  EXTRACT_RUN_CAP_REACHED,
  jobPaidMeter,
  MAX_EXTRACTS_PER_RUN,
  MAX_EXTRACTS_PER_TURN,
  PAID_BUDGET_REFUSED,
} from '../../src/broker/paid-meter.ts';
import { recordId } from '../../src/broker/records.ts';
import {
  type PaidCall,
  PaidCallRefused,
  TAVILY_CREDIT_USD,
} from '../../src/connectors/web-search.ts';
import { NO_LIMIT, SpendingGuard } from '../../src/gateway/spending.ts';
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
}, 15_000);

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

  test("calls side by side are held against the installation's cap while they run, and let go when settled or given up", async () => {
    // A month of its own, so no other spending counts toward this cap.
    const now = new Date('2031-03-15T12:00:00Z');
    const extract = { provider: 'tavily', kind: 'extract', maxCredits: 2 } as const;
    const guard = new SpendingGuard(
      db(),
      {
        // Room for exactly one extract at its ceiling.
        installation: { day: { usd: 2 * TAVILY_CREDIT_USD, tokens: null }, month: NO_LIMIT },
        person: { day: NO_LIMIT, month: NO_LIMIT },
        noticePercent: 80,
      },
      undefined,
      () => now,
    );
    const meter = jobPaidMeter(db(), guard);
    const first = await job();
    const second = await job();
    const tight = await job({ max_usd_est: 0.001 });
    try {
      const both = await Promise.allSettled([
        meter.reserve(await first.call(), extract),
        meter.reserve(await second.call(), extract),
      ]);
      const admitted = both.filter((result) => result.status === 'fulfilled');
      const refused = both.filter((result) => result.status === 'rejected');
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(PaidCallRefused);
      // A call that cost nothing lets its hold go.
      await meter.settle((admitted[0] as PromiseFulfilledResult<{ id: string }>).value, 0);
      // So does one the job itself refused after the cap admitted it.
      const overJob = await refusal(meter.reserve(await tight.call(), extract));
      expect((overJob as Error).message).toBe(PAID_BUDGET_REFUSED);
      const next = await meter.reserve(await second.call(), extract);
      // Settled at its cost, the call is spending, and the cap is reached.
      await meter.settle(next, 2);
      const capped = await refusal(meter.reserve(await first.call(), extract));
      expect(capped).toBeInstanceOf(PaidCallRefused);
      expect((capped as Error).message).not.toBe(PAID_BUDGET_REFUSED);
    } finally {
      await db()`delete from model_usage where job_id in
        (${first.claims.job_id}, ${second.claims.job_id}, ${tight.claims.job_id})`;
      await db()`delete from spending_notice where period >= '2031-01-01'`;
    }
  });

  test('a run and its helper steps share one count of hosted-reader pages across all their shifts', async () => {
    const run = await job();
    const runId = run.claims.job_id;
    await db()`update job set kind = 'run' where id = ${runId}`;
    await db()`insert into run_state (job_id, space_id, goal)
      values (${runId}, ${run.claims.space_id}, 'Keep the reading list current')`;
    const step = await job();
    await db()`update job set kind = 'run_step' where id = ${step.claims.job_id}`;
    await db()`insert into run_state (job_id, space_id, parent_run_id, goal)
      values (${step.claims.job_id}, ${step.claims.space_id}, ${runId}, 'Read one source')`;
    const meter = jobPaidMeter(db());
    const extract = { provider: 'tavily', kind: 'extract', maxCredits: 2 } as const;
    /** A new shift: a new attempt on the run, which alone would start a fresh turn count. */
    const shift = async (epoch: number) => {
      const attemptId = recordId('att');
      await db()`update job set lease_epoch = ${epoch} where id = ${runId}`;
      await db()`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${attemptId}, ${runId}, ${epoch}, 'fake', 'fake', 'scripted')`;
      return attemptId;
    };
    const read = async (target: typeof run, attemptId?: string) => {
      const call = await target.call();
      return meter.reserve(attemptId ? { ...call, attemptId } : call, extract);
    };
    let pages = 0;
    for (let epoch = 2; pages < MAX_EXTRACTS_PER_RUN - 1; epoch += 1) {
      const attemptId = await shift(epoch);
      for (let n = 0; n < MAX_EXTRACTS_PER_TURN && pages < MAX_EXTRACTS_PER_RUN - 1; n += 1) {
        await meter.settle(await read(run, attemptId), 2);
        pages += 1;
      }
    }
    // The helper step's page counts toward the run.
    await meter.settle(await read(step), 2);
    const fresh = await shift(50);
    const overRun = await refusal(read(run, fresh));
    expect(overRun).toBeInstanceOf(PaidCallRefused);
    expect((overRun as Error).message).toBe(EXTRACT_RUN_CAP_REACHED);
    expect((await refusal(read(step))) as Error).toBeInstanceOf(PaidCallRefused);
    // Searches are not counted.
    const search = await meter.reserve(
      { ...(await run.call()), attemptId: fresh },
      { provider: 'tavily', kind: 'search', maxCredits: 1 },
    );
    await meter.settle(search, 1);
  });
});
