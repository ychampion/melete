/**
 * The reach-me ladder against Postgres: a deadline the person set that goes
 * unanswered climbs from a push to a text and then a call to their own
 * verified number, stops when they acknowledge on any channel, keeps to its
 * caps and the night rule, honours STOP, and never contacts another number.
 *
 * The telephony provider is a fake that records every text and call and signs
 * its webhooks the way Twilio does; clocks run on a clock the test moves.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushPayload } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import { connection, experienceProfile, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { PushService } from '../../src/push/service.ts';
import { decryptPayload, generateVapidKeys, toBase64Url } from '../../src/push/webpush.ts';
import { DAILY_CAPS } from '../../src/reach/policy.ts';
import {
  type ReachConfig,
  type ReachProvider,
  ReachSendFailure,
} from '../../src/reach/provider.ts';
import { ReachService } from '../../src/reach/service.ts';
import { twilioSignature, validTwilioSignature } from '../../src/reach/twilio.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { SituationService, type SubjectReader } from '../../src/situations/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'reach-fixture-key-32-bytes!!!!!!' })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

const MINUTE = 60_000;
let clock = Date.parse('2026-10-05T12:00:00.000Z');
const sources = new Map<string, { subjects?: SubjectReader }>();

// --------------------------------------------------------------------------
// the fake provider: records what it was asked to send, signs like Twilio
// --------------------------------------------------------------------------

const ACCOUNT = `AC${'b'.repeat(32)}`;
const TOKEN = 't'.repeat(32);
const FROM = '+15550001000';
const BASE = 'https://melete.example/api';
type Made = {
  channel: 'text' | 'call';
  to: string;
  body: string;
  ref: string;
  callback: string | null;
};
const made: Made[] = [];
const fake = {
  /** Numbers that replied STOP on the provider's side. */
  unsubscribed: new Set<string>(),
};
const provider: ReachProvider = {
  from: FROM,
  name: 'fake',
  async text(to, body, callback) {
    if (fake.unsubscribed.has(to)) throw new ReachSendFailure('opted_out');
    const ref = `SM${made.length}`;
    made.push({ channel: 'text', to, body, ref, callback });
    return { ref, status: 'queued' };
  },
  async call(to, twiml, callback) {
    const ref = `CA${made.length}`;
    made.push({ channel: 'call', to, body: twiml, ref, callback });
    return { ref, status: 'queued' };
  },
  authentic: (url, params, signature) =>
    validTwilioSignature(signature, url, params.entries(), TOKEN),
  ownAccount: (params) => params.get('AccountSid') === ACCOUNT,
};
const PRICES = { textUsd: 0.01, callUsdPerMinute: 0.02 };
const config: ReachConfig = { provider, callbackBase: BASE, unavailable: null, prices: PRICES };

/** A webhook request as the provider sends it, signed for its exact address. */
function signed(path: string, fields: Record<string, string>) {
  const params = new URLSearchParams({ AccountSid: ACCOUNT, ...fields });
  const url = `${BASE}${path}`;
  return { url, params, signature: twilioSignature(url, params.entries(), TOKEN) };
}

// --------------------------------------------------------------------------
// push: a phone that decrypts what reaches it
// --------------------------------------------------------------------------

type Phone = { endpoint: string; publicKey: string; privateKey: string; auth: string };
const delivered: Array<{ principal: string; title: string }> = [];
const phones = new Map<string, Phone & { principal: string }>();
const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const phone = phones.get(String(input));
  if (!phone) return new Response(null, { status: 404 });
  const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
  const plain = await decryptPayload(body, phone);
  const payload = pushPayload.parse(JSON.parse(new TextDecoder().decode(plain)));
  delivered.push({ principal: phone.principal, title: payload.title });
  return new Response(null, { status: 201 });
}) as typeof fetch;
let push: PushService;

const situations =
  jobs && triggers
    ? new SituationService({
        jobs,
        triggers,
        connectors: sources,
        now: () => clock,
        notify: (principalId) => push.dispatch(principalId, new Date(clock)),
      })
    : null;
const reach =
  handle && situations
    ? new ReachService({
        db: handle.db,
        config,
        now: () => clock,
        ack: (principalId, id) => required(situations).ack(principalId, id),
      })
    : null;
if (situations && reach)
  situations.deps.escalate = (tx, row, pushed) => reach.escalate(tx, row, pushed);

// --------------------------------------------------------------------------
// people
// --------------------------------------------------------------------------

