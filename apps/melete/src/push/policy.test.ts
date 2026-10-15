/**
 * When Melete may speak: quiet hours hold, events that arrive together go out
 * as one push, the daily cap holds what is left for later, and every push
 * carries its "because".
 */
import { describe, expect, test } from 'bun:test';
import { pushPayload } from '@melete/contracts';
import { composeBatch, isQuiet, localTime, planPush, type Waiting } from './policy.ts';

const day = { start: '08:00', end: '22:00', timeZone: 'Europe/London' };
const pacing = { dailyCap: 3, batchMinutes: 10 };
const at = (iso: string) => new Date(iso);

const decision = (id: string, createdAt: string): Waiting => ({
  id,
  kind: 'decision',
  title: 'One decision is waiting',
  body: `Tern & Co: send the refund email? (${id})`,
  because: 'Because it can’t go on until you decide.',
  url: `/#/chat/job_${id}`,
  createdAt: at(createdAt),
});
const settled = (id: string, createdAt: string): Waiting => ({
  id,
  kind: 'settled',
  title: 'A chase settled',
  body: `Halliwell & Fox paid the invoice (${id})`,
  because: 'Because you asked Melete to chase this.',
  url: `/#/chat/job_${id}`,
  createdAt: at(createdAt),
});

describe('quiet hours', () => {
  test('outside the day hours is quiet, in the person’s own time zone', () => {
    // 07:30 in London during British Summer Time is 06:30 UTC.
    expect(isQuiet(at('2026-09-27T06:30:00Z'), day)).toBe(true);
    expect(isQuiet(at('2026-09-27T07:30:00Z'), day)).toBe(false); // 08:30 BST
    expect(isQuiet(at('2026-09-27T21:30:00Z'), day)).toBe(true); // 22:30 BST
  });

  test('a day that ends after midnight wraps', () => {
    const late = { start: '10:00', end: '01:00', timeZone: 'UTC' };
    expect(isQuiet(at('2026-09-27T00:30:00Z'), late)).toBe(false);
    expect(isQuiet(at('2026-09-27T03:00:00Z'), late)).toBe(true);
    expect(isQuiet(at('2026-09-27T23:00:00Z'), late)).toBe(false);
  });

  test('an unknown time zone reads as UTC rather than failing', () => {
    expect(localTime(at('2026-09-27T12:00:00Z'), 'Not/AZone').minutes).toBe(12 * 60);
  });

  test('nothing is sent during quiet hours, however much waits', () => {
    const plan = planPush({
      waiting: [decision('a', '2026-09-26T20:00:00Z')],
      day,
      pacing,
      sentToday: 0,
      now: at('2026-09-27T05:00:00Z'),
    });
    expect(plan).toEqual({ hold: 'quiet' });
  });
});

describe('batching', () => {
  test('a new event waits the batching window for company', () => {
    const plan = planPush({
      waiting: [decision('a', '2026-09-27T09:00:00Z')],
      day,
      pacing,
      sentToday: 0,
      now: at('2026-09-27T09:05:00Z'),
    });
    expect(plan).toEqual({ hold: 'batching' });
  });

  test('several events inside the window go out as one push', () => {
    const plan = planPush({
      waiting: [
        settled('s1', '2026-09-27T09:02:00Z'),
        decision('d1', '2026-09-27T09:00:00Z'),
        decision('d2', '2026-09-27T09:04:00Z'),
      ],
      day,
      pacing,
      sentToday: 0,
      now: at('2026-09-27T09:11:00Z'),
    });
    if (!('send' in plan)) throw new Error(`held: ${JSON.stringify(plan)}`);
    expect(plan.ids).toEqual(['d1', 's1', 'd2']);
    expect(plan.send.title).toBe('Two decisions are waiting');
    expect(plan.send.because).toBe(
      'Because two decisions wait and one chase settled since the last one.',
    );
    // Tapping goes to the first decision, the thing only the person can do.
    expect(plan.send.url).toBe('/#/chat/job_d1');
    expect(pushPayload.parse(plan.send)).toBeTruthy();
  });
});

