import { describe, expect, test } from 'bun:test';
import { PRIVACY_CATEGORIES, type PrivacyCategory } from '@melete/contracts';
import {
  abaRouting,
  cardNumber,
  cpf,
  detect,
  ibanValid,
  luhn,
  nhsNumber,
  spanishId,
  verhoeff,
} from './detect.ts';

const ALL = new Set<PrivacyCategory>(PRIVACY_CATEGORIES);

/** What each detection covers, as [category, text]. */
const found = (text: string) =>
  detect(text, ALL).map((span) => [span.category, text.slice(span.start, span.end)]);

describe('checksums', () => {
  test('Luhn, card networks and the ABA routing checksum', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
    expect(cardNumber('4111111111111111')).toBe(true);
    expect(cardNumber('378282246310005')).toBe(true);
    expect(cardNumber('5555555555554444')).toBe(true);
    // Luhn-valid but no card network starts with 9 and has this length.
    expect(cardNumber('9111111111111110')).toBe(false);
    expect(abaRouting('021000021')).toBe(true);
    expect(abaRouting('011401533')).toBe(true);
    expect(abaRouting('021000022')).toBe(false);
    // A valid checksum with a prefix the Federal Reserve never assigns.
    expect(abaRouting('990000009')).toBe(false);
  });

  test('IBAN mod-97, Verhoeff, NHS mod-11, CPF and DNI letters', () => {
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
    expect(verhoeff('234123412346')).toBe(true);
    expect(verhoeff('234123412345')).toBe(false);
    expect(nhsNumber('9434765919')).toBe(true);
    expect(nhsNumber('9434765918')).toBe(false);
    expect(cpf('52998224725')).toBe(true);
    expect(cpf('11111111111')).toBe(false);
    expect(spanishId('12345678Z')).toBe(true);
    expect(spanishId('12345678A')).toBe(false);
    expect(spanishId('X1234567L')).toBe(true);
  });
});

