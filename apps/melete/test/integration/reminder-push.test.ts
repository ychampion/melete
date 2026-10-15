/**
 * A reminder the person set reaches their phone at the time they set, even
 * before their day starts: a conversation's own timer coming due, a routine's
 * scheduled run. What Melete says by itself still waits for their day. The
 * push service is a stand-in that reads each body with the browser's own keys,
 * as a phone would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pushPayload } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import {
  agent,
  experienceProfile,
  experienceTurn,
  job,
  principal,
  pushIntent,
  pushSetting,
  pushSubscription,
  space,
} from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { PushService } from '../../src/push/service.ts';
import { decryptPayload, generateVapidKeys, toBase64Url } from '../../src/push/webpush.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
afterAll(async () => {
  await fixture?.close();
}, 60_000);

const MINUTE = 60_000;

/**
 * A time zone where the real clock reads 06:xx, before a day that starts at
 * 08:00, whenever the test runs. Etc/GMT-N is UTC+N.
 */
const dawnZone = (() => {
  let offset = (6 - new Date().getUTCHours() + 48) % 24;
  if (offset > 14) offset -= 24;
  return offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
})();

(fixture ? describe : describe.skip)('reminders reach the phone on time', () => {
  if (!fixture) return;
  const db = fixture.db;
  type Phone = { endpoint: string; publicKey: string; privateKey: string; auth: string };
  const phones = new Map<string, Phone>();
  const delivered: Array<{ endpoint: string; payload: ReturnType<typeof pushPayload.parse> }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(input);
    const phone = phones.get(endpoint);
    if (!phone) return new Response(null, { status: 404 });
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const plain = await decryptPayload(body, phone);
    delivered.push({
      endpoint,
      payload: pushPayload.parse(JSON.parse(new TextDecoder().decode(plain))),
    });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  let push: PushService;

  beforeAll(async () => {
    push = new PushService(db, {
      keys: await generateVapidKeys(),
      subject: 'mailto:owner@example.com',
      extraOrigins: [],
      fetcher,
    });
  });

  /** A person whose day is 08:00 to 22:00, where it is now 06:xx, with one phone. */
  const person = async () => {
    const principalId = newId('own');
    const spaceId = newId('sp');
    const agentId = newId('agent');
    await db.insert(principal).values({ id: principalId, email: `${principalId}@example.com` });
    await db.insert(space).values({
      id: spaceId,
      name: 'personal',
      kind: 'personal',
      ownerPrincipalId: principalId,
      gitPath: `/data/spaces/${spaceId}`,
    });
    await db.insert(experienceProfile).values({
      spaceId,
      name: 'Sam',
      dayStart: '08:00',
      dayEnd: '22:00',
      timeZone: dawnZone,
    });
    await db.insert(agent).values({
      id: agentId,
      spaceId,
      name: 'Melete',
      role: 'assistant',
      colour: 'blue',
      surface: 'paper',
      eyeColour: 'dark',
      tone: 'plain',
      standingInstruction: '',
      isDefault: true,
    });
    const keys = await generateVapidKeys();
    const phone: Phone = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${principalId}`,
      ...keys,
      auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
    phones.set(phone.endpoint, phone);
    await db.insert(pushSubscription).values({
      id: newId('psub'),
      principalId,
      endpoint: phone.endpoint,
      p256dh: phone.publicKey,
      auth: phone.auth,
      createdAt: new Date(Date.now() - 60 * MINUTE),
    });
    return { principalId, spaceId, agentId, endpoint: phone.endpoint };
  };
  type Person = Awaited<ReturnType<typeof person>>;

  /** A conversation (or routine) resting after an answer in a turn opened by `submissionId`. */
  const answered = async (
    who: Person,
    shape: { title: string; answer: string; submission: (jobId: string) => string; kind?: string },
  ) => {
    const jobId = newId('job');
    const turnId = newId('turn');
    await db.insert(job).values({
      id: jobId,
      spaceId: who.spaceId,
      principalId: who.principalId,
      title: shape.title,
      objective: shape.title,
      kind: shape.kind ?? 'chat',
      agentId: who.agentId,
      state: 'waiting_for_input',
      wait: { kind: 'none' },
      currentTurnId: turnId,
    });
    await db.insert(experienceTurn).values({
      id: turnId,
      jobId,
      agentId: who.agentId,
      submissionId: shape.submission(jobId),
      text: '',
      answer: shape.answer,
      status: 'done',
      finishedAt: new Date(),
    });
    return { jobId, turnId };
  };

  const pass = async (who: Person) => {
    const since = new Date(Date.now() - 60 * MINUTE);
    await push.collectStatus(who.principalId, since, new Date());
    return push.dispatch(who.principalId, new Date());
  };
  const to = (who: Person) => delivered.filter((entry) => entry.endpoint === who.endpoint);
  const intents = (who: Person) =>
    db.select().from(pushIntent).where(eq(pushIntent.principalId, who.principalId));

  test('a 06:30 reminder goes at 06:30, before the person’s day starts', async () => {
    const who = await person();
    const { jobId } = await answered(who, {
      title: 'Airport',
      answer: 'Time to leave for the airport.',
      submission: (id) => `wake:${id}:timer:4`,
    });
    expect(await pass(who)).toBe('sent');
    expect(to(who).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({
        title: 'Airport',
        body: 'Time to leave for the airport.',
        because: 'Because you asked for this at this time.',
        url: `/#/chat/${jobId}`,
      }),
    ]);
    const [sent] = await intents(who);
    expect(sent).toMatchObject({ kind: 'reminder', sentLane: 'reminder' });
    expect(sent?.sentAt).not.toBeNull();
  });

  test('an answer Melete gives by itself still waits for the day, beside a reminder', async () => {
    const who = await person();
    const notice = await answered(who, {
      title: 'Packing list',
      answer: 'I tidied the packing list.',
      submission: (id) => `sub:${id}`,
    });
    await answered(who, {
      title: 'Bins',
      answer: 'Take the bins out.',
      submission: (id) => `wake:${id}:timer:2`,
    });
    expect(await pass(who)).toBe('sent');
    expect(to(who).map((entry) => entry.payload.title)).toEqual(['Bins']);
    // The next pass, still before the day, holds the rest.
    expect(await pass(who)).toBe('quiet');
    const [waiting] = await db
      .select()
      .from(pushIntent)
      .where(
        and(
          eq(pushIntent.principalId, who.principalId),
          eq(pushIntent.dedupKey, `status:done:${notice.jobId}:${notice.turnId}`),
        ),
      );
    expect(waiting).toMatchObject({ kind: 'done', sentAt: null, droppedAt: null });
  });

  test('two reminders in one conversation minutes apart both go: no throttle holds the second', async () => {
    const who = await person();
    const first = await answered(who, {
      title: 'Medication',
      answer: 'Take the first pill.',
      submission: (id) => `wake:${id}:timer:2`,
    });
    expect(await pass(who)).toBe('sent');
    const second = newId('turn');
    await db.insert(experienceTurn).values({
      id: second,
      jobId: first.jobId,
      agentId: who.agentId,
      submissionId: `wake:${first.jobId}:timer:5`,
      text: '',
      answer: 'Take the second pill.',
      status: 'done',
      finishedAt: new Date(),
    });
    expect(await pass(who)).toBe('sent');
    expect(to(who).map((entry) => entry.payload.body)).toEqual([
      'Take the first pill.',
      'Take the second pill.',
    ]);
    // Each is its own notification on the phone: the second never replaces the first.
    const [a, b] = to(who).map((entry) => entry.payload.tag);
    expect(a).not.toBe(b);
  });

  test('a routine’s scheduled run is pushed on time, and counts against no cap', async () => {
    const who = await person();
    // A daily cap of one does not hold back the second.
    await db.insert(pushSetting).values({ principalId: who.principalId, dailyCap: 1 });
    await answered(who, {
      title: 'Morning brief',
      answer: 'Rain from 7. Two meetings before noon.',
      kind: 'routine',
      submission: () => `routine:${newId('trg')}:1`,
    });
    expect(await pass(who)).toBe('sent');
    await answered(who, {
      title: 'Stretch',
      answer: 'Time to stretch.',
      submission: (id) => `wake:${id}:schedule:${newId('trg')}:3`,
    });
    expect(await pass(who)).toBe('sent');
    expect(to(who).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({
        title: 'Morning brief',
        because: 'Because your routine ran at the time you set.',
      }),
      expect.objectContaining({ title: 'Stretch' }),
    ]);
  });

  test('turning the kind off stops reminders too', async () => {
    const who = await person();
    await push.updateSettings(who.principalId, { settled: false });
    await answered(who, {
      title: 'Airport',
      answer: 'Time to leave for the airport.',
      submission: (id) => `wake:${id}:timer:4`,
    });
    expect(await pass(who)).toBe('nothing');
    expect(to(who)).toHaveLength(0);
  });
});
