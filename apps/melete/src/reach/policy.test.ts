import { describe, expect, test } from 'bun:test';
import {
  agreedWording,
  DAILY_CAPS,
  decideRung,
  type RungInput,
  replyKind,
  textBody,
} from './policy.ts';

const NUMBER = '+15550002222';
const agreed = { number: NUMBER, texts: true, calls: true, nights: false };
const open = { live: true, urgent: true, personSet: true, acked: false };

const base = (over: Partial<RungInput> = {}): RungInput => ({
  channel: 'text',
  situation: open,
  number: NUMBER,
  consent: agreed,
  optedOut: false,
  providerReady: true,
  sentToday: { text: 0, call: 0 },
  day: { start: '08:00', end: '22:00', timeZone: 'America/Los_Angeles' },
  // Noon in Los Angeles.
  now: new Date('2026-10-05T19:00:00Z'),
  ...over,
});

describe('a rung of the ladder', () => {
  test('goes to the verified number only, while it is unacknowledged and agreed to', () => {
    expect(decideRung(base())).toEqual({ send: true, to: NUMBER });
    expect(decideRung(base({ channel: 'call' }))).toEqual({ send: true, to: NUMBER });
    // An agreement given for another number covers nothing.
    expect(decideRung(base({ consent: { ...agreed, number: '+15550003333' } })).send).toBe(false);
    expect(decideRung(base({ number: null })).send).toBe(false);
    expect(decideRung(base({ consent: null })).send).toBe(false);
  });

  test('stops once it is seen or settled, and never for something the person did not set', () => {
    expect(decideRung(base({ situation: { ...open, acked: true } }))).toMatchObject({
      send: false,
      cancel: true,
    });
    expect(decideRung(base({ situation: { ...open, live: false } }))).toMatchObject({
      send: false,
      cancel: true,
    });
    expect(decideRung(base({ situation: null })).send).toBe(false);
    expect(decideRung(base({ situation: { ...open, personSet: false } })).send).toBe(false);
    expect(decideRung(base({ situation: { ...open, urgent: false } })).send).toBe(false);
  });

  test('keeps to six texts and three calls a day', () => {
    expect(decideRung(base({ sentToday: { text: DAILY_CAPS.text - 1, call: 0 } })).send).toBe(true);
    expect(decideRung(base({ sentToday: { text: DAILY_CAPS.text, call: 0 } })).send).toBe(false);
    expect(decideRung(base({ channel: 'call', sentToday: { text: 6, call: 2 } })).send).toBe(true);
    expect(decideRung(base({ channel: 'call', sentToday: { text: 0, call: 3 } })).send).toBe(false);
  });

  test('holds outside the person’s day unless they asked for nights', () => {
    // Two in the morning in Los Angeles.
    const night = new Date('2026-10-05T09:00:00Z');
    expect(decideRung(base({ now: night }))).toMatchObject({ send: false });
    expect(decideRung(base({ now: night, channel: 'call' })).send).toBe(false);
    expect(decideRung(base({ now: night, consent: { ...agreed, nights: true } })).send).toBe(true);
  });

  test('a STOP, texts only, or no provider says why it stops', () => {
    expect(decideRung(base({ optedOut: true })).send).toBe(false);
    expect(decideRung(base({ channel: 'call', consent: { ...agreed, calls: false } }))).toEqual({
      send: false,
      reason: 'You chose texts only, so Melete didn’t call.',
    });
    expect(decideRung(base({ providerReady: false }))).toMatchObject({
      send: false,
      reason: expect.stringContaining('push only'),
    });
  });
});

describe('a reply to Melete’s number', () => {
  test('the words that end consent end it', () => {
    for (const word of [
      'STOP',
      'stop',
      'Stop.',
      'STOPALL',
      'quit',
      'END',
      'revoke',
      'opt out',
      'Cancel',
      'unsubscribe',
      'please stop texting me',
      'Stop calling',
    ])
      expect([word, replyKind(word)]).toEqual([word, 'stop']);
  });

  test('START undoes it, HELP asks, and anything else is an answer', () => {
    expect(replyKind('START')).toBe('start');
    expect(replyKind('unstop')).toBe('start');
    expect(replyKind('HELP')).toBe('help');
    expect(replyKind('ok seen it')).toBe('answer');
    expect(replyKind('on it, sending now')).toBe('answer');
  });
});

describe('what is said and recorded', () => {
  test('the text names the deadline in Melete’s words and says how to stop', () => {
    const body = textBody('The contract is signed', 'Due Mon 3:00 PM, and it is not done yet.');
    expect(body).toContain('The contract is signed');
    expect(body).toContain('Reply STOP');
    expect(body.length).toBeLessThanOrEqual(320);
  });

  test('the recorded agreement has the number and only what was agreed', () => {
    const texts = agreedWording(NUMBER, { calls: false, nights: false });
    expect(texts).toContain(NUMBER);
    expect(texts).not.toContain('may call');
    expect(agreedWording(NUMBER, { calls: true, nights: true })).toContain(`may call ${NUMBER}`);
  });
});
