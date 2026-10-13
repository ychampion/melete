import { describe, expect, test } from 'bun:test';
import {
  cityFromTimeZone,
  DEFAULT_STARTERS,
  fillStarter,
  STARTER_CHAT_LIMIT,
  STARTER_LIMIT,
  type StarterTask,
  starterList,
  starterVisibility,
} from './starters.ts';

const base: StarterTask = {
  id: 'one',
  label: 'One',
  text: 'Do one thing.',
  icon: 'sparkles',
  capability: 'other',
};

describe('the built-in starters', () => {
  test('are four to six, valid, and each shows something different', () => {
    expect(starterList.safeParse(DEFAULT_STARTERS).success).toBe(true);
    expect(DEFAULT_STARTERS.length).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_STARTERS.length).toBeLessThanOrEqual(STARTER_LIMIT);
    const shown = new Set(DEFAULT_STARTERS.map((starter) => starter.capability));
    expect(shown.size).toBe(DEFAULT_STARTERS.length);
  });

  test('never ask to message anyone, buy anything or sign in somewhere', () => {
    for (const starter of DEFAULT_STARTERS)
      expect([
        starter.id,
        /\b(email|text|message|call|send|buy|order|pay|book|log ?in|sign ?in)\b/i.test(
          starter.text,
        ),
      ]).toEqual([starter.id, false]);
  });
});

describe('a starter in the composer', () => {
  test('the city goes into the blank, selected so typing replaces it', () => {
    const coffee = DEFAULT_STARTERS[0] as StarterTask;
    const filled = fillStarter(coffee, 'Los Angeles');
    expect(filled.text).toBe(
      'Find 3 well-reviewed coffee shops near Los Angeles and put them in a short list.',
    );
    expect(filled.text.slice(filled.select?.start, filled.select?.end)).toBe('Los Angeles');
  });

  test('without a city it asks for one', () => {
    const filled = fillStarter(DEFAULT_STARTERS[0] as StarterTask, null);
    expect(filled.text).toContain('near your city and');
    expect(filled.text.slice(filled.select?.start, filled.select?.end)).toBe('your city');
  });

  test('a blank loses its brackets and is selected; no blank leaves the cursor to the page', () => {
    const trip = fillStarter({ ...base, text: 'Plan a 3-day trip to [a city] on a budget.' }, null);
    expect(trip.text).toBe('Plan a 3-day trip to a city on a budget.');
    expect(trip.select).toEqual({ start: 21, end: 27 });
    expect(fillStarter(base, 'Paris')).toMatchObject({ text: 'Do one thing.', select: null });
  });
});

describe('an operator’s list', () => {
  test('is refused when it repeats an id, runs past six, or misuses brackets', () => {
    expect(starterList.safeParse([base, base]).success).toBe(false);
    expect(
      starterList.safeParse(
        Array.from({ length: STARTER_LIMIT + 1 }, (_, n) => ({ ...base, id: `s${n}` })),
      ).success,
    ).toBe(false);
    expect(starterList.safeParse([]).success).toBe(false);
    expect(starterList.safeParse([{ ...base, text: 'From [here] to [there]' }]).success).toBe(
      false,
    );
    expect(starterList.safeParse([{ ...base, text: 'Half a [bracket' }]).success).toBe(false);
    expect(starterList.safeParse([{ ...base, icon: 'rocket' }]).success).toBe(false);
    expect(starterList.safeParse([{ ...base, id: 'Has Spaces' }]).success).toBe(false);
    expect(starterList.safeParse([{ ...base, extra: true }]).success).toBe(false);
    expect(starterList.safeParse([{ ...base, text: 'Watch [a page] for {city}' }]).success).toBe(
      true,
    );
  });
});

test('a time zone names a city only when it is one', () => {
  expect(cityFromTimeZone('America/Los_Angeles')).toBe('Los Angeles');
  expect(cityFromTimeZone('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  expect(cityFromTimeZone('Asia/Kolkata')).toBe('Kolkata');
  for (const zone of ['UTC', 'Etc/GMT+5', 'US/Pacific', '', null, undefined])
    expect(cityFromTimeZone(zone)).toBeNull();
});

test('starters are offered after setup, until three chats or until put away', () => {
  const at = (chats: number, dismissed = false, onboarded = true) =>
    starterVisibility({ chats, dismissed, onboarded });
  expect(at(0, false, false)).toEqual({ show: false, reason: 'not_onboarded' });
  expect(at(0)).toEqual({ show: true, reason: null });
  expect(at(STARTER_CHAT_LIMIT - 1)).toEqual({ show: true, reason: null });
  expect(at(STARTER_CHAT_LIMIT)).toEqual({ show: false, reason: 'has_chats' });
  expect(at(STARTER_CHAT_LIMIT + 5)).toEqual({ show: false, reason: 'has_chats' });
  expect(at(0, true)).toEqual({ show: false, reason: 'dismissed' });
});
