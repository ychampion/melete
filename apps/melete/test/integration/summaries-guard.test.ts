/**
 * "Show me only what needs me" held in code, end to end on Postgres. A room's
 * maker connects her mailbox; another person in the room asks the room's agent
 * what she needs. Whatever the model writes, the details of her mail (who
 * wrote, the doctor, the medicine, the numbers, a subject said word for word)
 * never reach that person: not in the answer, its cards and receipts, the
 * board, or the live stream. The model itself reads them as placeholders. The
 * maker reads everything as before.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BoardItem,
  boardList,
  type CapabilityClaims,
  type JsonObject,
  type RoomStreamFrame,
  roomDetail,
  roomMessageResponse,
  roomThreadView,
} from '@melete/contracts';
import { signCapability } from '../../src/broker/capability.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import {
  createModelGateway,
  type GatewayBudget,
  type GatewayPrincipal,
  providersFromEnv,
} from '../../src/gateway/index.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { KEPT_WHERE } from '../../src/rooms/projection.ts';
import { roomHandle } from '../../src/rooms/transcript.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import {
  EMPTY_ORIGINALS,
  guardFor,
  minimise,
  minimiserFor,
  scrub,
  stepRefusal,
  summariesMinimiser,
  withSummaryStepCheck,
} from '../../src/spaces/summary-guard.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-summaries-guard-'));
const registry = new ConnectorRegistry();
const SIGNING_KEY = 'summaries-guard-signing-key-32-bytes!';
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: SIGNING_KEY,
      liveConnectionScopes: true,
    })
  : null;
const broker = handle ? new BrokerService({ sql: handle.sql, connectors: registry }) : null;
const app =
  handle && jobs && runner && broker
    ? createApp({
        env: loadEnv({
          MELETE_PREVIEW_MULTIPLAYER: 'true',
          NODE_ENV: 'test',
          MELETE_SPACES_DIR: directory,
        }),
        db: handle.db,
        sql: handle.sql,
        jobs,
        runner,
        broker,
        registry,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';

function database() {
  if (!handle || !queue || !app || !jobs || !runner || !broker)
    throw new Error('Postgres unavailable');
  return { ...handle, app, jobs, runner, broker };
}
function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}
async function send(cookie: string, path: string, method = 'GET', body?: unknown) {
  return database().app.request(path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answered = await response;
  const text = await answered.text();
  expect([answered.status, text.slice(0, 300)]).toEqual([status, text.slice(0, 300)]);
  return JSON.parse(text) as T;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const suffix = () => randomBytes(13).toString('hex').toUpperCase().slice(0, 25);
const submission = () => `s${randomBytes(8).toString('hex')}`;

/** What the room's search of the maker's mailbox brought back, as the email connector records it. */
const SEARCH: JsonObject = {
  messages: [
    {
      uid: 41,
      message_id: '<a41@okafor-clinic.example>',
      from: 'Dr. Wendell Okafor <frontdesk@okafor-clinic.example>',
      to: 'Odile Varga <odile@example.test>',
      subject: 'Your visit with Dr. Okafor on Tuesday, November 18 at 2:15 PM',
      text: 'Hi Odile, this confirms your follow-up with Dr. Wendell Okafor at Larkspur Family Medicine, 1200 Larch Street, Fairview, CA 94110. Questions? Call 555-0188.',
    },
    {
      uid: 42,
      from: 'Fairview Pharmacy <rx@fairview-pharmacy.example>',
      to: 'odile@example.test',
      subject: 'Refill reminder: lisinopril 10 mg due Nov 5 (no refills left)',
      text: 'Your prescription for lisinopril 10 mg (Rx 5512093) is due for refill on Nov 5. Prescriber: Wendell Okafor.',
    },
    {
      uid: 43,
      from: 'Brightfield Health Plans <notices@brightfield.example>',
      to: 'odile@example.test',
      subject: 'Your 2027 Annual Notice of Changes',
      text: 'Your plan changes on January 1, 2027. Your monthly premium will go from $0 to $12.40.',
    },
  ],
};
const PRIVATE = [
  'Okafor',
  'Wendell',
  'okafor-clinic.example',
  'fairview-pharmacy.example',
  'lisinopril',
  '5512093',
  '555-0188',
  'Brightfield',
  'Larkspur',
  '1200 Larch Street',
];
const SUBJECT = 'Annual Notice of Changes';
const leaks = (text: string, among = [...PRIVATE, SUBJECT]) =>
  among.filter((value) => text.toLowerCase().includes(value.toLowerCase()));

