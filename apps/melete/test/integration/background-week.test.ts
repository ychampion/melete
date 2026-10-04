/**
 * A scripted week of background work for two people, run through the model
 * gateway on its fake transport at the default model's prices, recorded in
 * `model_usage`, rolled up by day, and read back as background cost per
 * active person-day. It prints the week and the figure, so a change to what
 * background work costs shows here first.
 *
 * Each day, a standing watch wakes for the observations that pass its test,
 * and each wake makes four model calls of 30,000 input tokens (70% read from
 * the prompt cache) and 1,200 output tokens; memory reads each message the
 * person wrote (2,000 in, 300 out); and the person's own turns run beside it,
 * counted as interactive. Weekends are quieter. No paid call is made.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { principal, space } from '../../src/db/schema.ts';
import { createModelGateway, providersFromEnv } from '../../src/gateway/index.ts';
import { PriceTable } from '../../src/gateway/prices.ts';
import { NO_LIMIT, SpendingGuard } from '../../src/gateway/spending.ts';
import type { GatewayPrincipal } from '../../src/gateway/types.ts';
import { backgroundCostPerPersonDay, rollupUsageDay, utcDay } from '../../src/gateway/usage-day.ts';
import { newId } from '../../src/ids.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';
/** The default model's own prices, per million tokens. */
const prices = new PriceTable({
  'fireworks/*deepseek-v4p1-flash*': { input: 0.3, output: 1.2, cached_input: 0.006 },
});
const WEEK_START = Date.parse('2026-09-07T00:00:00Z');
const DAY_MS = 86_400_000;

type Person = {
  name: string;
  /** Per weekday: observations in, the share that wakes the watch, messages written. */
  weekday: { observations: number; wakeShare: number; messages: number };
  weekend: { observations: number; wakeShare: number; messages: number };
};

const PEOPLE: Person[] = [
  {
    name: 'founder',
    weekday: { observations: 200, wakeShare: 0.15, messages: 20 },
    weekend: { observations: 60, wakeShare: 0.1, messages: 4 },
  },
  {
    name: 'teammate',
    weekday: { observations: 120, wakeShare: 0.1, messages: 12 },
    weekend: { observations: 20, wakeShare: 0.05, messages: 0 },
  },
];

const servers: Server[] = [];

