/**
 * Your usage and Home's starter tasks, against Postgres, through the routes a
 * browser calls.
 *
 * `GET /usage/mine` reads the signed-in account's own model calls and nobody
 * else's: not a member's in the owner's shared space, not the owner's from a
 * member's session, and never for a guest. Its figures are the meter's: the
 * same totals `GET /usage` reports, the same calls split by day and by kind.
 *
 * `GET /starters` offers them once setup is done, until three chats or until
 * put away; putting them away holds for that account in any session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { myUsageResponse, startersResponse, usageResponse } from '@melete/contracts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { NO_LIMIT, SpendingGuard, type SpendingLimits } from '../../src/gateway/spending.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const directory = await mkdtemp(join(tmpdir(), 'melete-usage-starters-'));
const password = 'a-long-enough-password';

const limits: SpendingLimits = {
  installation: { day: NO_LIMIT, month: NO_LIMIT },
  person: { day: { usd: 50, tokens: null }, month: { usd: 100, tokens: null } },
  background: { day: NO_LIMIT, month: NO_LIMIT },
  noticePercent: 80,
};

function database() {
  if (!handle) throw new Error('Postgres unavailable');
  return handle;
}

function makeApp(spending: SpendingGuard) {
  return createApp({
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_PREVIEW_MULTIPLAYER: 'true',
      MELETE_SPACES_DIR: join(directory, 'spaces'),
      MELETE_WORK_DIR: join(directory, 'work'),
      MELETE_PUBLIC_URL: 'https://melete.example',
      MELETE_SETUP_OPEN: 'true',
    }),
    db: database().db,
    sql: database().sql,
    registry: new ConnectorRegistry(),
    spending,
    checkDatabase: async () => 'ok',
  });
}

type App = ReturnType<typeof makeApp>;
type Person = { id: string; cookie: string; space: string };

function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}

const call = (app: App, cookie: string, path: string, method = 'GET', body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function ok(response: Response | Promise<Response>, status = 200): Promise<unknown> {
  const answered = await response;
  const text = await answered.text();
  expect([answered.status, text.slice(0, 300)]).toEqual([status, text.slice(0, 300)]);
  return JSON.parse(text);
}

async function login(app: App, email: string): Promise<string> {
  return sessionCookie(
    await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
}

async function personalSpace(id: string): Promise<string> {
  const [row] = await database().sql`select s.id from space s
    where s.kind = 'personal'
      and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${id}
    order by s.created_at limit 1`;
  if (!row) throw new Error(`No personal space for ${id}`);
  return String(row.id);
}

/** A job of a person's, of the given kind and state, in a space. */
async function job(
  spaceId: string,
  principalId: string,
  title: string,
  kind = 'chat',
  state = 'completed',
  parent: string | null = null,
) {
  const { sql } = database();
  const agentId = newId('agent');
  await sql`insert into agent
    (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
    values (${agentId}, ${spaceId}, 'Aide', 'assistant', 'blue', 'matte', 'grey', 'plain', 'Help.')`;
  const id = newId('job');
  await sql`insert into job (id, space_id, title, principal_id, objective, agent_id, state, kind,
      experience_parent_id)
    values (${id}, ${spaceId}, ${title}, ${principalId}, ${title}, ${agentId}, ${state}, ${kind},
      ${parent})`;
  return { id, agentId };
}

async function turn(jobId: string, agentId: string, status: string) {
  await database()
    .sql`insert into experience_turn (id, job_id, agent_id, submission_id, text, status)
    values (${newId('turn')}, ${jobId}, ${agentId}, ${`s${randomUUID()}`}, 'hello', ${status})`;
}

/** One settled model call, as the gateway records it. */
async function charge(options: {
  person: string;
  space: string | null;
  job: string | null;
  usd: number;
  tokens?: number;
  background?: boolean;
  at?: string;
}) {
  const background = options.background ?? false;
  await database().sql`insert into model_usage (id, created_at, space_id, principal_id, job_id,
      purpose, provider, model, status, input_tokens, output_tokens, cost_usd, class, tier)
    values (${randomUUID()}, ${options.at ?? new Date().toISOString()}::timestamptz,
      ${options.space}, ${options.person}, ${options.job}, ${options.job ? 'agent' : 'memory'},
      'fireworks', 'deepseek-v4p1-flash', 'succeeded', ${options.tokens ?? 1000}, 0,
      ${options.usd}, ${background ? 'background' : 'interactive'},
      ${background ? 't2' : 'interactive'})`;
}

