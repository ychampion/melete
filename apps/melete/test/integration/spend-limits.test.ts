/**
 * Monthly limits for one member and budgets for one space: checked beside the
 * installation's limits, named in the refusal, cleared to nothing, and what
 * `GET /usage` shows by space and by member, with the routes that set them.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spendLimitResponse, usageResponse } from '@melete/contracts';
import { Hono } from 'hono';
import { mountUsage } from '../../src/api/usage.ts';
import { owner, principal, space, spaceMembership } from '../../src/db/schema.ts';
import { PriceTable } from '../../src/gateway/prices.ts';
import { NO_LIMIT, SpendingGuard, type SpendingLimits } from '../../src/gateway/spending.ts';
import type { GatewayPrincipal, GatewaySettlement } from '../../src/gateway/types.ts';
import { newId } from '../../src/ids.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const MODEL = 'accounts/fireworks/models/fixture-model';
/** Mid-October, so a month's limit resets on November 1. */
const NOW = new Date('2026-10-15T12:00:00Z');
const RESETS = 'it resets on November 1. The person who runs this Melete can raise it.';

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
  usage: { inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens, cachedInputTokens: 0 },
  latencyMs: 5,
  status: 'succeeded',
  httpStatus: 200,
});

/** A call one person makes in one space. */
const callBy = (actor: string, spaceId: string): GatewayPrincipal => ({
  jobId: `voice:${spaceId}`,
  attemptId: `voice:${randomUUID()}`,
  privacy: { kind: 'service', purpose: 'voice', spaceId, sourceJobId: null },
  actor,
  epoch: 0,
  revision: 0,
  maxRequests: 1,
  maxTokens: 10_000,
  allowedModels: [{ provider: 'fireworks', model: MODEL }],
});

let ada = '';
let bea = '';
let adaSpace = '';
let beaSpace = '';
let room = '';

function db() {
  if (!handle) throw new Error('Postgres unavailable');
  return handle;
}

async function spend(guard: SpendingGuard, actor: string, spaceId: string, calls: number) {
  for (let n = 0; n < calls; n++) await guard.record(callBy(actor, spaceId), settlement(40));
}

/** The refusal a call would meet now, or null when it is admitted. */
async function refusal(guard: SpendingGuard, actor: string, spaceId: string) {
  const principal = callBy(actor, spaceId);
  try {
    await guard.admit(principal);
    guard.release(principal);
    return null;
  } catch (error) {
    return (error as { detail?: string }).detail ?? String(error);
  }
}