describe('the daily cap', () => {
  test('once the cap is reached, what waits is held for the next day', () => {
    const plan = planPush({
      waiting: [decision('a', '2026-09-27T09:00:00Z')],
      day,
      pacing,
      sentToday: 3,
      now: at('2026-09-27T12:00:00Z'),
    });
    expect(plan).toEqual({ hold: 'cap' });
  });

  test('under the cap it sends', () => {
    const plan = planPush({
      waiting: [decision('a', '2026-09-27T09:00:00Z')],
      day,
      pacing,
      sentToday: 2,
      now: at('2026-09-27T12:00:00Z'),
    });
    expect('send' in plan).toBe(true);
  });
});

describe('the because line', () => {
  test('a single push carries its own reason', () => {
    const payload = composeBatch([settled('s1', '2026-09-27T09:00:00Z')]);
    expect(payload.because).toBe('Because you asked Melete to chase this.');
    expect(payload.tag).toBe('settled');
  });

  test('every composed push has a non-empty because that fits the payload', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      i % 2 ? decision(`d${i}`, '2026-09-27T09:00:00Z') : settled(`s${i}`, '2026-09-27T09:00:00Z'),
    );
    for (let n = 1; n <= many.length; n++) {
      const payload = pushPayload.parse(composeBatch(many.slice(0, n)));
      expect(payload.because.length).toBeGreaterThan(0);
      expect(payload.because.startsWith('Because')).toBe(true);
    }
  });

  test('stopped conversations and answers fold into a batch that counts them, a stop leading', () => {
    const stop: Waiting = {
      id: 'n1',
      kind: 'needs_you',
      title: 'Book the dentist',
      body: 'The site wants a code sent to your phone.',
      because: 'Because it can’t go on without you.',
      url: '/#/chat/job_n1',
      createdAt: at('2026-09-27T09:00:00Z'),
      urgency: 'soon',
    };
    const answer = (id: string): Waiting => ({
      ...stop,
      id,
      kind: 'done',
      body: `Booked (${id})`,
      because: 'Because it finished while you were away.',
      url: `/#/chat/job_${id}`,
    });
    const both = pushPayload.parse(composeBatch([answer('a1'), stop]));
    expect(both.title).toBe('One conversation needs you');
    expect(both.because).toBe(
      'Because one conversation stopped and one answer came since the last one.',
    );
    expect(both.url).toBe('/#/chat/job_n1');
    const answers = pushPayload.parse(composeBatch([answer('a1'), answer('a2')]));
    expect(answers.title).toBe('Two answers are ready');
  });
});

describe('urgency lanes', () => {
  const noticed = (
    id: string,
    createdAt: string,
    urgency: 'soon' | 'urgent',
    personSet: boolean,
  ): Waiting => ({
    id,
    kind: 'situation',
    title: 'The contract is signed',
    body: 'Due Mon 3:00 PM, and it is not done yet.',
    because: personSet
      ? 'Because you asked Melete to keep this deadline.'
      : 'Because it has a due date.',
    url: '/#/',
    createdAt: at(createdAt),
    urgency,
    personSet,
    ack: `/situations/${id}/ack`,
  });
  // 05:00 UTC is 06:00 in London: quiet.
  const night = at('2026-09-27T05:00:00Z');
  const noon = at('2026-09-27T11:00:00Z');

  test('an urgent deadline the person set goes now, even in quiet hours, alone and with its ack', () => {
    const plan = planPush({
      waiting: [
        decision('a', '2026-09-27T04:00:00Z'),
        noticed('u', '2026-09-27T05:00:00Z', 'urgent', true),
      ],
      day,
      pacing,
      sentToday: 0,
      now: night,
    });
    if (!('send' in plan)) throw new Error(`held: ${plan.hold}`);
    expect(plan.ids).toEqual(['u']);
    expect(plan.urgency).toBe('urgent');
    expect(plan.send.ack).toBe('/situations/u/ack');
    expect(pushPayload.parse(plan.send).because).toContain('you asked');
  });

  test('one the person did not set waits for their day, then goes without the normal batch delay', () => {
    const waiting = [noticed('s', '2026-09-27T10:59:30Z', 'urgent', false)];
    expect(planPush({ waiting, day, pacing, sentToday: 0, now: night })).toEqual({ hold: 'quiet' });
    const plan = planPush({ waiting, day, pacing, sentToday: 0, now: noon });
    expect('send' in plan && plan.ids).toEqual(['s']);
  });

  test('soon waits a minute for company; each lane has its own cap and spills into the next', () => {
    const fresh = [noticed('s', '2026-09-27T10:59:30Z', 'soon', false)];
    expect(planPush({ waiting: fresh, day, pacing, sentToday: 0, now: noon })).toEqual({
      hold: 'batching',
    });
    const ready = [noticed('s', '2026-09-27T10:58:00Z', 'soon', false)];
    const full = { normal: pacing.dailyCap, soon: 0, urgent: 0 };
    const sent = planPush({ waiting: ready, day, pacing, sentToday: full, now: noon });
    expect('send' in sent && sent.urgency).toBe('soon');
    const soonFull = { normal: pacing.dailyCap, soon: 6, urgent: 0 };
    expect(planPush({ waiting: ready, day, pacing, sentToday: soonFull, now: noon })).toEqual({
      hold: 'cap',
    });
    const urgentFull = { normal: 0, soon: 0, urgent: 3 };
    const spilled = planPush({
      waiting: [noticed('u', '2026-09-27T10:58:00Z', 'urgent', true)],
      day,
      pacing,
      sentToday: urgentFull,
      now: night,
    });
    expect(spilled).toEqual({ hold: 'quiet' });
  });
});

