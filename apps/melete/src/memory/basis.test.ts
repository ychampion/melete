import { describe, expect, test } from 'bun:test';
import { bearsOn, beliefTerms } from './basis.ts';

const beliefs = {
  tea: beliefTerms('pref.drink.kind', 'tea, never coffee after noon'),
  sister: beliefTerms('contact.priya.relation', 'Priya is my sister, priya@example.com'),
  dentist: beliefTerms('event.dentist.time', 'Dentist appointment on Friday at 3pm'),
  dinner: beliefTerms('pref.dinner.time', 'seven'),
  phone: beliefTerms('contact.sam.phone', '+1 (415) 555-0134'),
};

describe('a recalled belief is named only when the action bears on it', () => {
  test('saving a test file has nothing to do with drinks, family or the dentist', () => {
    const save = { path: 'approve-test.txt', content: 'approval test\n' };
    for (const terms of Object.values(beliefs)) expect(bearsOn(save, terms)).toBe(false);
  });

  test('a message to the person the belief is about', () => {
    const send = { to: ['priya@example.com'], subject: 'Sunday', body: 'Lunch?' };
    expect(bearsOn(send, beliefs.sister)).toBe(true);
    expect(bearsOn(send, beliefs.tea)).toBe(false);
    expect(bearsOn({ to: 'Priya <p@example.org>', body: 'hi' }, beliefs.sister)).toBe(true);
  });

  test('an event or text that names what the belief holds', () => {
    expect(bearsOn({ summary: 'Dentist', start: '2026-10-03T15:00:00Z' }, beliefs.dentist)).toBe(
      true,
    );
    expect(bearsOn({ body: 'Dinner at seven?' }, beliefs.dinner)).toBe(true);
    expect(bearsOn({ to: '4155550134', body: 'Running late' }, beliefs.phone)).toBe(true);
  });

  test('common words alone tie nothing together', () => {
    const terms = beliefTerms('pref.email.time', 'Prefers email in the morning');
    expect(terms).not.toContain('email');
    expect(terms).not.toContain('prefers');
    expect(bearsOn({ subject: 'Your email', body: 'Sent today' }, terms)).toBe(false);
  });

  test('an action with nothing to read bears on nothing', () => {
    expect(bearsOn(null, beliefs.tea)).toBe(false);
    expect(bearsOn({}, beliefs.tea)).toBe(false);
  });
});
