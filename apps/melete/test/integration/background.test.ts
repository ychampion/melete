/**
 * Background and interactive model calls: counted apart, rolled up by day to
 * the micro-dollar, limited apart (a person's own message always runs), a
 * job's dollar limit that counts its model calls when the operator says so,
 * the operator's spending alerts, and what `GET /usage` reports.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import {
  type AttemptBundle,
  type AttemptOutcome,
  jobBudget,
  type RuntimeAdapter,
  usageResponse,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { mountUsage } from '../../src/api/usage.ts';
import { signCapability } from '../../src/broker/capability.ts';
import { PostgresGatewayBudget } from '../../src/broker/gateway-budget.ts';
import { attempt, job, principal, space } from '../../src/db/schema.ts';
import { appendEvent } from '../../src/events/store.ts';
import { createModelGateway, providersFromEnv } from '../../src/gateway/index.ts';
import { PriceTable } from '../../src/gateway/prices.ts';
import { NO_LIMIT, SpendingGuard, type SpendingLimits } from '../../src/gateway/spending.ts';
import type { GatewayPrincipal } from '../../src/gateway/types.ts';
import { rollupUsageDay, usageSeries, utcDay } from '../../src/gateway/usage-day.ts';
import { healthDetail } from '../../src/health/monitor.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'background-meter-signing-key-000000000000';
const MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';
let spaceId = '';
let personId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** The default model's own prices: $0.30 in, $1.20 out, $0.006 cached, per million. */
const prices = new PriceTable({
  'fireworks/*deepseek-v4p1-flash*': { input: 0.3, output: 1.2, cached_input: 0.006 },
});

function limits(background: Partial<NonNullable<SpendingLimits['background']>> = {}) {
  return {
    installation: { day: NO_LIMIT, month: NO_LIMIT },
    person: { day: NO_LIMIT, month: NO_LIMIT },
    background: { day: NO_LIMIT, month: NO_LIMIT, ...background },
    noticePercent: 80,
  } satisfies SpendingLimits;
}

const servers: Server[] = [];

/**
 * A gateway on the default model whose provider reports the usage it is told
 * to; each call is made as the principal named by its token.
 */