describe('detectors find what they are for', () => {
  const cases: [string, PrivacyCategory, string][] = [
    ['Card: 4111 1111 1111 1111, exp 09/28', 'card', '4111 1111 1111 1111'],
    ['amex 3782-822463-10005 please', 'card', '3782-822463-10005'],
    ['the CVV is 737', 'card', '737'],
    ['My checking account number is 000123456789.', 'account', '000123456789'],
    ['Pay from my savings account 4400 1234 5678.', 'account', '4400 1234 5678'],
    ['the card ending in 4242 was declined', 'account', '4242'],
    ['IBAN GB82 WEST 1234 5698 7654 32 for rent', 'account', 'GB82 WEST 1234 5698 7654 32'],
    ['Routing number: 021000021', 'routing', '021000021'],
    ['ABA routing for Chase is 021000021', 'routing', '021000021'],
    ['sort code 20-00-00', 'routing', '20-00-00'],
    ['IFSC HDFC0001234', 'routing', 'HDFC0001234'],
    ['SSN 123-45-6789 on file', 'ssn', '123-45-6789'],
    ['my social security number is 123456789', 'ssn', '123456789'],
    ['ITIN 912-70-1234', 'tax_id', '912-70-1234'],
    ['Our EIN is 12-3456789.', 'tax_id', '12-3456789'],
    ['PAN ABCPE1234F', 'tax_id', 'ABCPE1234F'],
    ['NI number AB 12 34 56 C', 'national_id', 'AB 12 34 56 C'],
    ['Aadhaar 2341 2341 2346', 'national_id', '2341 2341 2346'],
    ['CPF 529.982.247-25', 'national_id', '529.982.247-25'],
    ['DNI 12345678Z', 'national_id', '12345678Z'],
    ['SIN 130 692 544', 'national_id', '130 692 544'],
    ['passport number is 533380006', 'passport', '533380006'],
    ["driver's license D1234567", 'license', 'D1234567'],
    ['NHS number 943 476 5919', 'health', '943 476 5919'],
    ['MRN: 00482913', 'health', '00482913'],
    ['member ID XJH4412903', 'health', 'XJH4412903'],
    ['MBI 1EG4-TE5-MK73', 'health', '1EG4-TE5-MK73'],
    ['I was diagnosed with type 2 diabetes last spring.', 'health', 'type 2 diabetes'],
    ['taking Sertraline 50 mg daily', 'health', 'Sertraline 50 mg'],
    ['Send it to 742 Evergreen Terrace, Springfield', 'address', '742 Evergreen Terrace'],
    [
      '1600 Pennsylvania Avenue NW, Washington, DC 20500',
      'address',
      '1600 Pennsylvania Avenue NW, Washington, DC 20500',
    ],
    ['Flat 2, 221B Baker Street', 'address', '221B Baker Street'],
    ['I live at 742 Evergreen Terrace.', 'address', '742 Evergreen Terrace'],
    ['Meet at 12 Main St. at noon', 'address', '12 Main St.'],
    ['Post to PO Box 1234', 'address', 'PO Box 1234'],
    ['postcode SW1A 1AA', 'address', 'SW1A 1AA'],
    ['call me on +44 20 7946 0958', 'phone', '+44 20 7946 0958'],
    ['cell (415) 555-0132', 'phone', '(415) 555-0132'],
    ['text 415-555-0132 later', 'phone', '415-555-0132'],
    ['or call 1-800-555-0199 today', 'phone', '1-800-555-0199'],
    ['mobile 07700 900123', 'phone', '07700 900123'],
    ['WhatsApp +91 98765 43210', 'phone', '+91 98765 43210'],
    ['phone: 4155550132', 'phone', '4155550132'],
    ['email sam.rivera+bills@example.org today', 'email', 'sam.rivera+bills@example.org'],
    ['DOB: 03/14/1988', 'dob', '03/14/1988'],
    ['my date of birth is 03/14/1988.', 'dob', '03/14/1988'],
    ['I was born on March 14, 1988', 'dob', 'March 14, 1988'],
    [
      'key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx123',
      'credential',
      'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx123',
    ],
    [
      'ghp_0123456789abcdefghijABCDEFGHIJ012345',
      'credential',
      'ghp_0123456789abcdefghijABCDEFGHIJ012345',
    ],
    ['AWS AKIAIOSFODNN7EXAMPLE', 'credential', 'AKIAIOSFODNN7EXAMPLE'],
    ['my password is hunter22!x', 'credential', 'hunter22!x'],
    ['My banking password is Tr0ub4dor&3.', 'credential', 'Tr0ub4dor&3'],
    [
      '"api_key": "a8f5f167f44f4964e6c998dee827110c"',
      'credential',
      'a8f5f167f44f4964e6c998dee827110c',
    ],
    ['postgres://app:s3cretPw@db.internal:5432/app', 'credential', 's3cretPw'],
    [
      'Authorization: Bearer abcdefghijklmnop1234567890',
      'credential',
      'abcdefghijklmnop1234567890',
    ],
    ['DB_PASSWORD=supersecret99', 'credential', 'supersecret99'],
    ['export SMTP_PASSWORD="hunter22x"', 'credential', 'hunter22x'],
    [
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'credential',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    ],
    ['Please pay account 98765432 today', 'account', '98765432'],
    ['transfer the fee to account 12345678', 'account', '12345678'],
  ];
  for (const [text, category, value] of cases)
    test(`${category}: ${value}`, () => {
      expect(found(text)).toContainEqual([category, value]);
    });
});

