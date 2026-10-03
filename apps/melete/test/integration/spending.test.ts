import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AttemptBundle, AttemptOutcome, RuntimeAdapter } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { attempt, job, principal, space } from '../../src/db/schema.ts';
import { appendEvent } from '../../src/events/store.ts';
import { createModelGateway, providersFromEnv } from '../../src/gateway/index.ts';
import { PriceTable } from '../../src/gateway/prices.ts';
import { NO_LIMIT, SpendingGuard, type SpendingLimits } from '../../src/gateway/spending.ts';
import type { GatewayPrincipal, GatewaySettlement } from '../../src/gateway/types.ts';
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

/** A gateway whose provider answers 40 output tokens, slowly when asked. */
async function gateway(guard: SpendingGuard) {
  const server = createModelGateway({
    privacy: false,
    spending: guard,
    budget: { reserve: async () => ({ id: randomUUID() }), settle: async () => {} },
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
  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await resetTestRows(handle.sql);
    await handle.sql`delete from model_usage`;
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
      spendingLimit: (jobId) => guard.reachedForJob(jobId),
    });
    guard.onRefused = (_scope, refused, message) => {
      if (refused.privacy.kind === 'job')
        runner.stopForSpending(refused.jobId, refused.attemptId, message);
    };
    const wake = async (row: JobRow) => {
      await handle.db.update(job).set({ nextWakeAt: new Date() }).where(eq(job.id, row.id));
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