/** The answer a model that ignores its instructions writes. */
const LEAKY_ANSWER =
  'Mom sees Dr. Wendell Okafor next Tuesday at 2:15 PM. Her lisinopril refill is due Nov 5 (Rx 5512093), so call 555-0188. She also got the 2027 Annual Notice of Changes from Brightfield: the premium goes to $12.40.';

type Person = { id: string; cookie: string };
let maker: Person;
let helper: Person;
let roomId = '';
let mailId = '';

async function makeRoom() {
  const made = roomDetail.parse(
    await ok(send(maker.cookie, '/rooms', 'POST', { name: 'Mail for Mom' }), 201),
  );
  const id = made.room.id;
  await ok(send(maker.cookie, `/rooms/${id}/members`, 'POST', { principal_id: helper.id }), 201);
  await ok(send(maker.cookie, `/spaces/${id}/summaries-only`, 'PUT', { on: true }));
  return id;
}
async function claimJob(jobId: string) {
  const { sql, runner } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  const claimed = await runner.claim({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
  if (!claimed) throw new Error(`Request ${jobId} could not be claimed`);
  return claimed.claims as CapabilityClaims;
}
async function request(person: Person, text: string) {
  const opened = roomMessageResponse.parse(
    await ok(
      send(person.cookie, `/rooms/${roomId}/threads`, 'POST', {
        text,
        submission_id: submission(),
      }),
      201,
    ),
  );
  const jobId = opened.request_job_id ?? '';
  return { jobId, threadId: opened.thread.id, claims: await claimJob(jobId) };
}
/** A step of the request, recorded as its connector recorded it. */
async function step(
  claims: CapabilityClaims,
  kind: string,
  payload: JsonObject,
  detail: JsonObject,
  effect = 'read',
) {
  const id = `act_0${suffix()}`;
  const body = JSON.stringify(payload);
  await database()
    .sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
      canonical_payload, payload_hash, status, idempotency_key, receipt, resolved_at)
    values (${id}, ${claims.job_id}, ${claims.attempt_id}, ${mailId}, ${kind}, ${effect},
      ${body}::jsonb, ${hash(body)}, 'succeeded', ${id},
      ${JSON.stringify({ action_id: id, detail })}::jsonb, now())`;
  return id;
}
/** The model's answer to the request, as the runner leaves it once the turn ends. */
async function answered(jobId: string, answer: string, status = 'done') {
  await database()
    .sql`update experience_turn set answer = ${answer}, status = ${status} where job_id = ${jobId}`;
}
async function turnOf(jobId: string) {
  const [row] = await database().sql`select id from experience_turn where job_id = ${jobId}`;
  return String(row?.id);
}
/** One piece of the answer as it streamed. */
let pieces = 0;
async function streamed(jobId: string, turnId: string, text: string) {
  pieces += 1;
  const payload = {
    kind: 'experience',
    turn_id: turnId,
    at: new Date().toISOString(),
    item: { type: 'text_delta', text },
  };
  await database().sql`insert into event (job_id, type, payload, dedup_key)
    values (${jobId}, 'notice', ${JSON.stringify(payload)}::jsonb, ${`experience:guard:${pieces}`})`;
}
async function boardConnection() {
  const [row] = await database().sql`select id from connection
    where space_id = ${roomId} and provider = 'board' and status = 'active'`;
  return String(row?.id);
}
async function thread(person: Person, threadId: string) {
  return roomThreadView.parse(
    await ok(send(person.cookie, `/rooms/${roomId}/threads/${threadId}`)),
  );
}
async function frames(person: Person, threadId: string) {
  return (
    await ok<{ frames: RoomStreamFrame[] }>(
      send(person.cookie, `/rooms/${roomId}/threads/${threadId}/events?after=0`),
    )
  ).frames;
}
async function board(person: Person) {
  return boardList.parse(await ok(send(person.cookie, `/rooms/${roomId}/board`))).items;
}

withDb('summaries only, held in code', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  beforeAll(async () => {
    const { app } = database();
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'odile@example.test', password }),
    });
    expect(setup.status).toBe(201);
    maker = {
      id: ((await setup.json()) as { owner: { id: string } }).owner.id,
      cookie: sessionCookie(setup),
    };
    const made = await ok<{ principal: { id: string } }>(
      send(maker.cookie, '/principals', 'POST', { email: 'theo@example.test', password }),
      201,
    );
    const login = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'theo@example.test', password }),
    });
    helper = { id: made.principal.id, cookie: sessionCookie(login) };
    await ok(send(maker.cookie, '/me', 'PATCH', { display_name: 'Odile' }));
    await ok(send(helper.cookie, '/me', 'PATCH', { display_name: 'Theo' }));
    roomId = await makeRoom();
    mailId = `con_0${suffix()}`;
    await database()
      .sql`insert into connection (id, space_id, provider, label, scopes, configuration, shared_use)
      values (${mailId}, ${roomId}, 'imap', 'Odile’s mail', '["email.search"]'::jsonb,
        '{"from":"odile@example.test"}'::jsonb, 'room')`;
  }, 60_000);

  test('the helper’s answer, cards and receipts keep the mail’s details out; the maker’s do not', async () => {
    const { claims, jobId, threadId } = await request(
      helper,
      '@Melete What does Mom need from us this week?',
    );
    await step(claims, 'email.search', { query: 'newer_than:14d', limit: 10 }, SEARCH);
    // A step the agent made itself keeps its own title, and is checked like its answer.
    await step(
      claims,
      'calendar.create',
      {
        summary: 'Visit with Dr. Wendell Okafor',
        start: '2026-11-18T14:15:00-08:00',
        end: '2026-11-18T15:00:00-08:00',
        location: '1200 Larch Street, Fairview, CA 94110',
      },
      { event_id: 'evt-1' },
      'write',
    );
    await answered(jobId, LEAKY_ANSWER);

    const seen = await thread(helper, threadId);
    const asked = seen.requests.find((entry) => entry.job_id === jobId);
    const answer = asked?.turns.at(-1)?.answer ?? '';
    expect(leaks(answer)).toEqual([]);
    expect(answer).toBe(
      'Mom sees the doctor next Tuesday at 2:15 PM. Her medicine refill is due Nov 5 (Rx kept back), so call a phone number. She also got the message from the health plan: the premium goes to $12.40.',
    );
    expect(leaks(JSON.stringify(asked?.cards))).toEqual([]);
    expect(leaks(JSON.stringify(asked?.receipts))).toEqual([]);
    const kept = asked?.receipts.find((receipt) => receipt.where === KEPT_WHERE);
    expect(kept?.what).toMatch(/^Kept \d+ private details out of this request$/);

    // The maker reads her own mail's details as the agent wrote them, with no such receipt.
    const own = (await thread(maker, threadId)).requests.find((entry) => entry.job_id === jobId);
    expect(own?.turns.at(-1)?.answer).toBe(LEAKY_ANSWER);
    expect(JSON.stringify(own?.cards)).toContain('Okafor');
    expect(own?.receipts.some((receipt) => receipt.where === KEPT_WHERE)).toBe(false);
  });

  test('the live stream sends the helper each answer whole and checked, even cut across a name', async () => {
    const { claims, jobId, threadId } = await request(helper, '@Melete Anything from the clinic?');
    await step(claims, 'email.search', { query: 'clinic', limit: 5 }, SEARCH);
    const turnId = await turnOf(jobId);
    await answered(jobId, '', 'streaming');
    await streamed(jobId, turnId, 'Dr. Wendell Oka');
    await streamed(jobId, turnId, 'for wrote about the visit. Her lisino');
    // While the turn writes, the word under way waits for the rest of it.
    const writing = (await frames(helper, threadId)).filter(
      (frame) => frame.kind === 'request' && frame.request_job_id === jobId,
    );
    const texts = writing.flatMap((frame) =>
      frame.kind === 'request' && frame.event.item.type === 'text_delta' ? [frame.event.item] : [],
    );
    expect(texts).toEqual([
      { type: 'text_delta', text: 'The doctor wrote about the visit. Her ', restart: true },
    ]);
    await streamed(jobId, turnId, 'pril refill is due.');
    await answered(
      jobId,
      'Dr. Wendell Okafor wrote about the visit. Her lisinopril refill is due.',
    );
    const done = (await frames(helper, threadId)).flatMap((frame) =>
      frame.kind === 'request' && frame.event.item.type === 'text_delta' ? [frame.event.item] : [],
    );
    expect(done).toEqual([
      {
        type: 'text_delta',
        text: 'The doctor wrote about the visit. Her medicine refill is due.',
        restart: true,
      },
    ]);
    // The maker's stream is the stream as it was written.
    const own = (await frames(maker, threadId)).flatMap((frame) =>
      frame.kind === 'request' && frame.event.item.type === 'text_delta'
        ? [frame.event.item.text]
        : [],
    );
    expect(own.join('')).toBe(
      'Dr. Wendell Okafor wrote about the visit. Her lisinopril refill is due.',
    );
  });

  test('what the agent puts on the board is checked for the helper, and read as written by the maker', async () => {
    const { claims } = await request(helper, '@Melete Put the refill on the board.');
    await step(claims, 'email.search', { query: 'refill', limit: 5 }, SEARCH);
    const proposed = await database().broker.propose(claims, {
      connection_id: await boardConnection(),
      kind: 'board.add',
      payload: {
        kind: 'task',
        title: 'Call Dr. Okafor about lisinopril',
        detail: 'Rx 5512093 has no refills left; Fairview Pharmacy is at 555-0188.',
        due_at: '2026-11-05T17:00:00Z',
        visibility: 'everyone',
      },
    });
    expect(proposed.requires_approval).toBe(false);
    const mine = (items: BoardItem[]) =>
      items.find((item) => item.title.startsWith('Call ')) as BoardItem;
    const shown = mine(await board(helper));
    expect(leaks(`${shown.title} ${shown.detail}`)).toEqual([]);
    expect(shown.title).toBe('Call the doctor about a medicine');
    expect(shown.detail).toBe(
      'Rx kept back has no refills left; the pharmacy is at a phone number.',
    );
    // The dates and the kind of task are what the helper needs, and they stay.
    expect(shown.due_at).toBe('2026-11-05T17:00:00.000Z');
    const own = mine(await board(maker));
    expect(own.title).toBe('Call Dr. Okafor about lisinopril');
    // The same holds on the page of every room the helper is in.
    const across = boardList.parse(await ok(send(helper.cookie, '/board'))).items;
    expect(leaks(JSON.stringify(across))).toEqual([]);
    // And on the helper's phone, when a note is put on the board for them.
    await database().sql`insert into push_subscription (id, principal_id, endpoint, p256dh, auth)
      values (${`psub_${suffix()}`}, ${helper.id}, ${`https://push.example/${suffix()}`}, 'key', 'auth')`;
    const noted = await database().broker.propose(claims, {
      connection_id: await boardConnection(),
      kind: 'board.note',
      payload: {
        title: 'Ask Dr. Okafor to renew the lisinopril',
        assignee: roomHandle(roomId, helper.id),
      },
    });
    expect(noted.requires_approval).toBe(false);
    const pushed = await database()
      .sql`select body from push_intent where principal_id = ${helper.id} and kind = 'decision'`;
    expect(pushed.map((row) => String(row.body))).toEqual(['Ask the doctor to renew the medicine']);
  });

  test('what the model reads for the helper carries the details only as placeholders', async () => {
    const { jobId } = await request(helper, '@Melete Who wrote to Mom?');
    // The request has read nothing itself: the room's earlier reads of the
    // mailbox are what its details come from, whichever request made them.
    expect(await minimiserFor(database().db, jobId)).not.toBeNull();
    const sent: string[] = [];
    const budget: GatewayBudget = {
      reserve: async () => ({ id: 'reserved' }),
      settle: async () => {},
    };
    const principal = (id: string): GatewayPrincipal => ({
      privacy: { kind: 'job' },
      jobId: id,
      attemptId: 'attempt-guard',
      epoch: 1,
      revision: 1,
      maxRequests: 10,
      maxTokens: 20_000,
      allowedModels: [{ provider: 'openai', model: 'fixture-chat' }],
    });
    let current = jobId;
    const server = createModelGateway({
      privacy: false,
      authenticate: async () => principal(current),
      budget,
      providers: providersFromEnv({ OPENAI_API_KEY: 'guard-openai-secret' }),
      defaultProvider: 'openai',
      minimise: summariesMinimiser(database().db),
      fetch: async (outbound) => {
        sent.push(await outbound.text());
        return Response.json({
          model: 'fixture-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
      onError: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const ask = () =>
      fetch(`http://127.0.0.1:${address.port}/providers/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-test',
          'x-melete-capability': 'attempt-capability',
        },
        body: JSON.stringify({
          model: 'fixture-chat',
          max_tokens: 50,
          messages: [
            { role: 'user', content: 'Who wrote to Mom? Was it Dr. Okafor?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'email_search', arguments: '{"query":"newer_than:14d"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify(SEARCH) },
          ],
        }),
      });
    try {
      expect((await ask()).status).toBe(200);
      const helperBody = sent.at(-1) ?? '';
      expect(leaks(helperBody, PRIVATE)).toEqual([]);
      for (const placeholder of ['[doctor 1]', '[medicine 1]', '[pharmacy 1]', '[phone number'])
        expect(helperBody).toContain(placeholder);
      for (const stays of ['Nov 5', '$12.40', 'Tuesday, November 18'])
        expect(helperBody).toContain(stays);

      // The maker's own request goes as it was written.
      const own = await request(maker, '@Melete Who wrote to me?');
      expect(await minimiserFor(database().db, own.jobId)).toBeNull();
      current = own.jobId;
      expect((await ask()).status).toBe(200);
      expect(sent.at(-1)).toContain('Okafor');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a read that finishes after a later one is still taken in', async () => {
    const { claims } = await request(helper, '@Melete Anything new from the cardiologist?');
    const later: JsonObject = {
      messages: [
        {
          uid: 61,
          from: 'Dr. Imani Castellanos <office@castellanos-heart.example>',
          to: 'odile@example.test',
          subject: 'Your echo results are in',
          text: 'Dr. Imani Castellanos reviewed the echo.',
        },
      ],
    };
    const sooner: JsonObject = {
      messages: [
        {
          uid: 62,
          from: 'Dr. Petra Lindqvist <desk@lindqvist-eyes.example>',
          to: 'odile@example.test',
          subject: 'Your eye exam',
          text: 'Dr. Petra Lindqvist will see you on Thursday.',
        },
      ],
    };
    // The first read starts, and is still out when a second one finishes.
    const first = `act_0${suffix()}`;
    const body = JSON.stringify({ query: 'cardiology' });
    await database()
      .sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, status, idempotency_key, created_at)
      values (${first}, ${claims.job_id}, ${claims.attempt_id}, ${mailId}, 'email.search', 'read',
        ${body}::jsonb, ${hash(body)}, 'dispatched', ${first}, now() - interval '1 minute')`;
    await step(claims, 'email.search', { query: 'eyes' }, sooner);
    const before = await guardFor(database().db, roomId, helper.id);
    expect(scrub('Dr. Petra Lindqvist wrote.', before ?? EMPTY_ORIGINALS).text).toBe(
      'The doctor wrote.',
    );
    expect(scrub('Dr. Imani Castellanos wrote.', before ?? EMPTY_ORIGINALS).kept).toBe(0);
    // It finishes later than the second, yet older: it is taken in all the same.
    await database().sql`update action set status = 'succeeded', resolved_at = now(),
      receipt = ${JSON.stringify({ action_id: first, detail: later })}::jsonb where id = ${first}`;
    const after = await guardFor(database().db, roomId, helper.id);
    expect(scrub('Dr. Imani Castellanos reviewed the echo.', after ?? EMPTY_ORIGINALS).text).toBe(
      'The doctor reviewed the echo.',
    );
    expect(await minimiserFor(database().db, claims.job_id)).not.toBeNull();
    expect(
      minimise(
        'Castellanos',
        (await minimiserFor(database().db, claims.job_id)) ?? EMPTY_ORIGINALS,
      ),
    ).toMatch(/^\[doctor \d+\]$/);
  });

  test('a step that would carry a placeholder out of the room is refused, and nothing is written', async () => {
    const reached: string[] = [];
    const check = withSummaryStepCheck(
      async (forwarded) => {
        reached.push(`${new URL(forwarded.url).pathname} ${await forwarded.text()}`);
        return Response.json({ ok: true });
      },
      { capabilityKey: SIGNING_KEY, reader: database().db },
    );
    const call = (claims: CapabilityClaims, path: string, body: JsonObject) =>
      check(
        new Request(`http://broker${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${signCapability(claims, SIGNING_KEY)}`,
          },
          body: JSON.stringify(body),
        }),
      );
    const { claims } = await request(helper, '@Melete Put the visit on Mom’s calendar.');
    const event = {
      connection_id: mailId,
      kind: 'calendar.create',
      payload: { title: 'Visit with [doctor 1]', location: '[address 1]' },
    };
    const refused = await call(claims, '/actions', event);
    expect(refused.status).toBe(400);
    const told = ((await refused.json()) as { error: { code: string; message: string } }).error;
    expect(told.code).toBe('payload_invalid');
    expect(told.message).toBe(stepRefusal(['[doctor 1]', '[address 1]'], 'Odile'));
    const mailed = await call(claims, '/tools/call', {
      name: 'mail.send',
      arguments: {
        to: 'help@pharmacy.example',
        body: 'Hi [pharmacist 1], about the [medicine 1].',
      },
    });
    expect(mailed.status).toBe(400);
    // A placeholder in another case, and a detail written out, are refused the same way.
    const shouted = await call(claims, '/actions', {
      ...event,
      payload: { title: 'Visit with [Doctor 1]' },
    });
    expect(shouted.status).toBe(400);
    const written = await call(claims, '/tools/call', {
      name: 'mail.send',
      arguments: {
        to: 'helper@else.example',
        body: 'Her doctor is Dr. Wendell Okafor, and the pharmacy is at 555-0188.',
      },
    });
    expect(written.status).toBe(400);
    expect(((await written.json()) as { error: { message: string } }).error.message).toBe(
      stepRefusal([], 'Odile'),
    );
    expect(reached).toEqual([]);

    // The board stays in the room, where each person reads it checked; a step without
    // placeholders goes as usual; and the maker's own requests read the real details.
    const board = {
      connection_id: await boardConnection(),
      kind: 'board.add',
      payload: { kind: 'task', title: 'Call [doctor 1]', visibility: 'everyone' },
    };
    expect((await call(claims, '/actions', board)).status).toBe(200);
    const plain = { ...event, payload: { title: 'Visit with the doctor' } };
    expect((await call(claims, '/actions', plain)).status).toBe(200);
    const own = await request(maker, '@Melete Put my visit on the calendar.');
    expect((await call(own.claims, '/actions', event)).status).toBe(200);
    expect(reached.map((line) => line.split(' ')[0])).toEqual(['/actions', '/actions', '/actions']);
  });
});
