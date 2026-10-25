import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AttemptBundle, AttemptOutcome, RuntimeAdapter } from '@melete/contracts';
import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { attempt, job, principal, space } from '../../src/db/schema.ts';
import { appendEvent } from '../../src/events/store.ts';
import { createModelGateway, providersFromEnv } from '../../src/gateway/index.ts';
import { PriceTable } from '../../src/gateway/prices.ts';
import {
  ACCOUNT_OFF_MESSAGE,
  NO_LIMIT,
  SpendingGuard,
  type SpendingLimits,
} from '../../src/gateway/spending.ts';
import {
  GatewayError,
  type GatewayPrincipal,
  type GatewayReservation,
  type GatewaySettlement,
} from '../../src/gateway/types.ts';
import { healthDetail } from '../../src/health/monitor.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'spending-limit-signing-key-0000000000000';
const MODEL = 'accounts/fireworks/models/fixture-model';
/** Mid-October, so this month's limit resets on November 1. */
const NOW = new Date('2026-10-15T12:00:00Z');
let spaceId = '';
let personId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** A cent per output token: a 40-token answer costs $0.40. */
const prices = new PriceTable({ 'fireworks/*': { input: 0, output: 10_000 } });

function limits(person: Partial<SpendingLimits['person']> = {}): SpendingLimits {
  return {
    installation: { day: NO_LIMIT, month: NO_LIMIT },
    person: { day: NO_LIMIT, month: NO_LIMIT, ...person },
    noticePercent: 80,
  };
}

const settlement = (outputTokens: number): GatewaySettlement => ({
  provider: 'fireworks',
  modelRequested: MODEL,
  modelActual: MODEL,
  usage: {
    inputTokens: 10,
    outputTokens,
    totalTokens: 10 + outputTokens,
    cachedInputTokens: 0,
  },
  latencyMs: 5,
  status: 'succeeded',
  httpStatus: 200,
});

const jobPrincipal = (jobId: string): GatewayPrincipal => ({
  jobId,
  attemptId: `att_${randomUUID()}`,
  privacy: { kind: 'job' },
  epoch: 1,
  revision: 0,
  maxRequests: 10,
  maxTokens: 10_000,
  allowedModels: [{ provider: 'fireworks', model: MODEL }],
});

const servicePrincipal = (): GatewayPrincipal => ({
  jobId: `memory:${spaceId}`,
  attemptId: `memory:${randomUUID()}`,
  privacy: { kind: 'service', purpose: 'memory', spaceId, sourceJobId: null },
  epoch: 0,
  revision: 0,
  maxRequests: 1,
  maxTokens: 10_000,
  allowedModels: [{ provider: 'fireworks', model: MODEL }],
});

const servers: Server[] = [];

/**
 * A gateway whose provider answers 40 output tokens, slowly when asked, and
 * whose budget reserves every call unless `reserve` says otherwise.
 */