async function gateway(guard: SpendingGuard) {
  const principals = new Map<string, GatewayPrincipal>();
  const server = createModelGateway({
    privacy: false,
    spending: guard,
    budget: { reserve: async () => ({ id: randomUUID() }), settle: async () => {} },
    authenticate: async (token) => {
      const found = principals.get(token);
      if (!found) throw new Error('unknown principal');
      return found;
    },
    providers: providersFromEnv({ FIREWORKS_API_KEY: 'fixture-key' }),
    defaultProvider: 'fireworks',
    fetch: async (request) => {
      const body = (await request.json()) as { messages: { content: string }[] };
      const [input, cached, output] = (body.messages[0]?.content ?? '0 0 0').split(' ').map(Number);
      return Response.json({
        model: MODEL,
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: {
          prompt_tokens: input,
          completion_tokens: output,
          total_tokens: (input ?? 0) + (output ?? 0),
          prompt_tokens_details: { cached_tokens: cached },
        },
      });
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  /** One call: `input` tokens of which `cached` were read from the cache, and `output` out. */
  return async (as: GatewayPrincipal, input: number, cached: number, output: number) => {
    const token = randomUUID();
    principals.set(token, as);
    const response = await fetch(
      `http://127.0.0.1:${address.port}/providers/fireworks/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-test',
          'x-melete-capability': token,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2000,
          messages: [{ role: 'user', content: `${input} ${cached} ${output}` }],
        }),
      },
    );
    await response.body?.cancel();
    return response.status;
  };
}

const agent = (jobId: string, attemptId: string): GatewayPrincipal => ({
  jobId,
  attemptId,
  privacy: { kind: 'job' },
  epoch: 1,
  revision: 0,
  maxRequests: 100,
  maxTokens: 100_000,
  allowedModels: [{ provider: 'fireworks', model: MODEL }],
});

const service = (purpose: string, sourceJobId: string | null = null): GatewayPrincipal => ({
  jobId: `${purpose}:${spaceId}`,
  attemptId: `${purpose}:${randomUUID()}`,
  privacy: { kind: 'service', purpose, spaceId, sourceJobId },
  epoch: 0,
  revision: 0,
  maxRequests: 1,
  maxTokens: 100_000,
  allowedModels: [{ provider: 'fireworks', model: MODEL }],
});

async function createJob(title: string): Promise<JobRow> {
  const { jobs } = fixture();
  const row = await jobs.create({ space_id: spaceId, title, objective: `Handle ${title}` });
  // Wakes in these tests are many; the job's own attempt count is not under test.
  await fixture()
    .handle.db.update(job)
    .set({ budget: { ...jobBudget.parse(row.budget), max_attempts: 1000 } })
    .where(eq(job.id, row.id));
  return jobs.get(row.id);
}

const say = (jobId: string, text: string) =>
  fixture().jobs.transaction((tx) =>
    appendEvent(tx, {
      jobId,
      type: 'notice',
      payload: { kind: 'user_message', text, principal_id: personId },
      dedupKey: `${jobId}:input:${randomUUID()}`,
    }),
  );

const triggered = (jobId: string, triggerId: string) =>
  fixture().jobs.transaction((tx) =>
    appendEvent(tx, {
      jobId,
      type: 'notice',
      payload: { kind: 'trigger_event', trigger_id: triggerId, event: { kind: 'mail' } },
      dedupKey: `${triggerId}:consumed:${randomUUID()}`,
    }),
  );

const rest: AttemptOutcome = {
  kind: 'waiting_for_event_or_time',
  wait: { kind: 'timer', wake_at: new Date(Date.now() + 3_600_000).toISOString() },
};

/** Claims the job's next attempt now and returns its id; the runtime is not started. */
async function claim(runner: AttemptRunner, id: string) {
  const { handle, jobs } = fixture();
  await handle.db
    .update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, id));
  const current = await jobs.get(id);
  return runner.claim({
    job_id: id,
    expected_epoch: current.leaseEpoch,
    expected_version: current.stateVersion,
    reason: 'timer',
  });
}

withDb('background and interactive model calls', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await resetTestRows(handle.sql);
    await handle.sql`delete from model_usage`;
    await handle.sql`delete from usage_day`;
    await handle.sql`delete from spending_notice`;
    personId = newId('own');
    spaceId = newId('sp');
    await handle.db.insert(principal).values({ id: personId, email: `${personId}@example.test` });
    await handle.db.insert(space).values({
      id: spaceId,
      name: 'Personal',
      gitPath: `/spaces/${spaceId}`,
      ownerPrincipalId: personId,
    });
  }, 15_000);

  afterAll(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('background and interactive are counted apart and the rollup matches to the micro-dollar', async () => {
    const { handle, jobs } = fixture();
    const guard = new SpendingGuard(handle.sql, limits(), prices);
    const call = await gateway(guard);
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const watch = await createJob('Watch the supplier mail');

    // The person writes: the attempt that reads it is interactive.
    await say(watch.id, 'Tell me when the oak price changes');
    const asked = await claim(runner, watch.id);
    if (!asked) throw new Error('no attempt');
    await runner.commitOutcome(asked.claims, rest);
    // A watch fires: the attempt it wakes is background, and names the trigger.
    const triggerId = newId('trg');
    await triggered(watch.id, triggerId);
    const woken = await claim(runner, watch.id);
    if (!woken) throw new Error('no attempt');
    await runner.commitOutcome(woken.claims, rest);
    // A timer with nothing new: background, with no trigger.
    const timed = await claim(runner, watch.id);
    if (!timed) throw new Error('no attempt');
    const rows = await handle.db
      .select({ id: attempt.id, usageClass: attempt.usageClass, triggerId: attempt.triggerId })
      .from(attempt)
      .where(eq(attempt.jobId, watch.id))
      .orderBy(attempt.epoch);
    expect(rows.map((row) => [row.id, row.usageClass, row.triggerId])).toEqual([
      [asked.claims.attempt_id, 'interactive', null],
      [woken.claims.attempt_id, 'background', triggerId],
      [timed.claims.attempt_id, 'background', null],
    ]);

    // Calls with uneven token counts, so cents and fractions of cents add up.
    expect(await call(agent(watch.id, asked.claims.attempt_id), 12_345, 6_789, 987)).toBe(200);
    expect(await call(agent(watch.id, asked.claims.attempt_id), 33_331, 20_000, 1_111)).toBe(200);
    expect(await call(agent(watch.id, woken.claims.attempt_id), 29_999, 21_007, 1_203)).toBe(200);
    expect(await call(agent(watch.id, timed.claims.attempt_id), 7_777, 0, 333)).toBe(200);
    // The background turn's search, and the person's own voice aside.
    const search = { ...service('web_search', watch.id), attemptId: woken.claims.attempt_id };
    expect(await call(search, 3_001, 0, 499)).toBe(200);
    expect(await call(service('voice', watch.id), 1_501, 1_024, 77)).toBe(200);
    // Memory reads what was said, in the background.
    for (let read = 0; read < 3; read++)
      expect(await call(service('memory', watch.id), 4_111 + read, 2_048, 301)).toBe(200);

    const recorded = await handle.sql`select purpose, class, tier, trigger_id,
        charged_input_tokens, input_tokens, cached_input_tokens
      from model_usage order by created_at, id`;
    expect(recorded.map((row) => `${row.purpose}/${row.class}/${row.tier}`).sort()).toEqual(
      [
        'agent/interactive/interactive',
        'agent/interactive/interactive',
        'agent/background/t2',
        'agent/background/t2',
        'web_search/background/service',
        'voice/interactive/service',
        'memory/background/service',
        'memory/background/service',
        'memory/background/service',
      ].sort(),
    );
    expect(recorded.filter((row) => row.trigger_id === triggerId)).toHaveLength(2);
    // Cached input is charged at its cached price: 6,789 cached of 12,345 is
    // 5,556 fresh plus 6,789 × 0.02.
    const first = recorded.find((row) => row.input_tokens === 12_345);
    expect(first?.cached_input_tokens).toBe(6_789);
    expect(first?.charged_input_tokens).toBe(Math.ceil(5_556 + 6_789 * (0.006 / 0.3)));

    // The day rolls up, and each class matches the calls to the micro-dollar.
    const day = utcDay(new Date());
    expect(await rollupUsageDay(handle.sql, day)).toBeGreaterThan(0);
    const exact = await handle.sql`select class,
        round(sum(cost_usd)::numeric, 6)::text as usd, count(*)::int as calls,
        sum(charged_input_tokens)::bigint::text as charged
      from model_usage group by class order by class`;
    const rolled = await handle.sql`select class,
        round(sum(cost_usd)::numeric, 6)::text as usd, sum(calls)::int as calls,
        sum(charged_input_tokens)::bigint::text as charged
      from usage_day where day = ${day} group by class order by class`;
    expect(rolled.map((row) => ({ ...row }))).toEqual(exact.map((row) => ({ ...row })));
    expect(rolled.map((row) => [row.class, row.calls])).toEqual([
      ['background', 6],
      ['interactive', 3],
    ]);
    // Each line of the rollup is the same sum, to the micro-dollar.
    const lines = await handle.sql`select d.tier, d.purpose, d.class, d.cost_usd as rolled,
        (select round(sum(m.cost_usd)::numeric, 6)::float8 from model_usage m
          where m.tier = d.tier and m.purpose = d.purpose and m.class = d.class) as exact
      from usage_day d where d.day = ${day}`;
    expect(lines.length).toBe(5);
    for (const line of lines) expect(line.rolled).toBe(line.exact);
    // Written again, the day is replaced, not added to.
    await rollupUsageDay(handle.sql, day);
    const [again] =
      await handle.sql`select sum(calls)::int as calls from usage_day where day = ${day}`;
    expect(again?.calls).toBe(9);

    // What Settings is told: the background part, by purpose and by tier.
    const summary = await guard.summary(personId);
    const [background] =
      await handle.sql`select round(sum(cost_usd)::numeric, 6)::float8 as usd from model_usage where class = 'background'`;
    expect(summary.background?.day.usd).toBe(background?.usd);
    expect(summary.by_tier.map((row) => [row.tier, row.calls]).sort()).toEqual([
      ['interactive', 2],
      ['service', 5],
      ['t2', 2],
    ]);
    expect(
      summary.by_purpose.map((row) => `${row.purpose}/${row.class}:${row.calls}`).sort(),
    ).toEqual([
      'agent/background:2',
      'agent/interactive:2',
      'memory/background:3',
      'voice/interactive:1',
      'web_search/background:1',
    ]);
    const series = await usageSeries(handle.sql, personId);
    expect(series).toHaveLength(30);
    expect(series.at(-1)).toMatchObject({ day, calls: 9, background_usd: background?.usd });
  });

  test("a person's own message always still runs at the background limit", async () => {
    const { handle, jobs } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      limits({ day: { usd: 0.01, tokens: null } }),
      prices,
    );
    let started = 0;
    const engine: RuntimeAdapter = {
      capabilities: () => new StubRuntimeAdapter().capabilities(),
      start: async (_bundle: AttemptBundle) => {
        started++;
        return rest;
      },
    };
    const runner = new AttemptRunner(jobs, engine, {
      key,
      spendingLimit: (jobId, usageClass) => guard.limitForJob(jobId, usageClass),
    });
    const wake = async (row: JobRow) => {
      await handle.db.update(job).set({ nextWakeAt: new Date() }).where(eq(job.id, row.id));
      const current = await jobs.get(row.id);
      await runner.handleWake({
        job_id: current.id,
        expected_epoch: current.leaseEpoch,
        expected_version: current.stateVersion,
        reason: 'timer',
      });
    };
    // Background work today has already spent past the person's background limit.
    const watch = await createJob('Watch the invoices');
    await triggered(watch.id, newId('trg'));
    const memory = service('memory');
    const call = await gateway(guard);
    expect(await call(memory, 40_000, 0, 2_000)).toBe(200);
    // The next background call is refused with the sentence that says so.
    const refused = await call(service('memory'), 1_000, 0, 10);
    expect(refused).toBe(402);

    // A background wake starts no engine and ends on the limit.
    await wake(watch);
    expect(started).toBe(0);
    const [held] = await handle.db.select().from(attempt).where(eq(attempt.jobId, watch.id));
    expect(held?.usageClass).toBe('background');
    expect(held?.outcome).toBe('budget_exhausted');
    expect(held?.outcomeDetail).toMatchObject({
      summary: expect.stringMatching(
        /^Background work has reached today's limit; it starts again on .+ at 00:00 UTC\. Your own messages still go through\.$/,
      ),
    });

    // The person writes: their turn runs, and its calls are let through.
    const chat = await createJob('Plan the trip');
    await say(chat.id, 'Find me a train to Sacramento');
    await wake(chat);
    expect(started).toBe(1);
    const [ran] = await handle.db.select().from(attempt).where(eq(attempt.jobId, chat.id));
    expect(ran?.usageClass).toBe('interactive');
    if (!ran) throw new Error('no attempt');
    expect(await call(agent(chat.id, ran.id), 5_000, 0, 500)).toBe(200);
    expect(await call(service('voice', chat.id), 500, 0, 50)).toBe(200);
    await runner.stop();
  });

  test("a job's model calls count against its dollar limit when the operator turns that on", async () => {
    const { handle } = fixture();
    // The fixture job's attempt runs on the scripted model, priced here at the default's rates.
    const scripted = new PriceTable({ 'fake/*': { input: 0.3, output: 1.2 } });
    const settle = async (
      budget: PostgresGatewayBudget,
      principal: GatewayPrincipal,
      n: number,
    ) => {
      const reservation = await budget.reserve({
        principal,
        requestId: `call-${n}`,
        provider: 'fake',
        model: 'scripted',
        estimatedTokens: 20_000,
        maxOutputTokens: 1_000,
      });
      // 1,000,000 input tokens at $0.30: thirty cents a call.
      await budget.settle(reservation, {
        provider: 'fake',
        modelRequested: 'scripted',
        modelActual: 'scripted',
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
          cachedInputTokens: 0,
        },
        latencyMs: 5,
        status: 'succeeded',
        httpStatus: 200,
      });
    };
    const big = { max_turns: 10, max_output_tokens: 100_000, max_usd_est: 0.5 };

    // Counted: two calls fit under fifty cents (the second finishes past it),
    // and the third is refused.
    const counted = await seedJob(handle.sql, { budget: big });
    const charged = new PostgresGatewayBudget({
      sql: handle.sql,
      capabilityKey: key,
      modelDollars: scripted,
    });
    const principal = await charged.authenticate(signCapability(counted.claims, key));
    await settle(charged, principal, 1);
    await settle(charged, principal, 2);
    expect(await rejectionOf(settle(charged, principal, 3))).toMatchObject({
      code: 'budget_exceeded',
    });
    const [ledger] =
      await handle.sql`select sum(settled)::float8 as usd from budget_ledger where job_id = ${counted.claims.job_id} and kind = 'usd_est'`;
    expect(ledger?.usd).toBeCloseTo(0.6, 9);
    const [usage] =
      await handle.sql`select usage from attempt where id = ${counted.claims.attempt_id}`;
    expect(usage?.usage.usd_est).toBeCloseTo(0.6, 9);

    // Left off, the same calls count nothing against the dollar limit.
    const free = await seedJob(handle.sql, { budget: big });
    const uncounted = new PostgresGatewayBudget({ sql: handle.sql, capabilityKey: key });
    const freePrincipal = await uncounted.authenticate(signCapability(free.claims, key));
    for (const n of [1, 2, 3]) await settle(uncounted, freePrincipal, n);
    const [none] =
      await handle.sql`select count(*)::int as rows from budget_ledger where job_id = ${free.claims.job_id} and kind = 'usd_est'`;
    expect(none?.rows).toBe(0);
  });

  test('the operator is alerted when an hour runs far above the usual, or one person dominates the day', async () => {
    const { handle } = fixture();
    const other = newId('own');
    await handle.db.insert(principal).values({ id: other, email: `${other}@example.test` });
    // A week of quiet hours at five cents, then a dollar-forty in the last few minutes.
    for (let hour = 2; hour <= 168; hour++)
      await handle.sql`insert into model_usage (id, created_at, principal_id, purpose, provider, model, status, cost_usd)
        values (${randomUUID()}, now() - make_interval(hours => ${hour}), ${other}, 'agent', 'fireworks', ${MODEL}, 'succeeded', 0.05)`;
    await handle.sql`insert into model_usage (id, created_at, principal_id, purpose, provider, model, status, cost_usd, class, tier)
      values (${randomUUID()}, now() - interval '30 seconds', ${personId}, 'agent', 'fireworks', ${MODEL}, 'succeeded', 1.4, 'background', 't2'),
        (${randomUUID()}, now() - interval '30 seconds', ${other}, 'agent', 'fireworks', ${MODEL}, 'succeeded', 0.1, 'interactive', 'interactive')`;
    const probes = { version: 'test', database: async () => 'ok' as const, sql: handle.sql };
    const detail = await healthDetail({
      ...probes,
      spend: { hourlyMultiple: 10, personPercent: 40, minUsd: 1 },
    });
    const checks = Object.fromEntries(detail.checks.map((check) => [check.name, check]));
    expect(checks.spend_rate).toMatchObject({ ok: false });
    expect(checks.spend_rate?.detail).toStartWith('$1.50 on model calls in the last hour');
    // One person is most of today's spending, whatever the hour of the day.
    expect(checks.spend_share).toMatchObject({ ok: false });
    expect(checks.spend_share?.detail).toStartWith(`${personId} accounts for`);
    expect(detail.status).toBe('unhealthy');
    // Unasked for, neither check runs.
    const plain = await healthDetail(probes);
    expect(plain.checks.map((check) => check.name)).toEqual([
      'database',
      'job_queue',
      'error_rate',
    ]);
  });

  test('GET /usage reports the background part, by purpose and tier, the last 30 days, and the owner sees cost per person-day', async () => {
    const { handle } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      limits({ day: { usd: 0.5, tokens: null } }),
      prices,
    );
    const call = await gateway(guard);
    // Yesterday's background reads, rolled up, and today's.
    const yesterday = new Date(Date.now() - 86_400_000);
    for (let read = 0; read < 2; read++)
      expect(await call(service('memory'), 100_000, 0, 1_000)).toBe(200);
    await handle.sql`update model_usage set created_at = ${yesterday.toISOString()}::timestamptz`;
    await rollupUsageDay(handle.sql, utcDay(yesterday));
    expect(await call(service('memory'), 10_000, 0, 100)).toBe(200);
    const app = new Hono();
    app.use(async (c, next) => {
      c.set('owner' as never, { id: personId } as never);
      await next();
    });
    mountUsage(app, { spending: guard, isOwner: async () => true, sql: handle.sql });
    const response = await app.request('/usage');
    expect(response.status).toBe(200);
    const body = usageResponse.parse(await response.json());
    expect(body.limits.background).toEqual({ day: { usd: 0.5, tokens: null }, month: NO_LIMIT });
    // This month's calls: yesterday's two as well, unless yesterday was last month.
    const thisMonth = utcDay(yesterday).slice(0, 7) === utcDay(new Date()).slice(0, 7) ? 3 : 1;
    expect(body.by_purpose).toEqual([
      expect.objectContaining({ purpose: 'memory', class: 'background', calls: thisMonth }),
    ]);
    expect(body.by_tier).toEqual([expect.objectContaining({ tier: 'service', calls: thisMonth })]);
    expect(body.days).toHaveLength(30);
    const yesterdayPoint = body.days?.find((point) => point.day === utcDay(yesterday));
    // 2 × (100,000 × $0.30 + 1,000 × $1.20) per million.
    expect(yesterdayPoint).toEqual({
      day: utcDay(yesterday),
      usd: 0.0624,
      background_usd: 0.0624,
      calls: 2,
    });
    expect(body.background_per_person_day).toEqual({
      person_days: 1,
      median_usd: 0.0624,
      p95_usd: 0.0624,
      mean_usd: 0.0624,
    });
  });
  test('calls admitted side by side are judged one after another, as if made in turn', async () => {
    const { handle } = fixture();
    await handle.sql`insert into model_usage (id, created_at, space_id, principal_id, purpose, provider,
        model, status, cost_usd, class, tier)
      values (${randomUUID()}, now(), ${spaceId}, ${personId}, 'memory', 'x', 'y', 'succeeded', 0.9,
        'background', 'service')`;
    // An unknown model is priced $3 in and $15 out: each call may cost $0.09.
    const call = {
      provider: 'unknown',
      model: 'm',
      inputTokens: 10_000,
      maxOutputTokens: 4_000,
      local: false,
    };
    const results = async (parallel: boolean) => {
      const guard = new SpendingGuard(handle.sql, limits({ day: { usd: 1, tokens: null } }));
      const one = () =>
        guard.admit(service('memory'), call).then(
          () => 'ok',
          () => 'refused',
        );
      if (parallel) return Promise.all(Array.from({ length: 5 }, one));
      const serial: string[] = [];
      for (let n = 0; n < 5; n++) serial.push(await one());
      return serial;
    };
    const serial = await results(false);
    expect(serial).toEqual(['ok', 'ok', 'refused', 'refused', 'refused']);
    expect(await results(true)).toEqual(serial);
  });

  test('rollups of the same day at once all finish, and the day matches its calls', async () => {
    const { handle } = fixture();
    // Many groups, so each rollup's insert takes long enough for the others to meet it.
    await handle.sql`insert into model_usage (id, created_at, space_id, principal_id, purpose,
        provider, model, status, input_tokens, output_tokens, cost_usd, class, tier)
      select gen_random_uuid()::text, now(), ${spaceId}, 'own_' || (n % 50), 'purpose_' || (n % 40),
        'fireworks', ${MODEL}, 'succeeded', n, n, n / 1000000.0, 'background', 'service'
      from generate_series(1, 4000) as n`;
    const day = utcDay(new Date());
    const all = await Promise.allSettled(
      Array.from({ length: 8 }, () => rollupUsageDay(handle.sql, day)),
    );
    expect(all.map((result) => result.status)).toEqual(Array(8).fill('fulfilled'));
    const [rolled] =
      await handle.sql`select round(sum(cost_usd)::numeric, 6)::text as usd, sum(calls)::int as calls from usage_day where day = ${day}`;
    const [exact] =
      await handle.sql`select round(sum(cost_usd)::numeric, 6)::text as usd, count(*)::int as calls from model_usage`;
    expect({ ...rolled }).toEqual({ ...exact });
  });
});
