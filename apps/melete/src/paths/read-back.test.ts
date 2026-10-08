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

  test('a server error after the form left may have landed, so it is unclear, never not done', () => {
    // A gateway timing out in front of a site that took the booking answers 502 or 504.
    for (const status of [500, 502, 503, 504])
      expect(
        readBack(sent, page({ status, tree: '- heading "Something went wrong"' })).verdict,
      ).toBe('unclear');
  });

  test('words in the body text alone do not say a submit failed', () => {
    // A booked page with no stock phrase for it, and a line about cancelling.
    expect(
      readBack(
        sent,
        page({
          tree: '- heading "Your table for 2, Saturday 7:00 pm"\n- paragraph: Unable to make it? Cancel below.',
        }),
      ).verdict,
    ).toBe('unclear');
    expect(
      readBack(
        sent,
        page({
          tree: '- heading "Reservation details"\n- paragraph: Fields marked * are required',
        }),
      ).verdict,
    ).toBe('unclear');
    // The same body text with the form sent back is the site refusing it.
    expect(
      readBack(
        sent,
        page({ forms: [{ ...sent }], tree: '- paragraph: Please enter a valid phone number' }),
      ).verdict,
    ).toBe('not_done');
    expect(readBack(sent, page({ tree: '- heading "Something went wrong"' })).verdict).toBe(
      'not_done',
    );
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

  test('only the structure of the page hands it over: a bot check it shows, never words about one', () => {
    expect(blockerOf(page({ challenge: true }))).toBe('captcha');
    expect(readBack(sent, page({ challenge: true }))).toMatchObject({
      verdict: 'unclear',
      blocker: 'captcha',
    });
    // Words alone, wherever they are, ask nothing of the person.
    for (const tree of [
      '- paragraph: This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.',
      '- iframe "reCAPTCHA"',
      '- heading "Enter the code we sent to your phone"',
      '- heading "Two-factor authentication"',
    ])
      expect(blockerOf(page({ tree }))).toBeNull();
    for (const label of ['Card number', 'Billing address', 'Passport expiration date'])
      expect(blockerOf(page({ schema: [{ label, role: 'textbox' }] }))).toBeNull();
    expect(
      readBack(
        sent,
        page({
          tree: '- heading "Thanks for your message"\n- paragraph: This site is protected by reCAPTCHA.',
        }),
      ),
    ).toMatchObject({ verdict: 'done', blocker: null });
  });

  test('a page that shows back what was sent must show all of it', () => {
    const form = {
      ...sent,
      fields: {
        custname: 'Ada Lovelace',
        custtel: '555-0100',
        size: 'medium',
        comments: 'Ring twice',
      },
    };
    // An echo page, as a form tester shows it: the fields by name, with what arrived.
    const echoed = (shown: Record<string, string>) =>
      page({
        tree: `- text: ${JSON.stringify({ form: shown })}`,
      });
    expect(readBack(form, echoed({ custname: 'Ada Lovelace', custtel: '555-0100' }))).toMatchObject(
      {
        verdict: 'not_done',
        evidence: 'The page shows what was sent except size, comments.',
      },
    );
    expect(
      readBack(
        form,
        echoed({
          custname: 'Ada Lovelace',
          custtel: '555-0100',
          size: 'medium',
          comments: 'Ring twice',
        }),
      ),
    ).toMatchObject({ verdict: 'done', evidence: 'The page shows every value that was sent.' });
    // A thank-you note that greets the person by name is not an echo page.
    expect(readBack(form, page({ tree: '- heading "Thank you, Ada Lovelace"' })).verdict).toBe(
      'done',
    );
  });
});