describe('what the person timed', () => {
  // Day hours 08:00-22:00 in New York; 10:30 UTC is 06:30 there.
  const dayNY = { start: '08:00', end: '22:00', timeZone: 'America/New_York' };
  const half6 = at('2026-09-28T10:30:00Z');
  const reminder = (id: string, createdAt: string): Waiting => ({
    id,
    kind: 'reminder',
    title: 'Airport',
    body: 'Time to leave for the airport.',
    because: 'Because you asked for this at this time.',
    url: `/#/chat/job_${id}`,
    createdAt: at(createdAt),
  });
  const answer = (id: string, createdAt: string): Waiting => ({
    id,
    kind: 'done',
    title: 'Trip notes',
    body: 'I tidied the packing list.',
    because: 'Because it finished while you were away.',
    url: `/#/chat/job_${id}`,
    createdAt: at(createdAt),
    urgency: 'soon',
  });

  test('a 06:30 reminder goes at 06:30, before the day starts', () => {
    expect(isQuiet(half6, dayNY)).toBe(true);
    const plan = planPush({
      waiting: [reminder('r', '2026-09-28T10:30:00Z')],
      day: dayNY,
      pacing,
      sentToday: 0,
      now: half6,
    });
    if (!('send' in plan)) throw new Error(`held: ${plan.hold}`);
    expect(plan.ids).toEqual(['r']);
    expect(plan.onTime).toBe(true);
    expect(pushPayload.parse(plan.send)).toMatchObject({
      title: 'Airport',
      body: 'Time to leave for the airport.',
      because: 'Because you asked for this at this time.',
      tag: 'reminder:r',
    });
  });

  test('no cap holds it back, and it does not wait for company', () => {
    const plan = planPush({
      waiting: [reminder('r', '2026-09-28T16:00:00Z')],
      day: dayNY,
      pacing,
      sentToday: { normal: pacing.dailyCap, soon: 6, urgent: 3 },
      now: at('2026-09-28T16:00:00Z'),
    });
    expect('send' in plan && plan.ids).toEqual(['r']);
  });

  test('what Melete says by itself still waits for the day, even beside a reminder', () => {
    const notice = answer('d', '2026-09-28T10:00:00Z');
    expect(planPush({ waiting: [notice], day: dayNY, pacing, sentToday: 0, now: half6 })).toEqual({
      hold: 'quiet',
    });
    const plan = planPush({
      waiting: [notice, reminder('r', '2026-09-28T10:30:00Z')],
      day: dayNY,
      pacing,
      sentToday: 0,
      now: half6,
    });
    expect('send' in plan && plan.ids).toEqual(['r']);
  });

  test('two that come due together go as one push that counts them', () => {
    const plan = planPush({
      waiting: [reminder('a', '2026-09-28T10:30:00Z'), reminder('b', '2026-09-28T10:30:10Z')],
      day: dayNY,
      pacing,
      sentToday: 0,
      now: half6,
    });
    if (!('send' in plan)) throw new Error(`held: ${plan.hold}`);
    expect(plan.ids).toEqual(['a', 'b']);
    expect(pushPayload.parse(plan.send)).toMatchObject({
      title: 'Two things you asked for',
      because: 'Because you asked for these at this time.',
      tag: 'reminder:a',
    });
  });
});