describe('false-positive guards', () => {
  const clean = [
    'Order #123456789012 shipped on 2026-09-30.',
    'Your order number is 4111-2222-3333-4444 and it ships Tuesday.',
    'Invoice 415-555-0132 is due.',
    'Tracking 1Z999AA10123456784 via UPS.',
    'The total was $1,234.56 and then €49.99 more.',
    'We paid 12345.67 last month.',
    'Meeting on 09/30/2026 at 14:30, then 2026-10-01.',
    'Version 2.3.14 fixes build 20260930.',
    'ISBN 978-0-306-40615-7',
    'Call in 5 minutes; the answer is 42.',
    'The account was opened in 2019.',
    'My account balance is 123456 dollars.',
    'The token is expired, please sign in again.',
    'Password is required.',
    'We diagnosed the bug in the parser.',
    'It costs 250 mg of effort.',
    'A timestamp: 1727712345678.',
    'Year range 1990-2020 and page 12-34.',
    'Room 101 on floor 3.',
    'max_tokens: 4096 and prompt_tokens=1200',
    'The savings account balance is 123456 dollars.',
  ];
  for (const text of clean)
    test(text, () => {
      expect(found(text)).toEqual([]);
    });
});

describe('randomized look-alikes stay untouched', () => {
  // A small seeded generator, so a failure names the exact text.
  let seed = 0x5eed;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const digits = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      String(index === 0 ? 1 + (next() % 9) : next() % 10),
    ).join('');
  const pick = <T>(items: T[]): T => items[next() % items.length] as T;
  const pad = (value: number) => String(value).padStart(2, '0');
  const makers: (() => string)[] = [
    () =>
      `${pick(['Order', 'Invoice', 'Tracking', 'Ref', 'Ticket', 'Booking'])} #${digits(6 + (next() % 14))} is ready.`,
    () =>
      `${pick(['Order', 'Invoice', 'Confirmation'])} ${digits(3)}-${digits(3)}-${digits(4)} ships soon.`,
    () =>
      `It cost ${pick(['$', '€', '£', '₹'])}${digits(1 + (next() % 5))}.${pad(next() % 100)} in total.`,
    () => `Total: ${digits(1)},${digits(3)},${digits(3)}.${pad(next() % 100)}`,
    () =>
      `Due ${2000 + (next() % 40)}-${pad(1 + (next() % 12))}-${pad(1 + (next() % 28))} at ${pad(next() % 24)}:${pad(next() % 60)}.`,
    () => `See you ${pad(1 + (next() % 12))}/${pad(1 + (next() % 28))}/${2000 + (next() % 40)}.`,
    () => `Upgrade to v${next() % 20}.${next() % 50}.${next() % 200} (build ${digits(8)}).`,
    () =>
      `We shipped ${next() % 500} boxes weighing ${next() % 90}.${next() % 10} kg to room ${next() % 999}.`,
    () => `Page ${next() % 400} of ${400 + (next() % 400)}, chapter ${next() % 30}.`,
  ];
  test('2,000 generated sentences produce no detections', () => {
    const flagged: string[] = [];
    for (let index = 0; index < 2000; index++) {
      const text = (makers[index % makers.length] as () => string)();
      if (detect(text, ALL).length) flagged.push(text);
    }
    expect(flagged).toEqual([]);
  });
});

describe('large texts', () => {
  test('a long run of letters and dashes is read in linear time', () => {
    const started = performance.now();
    expect(detect('a-'.repeat(100_000), ALL)).toEqual([]);
    expect(detect('-----BEGIN RSA PRIVATE KEY-----'.repeat(6_000), ALL)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test('tens of thousands of details are resolved without comparing every pair', () => {
    const text = Array.from({ length: 30_000 }, (_, index) => `p${index}@example.org`).join(', ');
    const started = performance.now();
    expect(detect(text, ALL)).toHaveLength(30_000);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('overlaps', () => {
  test('an IBAN is one detail, not an IBAN and an account number', () => {
    expect(found('account IBAN DE89 3704 0044 0532 0130 00')).toEqual([
      ['account', 'DE89 3704 0044 0532 0130 00'],
    ]);
  });

  test('disabled categories are left alone', () => {
    expect(detect('email me at a@b.co', new Set(['phone']))).toEqual([]);
  });
});
