import { afterAll, expect, test } from 'bun:test';
import { BudgetService } from '../../src/broker/budget.ts';
import { signCapability } from '../../src/broker/capability.ts';
import { PostgresGatewayBudget } from '../../src/broker/gateway-budget.ts';
import { recordId } from '../../src/broker/records.ts';
import type { GatewaySettlement } from '../../src/gateway/types.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});
const key = 'gateway-budget-fixture-key-0000000000000000';
const receipt: GatewaySettlement = {
  provider: 'fake',
  modelRequested: 'scripted',
  modelActual: 'fake-scripted-v1',
  usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, cachedInputTokens: 0 },
  latencyMs: 10,
  status: 'succeeded',
  httpStatus: 200,
};

databaseTest('two parallel reservations against a small allowance admit exactly one', async () => {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const seed = await seedJob(fixture.sql, { budget: { max_output_tokens: 10 } });
  const budget = new BudgetService(fixture.sql);
  const results = await Promise.allSettled([
    budget.reserve(seed.claims, [{ kind: 'tokens', amount: 7 }]),
    budget.reserve(seed.claims, [{ kind: 'tokens', amount: 7 }]),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const [row] =
    await fixture.sql`select sum(reserved)::int as total from budget_ledger where job_id = ${seed.claims.job_id}`;
  expect(row?.total).toBe(7);
});

databaseTest(
  'settlement releases unused allowance, remains idempotent, and preserves unknown reservations',
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const seed = await seedJob(fixture.sql, { budget: { max_output_tokens: 10 } });
    const budget = new BudgetService(fixture.sql);
    const [reserved] = await budget.reserve(seed.claims, [{ kind: 'tokens', amount: 8 }]);
    if (!reserved) throw new Error('Missing reservation');
    await budget.settle(reserved.id, null);
    expect(
      await rejectionOf(budget.reserve(seed.claims, [{ kind: 'tokens', amount: 3 }])),
    ).toMatchObject({ code: 'budget_exceeded' });
    await budget.settle(reserved.id, 2);
    await budget.settle(reserved.id, 2);
    expect(await rejectionOf(budget.settle(reserved.id, 0))).toMatchObject({
      code: 'budget_exceeded',
    });
    expect(await budget.reserve(seed.claims, [{ kind: 'tokens', amount: 8 }])).toHaveLength(1);
  },
);

databaseTest('a new attempt cannot spend a previous attempt allowance again', async () => {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const s = await seedJob(fixture.sql, { budget: { max_output_tokens: 10 } });
  const budget = new BudgetService(fixture.sql);
  await budget.reserve(s.claims, [{ kind: 'tokens', amount: 7 }]);
  const attemptId = recordId('att');
  await fixture.sql`update job set lease_epoch = 2 where id = ${s.claims.job_id}`;
  await fixture.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${s.claims.job_id}, 2, 'fake', 'fake', 'scripted')`;
  expect(
    await rejectionOf(
      budget.reserve({ ...s.claims, epoch: 2, attempt_id: attemptId }, [
        { kind: 'tokens', amount: 4 },
      ]),
    ),
  ).toMatchObject({ code: 'budget_exceeded' });
});

databaseTest(
  'gateway reserves both requests and tokens before recording a provider result',
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const s = await seedJob(fixture.sql, { budget: { max_turns: 1, max_output_tokens: 1000 } });
    const budget = new PostgresGatewayBudget({ sql: fixture.sql, capabilityKey: key });
    const principal = await budget.authenticate(signCapability(s.claims, key));
    const requests = await Promise.allSettled(
      [1, 2].map((n) =>
        budget.reserve({
          principal,
          requestId: `parallel-${n}`,
          provider: 'fake',
          model: 'scripted',
          estimatedTokens: 500,
          maxOutputTokens: 100,
        }),
      ),
    );
    const accepted = requests.find((result) => result.status === 'fulfilled');
    if (accepted?.status !== 'fulfilled') throw new Error('No request admitted');
    expect(requests.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const before =
      await fixture.sql`select kind, reserved, settled from budget_ledger where job_id = ${s.claims.job_id} order by kind`;
    expect(before.map((row) => [row.kind, row.reserved, row.settled])).toEqual([
      ['calls', 1, null],
      ['tokens', 500, null],
    ]);
    await budget.settle(accepted.value, receipt);
    await budget.settle(accepted.value, receipt);
    const [attempt] =
      await fixture.sql`select usage, model_actual from attempt where id = ${s.claims.attempt_id}`;
    expect(attempt?.usage.requests).toBe(1);
    expect(attempt?.usage.input_tokens).toBe(12);
    expect(attempt?.model_actual).toBe('fake-scripted-v1');
    const [ledger] =
      await fixture.sql`select settled from budget_ledger where id = ${accepted.value.id}`;
    expect(ledger?.settled).toBe(20);
  },
);

databaseTest(
  'gateway retains unknown usage and rejects a principal after the epoch bump',
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const s = await seedJob(fixture.sql);
    const budget = new PostgresGatewayBudget({ sql: fixture.sql, capabilityKey: key });
    const principal = await budget.authenticate(signCapability(s.claims, key));
    const request = {
      principal,
      requestId: 'unknown',
      provider: 'fake',
      model: 'scripted',
      estimatedTokens: 100,
      maxOutputTokens: 20,
    };
    const reservation = await budget.reserve(request);
    await fixture.sql`update job set state = 'cancelled', lease_epoch = 2 where id = ${s.claims.job_id}`;
    await budget.settle(reservation, {
      ...receipt,
      usage: null,
      modelActual: null,
      status: 'unknown',
    });
    const [ledger] =
      await fixture.sql`select settled from budget_ledger where id = ${reservation.id}`;
    expect(ledger?.settled).toBeNull();
    const [event] =
      await fixture.sql`select payload from event where dedup_key = ${`gateway:receipt:${reservation.id}`}`;
    expect(event?.payload.late).toBe(true);
    expect(await rejectionOf(budget.reserve({ ...request, requestId: 'fenced' }))).toMatchObject({
      code: 'stale_epoch',
    });
    const [job] = await fixture.sql`select state from job where id = ${s.claims.job_id}`;
    expect(job?.state).toBe('cancelled');
  },
);

databaseTest('negative reservations fail before writing any ledger row', async () => {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const s = await seedJob(fixture.sql);
  const budget = new BudgetService(fixture.sql);
  expect(
    await rejectionOf(budget.reserve(s.claims, [{ kind: 'tokens', amount: -1 }])),
  ).toMatchObject({ code: 'budget_exceeded' });
  expect(
    await fixture.sql`select * from budget_ledger where job_id = ${s.claims.job_id}`,
  ).toHaveLength(0);
});