async function gateway(
  guard: SpendingGuard,
  reserve: () => Promise<GatewayReservation> = async () => ({ id: randomUUID() }),
) {
  const server = createModelGateway({
    privacy: false,
    spending: guard,
    budget: { reserve, settle: async () => {} },
    authenticate: async () => servicePrincipal(),
    providers: providersFromEnv({ FIREWORKS_API_KEY: 'fixture-key' }),
    defaultProvider: 'fireworks',
    fetch: async (request) => {
      const body = await request.json();
      if (JSON.stringify(body).includes('slow')) await Bun.sleep(400);
      return Response.json({
        model: MODEL,
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
      });
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return (text: string) =>
    fetch(`http://127.0.0.1:${address.port}/providers/fireworks/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer melete-surrogate-test',
        'x-melete-capability': 'fixture',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 50,
        messages: [{ role: 'user', content: text }],
      }),
    });
}

async function createJob(title: string, kind = 'responsibility'): Promise<JobRow> {
  const { handle, jobs } = fixture();
  const row = await jobs.create({ space_id: spaceId, title, objective: `Handle ${title}` });
  if (kind !== 'responsibility')
    await handle.db.update(job).set({ kind }).where(eq(job.id, row.id));
  return jobs.get(row.id);
}

withDb('spending caps', () => {
  // The runner checks the limits around transactions that hold the event
  // order lock; a check that sent its reads to the pool inside one fails here.
  const lockGuard = process.env.MELETE_EVENT_LOCK_GUARD;
  beforeAll(() => {
    process.env.MELETE_EVENT_LOCK_GUARD = 'throw';
  });

  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await resetTestRows(handle.sql);
    await handle.sql`delete from model_usage`;
    await handle.sql`delete from spending_notice`;
    await handle.sql`delete from spend_hold`;
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
    if (lockGuard === undefined) delete process.env.MELETE_EVENT_LOCK_GUARD;
    else process.env.MELETE_EVENT_LOCK_GUARD = lockGuard;
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('a quiet notice at 80%, then new calls are refused while a call in flight finishes', async () => {
    const { handle } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      limits({ month: { usd: 1, tokens: null } }),
      prices,
      () => NOW,
    );
    const notices: string[] = [];
    guard.onNotice = (notice) => notices.push(`${notice.level}:${notice.message}`);
    const call = await gateway(guard);

    expect((await call('first')).status).toBe(200);
    expect((await guard.summary(personId)).notice).toBeNull();
    expect((await call('second')).status).toBe(200);
    // $0.80 of $1.00: the person is told once, and calls still go through.
    const warned = await guard.summary(personId);
    expect(warned.notice).toMatchObject({ level: 'warning', period: 'month', scope: 'person' });
    expect(warned.person?.month.usd).toBeCloseTo(0.8, 6);
    expect(notices).toEqual(["warning:You have used 80% of this month's model allowance."]);

    // A slow call is admitted below the limit, and what it may cost is held
    // while it runs, so a quick one beside it is refused. The slow one still
    // finishes and is counted, which takes the person past the limit.
    const slow = call('slow');
    await Bun.sleep(100);
    expect((await call('quick')).status).toBe(402);
    const finished = await slow;
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as { choices: unknown[] }).choices).toHaveLength(1);

    const refused = await call('one more');
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({
      error: {
        code: 'spending_limit_reached',
        message: "This month's limit is reached; it resets on November 1.",
      },
    });
    const [counted] =
      await handle.sql`select count(*)::int as calls, sum(cost_usd)::float8 as usd from model_usage where principal_id = ${personId}`;
    expect(counted?.calls).toBe(3);
    expect(Number(counted?.usd)).toBeCloseTo(1.2, 6);
    expect(notices.at(-1)).toBe("reached:This month's limit is reached; it resets on November 1.");
    const summary = await guard.summary(personId);
    expect(summary.notice?.level).toBe('reached');
    expect(summary.models).toEqual([
      { provider: 'fireworks', model: MODEL, calls: 3, usd: 1.2, tokens: 150 },
    ]);
  });

  test('routines and background jobs count against their person', async () => {
    const { handle } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      limits({ day: { usd: null, tokens: 100 } }),
      prices,
      () => NOW,
    );
    const routine = await createJob('Morning digest', 'routine');
    const background = await createJob('Watch the invoices');
    await guard.record(jobPrincipal(routine.id), settlement(40));
    expect(await guard.reached(personId)).toBeNull();
    await guard.record(jobPrincipal(background.id), settlement(40));
    // 100 tokens today: the person's next call, from any job, is refused.
    const chat = await createJob('Plan the trip');
    let refused: unknown;
    await guard.admit(jobPrincipal(chat.id)).catch((error) => {
      refused = error;
    });
    expect(refused).toMatchObject({
      status: 402,
      code: 'spending_limit_reached',
      detail: "Today's limit is reached; it resets on October 16 at 00:00 UTC.",
    });
    const rows = await handle.sql`select purpose, job_id from model_usage order by job_id`;
    expect(rows.map((row) => row.purpose)).toEqual(['agent', 'agent']);
  });

  test('no attempt starts past a limit, and an attempt whose call was refused ends on it', async () => {
    const { handle, jobs } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      limits({ month: { usd: 1, tokens: null } }),
      prices,
      () => NOW,
    );
    let started = 0;
    let release: (() => void) | undefined;
    const blocking: RuntimeAdapter = {
      capabilities: () => new StubRuntimeAdapter().capabilities(),
      start: (_bundle: AttemptBundle, _sink, signal) => {
        started++;
        return new Promise<AttemptOutcome>((_, reject) => {
          release = () => reject(new Error('released'));
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const runner = new AttemptRunner(jobs, blocking, {
      key,
      spendingLimit: (jobId) => guard.limitForJob(jobId),
    });
    guard.onRefused = (_scope, refused, message) => {
      if (refused.privacy.kind === 'job')
        runner.stopForSpending(refused.jobId, refused.attemptId, message);
    };
    const wake = async (row: JobRow) => {
      // Due by the database's clock, which the runner judges a wake by; this
      // process's clock can run a millisecond ahead of it.
      await handle.db.update(job).set({ nextWakeAt: sql`now()` }).where(eq(job.id, row.id));
      const current = await jobs.get(row.id);
      return runner.handleWake({
        job_id: current.id,
        expected_epoch: current.leaseEpoch,
        expected_version: current.stateVersion,
        reason: 'timer',
      });
    };

    // Under the limit the engine starts; its next call is refused part way.
    const working = await createJob('Draft the report');
    const running = wake(working);
    while (started === 0) await Bun.sleep(20);
    const [live] = await handle.db.select().from(attempt).where(eq(attempt.jobId, working.id));
    if (!live) throw new Error('no attempt');
    await guard.record(jobPrincipal(working.id), settlement(100));
    let refused: unknown;
    await guard.admit({ ...jobPrincipal(working.id), attemptId: live.id }).catch((error) => {
      refused = error;
    });
    expect(refused).toMatchObject({ code: 'spending_limit_reached' });
    await running;
    release?.();
    const [ended] = await handle.db.select().from(attempt).where(eq(attempt.id, live.id));
    expect(ended?.outcome).toBe('budget_exhausted');
    expect(ended?.outcomeDetail).toMatchObject({
      kind: 'budget_exhausted',
      summary: "This month's limit is reached; it resets on November 1.",
    });

    // Past the limit, a new job's attempt ends at once without an engine.
    const later = await createJob('Book the dentist');
    const before = started;
    await wake(later);
    expect(started).toBe(before);
    const [skipped] = await handle.db.select().from(attempt).where(eq(attempt.jobId, later.id));
    expect(skipped?.outcome).toBe('budget_exhausted');
    expect(skipped?.outcomeDetail).toMatchObject({
      summary: "This month's limit is reached; it resets on November 1.",
    });
    await runner.stop();
  });

  test('a call refused or limited by its provider counts nothing toward the limit', async () => {
    const { handle } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      limits({ month: { usd: 1, tokens: null } }),
      prices,
      () => NOW,
    );
    await guard.record(servicePrincipal(), { ...settlement(0), usage: null, status: 'failed' });
    const [row] = await handle.sql`select cost_usd, status, purpose from model_usage`;
    expect(row).toMatchObject({ cost_usd: 0, status: 'failed', purpose: 'memory' });
    expect(await guard.reached(personId)).toBeNull();
  });

  test('a call its budget refuses before it is sent leaves no hold behind', async () => {
    const { handle } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      limits({ month: { usd: 1, tokens: null } }),
      prices,
      () => NOW,
    );
    const call = await gateway(guard, async () => {
      throw new GatewayError(429, 'budget_exceeded');
    });
    expect((await call('Summarise the week')).status).toBe(429);
    expect(await handle.sql`select 1 from spend_hold`).toHaveLength(0);
  });

  test("calls on a person's own model cost nothing, so they never reach the installation's dollar limit", async () => {
    const { handle } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      {
        installation: { day: NO_LIMIT, month: { usd: 1, tokens: null } },
        person: { day: NO_LIMIT, month: NO_LIMIT },
        noticePercent: 80,
      },
      prices,
      () => NOW,
    );
    // Addressed to a cloud model, answered by the person's local one.
    for (let call = 0; call < 5; call++)
      await guard.record(servicePrincipal(), {
        ...settlement(100_000),
        servedLocally: true,
        servedBy: { provider: 'local', model: 'llama3.1:8b' },
      });
    expect(await guard.reached(personId)).toBeNull();
    const [row] =
      await handle.sql`select sum(cost_usd)::float8 as usd, sum(output_tokens)::int as tokens, min(provider) as provider from model_usage`;
    expect(row).toMatchObject({ usd: 0, tokens: 500_000, provider: 'local' });
    // An operator who prices the local model has it counted.
    const priced = new SpendingGuard(
      handle.sql,
      limits(),
      new PriceTable({ 'local/*': { input: 0, output: 1 } }),
      () => NOW,
    );
    await priced.record(servicePrincipal(), {
      ...settlement(1_000_000),
      servedLocally: true,
      servedBy: { provider: 'local', model: 'llama3.1:8b' },
    });
    const [after] = await handle.sql`select max(cost_usd)::float8 as usd from model_usage`;
    expect(after?.usd).toBeCloseTo(1, 6);
  });

  test("a person at their limit is refused in another person's conversation, and that person is not charged", async () => {
    const { handle, jobs } = fixture();
    const other = newId('own');
    await handle.db.insert(principal).values({ id: other, email: `${other}@example.test` });
    const guard = new SpendingGuard(
      handle.sql,
      limits({ day: { usd: 0.5, tokens: null } }),
      prices,
      () => NOW,
    );
    // The space owner's conversation; the other person writes in it.
    const shared = await createJob('Plan the offsite');
    await jobs.transaction((tx) =>
      appendEvent(tx, {
        jobId: shared.id,
        type: 'notice',
        payload: { kind: 'user_message', text: 'add a dinner', principal_id: other },
        dedupKey: `${shared.id}:input:spending-test`,
      }),
    );
    await guard.record({ ...servicePrincipal(), actor: other }, settlement(60));
    expect(await guard.reached(other)).not.toBeNull();
    let refused: unknown;
    await guard.admit(jobPrincipal(shared.id)).catch((error) => {
      refused = error;
    });
    expect(refused).toMatchObject({ code: 'spending_limit_reached' });
    expect(await guard.reached(personId)).toBeNull();
    // The owner, writing next, is charged for their own turn and admitted.
    await jobs.transaction((tx) =>
      appendEvent(tx, {
        jobId: shared.id,
        type: 'notice',
        payload: { kind: 'user_message', text: 'and lunch', principal_id: personId },
        dedupKey: `${shared.id}:input:spending-test-2`,
      }),
    );
    await guard.admit(jobPrincipal(shared.id));
    await guard.record(jobPrincipal(shared.id), settlement(10));
    const rows =
      await handle.sql`select principal_id, count(*)::int as calls from model_usage group by principal_id order by principal_id`;
    expect(Object.fromEntries(rows.map((row) => [row.principal_id, row.calls]))).toEqual({
      [other]: 1,
      [personId]: 1,
    });
  });

  test('calls running side by side are held against the limit until they report', async () => {
    const { handle } = fixture();
    const guard = new SpendingGuard(
      handle.sql,
      limits({ month: { usd: 1, tokens: null } }),
      prices,
      () => NOW,
    );
    const call = {
      provider: 'fireworks',
      model: MODEL,
      inputTokens: 10,
      maxOutputTokens: 60,
      local: false,
    };
    const first = servicePrincipal();
    await guard.admit(first, call);
    // $0.60 is held for the first call; a second may still start ($0.60 < $1).
    const second = servicePrincipal();
    await guard.admit(second, call);
    // $1.20 is now held: a third is refused while both run.
    let refused: unknown;
    await guard.admit(servicePrincipal(), call).catch((error) => {
      refused = error;
    });
    expect(refused).toMatchObject({ code: 'spending_limit_reached' });
    // Both report having used little; the holds go and calls start again.
    await guard.record(first, settlement(5));
    await guard.record(second, settlement(5));
    await guard.admit(servicePrincipal(), call);
  });

  test("a call's hold is let go only once its cost is in the totals", async () => {
    const { handle } = fixture();
    // The insert of a settled call waits at this gate while it is closed.
    let open: () => void = () => {};
    let gate: Promise<void> | null = null;
    const gated = new Proxy(handle.sql, {
      apply(target, self, args) {
        const first = args[0] as unknown;
        const text = Array.isArray(first) && 'raw' in first ? first.join('') : '';
        const query = Reflect.apply(target, self, args);
        return gate && text.includes('insert into model_usage') ? gate.then(() => query) : query;
      },
    });
    const guard = new SpendingGuard(
      gated,
      limits({ month: { usd: 1, tokens: null } }),
      prices,
      () => NOW,
    );
    const call = {
      provider: 'fireworks',
      model: MODEL,
      inputTokens: 10,
      maxOutputTokens: 60,
      local: false,
    };
    // $0.50 spent this month; a call admitted beside it holds $0.60.
    await guard.record(servicePrincipal(), settlement(50));
    const running = servicePrincipal();
    await guard.admit(running, call);
    // It settles at $0.50, which reaches the $1 limit. While its spending is
    // being written, its hold still counts, so the next call is refused.
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const recording = guard.record(running, settlement(50));
    await Bun.sleep(50);
    let refused: unknown;
    await guard.admit(servicePrincipal(), call).catch((error) => {
      refused = error;
    });
    expect(refused).toMatchObject({ code: 'spending_limit_reached' });
    gate = null;
    open();
    await recording;
    refused = undefined;
    await guard.admit(servicePrincipal(), call).catch((error) => {
      refused = error;
    });
    expect(refused).toMatchObject({ code: 'spending_limit_reached' });
    expect((await guard.totals(personId, NOW, true)).person?.month.usd).toBeCloseTo(1, 6);
  });

  test("service instances on one database hold each other's running calls against a cap", async () => {
    const { handle } = fixture();
    // Each instance has connections of its own, as separate services do, and
    // writes a call's hold a moment after reading the totals: calls not judged
    // one after another would all read the totals before any hold is written.
    const clients: Sql[] = [];
    const instance = (caps: SpendingLimits) => {
      const client = postgres(handle.url, { max: 2 });
      clients.push(client);
      const slowHolds = (tx: TransactionSql) =>
        new Proxy(tx, {
          apply(target, self, args) {
            const [strings] = args as unknown[];
            const text = Array.isArray(strings) && 'raw' in strings ? strings.join('') : '';
            const query = Reflect.apply(target, self, args);
            return text.includes('insert into spend_hold')
              ? Bun.sleep(100).then(() => query)
              : query;
          },
        });
      const slow = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== 'begin') return Reflect.get(target, property, receiver);
          return (step: (tx: TransactionSql) => Promise<unknown>) =>
            target.begin((tx) => step(slowHolds(tx)));
        },
      });
      return new SpendingGuard(slow, caps, prices, () => NOW);
    };
    const call = {
      provider: 'fireworks',
      model: MODEL,
      inputTokens: 10,
      maxOutputTokens: 60,
      local: false,
    };
    try {
      // Calls started at once; each instance lets go of the ones it started.
      // How many started is returned.
      const started = async (tries: (readonly [SpendingGuard, GatewayPrincipal])[]) => {
        const settled = await Promise.allSettled(
          tries.map(([guard, principal]) => guard.admit(principal, call)),
        );
        for (const one of settled)
          if (one.status === 'rejected')
            expect(one.reason).toMatchObject({ code: 'spending_limit_reached' });
        for (const [guard, principal] of tries) await guard.release(principal);
        expect(await handle.sql`select 1 from spend_hold`).toHaveLength(0);
        return settled.filter((one) => one.status === 'fulfilled').length;
      };
      // A person's $1 cap and $0.60 calls, two on each of six instances: two
      // start, as on one instance, never one or two per instance.
      const six = Array.from({ length: 6 }, () =>
        instance(limits({ month: { usd: 1, tokens: null } })),
      );
      expect(
        await started(
          six
            .flatMap((guard) => [guard, guard])
            .map((guard) => [guard, servicePrincipal()] as const),
        ),
      ).toBe(2);
      // A call running on one instance is held on the other until it reports.
      const [one, two] = six as [SpendingGuard, SpendingGuard];
      const running = servicePrincipal();
      await one.admit(running, call);
      await two.admit(servicePrincipal(), call);
      let refused: unknown;
      await two.admit(servicePrincipal(), call).catch((error) => {
        refused = error;
      });
      expect(refused).toMatchObject({ code: 'spending_limit_reached' });
      // It used $0.05: $0.65 with the other's hold, so another call starts.
      await one.record(running, settlement(5));
      await two.admit(servicePrincipal(), call);
      // The installation's own $1 cap holds across people too: of six people's
      // calls, one on each of six instances, two start.
      await handle.sql`delete from spend_hold`;
      await handle.sql`delete from model_usage`;
      const whole: SpendingLimits = {
        installation: { day: NO_LIMIT, month: { usd: 1, tokens: null } },
        person: { day: NO_LIMIT, month: NO_LIMIT },
        noticePercent: 80,
      };
      expect(
        await started(
          Array.from(
            { length: 6 },
            () => [instance(whole), { ...servicePrincipal(), actor: newId('own') }] as const,
          ),
        ),
      ).toBe(2);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  test('a hold whose call never reports stops counting once it expires', async () => {
    const { handle } = fixture();
    let now = NOW;
    const guard = new SpendingGuard(
      handle.sql,
      limits({ month: { usd: 1, tokens: null } }),
      prices,
      () => now,
    );
    const call = {
      provider: 'fireworks',
      model: MODEL,
      inputTokens: 10,
      maxOutputTokens: 60,
      local: false,
    };
    await guard.admit(servicePrincipal(), call);
    await guard.admit(servicePrincipal(), call);
    let refused: unknown;
    await guard.admit(servicePrincipal(), call).catch((error) => {
      refused = error;
    });
    expect(refused).toMatchObject({ code: 'spending_limit_reached' });
    // Neither call ever reported back. Ten minutes on, their holds are gone:
    // a call starts, and only its own hold is left.
    now = new Date(NOW.getTime() + 10 * 60_000 + 1);
    await guard.admit(servicePrincipal(), call);
    expect(await handle.sql`select 1 from spend_hold`).toHaveLength(1);
  });

  test('the totals the caps read stay in step with every call written, changed and removed', async () => {
    const { handle } = fixture();
    const other = newId('own');
    const people = [personId, other, null];
    const moments = [
      '2026-10-15T00:00:00.000Z',
      '2026-10-15T23:59:59.999Z',
      '2026-10-14T23:59:59.999Z',
      '2026-10-01T00:00:00.000Z',
      '2026-09-30T23:59:59.999Z',
    ];
    let seed = 12_345;
    const pick = <T>(list: readonly T[]): T => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return list[seed % list.length] as T;
    };
    const ids: string[] = [];
    for (let step = 0; step < 150; step++) {
      const action = ids.length
        ? pick(['insert', 'insert', 'change', 'remove'] as const)
        : 'insert';
      const cost = pick([0, 0.000_001, 0.1, 0.25, 3.5]);
      const tokens = pick([0, 7, 1_000]);
      if (action === 'insert') {
        const id = randomUUID();
        ids.push(id);
        await handle.sql`insert into model_usage (id, created_at, principal_id, purpose, provider,
            model, status, input_tokens, output_tokens, cost_usd, class)
          values (${id}, ${pick(moments)}::timestamptz, ${pick(people)}, 'agent', 'fireworks',
            ${MODEL}, 'succeeded', ${tokens}, ${pick([0, 40])}, ${cost},
            ${pick(['interactive', 'background'])})`;
      } else if (action === 'change') {
        const id = pick(ids);
        await handle.sql`update model_usage set cost_usd = ${cost}, input_tokens = ${tokens},
            created_at = ${pick(moments)}::timestamptz, principal_id = ${pick(people)},
            class = ${pick(['interactive', 'background'])}
          where id = ${id}`;
      } else {
        const id = pick(ids);
        ids.splice(ids.indexOf(id), 1);
        await handle.sql`delete from model_usage where id = ${id}`;
      }
    }
    // The same figures, summed straight from the calls.
    const calls = await handle.sql<
      {
        created_at: Date;
        principal_id: string | null;
        class: string;
        cost_usd: number;
        tokens: number;
      }[]
    >`select created_at, principal_id, class, cost_usd,
        (input_tokens + output_tokens)::int as tokens from model_usage`;
    const expected = new Map<string, { usd: number; tokens: number }>();
    for (const row of calls) {
      const at = new Date(row.created_at).toISOString();
      const scopes = ['installation'];
      if (row.principal_id) scopes.push(`person:${row.principal_id}`);
      if (row.principal_id && row.class === 'background')
        scopes.push(`background:${row.principal_id}`);
      for (const scope of scopes)
        for (const period of [at.slice(0, 7), at.slice(0, 10)]) {
          const key = `${period} ${scope}`;
          const sum = expected.get(key) ?? { usd: 0, tokens: 0 };
          expected.set(key, {
            usd: sum.usd + Number(row.cost_usd),
            tokens: sum.tokens + Number(row.tokens),
          });
        }
    }
    const counted = await handle.sql<
      { period: string; scope: string; usd: number; tokens: number }[]
    >`
      select period, scope, usd::float8 as usd, tokens::float8 as tokens from spend_counter`;
    const kept = new Map(
      counted
        .filter((row) => Math.abs(Number(row.usd)) > 1e-9 || Number(row.tokens) !== 0)
        .map((row) => [`${row.period} ${row.scope}`, row]),
    );
    const nonzero = [...expected].filter(([, sum]) => Math.abs(sum.usd) > 1e-9 || sum.tokens);
    expect([...kept.keys()].sort()).toEqual(nonzero.map(([key]) => key).sort());
    for (const [key, sum] of nonzero) {
      expect([key, Math.abs(Number(kept.get(key)?.usd) - sum.usd) < 1e-9]).toEqual([key, true]);
      expect([key, Number(kept.get(key)?.tokens)]).toEqual([key, sum.tokens]);
    }
    // What the guard reads for a person is those rows.
    const guard = new SpendingGuard(handle.sql, limits(), prices, () => NOW);
    const totals = await guard.totals(personId, NOW, true);
    const of = (key: string) => expected.get(key) ?? { usd: 0, tokens: 0 };
    expect(totals.installation.month.usd).toBeCloseTo(of('2026-10 installation').usd, 6);
    expect(totals.installation.day.tokens).toBe(of('2026-10-15 installation').tokens);
    expect(totals.person?.month.usd).toBeCloseTo(of(`2026-10 person:${personId}`).usd, 6);
    expect(totals.person?.day.tokens).toBe(of(`2026-10-15 person:${personId}`).tokens);
    expect(totals.background?.month.usd).toBeCloseTo(of(`2026-10 background:${personId}`).usd, 6);
    // Emptying the calls empties the totals.
    await handle.sql`truncate model_usage`;
    expect(await handle.sql`select 1 from spend_counter`).toHaveLength(0);
  });

  test("admitting and recording calls reads the running totals, never the month's calls", async () => {
    const { handle } = fixture();
    // Every statement the guard sends, as written: a sum over the month's calls
    // would run on every model call and grow with the month.
    const sent: string[] = [];
    const watched = new Proxy(handle.sql, {
      apply(target, self, args) {
        const [strings] = args;
        if (Array.isArray(strings) && 'raw' in strings) sent.push(strings.join('$'));
        return Reflect.apply(target, self, args);
      },
    });
    const guard = new SpendingGuard(
      watched,
      limits({ month: { usd: 100, tokens: null }, day: { usd: 50, tokens: null } }),
      prices,
      () => NOW,
    );
    const row = await createJob('Read the counters');
    const call = {
      provider: 'fireworks',
      model: MODEL,
      inputTokens: 10,
      maxOutputTokens: 50,
      local: false,
    };
    for (let index = 0; index < 3; index++) {
      const principal = jobPrincipal(row.id);
      await guard.admit(principal, call);
      await guard.record(principal, settlement(40));
    }
    expect(await guard.limitForJob(row.id)).toBeNull();
    expect((await guard.totals(personId, NOW, true)).person?.month.usd).toBe(1.2);
    const reads = sent.filter(
      (text) => /\bmodel_usage\b/.test(text) && !/^\s*insert into model_usage\b/.test(text),
    );
    expect(reads).toEqual([]);
    expect(sent.some((text) => /\bfrom spend_counter\b/.test(text))).toBe(true);
  });

  test("a turned-off account's work starts nothing and spends nothing", async () => {
    const { handle } = fixture();
    const routine = await createJob('Morning digest', 'routine');
    // No limits are set: only the account being off holds the work back.
    const open = new SpendingGuard(handle.sql, limits(), prices, () => NOW);
    expect(await open.limitForJob(routine.id, 'background')).toBeNull();
    await handle.sql`update principal set disabled_at = now() where id = ${personId}`;
    const off = new SpendingGuard(handle.sql, limits(), prices, () => NOW);
    for (const usageClass of ['background', 'interactive'] as const)
      expect(await off.limitForJob(routine.id, usageClass)).toEqual({
        message: ACCOUNT_OFF_MESSAGE,
        resetsAt: new Date('2026-10-16T00:00:00Z'),
      });
    // Where limits are set, the gateway refuses the account's calls as well.
    const capped = new SpendingGuard(
      handle.sql,
      limits({ month: { usd: 100, tokens: null } }),
      prices,
      () => NOW,
    );
    let refused: unknown;
    await capped.admit(jobPrincipal(routine.id)).catch((error) => {
      refused = error;
    });
    expect(refused).toMatchObject({ code: 'spending_limit_reached', detail: ACCOUNT_OFF_MESSAGE });
    // Turned back on, its work runs again.
    await handle.sql`update principal set disabled_at = null where id = ${personId}`;
    const back = new SpendingGuard(
      handle.sql,
      limits({ month: { usd: 100, tokens: null } }),
      prices,
      () => NOW,
    );
    expect(await back.limitForJob(routine.id, 'background')).toBeNull();
    await back.admit(jobPrincipal(routine.id));
  });

  test('the health detail is ok when healthy and names a stuck job queue', async () => {
    const { handle } = fixture();
    const probes = { version: 'test', database: async () => 'ok' as const, sql: handle.sql };
    const healthy = await healthDetail(probes);
    expect(healthy.status).toBe('ok');
    expect(healthy.checks.map((check) => check.name)).toEqual([
      'database',
      'job_queue',
      'error_rate',
    ]);
    const stuck = await createJob('Stuck');
    await handle.db
      .update(job)
      .set({ state: 'queued', nextWakeAt: new Date(Date.now() - 3_600_000) })
      .where(eq(job.id, stuck.id));
    const unhealthy = await healthDetail({
      ...probes,
      runtime: () => Promise.reject(new Error('down')),
    });
    expect(unhealthy.status).toBe('unhealthy');
    expect(unhealthy.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      'runtime',
      'job_queue',
    ]);
  });
});
