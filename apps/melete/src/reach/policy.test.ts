import { describe, expect, test } from 'bun:test';
import {
  agreedWording,
  callWords,
  codeAllowed,
  DAILY_CAPS,
  decideRung,
  providerAnswers,
  type RungInput,
  replyKind,
  TEXT_BODY,
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
  textWent: true,
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

  test('a day with no clear hours, or none known, counts as night', () => {
    expect(decideRung(base({ day: null })).send).toBe(false);
    expect(
      decideRung(base({ day: { start: '09:00', end: '09:00', timeZone: 'America/Los_Angeles' } }))
        .send,
    ).toBe(false);
    expect(decideRung(base({ day: null, consent: { ...agreed, nights: true } })).send).toBe(true);
  });

  test('a call follows only a text that went out', () => {
    expect(decideRung(base({ channel: 'call', textWent: false }))).toEqual({
      send: false,
      reason: 'The text before it didn’t go, so Melete didn’t call.',
    });
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
  test('any reasonable way of saying stop ends it, in any case and with either apostrophe', () => {
    for (const words of [
      'STOP',
      'stop',
      'Stop.',
      'STOPALL',
      'quit',
      'END',
      'revoke',
      'opt out',
      'opt-out',
      'Cancel',
      'unsubscribe',
      'Please stop',
      'please STOP!',
      'Cancel texts',
      'opt out please',
      'End texts',
      "don't text me",
      'don’t text me',
      'Don’t call me again',
      'do not call me',
      'No more texts',
      'never message me',
      'please stop texting me',
      'Stop calling',
      'leave me alone',
      'remove me from this',
    ])
      expect([words, replyKind(words)]).toEqual([words, 'stop']);
  });

  test('START undoes it, HELP asks, and a plain answer counts as seen', () => {
    expect(replyKind('START')).toBe('start');
    expect(replyKind('unstop')).toBe('start');
    expect(replyKind('HELP')).toBe('help');
    for (const words of ['ok', 'OK', 'seen', 'got it', '1', 'on it, sending now', 'thanks'])
      expect([words, replyKind(words)]).toEqual([words, 'answer']);
  });

  test('only the provider’s own keywords are left for it to confirm', () => {
    expect(providerAnswers('STOP')).toBe(true);
    expect(providerAnswers(' cancel ')).toBe(true);
    expect(providerAnswers('Please stop')).toBe(false);
    expect(providerAnswers('don’t text me')).toBe(false);
  });
});

describe('where codes may go', () => {
  test('the US and Canada by default, never the Caribbean area codes under +1', () => {
    expect(codeAllowed('+14155550100', ['+1'])).toBe(true);
    expect(codeAllowed('+16045550100', ['+1'])).toBe(true);
    expect(codeAllowed('+18765550100', ['+1'])).toBe(false);
    expect(codeAllowed('+18095550100', ['+1'])).toBe(false);
    expect(codeAllowed('+447700900100', ['+1'])).toBe(false);
  });

  test('an operator adds countries, or a Caribbean area code by name', () => {
    expect(codeAllowed('+447700900100', ['+1', '+44'])).toBe(true);
    expect(codeAllowed('+18765550100', ['+1', '+1876'])).toBe(true);
  });
});

describe('what is said and recorded', () => {
  test('a text and a call say only that a deadline is at risk, how to answer and how to stop', () => {
    expect(TEXT_BODY).toContain('a deadline you set is at risk');
    expect(TEXT_BODY).toContain('STOP');
    expect(TEXT_BODY.length).toBeLessThanOrEqual(160);
    const call = callWords('+15550001000');
    expect(call.lead).toStartWith('This is Melete');
    expect(call.keys).toContain('Press 9');
    // How to reach Melete back: its number, read digit by digit.
    expect(call.after).toContain('1 5 5 5 0 0 0 1 0 0 0');
  });

  test('the recorded agreement has the number and only what was agreed', () => {
    const texts = agreedWording(NUMBER, { calls: false, nights: false });
    expect(texts).toContain(NUMBER);
    expect(texts).not.toContain('may call');
    expect(agreedWording(NUMBER, { calls: true, nights: true })).toContain(`may call ${NUMBER}`);
  });
});