withDb('the scripted week', () => {
  afterAll(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
    await handle?.close();
  }, 15_000);

  test('the scripted week prints background cost per active person-day from recorded calls', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    await resetTestRows(handle.sql);
    await handle.sql`delete from model_usage`;
    await handle.sql`delete from usage_day`;
    let clock = WEEK_START;
    const guard = new SpendingGuard(
      handle.sql,
      {
        installation: { day: NO_LIMIT, month: NO_LIMIT },
        person: { day: NO_LIMIT, month: NO_LIMIT },
        noticePercent: 80,
      },
      prices,
      () => new Date(clock),
    );
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
        const [input = 0, cached = 0, output = 0] = (body.messages[0]?.content ?? '')
          .split(' ')
          .map(Number);
        return Response.json({
          model: MODEL,
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: input + output,
            prompt_tokens_details: { cached_tokens: cached },
          },
        });
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
    const call = async (as: GatewayPrincipal, input: number, cached: number, output: number) => {
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
      expect(response.status).toBe(200);
    };

    const people = [];
    for (const person of PEOPLE) {
      const id = newId('own');
      const spaceId = newId('sp');
      await handle.db.insert(principal).values({ id, email: `${person.name}@example.test` });
      await handle.db
        .insert(space)
        .values({ id: spaceId, name: person.name, gitPath: `/s/${spaceId}`, ownerPrincipalId: id });
      const watch = newId('job');
      const chat = newId('job');
      for (const [jobId, title] of [
        [watch, 'Watch mail and calendar'],
        [chat, 'Conversation'],
      ] as const)
        await handle.sql`insert into job (id, space_id, principal_id, title, objective, kind, state)
          values (${jobId}, ${spaceId}, ${id}, ${title}, ${title}, 'responsibility', 'waiting_for_event_or_time')`;
      people.push({ ...person, id, spaceId, watch, chat, trigger: newId('trg') });
    }
    const attemptOf = async (jobId: string, usageClass: string, triggerId: string | null) => {
      const id = newId('att');
      await handle.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model, class, trigger_id)
        values (${id}, ${jobId}, (select coalesce(max(epoch), 0) + 1 from attempt where job_id = ${jobId}),
          'fake', 'fireworks', ${MODEL}, ${usageClass}, ${triggerId})`;
      return id;
    };

    const lines: string[] = [];
    for (let day = 0; day < 7; day++) {
      clock = WEEK_START + day * DAY_MS + 9 * 3_600_000;
      const weekend = new Date(clock).getUTCDay() % 6 === 0;
      for (const person of people) {
        const shape = weekend ? person.weekend : person.weekday;
        const wakes = Math.round(shape.observations * shape.wakeShare);
        for (let wake = 0; wake < wakes; wake++) {
          const attemptId = await attemptOf(person.watch, 'background', person.trigger);
          const turn: GatewayPrincipal = {
            jobId: person.watch,
            attemptId,
            privacy: { kind: 'job' },
            epoch: 1,
            revision: 0,
            maxRequests: 10,
            maxTokens: 100_000,
            allowedModels: [{ provider: 'fireworks', model: MODEL }],
          };
          for (let step = 0; step < 4; step++) await call(turn, 30_000, 21_000, 1_200);
        }
        for (let message = 0; message < shape.messages; message++) {
          const attemptId = await attemptOf(person.chat, 'interactive', null);
          await call(
            {
              jobId: person.chat,
              attemptId,
              privacy: { kind: 'job' },
              epoch: 1,
              revision: 0,
              maxRequests: 10,
              maxTokens: 100_000,
              allowedModels: [{ provider: 'fireworks', model: MODEL }],
            },
            12_000,
            6_000,
            800,
          );
          await call(
            {
              jobId: `memory:${person.spaceId}`,
              attemptId: `memory:${randomUUID()}`,
              privacy: {
                kind: 'service',
                purpose: 'memory',
                spaceId: person.spaceId,
                sourceJobId: person.chat,
              },
              epoch: 0,
              revision: 0,
              maxRequests: 1,
              maxTokens: 100_000,
              allowedModels: [{ provider: 'fireworks', model: MODEL }],
            },
            2_000,
            0,
            300,
          );
        }
      }
      const date = utcDay(new Date(clock));
      await rollupUsageDay(handle.sql, date);
      const rows = await handle.sql`select principal_id, class, sum(calls)::int as calls,
          sum(cost_usd)::float8 as usd
        from usage_day where day = ${date} group by principal_id, class`;
      for (const person of people) {
        const of = (usageClass: string) =>
          rows.find((row) => row.principal_id === person.id && row.class === usageClass);
        lines.push(
          [
            date,
            person.name.padEnd(9),
            `background ${String(of('background')?.calls ?? 0).padStart(4)} calls $${Number(of('background')?.usd ?? 0).toFixed(4)}`,
            `interactive ${String(of('interactive')?.calls ?? 0).padStart(3)} calls $${Number(of('interactive')?.usd ?? 0).toFixed(4)}`,
          ].join('  '),
        );
      }
    }

    const from = utcDay(new Date(WEEK_START));
    const to = utcDay(new Date(WEEK_START + 7 * DAY_MS));
    const bcpd = await backgroundCostPerPersonDay(handle.sql, from, to);
    process.stdout.write(
      [
        '',
        'Scripted week, default model:',
        ...lines,
        `Background cost per active person-day over ${bcpd.person_days} person-days: median $${bcpd.median_usd.toFixed(4)}, p95 $${bcpd.p95_usd.toFixed(4)}, mean $${bcpd.mean_usd.toFixed(4)}`,
        `By step: ${JSON.stringify(bcpd.by_tier)}`,
        `By purpose: ${JSON.stringify(bcpd.by_purpose)}`,
        '',
      ].join('\n'),
    );

    // The figure is the recorded calls' own: each person-day's background
    // dollars, read straight from model_usage, give the same mean.
    expect(bcpd.person_days).toBe(14);
    const [direct] = await handle.sql`select
        round((sum(cost_usd) filter (where class = 'background'))::numeric, 6)::float8 as usd
      from model_usage where created_at >= ${new Date(WEEK_START).toISOString()}::timestamptz`;
    expect(bcpd.mean_usd).toBeCloseTo(Number(direct?.usd) / 14, 6);
    // A weekday wake on the default model: 4 × (9,000 × $0.30 + 21,000 × $0.006
    // + 1,200 × $1.20) per million = $0.017064; the founder's weekday is 30
    // of them and 20 memory reads at $0.00096.
    const founderWeekday = 30 * 0.017064 + 20 * 0.00096;
    expect(bcpd.p95_usd).toBeCloseTo(founderWeekday, 6);
    expect(Object.keys(bcpd.by_tier).sort()).toEqual(['service', 't2']);
    expect(Object.keys(bcpd.by_purpose).sort()).toEqual(['agent', 'memory']);
  });
});
