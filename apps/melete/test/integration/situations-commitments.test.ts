/**
 * The urgent path through the product: a commitment the person takes up in
 * Melete ("Handle it") becomes a deadline Melete keeps, looked at a day before
 * and again fifteen minutes before it is due. Still open at that last look, it
 * reaches the person's phone at once, even in their quiet hours. The same
 * commitment taken up by an outside assistant over MCP stays one Melete found:
 * on Home, never urgent.
 *
 * Signs in, scans the demonstration mailbox, and presses the button over the
 * real route; the clock runs on a time the test moves.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushPayload } from '@melete/contracts';
import { fixtureMessages } from '../../src/companies/fixtures.ts';
import { PLAYBOOK_FOR_KIND } from '../../src/companies/handle.ts';
import { fixtureMailbox } from '../../src/companies/mailbox.ts';
import { PostgresCompanyStore } from '../../src/companies/repository.ts';
import { scriptedExtractor } from '../../src/companies/scripted.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { actorEnvironment } from '../../src/mcp-server/actor.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { isQuiet } from '../../src/push/policy.ts';
import { PushService } from '../../src/push/service.ts';
import { decryptPayload, generateVapidKeys, toBase64Url } from '../../src/push/webpush.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { localDate, localInstant, spokenDate } from '../../src/situations/detectors.ts';
import { SituationService } from '../../src/situations/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'commitments-fixture-key-32-bytes!!' })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-commitments-'));
const MINUTE = 60_000;
let clock = Date.now();

const delivered: Array<ReturnType<typeof pushPayload.parse>> = [];
let phone: { endpoint: string; publicKey: string; privateKey: string; auth: string } | null = null;
const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
  if (!phone) return new Response(null, { status: 404 });
  const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
  const plain = await decryptPayload(body, phone);
  delivered.push(pushPayload.parse(JSON.parse(new TextDecoder().decode(plain))));
  return new Response(null, { status: 201 });
}) as typeof fetch;
let push: PushService | null = null;

const situations =
  jobs && triggers
    ? new SituationService({
        jobs,
        triggers,
        now: () => clock,
        notify: async (principalId) => push?.dispatch(principalId, new Date(clock)),
      })
    : null;
const app =
  handle && jobs && triggers && situations
    ? createApp({
        db: handle.db,
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
        sql: handle.sql,
        jobs,
        triggers,
        situations,
        checkDatabase: async () => 'ok',
        companies: {
          store: new PostgresCompanyStore(handle.db),
          mailbox: () => fixtureMailbox(fixtureMessages()),
          extractor: scriptedExtractor(),
          schedule: (work) => work(),
        },
      })
    : null;
const withDb = app ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

let cookie = '';
let spaceId = '';
let personId = '';
let items: string[] = [];
let spare = '';
const at = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;

/** The person's day, written to their profile and read back, so the test stands on it. */
async function profile(start: string, end: string, timeZone: string) {
  const { sql } = required(handle);
  await sql`insert into experience_profile (space_id, day_start, day_end, time_zone)
    values (${spaceId}, ${start}, ${end}, ${timeZone})
    on conflict (space_id) do update set day_start = excluded.day_start,
      day_end = excluded.day_end, time_zone = excluded.time_zone`;
  const [row] = await sql`select day_start, day_end, time_zone from experience_profile
    where space_id = ${spaceId}`;
  expect([row?.day_start, row?.day_end, row?.time_zone]).toEqual([start, end, timeZone]);
}

const call = (path: string, method = 'GET') =>
  required(app).request(path, { method, headers: { Cookie: cookie } });

