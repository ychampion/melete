import { describe, expect, test } from 'bun:test';
import { FIXTURE_MESSAGE_COUNT, FIXTURE_REFERENCE, fixtureMessages } from './fixtures.ts';
import { messageText, registrableDomain, senderAddress, withheldFromScan } from './messages.ts';
import { isCandidate, prefilter } from './prefilter.ts';

const now = new Date(FIXTURE_REFERENCE);
const message = (over: Partial<Parameters<typeof isCandidate>[0]> = {}) => ({
  messageId: '<a@example.test>',
  from: 'Acme <billing@acme.example>',
  to: 'you@example.test',
  subject: 'Hello',
  text: 'Nothing to see.',
  receivedAt: FIXTURE_REFERENCE,
  ...over,
});

describe('company identity', () => {
  test('a company is its registrable domain, so subdomains are one company', () => {
    expect(registrableDomain('billing@mail.acme.example')).toBe('acme.example');
    expect(registrableDomain('care@acme.co.uk')).toBe('acme.co.uk');
    expect(registrableDomain('care@mail.acme.co.uk')).toBe('acme.co.uk');
    expect(registrableDomain('nonsense')).toBe(null);
  });

  test('the address is read out of a display-name header', () => {
    expect(senderAddress('Acme Billing <billing@acme.example>')).toBe('billing@acme.example');
    expect(senderAddress('billing@acme.example')).toBe('billing@acme.example');
    expect(senderAddress('Acme Billing')).toBe(null);
  });
});

describe('the candidate filter', () => {
  test('selects a message that names money or a deadline', () => {
    expect(isCandidate(message({ text: 'Your refund of GBP 12.00 is on its way.' }))).toBe(true);
    expect(isCandidate(message({ subject: 'Your subscription renews soon' }))).toBe(true);
    expect(isCandidate(message({ text: 'We will reply within 5 working days.' }))).toBe(true);
  });

  test('passes over a message that names neither', () => {
    expect(isCandidate(message({ subject: 'Sunday', text: 'Are you around on Sunday?' }))).toBe(
      false,
    );
  });
});

describe('the prefilter over the fixture mailbox', () => {
  const result = prefilter(fixtureMessages(), { now, windowDays: 90 });

  test('withholds authentication mail before anything else sees it', () => {
    expect(result.counts.withheld).toBe(3);
    const texts = result.companies.flatMap((group) =>
      group.candidates.map((candidate) => candidate.text),
    );
    expect(texts.some((text) => /OTP|magic link|reset your password/i.test(text))).toBe(false);
  });

  test('groups every message by sender domain', () => {
    expect(result.counts.seen).toBe(FIXTURE_MESSAGE_COUNT);
    expect(result.counts.inWindow).toBe(FIXTURE_MESSAGE_COUNT);
    const domains = result.companies.map((group) => group.domain);
    expect(domains).toContain('nimbusledger.example');
    expect(domains).toContain('beaconfibre.example');
    // Four messages from Nimbus Ledger, one of which hygiene withheld before grouping.
    const nimbus = result.companies.find((group) => group.domain === 'nimbusledger.example');
    expect(nimbus?.messageCount).toBe(3);
    expect(nimbus?.name).toBe('Nimbus Ledger');
  });

  test('a newsletter is counted as marketing and never as a ledger candidate', () => {
    const letter = result.companies.find((group) => group.domain === 'longshoreletter.example');
    expect(letter?.marketingCount).toBe(1);
    expect(letter?.candidates).toEqual([]);
  });

  test('a message older than the window is not read', () => {
    const old = prefilter(fixtureMessages(), { now, windowDays: 7 });
    expect(old.counts.inWindow).toBeLessThan(result.counts.inWindow);
  });

  test('a colleague writing from the studio’s own domain is not a company', () => {
    const inside = result.companies.find((group) => group.domain === 'thackeraylane.example');
    expect(inside?.candidates).toEqual([]);
  });
});

describe('the stored text', () => {
  test('leads with the subject, so a quote can reach a figure stated only there', () => {
    const text = messageText({ subject: 'Your price is changing', text: 'Body.' });
    expect(text).toBe('Subject: Your price is changing\n\nBody.');
    expect(text.slice(9, 31)).toBe('Your price is changing');
  });
});

describe('hygiene', () => {
  test('is the connector’s own filter, applied to the scan', () => {
    expect(withheldFromScan(message({ text: 'Your OTP is 449120.' }))).toBe(true);
    expect(withheldFromScan(message({ text: 'Your refund is on its way.' }))).toBe(false);
  });
});

test('a company whose domain is not ASCII is still a company', () => {
  expect(registrableDomain('rechnung@bücher.example')).toBe('xn--bcher-kva.example');
  expect(registrableDomain('rechnung@mail.xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
});

test('a rendered From that holds two addresses in one part is nobody’s mail', () => {
  const result = prefilter(
    [
      message({ from: '"Acme" <billing@acme.example> "" <x@evil.test>' }),
      message({ messageId: '<b@example.test>', from: 'x@evil.test, Acme <billing@acme.example>' }),
    ],
    { now: new Date(FIXTURE_REFERENCE), windowDays: 90 },
  );
  expect(result.companies.map((group) => group.domain)).toEqual([]);
  expect(result.counts.noSender).toBe(2);
});
