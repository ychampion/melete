import { describe, expect, test } from 'bun:test';
import { claimsContinuation, unbackedClaims, withoutUnbackedClaims } from './claims.ts';

const families = (text: string, called: string[] = []) =>
  unbackedClaims(text, called).map((claim) => claim.family);

describe('a reply’s claims against the turn’s tools', () => {
  test('each delivery claim with no tool behind it is found', () => {
    expect(families('I’ve sent the email to Dana.')).toEqual(['sent']);
    expect(families('The invite has been sent.')).toEqual(['sent']);
    expect(families('I saved the report to your Files.')).toEqual(['saved']);
    expect(families('I added the dentist to your calendar for Tuesday.')).toEqual(['added']);
    expect(families('I booked a table for two at 7.')).toEqual(['booked']);
    expect(families('Your reservation has been booked.')).toEqual(['booked']);
    expect(families('I cancelled the subscription.')).toEqual(['closed']);
    expect(families('I’ve attached the packing list.')).toEqual(['attached']);
  });

  test('a method claim needs a browser, the computer or a page fetched', () => {
    expect(families('I checked in my browser and it is sold out.', ['web.search'])).toEqual([
      'browser',
    ]);
    expect(families('I opened their website and the hours are 9 to 5.', ['web.search'])).toEqual([
      'browser',
    ]);
    expect(families('I checked in my browser and it is sold out.', ['browser.open'])).toEqual([]);
    expect(families('I opened their website and the hours are 9 to 5.', ['web.fetch'])).toEqual([]);
  });

  test('the tool that does the step backs the claim', () => {
    expect(families('I’ve sent the email to Dana.', ['email.send'])).toEqual([]);
    expect(families('I added it to your calendar.', ['calendar.create'])).toEqual([]);
    expect(families('I booked a table for two at 7.', ['browser.submit'])).toEqual([]);
    expect(families('I saved the report to your Files.', ['files.write'])).toEqual([]);
    expect(families('I’ve attached the packing list.', ['artifact.publish'])).toEqual([]);
    // A draft is not a send.
    expect(families('I’ve sent the email to Dana.', ['email.draft'])).toEqual(['sent']);
  });

  test('offers, plans, negations, quotes and code are not claims', () => {
    for (const text of [
      'I can send it to Dana if you like.',
      'I’ll book the table once you pick a time.',
      'I haven’t sent anything yet.',
      'I have not booked it.',
      'Want me to add it to your calendar?',
      'I ordered the list by price.',
      'I saved you a step by grouping them.',
      '> I’ve sent the invoice and attached the receipt.',
      '```\nI booked it\n```',
      'The PDF you attached lists three dates.',
    ])
      expect(families(text)).toEqual([]);
  });

  test('a drafted message may say attached in its own words', () => {
    expect(families('Draft: the invoice is attached.', ['email.draft'])).toEqual([]);
  });

  test('the continuation names what was claimed and asks for the whole reply again', () => {
    const text = claimsContinuation(unbackedClaims('I sent it to Dana.', []));
    expect(text).toContain('"I sent it to Dana." (sending something)');
    expect(text).toContain('write your whole reply to the person again');
  });
});

describe('what still claims an undone step when the turn is saved', () => {
  test('the sentence goes and the rest of the reply stays', () => {
    const reply =
      'The clinic has a slot on Tuesday at 9. I booked it for you. Bring your insurance card.';
    expect(withoutUnbackedClaims(reply, [])).toBe(
      'The clinic has a slot on Tuesday at 9. Bring your insurance card.',
    );
    expect(withoutUnbackedClaims(reply, ['browser.submit'])).toBe(reply);
  });

  test('a list item that held only the claim goes with it', () => {
    const reply =
      'Done:\n- Found three dentists near you.\n- I emailed Dr. Rao.\n- Compared prices.';
    expect(withoutUnbackedClaims(reply, ['web.search'])).toBe(
      'Done:\n- Found three dentists near you.\n- Compared prices.',
    );
  });

  test('an attached claim is left to its own note, and a reply that is only a claim stays', () => {
    expect(withoutUnbackedClaims('I’ve attached the list. Enjoy.', [])).toBe(
      'I’ve attached the list. Enjoy.',
    );
    expect(withoutUnbackedClaims('I sent it.', [])).toBe('I sent it.');
  });

  test('the same reply and tools always give the same answer', () => {
    const reply = 'I cancelled the order. It was a duplicate.';
    expect(withoutUnbackedClaims(reply, [])).toBe(withoutUnbackedClaims(reply, []));
    expect(withoutUnbackedClaims(reply, [])).toBe('It was a duplicate.');
  });
});