withDb('member limits and space budgets', () => {
  beforeEach(async () => {
    const { db: orm, sql } = db();
    await resetTestRows(sql);
    await sql`delete from model_usage`;
    await sql`delete from spending_notice`;
    await sql`delete from spend_limit`;
    ada = newId('own');
    bea = newId('own');
    adaSpace = newId('sp');
    beaSpace = newId('sp');
    room = newId('sp');
    await orm.insert(principal).values([
      { id: ada, email: `${ada}@example.test`, displayName: 'Ada' },
      { id: bea, email: `bea-${bea}@example.test` },
    ]);
    // Ada runs the installation; Bea runs the room, and Ada is in it.
    await orm.insert(owner).values({ id: ada, email: `${ada}@example.test` });
    await orm.insert(space).values([
      { id: adaSpace, name: 'Personal', gitPath: `/spaces/${adaSpace}`, ownerPrincipalId: ada },
      { id: beaSpace, name: 'Personal', gitPath: `/spaces/${beaSpace}`, ownerPrincipalId: bea },
      {
        id: room,
        name: 'Launch',
        kind: 'shared',
        audience: 'space',
        gitPath: `/spaces/${room}`,
        ownerPrincipalId: bea,
      },
    ]);
    await orm.insert(spaceMembership).values([
      { principalId: bea, spaceId: room, role: 'owner' },
      { principalId: ada, spaceId: room, role: 'member' },
    ]);
  }, 15_000);

  afterAll(async () => {
    await handle?.close();
  }, 15_000);

  test('with nothing set nothing is limited', async () => {
    const guard = new SpendingGuard(db().sql, limits(), prices, () => NOW);
    await spend(guard, ada, room, 5);
    expect(await refusal(guard, ada, room)).toBeNull();
    expect(await guard.reachedLimit(ada, 'interactive', room)).toBeNull();
  });

  test("a member's limit refuses their next call in any space, says who can raise it, and clearing it lets them through", async () => {
    const guard = new SpendingGuard(db().sql, limits(), prices, () => NOW);
    await guard.spendLimits.set('member', ada, 1, ada);
    await spend(guard, ada, adaSpace, 2);
    // $0.80 of $1.00: still admitted.
    expect(await refusal(guard, ada, adaSpace)).toBeNull();
    await spend(guard, ada, room, 1);
    const message = `You have reached your monthly limit of $1.00; ${RESETS}`;
    expect(await refusal(guard, ada, adaSpace)).toBe(message);
    expect(await refusal(guard, ada, room)).toBe(message);
    // Someone else in the same room is not held to Ada's limit.
    expect(await refusal(guard, bea, room)).toBeNull();
    // What Settings shows Ada: her own limit in place of the installation-wide one.
    const summary = await guard.summary(ada, false);
    expect(summary.limits.person.month).toEqual({ usd: 1, tokens: null });
    expect(summary.notice).toMatchObject({ level: 'reached', scope: 'person', message });

    await guard.spendLimits.set('member', ada, null, ada);
    expect(await refusal(guard, ada, adaSpace)).toBeNull();
    expect(await db().sql`select * from spend_limit`).toHaveLength(0);
  });

  test("a member's own limit takes the place of the installation-wide monthly one", async () => {
    const guard = new SpendingGuard(
      db().sql,
      limits({ month: { usd: 0.5, tokens: null } }),
      prices,
      () => NOW,
    );
    await spend(guard, ada, adaSpace, 2);
    expect(await refusal(guard, ada, adaSpace)).toBe(
      "This month's limit is reached; it resets on November 1.",
    );
    await guard.spendLimits.set('member', ada, 5, ada);
    expect(await refusal(guard, ada, adaSpace)).toBeNull();
    // Bea has no limit of her own, so the installation-wide one still holds her.
    await spend(guard, bea, beaSpace, 2);
    expect(await refusal(guard, bea, beaSpace)).toBe(
      "This month's limit is reached; it resets on November 1.",
    );
  });

  test("a space's budget counts everyone's calls in it and holds only calls made there", async () => {
    const guard = new SpendingGuard(db().sql, limits(), prices, () => NOW);
    await guard.spendLimits.set('space', room, 1, ada);
    await spend(guard, ada, room, 2);
    expect(await refusal(guard, bea, room)).toBeNull();
    await spend(guard, bea, room, 1);
    const message = `"Launch" has reached its monthly budget of $1.00; ${RESETS}`;
    expect(await refusal(guard, ada, room)).toBe(message);
    expect(await refusal(guard, bea, room)).toBe(message);
    // Their own spaces are not the room.
    expect(await refusal(guard, ada, adaSpace)).toBeNull();
    expect(await refusal(guard, bea, beaSpace)).toBeNull();
    await guard.spendLimits.set('space', room, 2, ada);
    expect(await refusal(guard, bea, room)).toBeNull();
  });

  test("with both reached the member's own limit is named first, then the space's budget once it is cleared", async () => {
    const guard = new SpendingGuard(db().sql, limits(), prices, () => NOW);
    await guard.spendLimits.set('space', room, 0.8, ada);
    await guard.spendLimits.set('member', ada, 0.4, ada);
    await spend(guard, ada, room, 1);
    await spend(guard, bea, room, 1);
    expect(await refusal(guard, ada, room)).toBe(
      `You have reached your monthly limit of $0.40; ${RESETS}`,
    );
    await guard.spendLimits.set('member', ada, null, ada);
    expect(await refusal(guard, ada, room)).toBe(
      `"Launch" has reached its monthly budget of $0.80; ${RESETS}`,
    );
    // A member with a higher limit of their own is still held to the space's budget.
    await guard.spendLimits.set('member', ada, 100, ada);
    expect(await refusal(guard, ada, room)).toBe(
      `"Launch" has reached its monthly budget of $0.80; ${RESETS}`,
    );
  });

  test('calls running side by side in a space are held against its budget', async () => {
    const guard = new SpendingGuard(db().sql, limits(), prices, () => NOW);
    await guard.spendLimits.set('space', room, 0.4, ada);
    const call = {
      provider: 'fireworks',
      model: MODEL,
      inputTokens: 10,
      maxOutputTokens: 40,
      local: false,
    };
    // Each may cost $0.40: the second, admitted while the first runs, is refused.
    await guard.admit(callBy(ada, room), call);
    await expect(guard.admit(callBy(bea, room), call)).rejects.toMatchObject({ status: 402 });
  });

  function app(actor: string) {
    const { sql } = db();
    const guard = new SpendingGuard(sql, limits(), prices);
    const hono = new Hono();
    hono.use(async (c, next) => {
      c.set('owner' as never, { id: actor } as never);
      await next();
    });
    mountUsage(hono, { spending: guard, isOwner: async (id) => id === ada, sql });
    return { hono, guard };
  }
  const put = (hono: Hono, path: string, body: unknown) =>
    hono.request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('the person who runs the installation sets and clears limits; nobody else can', async () => {
    const owned = app(ada);
    const set = await put(owned.hono, `/usage/limits/members/${bea}`, { monthly_usd: 12.5 });
    expect(set.status).toBe(200);
    expect(spendLimitResponse.parse(await set.json())).toEqual({
      kind: 'member',
      id: bea,
      monthly_usd: 12.5,
    });
    expect(
      (await put(owned.hono, `/usage/limits/spaces/${room}`, { monthly_usd: 40 })).status,
    ).toBe(200);
    expect((await owned.guard.spendLimits.all(true)).space.get(room)).toBe(40);
    // A negative amount, a string, or no body at all is refused.
    for (const body of [{ monthly_usd: -1 }, { monthly_usd: '5' }, {}])
      expect((await put(owned.hono, `/usage/limits/spaces/${room}`, body)).status).toBe(400);
    expect(
      (await put(owned.hono, '/usage/limits/spaces/sp_missing', { monthly_usd: 1 })).status,
    ).toBe(404);
    expect(
      (await put(owned.hono, '/usage/limits/members/own_missing', { monthly_usd: 1 })).status,
    ).toBe(404);
    // Bea runs the room but not the installation.
    const other = app(bea);
    const refused = await put(other.hono, `/usage/limits/spaces/${room}`, { monthly_usd: 1000 });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
      'Only the person who runs this Melete sets spending limits.',
    );
    const cleared = await put(owned.hono, `/usage/limits/members/${bea}`, { monthly_usd: null });
    expect(await cleared.json()).toEqual({ kind: 'member', id: bea, monthly_usd: null });
    const rows = await db().sql`select kind, target_id, monthly_usd from spend_limit`;
    expect(rows.map((row) => [row.kind, row.target_id, row.monthly_usd])).toEqual([
      ['space', room, 40],
    ]);
  });

  test('GET /usage groups the month by space for a room owner, and by member for the person who runs it', async () => {
    const recorder = new SpendingGuard(db().sql, limits(), prices);
    await spend(recorder, ada, adaSpace, 1);
    await spend(recorder, ada, room, 2);
    await spend(recorder, bea, room, 1);
    await spend(recorder, bea, beaSpace, 3);
    await recorder.spendLimits.set('space', room, 5, ada);
    await recorder.spendLimits.set('member', bea, 2, ada);

    // Bea runs the room and her own space; she sees both, and no one's totals.
    const asBea = usageResponse.parse(await (await app(bea).hono.request('/usage')).json());
    expect(asBea.by_member).toBeNull();
    // The same spending in each, so they are listed by name.
    expect(asBea.by_space).toEqual([
      {
        space_id: room,
        name: 'Launch',
        kind: 'shared',
        calls: 3,
        usd: 1.2,
        tokens: 150,
        budget_usd: 5,
      },
      {
        space_id: beaSpace,
        name: 'Personal',
        kind: 'personal',
        calls: 3,
        usd: 1.2,
        tokens: 150,
        budget_usd: null,
      },
    ]);
    // Her own limit is the one Settings shows her.
    expect(asBea.limits.person.month).toEqual({ usd: 2, tokens: null });

    // Ada runs the installation: her own space and every room, and each member.
    const asAda = usageResponse.parse(await (await app(ada).hono.request('/usage')).json());
    expect(asAda.by_space?.map((row) => [row.space_id, row.calls])).toEqual([
      [room, 3],
      [adaSpace, 1],
    ]);
    expect(asAda.by_member).toEqual([
      { principal_id: bea, name: `bea-${bea}`, calls: 4, usd: 1.6, tokens: 200, limit_usd: 2 },
      { principal_id: ada, name: 'Ada', calls: 3, usd: 1.2, tokens: 150, limit_usd: null },
    ]);
  });
});
