/**
 * Phone presence against Postgres: a person's devices receive what is theirs
 * and nothing else, inside their day, under their cap, folded together when it
 * arrives together, always with its "because". The push service is a stand-in
 * that reads each body with the browser's own keys, as a phone would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pushPayload } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { experienceProfile, job, principal, question, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { PushService, recordSettled } from '../../src/push/service.ts';
import { decryptPayload, generateVapidKeys, toBase64Url } from '../../src/push/webpush.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
afterAll(async () => {
  await fixture?.close();
}, 60_000);

type Device = { endpoint: string; publicKey: string; privateKey: string; auth: string };
const device = async (endpoint: string): Promise<Device> => {
  const keys = await generateVapidKeys();
  return { endpoint, ...keys, auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
};

/** What reached the push service: the endpoint, and the payload the phone would read. */
type Delivered = { endpoint: string; payload: ReturnType<typeof pushPayload.parse> };

const MINUTE = 60_000;

(fixture ? describe : describe.skip)('push', () => {
  if (!fixture) return;
  const db = fixture.db;
  const devices = new Map<string, Device>();
  const delivered: Delivered[] = [];
  const gone = new Set<string>();
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(input);
    if (gone.has(endpoint)) return new Response(null, { status: 410 });
    const phone = devices.get(endpoint);
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
  const people = { ana: newId('own'), ben: newId('own') };
  const spaces = { ana: newId('sp'), ben: newId('sp') };
  let anaPhone: Device;
  let anaLaptop: Device;
  let benPhone: Device;

  /**
   * A time zone where the real clock reads about noon, so the test's minutes
   * never cross a local midnight, whenever it runs. Etc/GMT-N is UTC+N.
   */
  const noonZone = (() => {
    const offset = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
    return offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
  })();
  /** Day hours around that noon, so "now" is inside or outside the day on purpose. */
  const setDay = async (who: 'ana' | 'ben', inside: boolean) => {
    const [dayStart, dayEnd] = inside ? ['08:00', '20:00'] : ['15:00', '18:00'];
    await db
      .update(experienceProfile)
      .set({ dayStart, dayEnd, timeZone: noonZone })
      .where(eq(experienceProfile.spaceId, spaces[who]));
  };

  /** An open question on its own job: the decision Melete would ask for. */
  const ask = async (who: 'ana' | 'ben', text: string) => {
    const jobId = newId('job');
    await db.insert(job).values({
      id: jobId,
      spaceId: spaces[who],
      principalId: people[who],
      title: text,
      objective: text,
    });
    const id = newId('qst');
    await db.insert(question).values({
      id,
      jobId,
      text,
      because: ['Your answer decides the next step.'],
      ifIgnored: 'It waits for your answer.',
    });
    return { jobId, id };
  };

  const later = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

  beforeAll(async () => {
    const keys = await generateVapidKeys();
    push = new PushService(db, {
      keys,
      subject: 'mailto:owner@example.com',
      extraOrigins: [],
      fetcher,
    });
    for (const who of ['ana', 'ben'] as const) {
      await db.insert(principal).values({ id: people[who], email: `${who}@example.com` });
      await db.insert(space).values({
        id: spaces[who],
        name: 'personal',
        kind: 'personal',
        ownerPrincipalId: people[who],
        gitPath: `/data/spaces/${who}`,
      });
      await db.insert(experienceProfile).values({ spaceId: spaces[who], name: who });
      await setDay(who, true);
    }
    anaPhone = await device('https://fcm.googleapis.com/fcm/send/ana-phone');
    anaLaptop = await device('https://updates.push.services.mozilla.com/wpush/v2/ana-laptop');
    benPhone = await device('https://web.push.apple.com/ben-phone');
    for (const phone of [anaPhone, anaLaptop, benPhone]) devices.set(phone.endpoint, phone);
  });

  const subscribe = (who: 'ana' | 'ben', phone: Device, label: string) =>
    push.subscribe(people[who], {
      endpoint: phone.endpoint,
      keys: { p256dh: phone.publicKey, auth: phone.auth },
      device_label: label,
    });

  test('only a browser push service is accepted as an endpoint', async () => {
    await expect(
      push.subscribe(people.ana, {
        endpoint: 'http://169.254.169.254/latest/meta-data',
        keys: { p256dh: anaPhone.publicKey, auth: anaPhone.auth },
        device_label: 'x',
      }),
    ).rejects.toMatchObject({ code: 'push_endpoint_refused' });
    const ana = await subscribe('ana', anaPhone, 'Ana’s phone');
    await subscribe('ana', anaLaptop, 'Ana’s laptop');
    await subscribe('ben', benPhone, 'Ben’s phone');
    expect(ana.device_label).toBe('Ana’s phone');
    expect((await push.list(people.ana)).map((d) => d.device_label)).toEqual([
      'Ana’s phone',
      'Ana’s laptop',
    ]);
  });

  test('a decision waits the batching window, then reaches only its person’s devices', async () => {
    const { jobId } = await ask('ana', 'Send the refund email to Tern & Co?');
    expect((await push.runOnce(new Date()))[people.ana]).toBe('batching');
    delivered.length = 0;
    expect((await push.runOnce(later(11)))[people.ana]).toBe('sent');
    expect(delivered.map((d) => d.endpoint).sort()).toEqual(
      [anaLaptop.endpoint, anaPhone.endpoint].sort(),
    );
    const [first] = delivered;
    expect(first?.payload.title).toBe('One decision is waiting');
    expect(first?.payload.body).toBe('Send the refund email to Tern & Co?');
    expect(first?.payload.because).toBe('Because your answer decides the next step.');
    expect(first?.payload.url).toBe(`/#/chat/${jobId}`);
    // Ben has nothing waiting, and nothing of Ana's ever reaches his phone.
    expect(delivered.some((d) => d.endpoint === benPhone.endpoint)).toBe(false);
  });

  test('nothing is sent in quiet hours', async () => {
    await setDay('ana', false);
    await ask('ana', 'Hold the ryokan?');
    delivered.length = 0;
    expect((await push.runOnce(later(30)))[people.ana]).toBe('quiet');
    expect(delivered).toEqual([]);
    await setDay('ana', true);
  });

  test('the daily cap holds what is left for later', async () => {
    await push.updateSettings(people.ana, { daily_cap: 1 });
    delivered.length = 0;
    // One push already went out today; the question from quiet hours still waits.
    expect((await push.runOnce(later(30)))[people.ana]).toBe('cap');
    expect(delivered).toEqual([]);
    await push.updateSettings(people.ana, { daily_cap: 4 });
  });

  test('what arrived together goes out as one push, with one because', async () => {
    await ask('ana', 'Pay the Halliwell & Fox deposit?');
    delivered.length = 0;
    expect((await push.runOnce(later(30)))[people.ana]).toBe('sent');
    const payloads = delivered.filter((d) => d.endpoint === anaPhone.endpoint);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.payload.title).toBe('Two decisions are waiting');
    expect(payloads[0]?.payload.because).toBe('Because two decisions wait since the last one.');
  });

  test('a decision made before it went out is dropped, not sent', async () => {
    const { id } = await ask('ana', 'Cancel the Fernhill Files trial?');
    await push.runOnce(new Date());
    await db.update(question).set({ state: 'answered' }).where(eq(question.id, id));
    delivered.length = 0;
    expect((await push.runOnce(later(30)))[people.ana]).toBe('nothing');
    expect(delivered).toEqual([]);
  });

  test('a settled chase is told, with why', async () => {
    await recordSettled(db, {
      id: newId('led'),
      principalId: people.ana,
      summary: 'Tern & Co: £64.00 refund is back on your card',
      jobId: 'job_chase',
    });
    delivered.length = 0;
    expect((await push.runOnce(later(30)))[people.ana]).toBe('sent');
    expect(delivered[0]?.payload).toMatchObject({
      title: 'A chase settled',
      because: 'Because you asked Melete to chase this.',
      url: '/#/chat/job_chase',
    });
  });

  test('a device the push service says is gone is removed', async () => {
    gone.add(anaLaptop.endpoint);
    await ask('ana', 'Book the dentist?');
    expect((await push.runOnce(later(30)))[people.ana]).toBe('sent');
    expect((await push.list(people.ana)).map((d) => d.device_label)).toEqual(['Ana’s phone']);
  });

  test('a person removes their own device, never someone else’s', async () => {
    const [phone] = await push.list(people.ana);
    if (!phone) throw new Error('missing device');
    await expect(push.remove(people.ben, phone.id)).rejects.toMatchObject({ status: 404 });
    await push.remove(people.ana, phone.id);
    expect(await push.list(people.ana)).toEqual([]);
    // With no device left, nothing is collected or sent for Ana.
    await ask('ana', 'Renew the passport?');
    delivered.length = 0;
    const results = await push.runOnce(later(30));
    expect(results[people.ana]).toBeUndefined();
    expect(delivered).toEqual([]);
  });

  test('settings read quiet hours from the profile and turn kinds off', async () => {
    const settings = await push.settings(people.ben);
    expect(settings.quiet_hours).toEqual({ from: '20:00', until: '08:00', time_zone: noonZone });
    expect(settings).toMatchObject({ decisions: true, settled: true, weekly_summary: true });
    const off = await push.updateSettings(people.ben, { decisions: false });
    expect(off.decisions).toBe(false);
    await ask('ben', 'Reply to the landlord?');
    delivered.length = 0;
    expect((await push.runOnce(later(30)))[people.ben]).toBe('nothing');
    expect(delivered).toEqual([]);
  });
});