type Person = { id: string; spaceId: string; docs: string };
let numbers = 0;
const nextNumber = () => `+1555020${String(numbers++).padStart(4, '0')}`;

async function person(label: string, day = { start: '08:00', end: '22:00' }): Promise<Person> {
  const { db, sql } = required(handle);
  const id = newId('own');
  await sql`insert into principal (id, email) values (${id}, ${`${label}-${id}@example.test`})`;
  const spaceId = newId('sp');
  await db
    .insert(space)
    .values({ id: spaceId, name: label, gitPath: `/s/${spaceId}`, ownerPrincipalId: id });
  await db
    .insert(experienceProfile)
    .values({ spaceId, timeZone: 'UTC', dayStart: day.start, dayEnd: day.end });
  const docs = newId('conn');
  await db.insert(connection).values({ id: docs, spaceId, provider: 'test', label: 'Documents' });
  sources.set(docs, { subjects: { read: async () => ({ signed: false }) } });
  return { id, spaceId, docs };
}

async function withPhone(who: Person) {
  const keys = await generateVapidKeys();
  const endpoint = `https://push.example.test/${who.id}`;
  const auth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  phones.set(endpoint, { endpoint, ...keys, auth, principal: who.id });
  await required(handle)
    .sql`insert into push_subscription (id, principal_id, endpoint, p256dh, auth)
    values (${newId('psub')}, ${who.id}, ${endpoint}, ${keys.publicKey}, ${auth})`;
}

/** The person proves a number with the code texted to it. */
async function verify(who: Person, number: string) {
  const before = made.length;
  await required(reach).requestCode(who.id, number);
  const text = required(made.slice(before).find((m) => m.to === number));
  const code = required(/\b(\d{6})\b/.exec(text.body))[1] ?? '';
  return required(reach).verify(who.id, code);
}

async function optedIn(
  label: string,
  choice = { calls: true, nights: false },
  day?: { start: string; end: string },
) {
  const who = await person(label, day);
  await withPhone(who);
  const number = nextNumber();
  await verify(who, number);
  await required(reach).agree(who.id, choice);
  return { ...who, number };
}

/** A deadline the person set, at risk at its look five minutes before it is due. */
async function deadlineAtRisk(who: Person, subject: string, title = 'The contract is signed') {
  const due = clock + 30 * MINUTE;
  await required(situations).setDeadline({
    spaceId: who.spaceId,
    principalId: who.id,
    subjectKey: subject,
    connectionId: who.docs,
    title,
    dueAt: new Date(due),
    leadSeconds: 5 * 60,
    atRisk: { all: [{ field: 'signed', op: 'eq', value: false }] },
    personSet: true,
  });
  clock = due - 5 * MINUTE;
  await required(situations).sweep();
  const [row] = await required(handle).sql`select id from situation
    where principal_id = ${who.id} and subject_key = ${subject} and state in ('open', 'routed')`;
  return String(required(row).id);
}

/** An urgent situation about a deadline the person set, and its ladder, as the sweep makes them. */
async function urgent(who: Person) {
  const id = newId('sit');
  await required(handle).db.transaction(async (tx) => {
    await tx.execute(sql`insert into situation (id, space_id, principal_id, kind,
        subject_key, key, urgency, person_set, title, reason, because, origin)
      values (${id}, ${who.spaceId}, ${who.id}, 'deadline.at_risk', ${`doc:${id}`}, ${`key:${id}`},
        'urgent', true, 'The form is filed', 'Due Mon 12:30 PM, and it is not done yet.',
        '["clock:x"]'::jsonb, 'person')`);
    await required(reach).escalate(
      tx,
      { id, principalId: who.id, kind: 'deadline.at_risk', urgency: 'urgent', personSet: true },
      true,
    );
  });
  return id;
}

/** The message a refused call gives. (No `rejects`: it can hang a pooled connection in Bun.) */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'accepted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Move the clock and run the ladder. */
async function at(ms: number) {
  clock = ms;
  return required(reach).sweep();
}

/** The service as a provider reaches it: the whole app, with no session. */
const app =
  handle && jobs && reach
    ? createApp({
        env: loadEnv({
          NODE_ENV: 'test',
          MELETE_SPACES_DIR: await mkdtemp(join(tmpdir(), 'melete-reach-')),
          MELETE_PUBLIC_URL: 'https://melete.example',
        }),
        db: handle.db,
        sql: handle.sql,
        jobs,
        reach,
        checkDatabase: async () => 'ok',
      })
    : null;
