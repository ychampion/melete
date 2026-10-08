import { describe, expect, test } from 'bun:test';
import { blockerOf, type PageSeen, readBack } from './read-back.ts';

const sent = { url: 'https://book.example/reserve', name: 'Book', form_hash: 'a'.repeat(64) };
const page = (over: Partial<PageSeen> = {}): PageSeen => ({
  url: 'https://book.example/done',
  title: '',
  tree: '',
  schema: [],
  forms: [],
  ...over,
});

describe('reading a page back after a submit', () => {
  test('a confirmation on the page is done, with what it said', () => {
    const seen = readBack(
      sent,
      page({ title: 'Reservation', tree: '- heading "Your reservation is confirmed" [level=1]' }),
    );
    expect(seen).toMatchObject({ verdict: 'done', blocker: null, looks: 1 });
    expect(seen.evidence).toContain('reservation is confirmed');
  });

  test('an error on the page, or an error status, is not done', () => {
    expect(
      readBack(sent, page({ tree: '- alert: That time is no longer available' })).verdict,
    ).toBe('not_done');
    expect(
      readBack(sent, page({ status: 422, tree: '- heading "Thanks for booking"' })),
    ).toMatchObject({ verdict: 'not_done', evidence: 'The site answered 422 to the form.' });
  });

  test('a page that says nothing, or says both, is unclear', () => {
    expect(readBack(sent, page({ tree: '- heading "Book a table"' })).verdict).toBe('unclear');
    expect(
      readBack(sent, page({ tree: '- status: Booking confirmed\n- alert: Payment failed' }))
        .verdict,
    ).toBe('unclear');
    expect(
      readBack(sent, page({ forms: [{ ...sent }], tree: '- heading "Book a table"' })).evidence,
    ).toBe('The same form is back with nothing said about it.');
    expect(readBack(sent, null).verdict).toBe('unclear');
  });

  test('words in the page furniture do not decide it', () => {
    // A link or a button saying "error" or "thank you" is not the page speaking.
    expect(
      readBack(sent, page({ tree: '- link "Report an error"\n- button "Thank you notes"' }))
        .verdict,
    ).toBe('unclear');
  });

  test('a check for a person, a code or a card is a blocker only the person can pass', () => {
    expect(blockerOf(page({ tree: '- iframe "reCAPTCHA"' }))).toBe('captcha');
    expect(blockerOf(page({ tree: '- heading "Enter the code we sent to your phone"' }))).toBe(
      'two_factor',
    );
    expect(
      blockerOf(page({ schema: [{ label: 'Card number', role: 'textbox', sensitive: true }] })),
    ).toBe('payment');
    // A footer link about security settings asks for nothing.
    expect(blockerOf(page({ tree: '- link "Set up two-factor authentication"' }))).toBeNull();
    expect(readBack(sent, page({ tree: '- iframe "reCAPTCHA"' }))).toMatchObject({
      verdict: 'unclear',
      blocker: 'captcha',
    });
  });
});