withDb('a commitment taken up in Melete', () => {
  beforeAll(async () => {
    const setup = await required(app).request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'keeper@example.test', password: 'a-long-enough-password' }),
    });
    expect(setup.status).toBe(201);
    cookie =
      setup.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0] ?? '')
        .find((entry) => entry.startsWith('melete_session=')) ?? '';
    const spaces = (await (await call('/spaces')).json()) as {
      spaces: { id: string; kind: string }[];
    };
    spaceId = spaces.spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
    expect((await call(`/spaces/${spaceId}/companies/scan`, 'POST')).status).toBe(202);
    const { sql } = required(handle);
    const [who] = await sql`select id from owner limit 1`;
    personId = String(who?.id);
    // Four open commitments the product can handle (each kind has a playbook),
    // the first two due three hours from now, and one more it found.
    const found = await sql`select id from ledger_item where space_id = ${spaceId}
      and status = 'found' and kind in ${sql(Object.keys(PLAYBOOK_FOR_KIND))} order by id limit 4`;
    items = found.map((row) => String(row.id));
    expect(items).toHaveLength(4);
    const [other] = await sql`select id from ledger_item where space_id = ${spaceId}
      and status = 'found' and id not in ${sql(items)} order by id limit 1`;
    spare = String(required(other).id);
    await sql`update ledger_item set due_at = ${new Date(clock + 180 * MINUTE).toISOString()}::timestamptz,
        due_date_only = false
      where id in ${sql(items.slice(0, 2))}`;
    // Quiet now and at the last look (2 h 45 m on): their day starts five hours from now.
    const hour = new Date(clock).getUTCHours();
    await profile(at(hour + 5), at(hour + 7), 'UTC');
    // A phone to reach them on.
    const keys = await generateVapidKeys();
    phone = {
      endpoint: 'https://push.example.test/keeper',
      ...keys,
      auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
    await sql`insert into push_subscription (id, principal_id, endpoint, p256dh, auth)
      values (${newId('psub')}, ${personId}, ${phone.endpoint}, ${phone.publicKey}, ${phone.auth})`;
    push = new PushService(required(handle).db, {
      keys: await generateVapidKeys(),
      subject: 'mailto:owner@example.test',
      extraOrigins: ['https://push.example.test'],
      fetcher,
    });
  }, 120_000);

  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  const clockOf = async (item: string) => {
    const [row] = await required(handle).sql`select * from clock
      where subject_key = ${`ledger:${item}`} and state in ('armed', 'checking')`;
    return row;
  };
  const raisedOn = (item: string) =>
    required(handle).sql`select * from situation where subject_key = ${`ledger:${item}`}`;

  test('pressed by the person, it reaches them fifteen minutes before it is due, even in quiet hours', async () => {
    const [mine] = items;
    const pressed = await call(`/ledger/${mine}/handle?space_id=${spaceId}`, 'POST');
    expect(pressed.status).toBe(201);
    const kept = await clockOf(String(mine));
    expect(kept?.person_set).toBe(true);
    // Due in three hours: the day-before look has passed, so the next is fifteen minutes before.
    expect(kept?.lead_s).toBe(15 * 60);
    expect(new Date(kept?.fire_at).getTime()).toBe(clock + 165 * MINUTE);
    clock += 165 * MINUTE;
    // Their quiet hours, by the profile the push service reads.
    const [day] = await required(handle).sql`select day_start, day_end, time_zone
      from experience_profile where space_id = ${spaceId}`;
    expect(
      isQuiet(new Date(clock), {
        start: String(day?.day_start),
        end: String(day?.day_end),
        timeZone: String(day?.time_zone),
      }),
    ).toBe(true);
    const before = delivered.length;
    await required(situations).sweep();
    const [raised] = await raisedOn(String(mine));
    expect(raised?.urgency).toBe('urgent');
    expect(raised?.person_set).toBe(true);
    const told = delivered.slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]?.because).toBe('Because you asked Melete to keep this deadline.');
    expect(told[0]?.ack).toBe(`/situations/${raised?.id}/ack`);
    clock -= 165 * MINUTE;
  }, 60_000);

  test('pressed by an outside assistant, it stays one Melete found: on Home, never urgent', async () => {
    const [, theirs] = items;
    const actor = {
      principalId: personId,
      spaceId,
      membershipGeneration: null,
      clientId: 'assistant-fixture',
      clientName: 'An assistant',
    };
    const pressed = await principalContext.run(personId, () =>
      required(app).request(
        `/ledger/${theirs}/handle?space_id=${spaceId}`,
        { method: 'POST' },
        actorEnvironment(actor),
      ),
    );
    expect([pressed.status, pressed.status === 201 ? null : await pressed.text()]).toEqual([
      201,
      null,
    ]);
    clock += 165 * MINUTE;
    const before = delivered.length;
    await required(situations).sweep();
    const raised = await raisedOn(String(theirs));
    expect(raised.map((row) => [row.urgency, row.person_set])).toEqual([['normal', false]]);
    expect(delivered.slice(before)).toHaveLength(0);
  }, 60_000);
  const press = (item: string, assistant = false) =>
    assistant
      ? principalContext.run(personId, () =>
          required(app).request(
            `/ledger/${item}/handle?space_id=${spaceId}`,
            { method: 'POST' },
            actorEnvironment({
              principalId: personId,
              spaceId,
              membershipGeneration: null,
              clientId: 'assistant-fixture',
              clientName: 'An assistant',
            }),
          ),
        )
      : call(`/ledger/${item}/handle?space_id=${spaceId}`, 'POST');

  test('a commitment due on a date is due at the end of that working day, looked at only inside the person’s day, and never urgent', async () => {
    const zone = 'America/Los_Angeles';
    await profile('08:00', '22:00', zone);
    const item = String(items[2]);
    // Due on a date three days from now, as most commitments found in mail are.
    const date = localDate(clock + 3 * 86_400_000, zone);
    await required(handle)
      .sql`update ledger_item set due_at = ${`${date}T00:00:00.000Z`}::timestamptz,
        due_date_only = true where id = ${item}`;
    expect([200, 201]).toContain((await press(item)).status);
    const hourThere = (instant: number) =>
      Number(
        new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          hourCycle: 'h23',
          timeZone: zone,
        }).format(instant),
      );
    const kept = await clockOf(item);
    const due = localInstant(date, '17:00', zone);
    expect(new Date(kept?.due_at).getTime()).toBe(due);
    const saved = clock;
    const before = delivered.length;
    const looks: number[] = [];
    for (let look = 0; look < 3; look++) {
      const next = await clockOf(item);
      if (!next) break;
      const fire = new Date(next.fire_at).getTime();
      looks.push(fire);
      clock = fire;
      await required(situations).sweep();
    }
    clock = saved;
    // The day before at 5:00 PM, and the morning of the day at 8:00 AM: both inside their day.
    expect(looks).toEqual([due - 86_400_000, localInstant(date, '08:00', zone)]);
    for (const fire of looks) expect(hourThere(fire)).toBeGreaterThanOrEqual(8);
    for (const fire of looks) expect(hourThere(fire)).toBeLessThan(22);
    const raised = await raisedOn(item);
    expect(raised.map((row) => row.urgency)).toEqual(['soon']);
    expect(String(raised[0]?.reason)).toContain(`Due ${spokenDate(date)}`);
    // Nothing was pushed at once: a date is not a time to break someone's quiet for.
    expect(delivered.slice(before)).toHaveLength(0);
  }, 60_000);

  test('pressing Handle it again moves the deadline to the date the item has now, and keeps it the person’s', async () => {
    await profile(
      at(new Date(clock).getUTCHours() + 2),
      at(new Date(clock).getUTCHours() + 4),
      'UTC',
    );
    const item = String(items[3]);
    const { sql } = required(handle);
    await sql`update ledger_item set due_at = ${new Date(clock + 300 * MINUTE).toISOString()}::timestamptz,
        due_date_only = false where id = ${item}`;
    expect((await press(item, true)).status).toBe(201);
    expect((await clockOf(item))?.person_set).toBe(false);
    // The date moved; the person presses it themselves.
    await sql`update ledger_item set due_at = ${new Date(clock + 360 * MINUTE).toISOString()}::timestamptz
      where id = ${item}`;
    expect((await press(item)).status).toBe(200);
    const moved = await clockOf(item);
    expect([moved?.person_set, new Date(moved?.due_at).getTime(), moved?.lead_s]).toEqual([
      true,
      clock + 360 * MINUTE,
      15 * 60,
    ]);
    // An assistant pressing after them does not take it back.
    expect((await press(item, true)).status).toBe(200);
    expect((await clockOf(item))?.person_set).toBe(true);
  }, 60_000);

  test('a rescan that moves a commitment moves its clock, and one that removes it clears it', async () => {
    const { sql } = required(handle);
    const first = clock + 2 * 86_400_000;
    await sql`update ledger_item set due_at = ${new Date(first).toISOString()}::timestamptz,
        due_date_only = false where id = ${spare}`;
    await required(situations).sweep();
    expect(new Date((await clockOf(spare))?.due_at).getTime()).toBe(first);
    const second = clock + 3 * 86_400_000;
    await sql`update ledger_item set due_at = ${new Date(second).toISOString()}::timestamptz
      where id = ${spare}`;
    await required(situations).sweep();
    const live = await sql`select due_at from clock where subject_key = ${`ledger:${spare}`}
      and state in ('armed', 'checking')`;
    expect(live.map((row) => new Date(row.due_at).getTime())).toEqual([second]);
    await sql`delete from ledger_item where id = ${spare}`;
    await required(situations).sweep();
    expect(await clockOf(spare)).toBeUndefined();
    const [cleared] = await sql`select state from clock where subject_key = ${`ledger:${spare}`}`;
    expect(cleared?.state).toBe('cleared');
  }, 60_000);
  test('a look at a date-only commitment that would fall outside the person’s day waits for the morning', async () => {
    // A day that ends at 3:00 PM: the day-before look at 5:00 PM would be in their quiet hours.
    const zone = 'America/Los_Angeles';
    await profile('07:00', '15:00', zone);
    const item = String(items[1]);
    const date = localDate(clock + 4 * 86_400_000, zone);
    await required(handle)
      .sql`update ledger_item set due_at = ${`${date}T00:00:00.000Z`}::timestamptz,
        due_date_only = true where id = ${item}`;
    expect((await press(item, true)).status).toBe(200);
    const kept = await clockOf(item);
    expect(new Date(kept?.fire_at).getTime()).toBe(localInstant(date, '07:00', zone));
  }, 60_000);
});
