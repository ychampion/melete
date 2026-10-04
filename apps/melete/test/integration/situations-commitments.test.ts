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
import { PushService } from '../../src/push/service.ts';
import { decryptPayload, generateVapidKeys, toBase64Url } from '../../src/push/webpush.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
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
    // Two open commitments, each due three hours from now.
    // Two the product can handle: each kind has a playbook.
    const found = await sql`select id from ledger_item where space_id = ${spaceId}
      and status = 'found' and kind in ${sql(Object.keys(PLAYBOOK_FOR_KIND))} order by id limit 2`;
    items = found.map((row) => String(row.id));
    expect(items).toHaveLength(2);
    await sql`update ledger_item set due_at = ${new Date(clock + 180 * MINUTE).toISOString()}::timestamptz,
        due_date_only = false
      where id in ${sql(items)}`;
    // Quiet now: their day is two hours from now until four hours from now.
    const hour = new Date(clock).getUTCHours();
    const at = (h: number) => `${String((hour + h) % 24).padStart(2, '0')}:00`;
    await sql`update experience_profile set day_start = ${at(2)}, day_end = ${at(4)}, time_zone = 'UTC'
      where space_id = ${spaceId}`;
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
});