async function webhook(path: string, fields: Record<string, string>, signature?: string) {
  const request = signed(path, fields);
  return required(app).request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature ?? request.signature,
    },
    body: request.params.toString(),
  });
}

const rungs = async (situationId: string) =>
  Object.fromEntries(
    (
      await required(handle).sql`select channel, state, reason, number from reach_contact
        where situation_id = ${situationId}`
    ).map((row) => [String(row.channel), row]),
  );
/** The ladder's texts and calls to a number, leaving out the codes the person asked for. */
const sentTo = (who: { number: string }, channel?: 'text' | 'call') =>
  made.filter(
    (m) =>
      m.to === who.number &&
      !m.body.startsWith('Your Melete code') &&
      (!channel || m.channel === channel),
  );

withDb('the reach-me ladder', () => {
  beforeAll(async () => {
    push = new PushService(required(handle).db, {
      keys: await generateVapidKeys(),
      subject: 'mailto:owner@example.test',
      extraOrigins: ['https://push.example.test'],
      fetcher,
    });
  });
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('an unacknowledged urgent deadline: push, text at +3 min, call at +8; acknowledging stops it', async () => {
    const ana = await optedIn('ana');
    const pushesBefore = delivered.filter((d) => d.principal === ana.id).length;
    const id = await deadlineAtRisk(ana, 'doc:contract');
    const start = clock;
    // The push went at once, and the ladder waits behind it.
    expect(delivered.filter((d) => d.principal === ana.id).length).toBe(pushesBefore + 1);
    expect((await rungs(id)).push?.state).toBe('sent');
    expect((await rungs(id)).text?.state).toBe('waiting');
    await at(start + 2 * MINUTE + 59_000);
    expect(sentTo(ana)).toHaveLength(0);
    // Three minutes unanswered: one text, to the verified number, in Melete's words.
    await at(start + 3 * MINUTE);
    await at(start + 3 * MINUTE + 1000);
    expect(sentTo(ana, 'text')).toHaveLength(1);
    const text = required(sentTo(ana, 'text')[0]);
    expect(text.body).toContain('The contract is signed');
    expect(text.body).toContain('Reply STOP');
    expect(text.callback).toMatch(/^https:\/\/melete\.example\/api\/reach\/twilio\/status\/rch_/);
    await at(start + 7 * MINUTE);
    expect(sentTo(ana, 'call')).toHaveLength(0);
    // Eight minutes: one call, which says the deadline and how to answer.
    await at(start + 8 * MINUTE);
    expect(sentTo(ana, 'call')).toHaveLength(1);
    const call = required(sentTo(ana, 'call')[0]);
    expect(call.body).toContain(
      'This is Melete, about a deadline you set. The contract is signed.',
    );
    expect(call.body).toContain('Press 1');
    expect(call.body).toContain('/api/reach/twilio/key/rch_');
    // Pressing 1 says it was seen.
    const callRow = (await rungs(id)).call;
    expect(callRow?.state).toBe('sent');
    const keyId = required(/key\/(rch_[0-9A-Z]{26})/.exec(call.body))[1] ?? '';
    const press = signed(`/reach/twilio/key/${keyId}`, { CallSid: call.ref, Digits: '1' });
    expect(
      await required(reach).keypress(keyId, press.url, press.params, press.signature),
    ).toContain('marked it as seen');
    const [seen] = await required(handle).sql`select acked_at from situation where id = ${id}`;
    expect(seen?.acked_at).not.toBeNull();
    // Each one is counted toward the person's spend, as a background cost.
    const metered = await required(handle).sql`select model, cost_usd, class, situation_id
      from model_usage where principal_id = ${ana.id} and purpose = 'reach' order by model`;
    expect(metered.map((row) => [row.model, Number(row.cost_usd), row.class])).toEqual([
      ['call', PRICES.callUsdPerMinute, 'background'],
      ['code', PRICES.textUsd, 'background'],
      ['text', PRICES.textUsd, 'background'],
    ]);
    expect(metered.filter((row) => row.situation_id === id)).toHaveLength(2);
    // The receipts: the text delivered, the call answered for 75 seconds (two started minutes).
    const [textRow] = await required(handle)
      .sql`select id from reach_contact where provider_ref = ${text.ref}`;
    const textId = String(required(textRow).id);
    const textSigned = signed(`/reach/twilio/status/${textId}`, {
      MessageSid: text.ref,
      MessageStatus: 'delivered',
    });
    expect(
      await required(reach).receipt(
        textId,
        textSigned.url,
        textSigned.params,
        textSigned.signature,
      ),
    ).toBe(true);
    const callReceipt = signed(`/reach/twilio/status/${keyId}`, {
      CallSid: call.ref,
      CallStatus: 'completed',
      CallDuration: '75',
    });
    await required(reach).receipt(
      keyId,
      callReceipt.url,
      callReceipt.params,
      callReceipt.signature,
    );
    const after = await rungs(id);
    expect([after.text?.state, after.call?.state]).toEqual(['delivered', 'delivered']);
    const [callCost] = await required(handle)
      .sql`select cost_usd from model_usage where id = ${keyId}`;
    expect(Number(callCost?.cost_usd)).toBeCloseTo(2 * PRICES.callUsdPerMinute, 6);
    // A receipt not signed for this address changes nothing.
    const forged = signed(`/reach/twilio/status/${textId}`, {
      MessageSid: text.ref,
      MessageStatus: 'failed',
    });
    expect(await required(reach).receipt(textId, forged.url, forged.params, 'nope')).toBe(false);

    // Seeing the push stops what is left.
    const tapped = await deadlineAtRisk(ana, 'doc:lease', 'The lease is signed');
    const second = clock;
    await at(second + 3 * MINUTE);
    expect(sentTo(ana, 'text')).toHaveLength(2);
    await required(situations).ack(ana.id, tapped);
    await at(second + 8 * MINUTE);
    expect(sentTo(ana, 'call')).toHaveLength(1);
    expect((await rungs(tapped)).call?.state).toBe('cancelled');

    // So does answering the text.
    const answered = await deadlineAtRisk(ana, 'doc:nda', 'The NDA is signed');
    const third = clock;
    await at(third + 3 * MINUTE);
    expect(sentTo(ana, 'text')).toHaveLength(3);
    const reply = signed('/reach/twilio/sms', { From: ana.number, To: FROM, Body: 'on it' });
    expect(await required(reach).inbound(reply.url, reply.params, reply.signature)).toBe(
      'acknowledged',
    );
    await at(third + 8 * MINUTE);
    expect(sentTo(ana, 'call')).toHaveLength(1);
    expect((await rungs(answered)).call?.state).toBe('cancelled');
    const [replied] = await required(handle)
      .sql`select acked_at from situation where id = ${answered}`;
    expect(replied?.acked_at).not.toBeNull();
  }, 120_000);

  test('no contact to any number but the verified one without approval', async () => {
    const ben = await optedIn('ben');
    const other = nextNumber();
    // A new number waits for its code: it gets that code, which the person asked for, and nothing else.
    await required(reach).requestCode(ben.id, other);
    const id = await urgent(ben);
    const start = clock;
    await at(start + 3 * MINUTE);
    await at(start + 8 * MINUTE);
    const ladder = made.filter((m) => m.body.includes('The form is filed'));
    expect(ladder.map((m) => [m.channel, m.to])).toEqual([
      ['text', ben.number],
      ['call', ben.number],
    ]);
    expect(made.filter((m) => m.to === other).map((m) => m.body)).toEqual([
      expect.stringMatching(/^Your Melete code is \d{6}\./),
    ]);
    expect(Object.values(await rungs(id)).map((row) => row.number ?? null)).not.toContain(other);

    // An agreement recorded for another number covers nothing.
    await required(handle).sql`update reach_consent set number = ${other}
      where principal_id = ${ben.id} and withdrawn_at is null`;
    const elsewhere = await urgent(ben);
    const sentBefore = made.length;
    await at(clock + 3 * MINUTE);
    await at(clock + 5 * MINUTE);
    expect(made.length).toBe(sentBefore);
    expect((await rungs(elsewhere)).text?.reason).toContain('haven’t agreed');

    // Verifying the new number ends the agreement given for the old one.
    await required(handle).sql`update reach_consent set number = ${ben.number}
      where principal_id = ${ben.id} and withdrawn_at is null`;
    const before = made.length;
    const state = await verify(ben, other);
    expect(state.number).toBe(other);
    expect(state.consent).toBeNull();
    const [ended] = await required(handle).sql`select withdrawn_how from reach_consent
      where principal_id = ${ben.id} order by agreed_at desc limit 1`;
    expect(ended?.withdrawn_how).toBe('number');
    const after = await urgent(ben);
    await at(clock + 3 * MINUTE);
    await at(clock + 5 * MINUTE);
    // Only the code for the new number went out; the ladder stopped at push.
    expect(made.slice(before).map((m) => m.body.slice(0, 19))).toEqual(['Your Melete code is']);
    expect((await rungs(after)).text?.state).toBe('skipped');

    // A text from a number nobody verified is no one's: nothing is acknowledged or sent.
    const stranger = signed('/reach/twilio/sms', { From: '+15559990000', To: FROM, Body: 'STOP' });
    expect(await required(reach).inbound(stranger.url, stranger.params, stranger.signature)).toBe(
      'ignored',
    );
    // And a number someone else verified can't be claimed.
    const cy = await person('cy');
    expect(await refusal(required(reach).requestCode(cy.id, other))).toContain('already verified');
  }, 120_000);

  test('at most six texts and three calls a day', async () => {
    const dee = await optedIn('dee');
    const ids: string[] = [];
    for (let i = 0; i < DAILY_CAPS.text + 1; i++) {
      ids.push(await urgent(dee));
      const start = clock;
      await at(start + 3 * MINUTE);
      await at(start + 8 * MINUTE);
      clock = start + 10 * MINUTE;
    }
    expect(sentTo(dee, 'text')).toHaveLength(DAILY_CAPS.text);
    expect(sentTo(dee, 'call')).toHaveLength(DAILY_CAPS.call);
    const last = await rungs(required(ids.at(-1)));
    expect(last.text?.reason).toContain('6 texts today');
    expect((await rungs(required(ids[3]))).call?.reason).toContain('called 3 times today');
  }, 120_000);

  test('nothing is texted or called outside the person’s day unless they asked for nights', async () => {
    // Their day is 08:00–10:00 UTC; the test's clock is past noon.
    const eve = await optedIn(
      'eve',
      { calls: true, nights: false },
      { start: '08:00', end: '10:00' },
    );
    const quiet = await urgent(eve);
    await at(clock + 3 * MINUTE);
    await at(clock + 5 * MINUTE);
    expect(sentTo(eve)).toHaveLength(0);
    expect((await rungs(quiet)).text?.reason).toContain('outside your day');
    expect((await rungs(quiet)).call?.state).toBe('skipped');
    // Agreeing to nights as well: the same hour reaches them.
    await required(reach).agree(eve.id, { calls: true, nights: true });
    await urgent(eve);
    await at(clock + 3 * MINUTE);
    await at(clock + 5 * MINUTE);
    expect(sentTo(eve).map((m) => m.channel)).toEqual(['text', 'call']);
  }, 120_000);

  test('STOP opts out', async () => {
    const fay = await optedIn('fay');
    const id = await urgent(fay);
    const start = clock;
    await at(start + 3 * MINUTE);
    expect(sentTo(fay, 'text')).toHaveLength(1);
    // A STOP that isn't signed for this address changes nothing.
    const forged = signed('/reach/twilio/sms', { From: fay.number, To: FROM, Body: 'STOP' });
    expect(await required(reach).inbound(forged.url, forged.params, 'forged')).toBe('forbidden');
    expect((await required(reach).state(fay.id)).consent).not.toBeNull();
    const stop = signed('/reach/twilio/sms', { From: fay.number, To: FROM, Body: 'Stop' });
    expect(await required(reach).inbound(stop.url, stop.params, stop.signature)).toBe('stop');
    await at(start + 8 * MINUTE);
    expect(sentTo(fay, 'call')).toHaveLength(0);
    expect((await rungs(id)).call?.state).toBe('cancelled');
    const state = await required(reach).state(fay.id);
    expect(state.consent).toBeNull();
    expect(state.opted_out_at).not.toBeNull();
    const [ended] = await required(handle).sql`select withdrawn_how, wording, number
      from reach_consent where principal_id = ${fay.id}`;
    // What they agreed to is kept as it was, with when and how it ended.
    expect(ended?.withdrawn_how).toBe('stop');
    expect(ended?.number).toBe(fay.number);
    expect(String(ended?.wording)).toContain(`may text ${fay.number}`);
    // Nothing more goes, and turning it on again waits for START.
    await urgent(fay);
    await at(clock + 3 * MINUTE);
    await at(clock + 5 * MINUTE);
    expect(sentTo(fay)).toHaveLength(1);
    expect(await refusal(required(reach).agree(fay.id, { calls: false, nights: false }))).toContain(
      'START',
    );
    const start2 = signed('/reach/twilio/sms', { From: fay.number, To: FROM, Body: 'START' });
    expect(await required(reach).inbound(start2.url, start2.params, start2.signature)).toBe(
      'start',
    );
    expect(
      (await required(reach).agree(fay.id, { calls: false, nights: false })).consent?.calls,
    ).toBe(false);

    // A STOP sent to the provider directly is honoured when it refuses the next text.
    fake.unsubscribed.add(fay.number);
    const refused = await urgent(fay);
    await at(clock + 3 * MINUTE);
    expect((await rungs(refused)).text?.state).toBe('failed');
    expect((await required(reach).state(fay.id)).opted_out_at).not.toBeNull();
    expect((await required(reach).state(fay.id)).consent).toBeNull();
  }, 120_000);

  test('the provider’s webhooks reach the service without a session, and only with its signature', async () => {
    const ivy = await optedIn('ivy');
    // Unsigned, or signed for another address: refused before anything is read.
    expect(
      (await webhook('/reach/twilio/sms', { From: ivy.number, To: FROM, Body: 'STOP' }, 'x'))
        .status,
    ).toBe(403);
    expect((await required(reach).state(ivy.id)).consent).not.toBeNull();
    const stop = await webhook('/reach/twilio/sms', { From: ivy.number, To: FROM, Body: 'STOP' });
    expect(stop.status).toBe(200);
    expect(stop.headers.get('content-type')).toContain('text/xml');
    expect((await required(reach).state(ivy.id)).consent).toBeNull();
    // A receipt and a keypress for a contact that isn't theirs are refused.
    const receipt = await webhook(`/reach/twilio/status/rch_${'0'.repeat(26)}`, {
      MessageSid: 'SMnone',
      MessageStatus: 'delivered',
    });
    expect(receipt.status).toBe(204);
    const key = await webhook(`/reach/twilio/key/rch_${'0'.repeat(26)}`, {
      CallSid: 'CAnone',
      Digits: '1',
    });
    expect(key.status).toBe(403);
    // The signed-in routes still need a session.
    expect((await required(app).request('/reach')).status).toBe(401);
  }, 60_000);

  test('without a provider, the ladder stops at push and says so', async () => {
    const gus = await person('gus');
    const bare = new ReachService({
      db: required(handle).db,
      config: {
        provider: null,
        callbackBase: null,
        unavailable: 'Push only here.',
        prices: PRICES,
      },
      now: () => clock,
    });
    const state = await bare.state(gus.id);
    expect([state.available, state.unavailable_reason]).toEqual([false, 'Push only here.']);
    expect(await refusal(bare.requestCode(gus.id, nextNumber()))).toBe('Push only here.');
    const id = newId('sit');
    await required(handle).sql`insert into situation (id, space_id, principal_id, kind,
        subject_key, key, urgency, person_set, title, reason, because, origin)
      values (${id}, ${gus.spaceId}, ${gus.id}, 'deadline.at_risk', ${`doc:${id}`}, ${`key:${id}`},
        'urgent', true, 'The form is filed', 'Due soon.', '["clock:x"]'::jsonb, 'person')`;
    await required(handle).db.transaction((tx) =>
      bare.escalate(
        tx,
        { id, principalId: gus.id, kind: 'deadline.at_risk', urgency: 'urgent', personSet: true },
        true,
      ),
    );
    clock += 9 * MINUTE;
    await bare.sweep();
    const ladder = await rungs(id);
    expect([ladder.text?.state, ladder.call?.state]).toEqual(['skipped', 'skipped']);
    expect(ladder.text?.reason).toContain('push only');
  }, 60_000);

  test('only a deadline the person set climbs', async () => {
    const hal = await optedIn('hal');
    const id = newId('sit');
    await required(handle).sql`insert into situation (id, space_id, principal_id, kind,
        subject_key, key, urgency, person_set, title, reason, because, origin)
      values (${id}, ${hal.spaceId}, ${hal.id}, 'meeting.changed', ${`m:${id}`}, ${`key:${id}`},
        'soon', false, 'A meeting moved', 'It moved.', '["event:1"]'::jsonb, 'external_content')`;
    await required(handle).db.transaction((tx) =>
      required(reach).escalate(
        tx,
        { id, principalId: hal.id, kind: 'meeting.changed', urgency: 'soon', personSet: false },
        true,
      ),
    );
    expect(Object.keys(await rungs(id))).toEqual([]);
  }, 60_000);
});