withDb('your usage', () => {
  const guard = handle ? new SpendingGuard(handle.sql, limits) : (null as never);
  const app = handle ? makeApp(guard) : (null as never);
  let alice: Person;
  let bob: Person;
  let carol: { id: string; cookie: string };
  let shared: string;
  const ids: Record<string, string> = {};
  const lastMonth = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 3_600_000).toISOString();
  };

  beforeAll(async () => {
    const { sql } = database();
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password }),
    });
    expect(setup.status).toBe(201);
    const aliceId = ((await setup.clone().json()) as { owner: { id: string } }).owner.id;
    const aliceCookie = sessionCookie(setup);
    const made: Record<string, string> = {};
    for (const name of ['bob', 'carol']) {
      const response = (await ok(
        call(app, aliceCookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      )) as { principal: { id: string } };
      made[name] = response.principal.id;
    }
    // Her first request makes her personal space.
    await ok(call(app, aliceCookie, '/usage'));
    // Carol only ever came in through a room invite: a guest.
    await sql`update principal set kind = 'guest' where id = ${made.carol ?? ''}`;
    alice = { id: aliceId, cookie: aliceCookie, space: await personalSpace(aliceId) };
    const bobCookie = await login(app, 'bob@example.test');
    // Bob's first request makes his personal space.
    await ok(call(app, bobCookie, '/usage'));
    bob = { id: made.bob ?? '', cookie: bobCookie, space: await personalSpace(made.bob ?? '') };
    carol = { id: made.carol ?? '', cookie: await login(app, 'carol@example.test') };

    // Alice's shared space, with Bob in it.
    shared = newId('sp');
    await sql`insert into space (id, name, kind, owner_principal_id, git_path)
      values (${shared}, 'Team', 'shared', ${alice.id}, ${join(directory, 'team')})`;
    await sql`insert into space_membership (principal_id, space_id, role) values
      (${alice.id}, ${shared}, 'owner'), (${bob.id}, ${shared}, 'member')`;

    // Alice: a chat that answered, a routine that waits on her, a command its chat started,
    // a background watch that failed in the shared space, and a memory read with no job.
    const chat = await job(alice.space, alice.id, 'Plan a trip to Lisbon');
    await turn(chat.id, chat.agentId, 'done');
    const routine = await job(
      alice.space,
      alice.id,
      'Morning brief',
      'routine',
      'waiting_for_input',
    );
    await turn(routine.id, routine.agentId, 'needs_you');
    const command = await job(alice.space, alice.id, 'Find flights', 'command', 'running', chat.id);
    const watch = await job(shared, alice.id, 'Watch the prices page', 'watch', 'failed');
    ids.chat = chat.id;
    ids.routine = routine.id;
    ids.command = command.id;
    ids.watch = watch.id;
    await charge({ person: alice.id, space: alice.space, job: chat.id, usd: 1.25, tokens: 5000 });
    await charge({ person: alice.id, space: alice.space, job: chat.id, usd: 0.75, tokens: 3000 });
    await charge({
      person: alice.id,
      space: alice.space,
      job: routine.id,
      usd: 0.5,
      background: true,
    });
    await charge({ person: alice.id, space: alice.space, job: command.id, usd: 0.25 });
    await charge({ person: alice.id, space: shared, job: watch.id, usd: 0.1, background: true });
    await charge({ person: alice.id, space: alice.space, job: null, usd: 0.05, background: true });
    // Last month's call counts for nothing now.
    await charge({
      person: alice.id,
      space: alice.space,
      job: chat.id,
      usd: 9,
      at: lastMonth(),
    });

    // Bob: his own chat in Alice's shared space, and one in his own space.
    const bobShared = await job(shared, bob.id, 'Bob’s private question');
    await turn(bobShared.id, bobShared.agentId, 'failed');
    const bobOwn = await job(bob.space, bob.id, 'Bob’s groceries');
    ids.bobShared = bobShared.id;
    ids.bobOwn = bobOwn.id;
    await charge({ person: bob.id, space: shared, job: bobShared.id, usd: 3 });
    await charge({ person: bob.id, space: bob.space, job: bobOwn.id, usd: 2 });
    // Alice wrote in Bob's chat once: hers to pay, but his chat to see.
    await charge({ person: alice.id, space: shared, job: bobShared.id, usd: 0.4 });
    // Carol's own calls, in a room of Alice's.
    await charge({ person: carol.id, space: shared, job: null, usd: 7 });

    // Computer time kept running in Alice's own spaces, this month and last.
    await sql`insert into sandbox_awake_day (space_id, day, seconds) values
      (${alice.space}, (now() at time zone 'utc')::date, 1800),
      (${shared}, (now() at time zone 'utc')::date, 600),
      (${bob.space}, (now() at time zone 'utc')::date, 999)`;
  }, 60_000);

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('the numbers are the meter’s: totals, days and kinds all add up to the calls', async () => {
    const mine = myUsageResponse.parse(await ok(call(app, alice.cookie, '/usage/mine')));
    const meter = usageResponse.parse(await ok(call(app, alice.cookie, '/usage')));
    const [row] = await database().sql`select round(sum(cost_usd)::numeric, 6)::float8 as usd,
        sum(input_tokens + output_tokens)::int as tokens
      from model_usage where principal_id = ${alice.id}
        and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;
    // 1.25 + 0.75 + 0.5 + 0.25 + 0.1 + 0.05 + 0.4 this month.
    expect(Number(row?.usd)).toBeCloseTo(3.3, 6);
    expect(mine.spent.month.usd).toBeCloseTo(3.3, 6);
    expect(mine.spent.month).toEqual(meter.person?.month ?? { usd: -1, tokens: -1 });
    expect(mine.spent.month.tokens).toBe(Number(row?.tokens));
    expect(mine.spent.day).toEqual(meter.person?.day ?? { usd: -1, tokens: -1 });
    expect(mine.background_spent.month.usd).toBeCloseTo(0.65, 6);

    // Every day of the month so far, ending today, and they add up to the month.
    const today = new Date().toISOString().slice(0, 10);
    expect(mine.days).toHaveLength(new Date().getUTCDate());
    expect(mine.days.at(-1)?.day).toBe(today);
    expect(mine.days[0]?.day).toBe(mine.month_start.slice(0, 10));
    const sum = mine.days.reduce((total, day) => total + day.usd, 0);
    expect(sum).toBeCloseTo(mine.spent.month.usd, 6);
    expect(mine.days.reduce((total, day) => total + day.background_usd, 0)).toBeCloseTo(0.65, 6);

    // Chats are what she waited on; the rest ran in the background.
    expect(mine.kinds).toEqual([
      { kind: 'chats', calls: 4, usd: 2.65, tokens: 10_000 },
      { kind: 'background', calls: 3, usd: 0.65, tokens: 3000 },
    ]);
    expect(mine.kinds.reduce((total, kind) => total + kind.usd, 0)).toBeCloseTo(3.3, 6);
    // Her own spaces' computers: her personal one and the shared one she owns.
    expect(mine.computer_seconds).toBe(2400);
    expect(mine.caps).toEqual({
      month: { usd: 100, tokens: null },
      day: { usd: 50, tokens: null },
      background: null,
    });
    expect(mine.notice).toBeNull();
  });

  test('recent work is her own, newest first, with how it ended and the chat to open', async () => {
    const mine = myUsageResponse.parse(await ok(call(app, alice.cookie, '/usage/mine')));
    const byId = new Map(mine.runs.map((run) => [run.id, run]));
    expect(byId.get(ids.chat ?? '')).toMatchObject({
      title: 'Plan a trip to Lisbon',
      outcome: 'done',
      usd: 2,
      background: false,
      conversation_id: ids.chat,
    });
    expect(byId.get(ids.routine ?? '')).toMatchObject({
      outcome: 'needs_you',
      background: true,
      conversation_id: ids.routine,
    });
    // A command opens the chat that started it.
    expect(byId.get(ids.command ?? '')).toMatchObject({
      outcome: 'working',
      conversation_id: ids.chat,
    });
    // A watch has no thread of its own.
    expect(byId.get(ids.watch ?? '')).toMatchObject({ outcome: 'failed', conversation_id: null });
    // Bob's chat she paid into is still Bob's: counted in her totals, never listed.
    expect(byId.has(ids.bobShared ?? '')).toBe(false);
    expect(mine.runs).toHaveLength(4);
    const times = mine.runs.map((run) => run.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test('nobody reads anyone else’s usage: not the space owner, not a member, not a guest', async () => {
    const asBob = myUsageResponse.parse(await ok(call(app, bob.cookie, '/usage/mine')));
    expect(asBob.spent.month.usd).toBeCloseTo(5, 6);
    expect(asBob.runs.map((run) => run.id).sort()).toEqual(
      [ids.bobOwn ?? '', ids.bobShared ?? ''].sort(),
    );
    expect(asBob.runs.find((run) => run.id === ids.bobShared)?.outcome).toBe('failed');
    // His own space's computer only; the shared space is Alice's.
    expect(asBob.computer_seconds).toBe(999);
    const asAlice = myUsageResponse.parse(await ok(call(app, alice.cookie, '/usage/mine')));
    expect(asAlice.runs.some((run) => run.title.startsWith('Bob'))).toBe(false);
    expect(asAlice.spent.month.usd).toBeCloseTo(3.3, 6);

    // Nothing in the request chooses whose usage it is.
    for (const path of [
      `/usage/mine?principal_id=${bob.id}`,
      `/usage/mine?person=${bob.id}`,
      `/usage/mine?space_id=${shared}`,
    ]) {
      const asked = myUsageResponse.parse(await ok(call(app, alice.cookie, path)));
      expect(asked.spent.month.usd).toBeCloseTo(3.3, 6);
      expect(asked.runs.map((run) => run.id)).toEqual(asAlice.runs.map((run) => run.id));
    }

    // A guest's session reaches its rooms only.
    const guest = await call(app, carol.cookie, '/usage/mine');
    expect(guest.status).toBe(403);
    expect(((await guest.json()) as { error: { code: string } }).error.code).toBe(
      'guests_use_rooms',
    );
    // Signed out is no one at all.
    expect((await call(app, '', '/usage/mine')).status).toBe(401);
  });

  test('an installation with no limits shows spending alone', async () => {
    const open = makeApp(
      new SpendingGuard(database().sql, {
        installation: { day: NO_LIMIT, month: NO_LIMIT },
        person: { day: NO_LIMIT, month: NO_LIMIT },
        noticePercent: 80,
      }),
    );
    const mine = myUsageResponse.parse(await ok(call(open, alice.cookie, '/usage/mine')));
    expect(mine.caps).toBeNull();
    expect(mine.notice).toBeNull();
    expect(mine.spent.month.usd).toBeCloseTo(3.3, 6);
  });

  test('close to her own limit she is told, and at it told when it starts again', async () => {
    const near = makeApp(
      new SpendingGuard(database().sql, {
        ...limits,
        person: { day: NO_LIMIT, month: { usd: 4, tokens: null } },
      }),
    );
    // 3.30 of 4.00 is past 80%.
    const warned = myUsageResponse.parse(await ok(call(near, alice.cookie, '/usage/mine')));
    expect(warned.notice).toMatchObject({ level: 'warning', period: 'month', scope: 'person' });
    expect(warned.notice?.message).toBe("You have used 82% of this month's model allowance.");
    const over = makeApp(
      new SpendingGuard(database().sql, {
        ...limits,
        person: { day: NO_LIMIT, month: { usd: 3.3, tokens: null } },
      }),
    );
    const reached = myUsageResponse.parse(await ok(call(over, alice.cookie, '/usage/mine')));
    expect(reached.notice).toMatchObject({ level: 'reached', period: 'month' });
    expect(reached.notice?.message).toMatch(/^This month's limit is reached; it resets on /);
    // The same limit holds Bob to his own calls: his 5.00 is past it, and
    // under a roomier one he is told nothing.
    const bobView = myUsageResponse.parse(await ok(call(near, bob.cookie, '/usage/mine')));
    expect(bobView.notice).toMatchObject({ level: 'reached' });
    const roomy = makeApp(
      new SpendingGuard(database().sql, {
        ...limits,
        person: { day: NO_LIMIT, month: { usd: 10, tokens: null } },
      }),
    );
    expect(
      myUsageResponse.parse(await ok(call(roomy, bob.cookie, '/usage/mine'))).notice,
    ).toBeNull();
  });
});

withDb('starter tasks', () => {
  const guard = handle ? new SpendingGuard(handle.sql, limits) : (null as never);
  const app = handle ? makeApp(guard) : (null as never);
  let dana: Person;
  let erin: Person;

  const profile = (onboarded: boolean, zone = 'America/Chicago') => ({
    name: 'Dana',
    time_zone: zone,
    day_hours: { start: '08:00', end: '22:00' },
    onboarded,
  });
  const starters = async (person: Person) =>
    startersResponse.parse(await ok(call(app, person.cookie, '/starters')));

  beforeAll(async () => {
    const { sql } = database();
    // A fresh installation for these: its own first account.
    await sql`delete from model_usage`;
    const [existing] = await sql`select id from owner limit 1`;
    const ownerCookie = existing
      ? await login(app, 'alice@example.test')
      : sessionCookie(
          await app.request('/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'alice@example.test', password }),
          }),
        );
    const people: Person[] = [];
    for (const name of ['dana', 'erin']) {
      const made = (await ok(
        call(app, ownerCookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      )) as { principal: { id: string } };
      const cookie = await login(app, `${name}@example.test`);
      await ok(call(app, cookie, '/profile'));
      people.push({ id: made.principal.id, cookie, space: await personalSpace(made.principal.id) });
    }
    [dana, erin] = people as [Person, Person];
  }, 60_000);

  test('none before setup is done, then six, ready to edit, with the city filled in', async () => {
    expect(await starters(dana)).toEqual({ show: false, reason: 'not_onboarded', starters: [] });
    await ok(call(app, dana.cookie, '/profile', 'PATCH', profile(true)));
    const offered = await starters(dana);
    expect(offered.show).toBe(true);
    expect(offered.reason).toBeNull();
    expect(offered.starters.map((starter) => starter.id)).toEqual([
      'coffee-nearby',
      'stretch-reminder',
      'tech-news-pdf',
      'facts-from-file',
      'watch-page',
      'budget-trip',
    ]);
    const coffee = offered.starters[0];
    expect(coffee?.text).toBe(
      'Find 3 well-reviewed coffee shops near Chicago and put them in a short list.',
    );
    expect(coffee?.text.slice(coffee.select?.start, coffee.select?.end)).toBe('Chicago');
    const trip = offered.starters.at(-1);
    expect(trip?.text).toBe('Plan a 3-day trip to a city on a budget.');
    expect(trip?.text.slice(trip.select?.start, trip.select?.end)).toBe('a city');
    // Nothing is sent for her: offering starters starts no chat.
    const [chats] = await database().sql`select count(*)::int as n from job
      where principal_id = ${dana.id} and kind = 'chat'`;
    expect(Number(chats?.n)).toBe(0);
  });

  test('they go once she has three chats', async () => {
    for (const title of ['One', 'Two']) await job(dana.space, dana.id, title);
    expect((await starters(dana)).show).toBe(true);
    await job(dana.space, dana.id, 'Three');
    expect(await starters(dana)).toEqual({ show: false, reason: 'has_chats', starters: [] });
  });

  test('put away, they stay away for that person on every device, and only for them', async () => {
    await ok(call(app, erin.cookie, '/profile', 'PATCH', profile(true, 'UTC')));
    const before = await starters(erin);
    expect(before.show).toBe(true);
    // No city in UTC: the blank asks for one.
    expect(before.starters[0]?.text).toContain('near your city');
    expect(await ok(call(app, erin.cookie, '/starters/dismiss', 'POST'))).toEqual({
      status: 'ok',
    });
    // Twice is the same as once.
    await ok(call(app, erin.cookie, '/starters/dismiss', 'POST'));
    expect(await starters(erin)).toEqual({ show: false, reason: 'dismissed', starters: [] });
    // Another sign-in, as from another device.
    const elsewhere = { ...erin, cookie: await login(app, 'erin@example.test') };
    expect((await starters(elsewhere)).reason).toBe('dismissed');
    const [kept] = await database().sql`select count(*)::int as n from starter_dismissal
      where principal_id = ${erin.id}`;
    expect(Number(kept?.n)).toBe(1);
    // Dana's own answer is unchanged by Erin's choice.
    expect((await starters(dana)).reason).toBe('has_chats');
  });

  test('an operator’s own list replaces the built-in one', async () => {
    const custom = createApp({
      env: loadEnv({
        NODE_ENV: 'test',
        MELETE_SPACES_DIR: join(directory, 'spaces'),
        MELETE_WORK_DIR: join(directory, 'work'),
        MELETE_PUBLIC_URL: 'https://melete.example',
        MELETE_STARTERS: JSON.stringify([
          {
            id: 'weather',
            label: 'Weekend weather',
            text: 'What will the weather be like in {city} this weekend?',
            icon: 'sparkles',
            capability: 'research',
          },
        ]),
      }),
      db: database().db,
      sql: database().sql,
      registry: new ConnectorRegistry(),
      checkDatabase: async () => 'ok',
    });
    const fresh = await login(custom, 'dana@example.test');
    await database().sql`delete from job where principal_id = ${dana.id} and kind = 'chat'`;
    const offered = startersResponse.parse(await ok(call(custom, fresh, '/starters')));
    const text = 'What will the weather be like in Chicago this weekend?';
    const start = text.indexOf('Chicago');
    expect(offered.starters).toEqual([
      {
        id: 'weather',
        label: 'Weekend weather',
        icon: 'sparkles',
        capability: 'research',
        text,
        select: { start, end: start + 'Chicago'.length },
      },
    ]);
  });
});
