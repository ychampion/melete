/**
 * Deterministic detectors for the details the privacy router swaps out before a
 * request reaches a cloud model.
 *
 * Every rule is a pattern, usually a checksum, and often a context word that
 * must appear shortly before the value. Context is what keeps an order number,
 * a date or a price from being read as an account, an ID or a phone number: a
 * bare nine-digit number is only a routing number when the text around it says
 * so. Rules return the span of the value itself, never of the words around it.
 */
import type { PrivacyCategory } from '@melete/contracts';

export type Detection = {
  start: number;
  end: number;
  category: PrivacyCategory;
};

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const digitsOf = (value: string): string => value.replace(/\D/g, '');

export function luhn(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ABA routing number: 3-7-1 weighted checksum and a Federal Reserve prefix. */
export function abaRouting(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const prefix = Number(digits.slice(0, 2));
  const prefixOk =
    prefix <= 12 ||
    (prefix >= 21 && prefix <= 32) ||
    (prefix >= 61 && prefix <= 72) ||
    prefix === 80;
  if (!prefixOk) return false;
  const d = [...digits].map(Number) as number[];
  const sum =
    3 * ((d[0] ?? 0) + (d[3] ?? 0) + (d[6] ?? 0)) +
    7 * ((d[1] ?? 0) + (d[4] ?? 0) + (d[7] ?? 0)) +
    ((d[2] ?? 0) + (d[5] ?? 0) + (d[8] ?? 0));
  return sum % 10 === 0;
}

/** IBAN: ISO 13616 mod-97 over the rearranged account. */
export function ibanValid(value: string): boolean {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : char;
    for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff, as India's Aadhaar numbers carry. */
export function verhoeff(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let check = 0;
  const reversed = [...digits].reverse();
  for (const [index, char] of reversed.entries()) {
    check = VERHOEFF_D[check]?.[VERHOEFF_P[index % 8]?.[Number(char)] ?? 0] ?? 0;
  }
  return check === 0;
}

/** NHS number: weights 10..2 over nine digits, mod 11. */
export function nhsNumber(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index++) sum += Number(digits[index]) * (10 - index);
  const check = 11 - (sum % 11);
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === Number(digits[9]);
}

/** Brazil's CPF: two mod-11 check digits, and not one repeated digit. */
export function cpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index++)
      sum += Number(digits[index]) * (length + 1 - index);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

/** Spain's DNI and NIE: the letter is the number mod 23. */
export function spanishId(value: string): boolean {
  const normal = value.toUpperCase().replace(/[\s-]/g, '');
  const match = /^([XYZ]?)(\d{7,8})([A-Z])$/.exec(normal);
  if (!match) return false;
  const [, prefix, number, letter] = match;
  if (prefix && number?.length !== 7) return false;
  if (!prefix && number?.length !== 8) return false;
  const lead = prefix ? String('XYZ'.indexOf(prefix)) : '';
  const numeric = Number(lead + number);
  return 'TRWAGMYFPDXBNJZSQVHLCKE'[numeric % 23] === letter;
}

/** Card networks by prefix and length, so a Luhn-valid order number is not a card. */
export function cardNumber(digits: string): boolean {
  const length = digits.length;
  if (length < 13 || length > 19 || !luhn(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  if (/^4/.test(digits)) return length === 13 || length === 16 || length === 19;
  if (/^5[1-5]/.test(digits)) return length === 16;
  if (/^2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d\d|7(?:[01]\d|20))/.test(digits)) return length === 16;
  if (/^3[47]/.test(digits)) return length === 15;
  if (/^3(?:0[0-5]|[689])/.test(digits)) return length >= 14;
  if (/^35(?:2[89]|[3-8]\d)/.test(digits)) return length >= 16;
  if (/^(?:6011|65|64[4-9]|622)/.test(digits)) return length >= 16;
  if (/^62/.test(digits)) return length >= 16;
  if (/^(?:5018|5020|5038|6304|6759|676[1-3])/.test(digits)) return length >= 12;
  return false;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Rule = {
  category: PrivacyCategory;
  /** Global; a group named `v` narrows the match to the value. */
  pattern: RegExp;
  /** Most rules need a digit; texts without one skip them entirely. */
  digits?: boolean;
  /** Must appear within `window` characters before the value, on the same line. */
  context?: RegExp;
  window?: number;
  /** A match with this before it is something else: an order, an invoice. */
  refuse?: RegExp;
  valid?: (value: string) => boolean;
  /** A cheap test the text must pass before the rule's pattern runs. */
  hint?: RegExp;
};

/** Words that make a number an order, an invoice or a shipment rather than a person's. */
const NOT_PERSONAL =
  /\b(?:order|invoice|inv|receipt|confirmation|conf|tracking|shipment|ref(?:erence)?|ticket|case|booking|reservation|item|sku|model|serial|version|build|isbn|po|quote|transaction|txn)\b[\s#:.no-]*$/i;

/** Words that make a number a sum of money. */
const AMOUNT =
  /\b(?:balance|total|amount|sum|limit|payment of|paid|pay|owe[sd]?|worth|price|cost|fee|charge[sd]?|refund(?:ed)?|salary|income)\b[^\n]{0,12}$/i;

/** Digits that are a date, whatever word came before them. */
const DATE_SHAPE = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{2,4})$/;

/** Whole words end at a word boundary; only abbreviations take their full stop with them. */
const STREET_TYPES =
  '(?:Street|Avenue|Road|Boulevard|Lane|Drive|Court|Place|Terrace|Way|Circle|Parkway|Highway|Square|Close|Crescent|Mews|Gardens|Grove|Trail|Alley|Plaza)\\b|(?:St|Ave|Rd|Blvd|Ln|Dr|Ct|Pl|Ter|Cir|Pkwy|Hwy|Sq|Cres|Trl)\\b\\.?';

const MONTHS =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

const DATE_VALUE = `(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\.?,?\\s+\\d{4})`;

const RULES: Rule[] = [
  // Credentials first: a key can contain long digit runs another rule would misread.
  {
    category: 'credential',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{16,}?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    category: 'credential',
    pattern:
      /(?<![A-Za-z0-9_-])(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|fw_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{50,}|shpat_[a-fA-F0-9]{32}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  },
  {
    category: 'credential',
    pattern:
      /\b(?:password|passwd|passcode|pwd|pin|api[ _-]?key|secret(?:[ _-]?key)?|access[ _-]?(?:key|token)|auth[ _-]?token|token|client[ _-]?secret)\b["']?\s*(?:is|was|:|=|=>)\s*["']?(?!(?:not|required|invalid|incorrect|correct|wrong|missing|expired|empty|set|valid|stored|changed|reset|null|none|undefined|true|false|the|a|an|your|my|in|on|being|still|now|also|too|here|there|below|above)\b)(?<v>[^\s"',;]{3,199}[^\s"',;.!?])/gi,
  },
  {
    category: 'credential',
    pattern: /\bBearer\s+(?<v>[A-Za-z0-9._~+/-]{16,}=*)/g,
  },
  {
    category: 'credential',
    // user:password@host in a URL or a connection string: only the password.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:(?<v>[^\s/@]{3,})@/gi,
  },
  // Payment cards and their security codes.
  {
    category: 'card',
    digits: true,
    refuse: NOT_PERSONAL,
    // Twelve or more digits in card-style groups (4-4-4, 4-6-4, 4-6-5), before the costlier search.
    hint: /\d{4}[ -]?\d{4,6}[ -]?\d{4}/,
    pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    valid: (value) => cardNumber(digitsOf(value)),
  },
  {
    category: 'card',
    digits: true,
    pattern: /\b(?:CVV2?|CVC2?|CID|security code)\b\s*(?:is|:|#)?\s*(?<v>\d{3,4})(?!\d)/gi,
  },
  // IBAN before plain account numbers.
  {
    category: 'account',
    digits: true,
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    valid: ibanValid,
  },
  // US Social Security numbers and ITINs, formatted.
  {
    category: 'tax_id',
    digits: true,
    pattern: /(?<![\d-])9\d{2}([- ])(?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])\1\d{4}(?![\d-])/g,
  },
  {
    category: 'ssn',
    digits: true,
    refuse: NOT_PERSONAL,
    pattern: /(?<![\d-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/g,
  },
  {
    category: 'ssn',
    digits: true,
    context: /\b(?:SSN|SS#|social security(?: number| no\.?| #)?)\b/i,
    window: 40,
    pattern: /(?<!\d)(?!000|666|9\d\d)\d{9}(?!\d)/g,
  },
  // Tax identifiers.
  {
    category: 'tax_id',
    digits: true,
    context:
      /\b(?:EIN|FEIN|TIN|ITIN|UTR|VAT(?: number| no\.?)?|employer identification|tax (?:id|identification|reference|number|file number))\b/i,
    window: 48,
    pattern: /(?<![\d-])(?:\d{2}-\d{7}|\d{9,10}|\d{3} ?\d{3} ?\d{3,4}|[A-Z]{2}\d{9,12})(?![\d-])/g,
  },
  {
    category: 'tax_id',
    digits: true,
    // India PAN: five letters, four digits, a letter; the fourth letter is the holder type.
    pattern: /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g,
  },
  // National identity numbers.
  {
    category: 'national_id',
    digits: true,
    // UK National Insurance number.
    pattern:
      /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
  },
  {
    category: 'national_id',
    digits: true,
    // Aadhaar, grouped four-four-four, Verhoeff-valid.
    refuse: NOT_PERSONAL,
    pattern: /(?<![\d-])[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?![\d-])/g,
    valid: (value) => verhoeff(digitsOf(value)),
  },
  {
    category: 'national_id',
    digits: true,
    context: /\b(?:aadhaar|aadhar|UIDAI|UID)\b/i,
    window: 40,
    pattern: /(?<!\d)[2-9]\d{11}(?!\d)/g,
    valid: (value) => verhoeff(digitsOf(value)),
  },
  {
    category: 'national_id',
    digits: true,
    // Canadian Social Insurance Number, grouped three-three-three, Luhn-valid.
    refuse: NOT_PERSONAL,
    pattern: /(?<![\d-])[1-79]\d{2}[ -]\d{3}[ -]\d{3}(?![\d-])/g,
    valid: (value) => luhn(digitsOf(value)),
  },
  {
    category: 'national_id',
    digits: true,
    context: /\b(?:SIN|social insurance)\b/i,
    window: 40,
    pattern: /(?<!\d)[1-79]\d{8}(?!\d)/g,
    valid: (value) => luhn(digitsOf(value)),
  },
  {
    category: 'national_id',
    digits: true,
    pattern: /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\d-])/g,
    valid: (value) => cpf(digitsOf(value)),
  },
  {
    category: 'national_id',
    digits: true,
    pattern: /\b[XYZ]?\d{7,8}-?[A-Z]\b/g,
    valid: spanishId,
  },
  {
    category: 'national_id',
    digits: true,
    context:
      /\b(?:national (?:id|identity|insurance)|identity (?:card|number|no\.?)|id (?:card|number|no\.?)|personal (?:id|number|code)|citizen(?:ship)? (?:id|number)|BSN|NIE|DNI|CURP|NRIC|HKID|personnummer)\b/i,
    window: 40,
    pattern: /(?<![A-Za-z0-9-])(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,19}(?![A-Za-z0-9-])/g,
  },
  {
    category: 'passport',
    digits: true,
    context: /\bpassport\b/i,
    window: 40,
    pattern: /(?<![A-Za-z0-9])(?=[A-Z0-9]*\d)[A-Z0-9]{6,9}(?![A-Za-z0-9])/g,
  },
  {
    category: 'license',
    digits: true,
    context:
      /\b(?:driver'?s?|driving|drivers)\s+licen[cs]e\b|\bDL\s*(?:#|no\.?|number)|\blicen[cs]e\s+(?:number|no\.?|#)/i,
    window: 40,
    pattern: /(?<![A-Za-z0-9-])(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,19}(?![A-Za-z0-9-])/g,
  },
  // Health identifiers and statements.
  {
    category: 'health',
    digits: true,
    context: /\bNHS\b/i,
    window: 40,
    pattern: /(?<!\d)\d{3}[ -]?\d{3}[ -]?\d{4}(?!\d)/g,
    valid: (value) => nhsNumber(digitsOf(value)),
  },
  {
    category: 'health',
    digits: true,
    context:
      /\b(?:MRN|medical record|patient (?:id|number|no\.?)|member (?:id|number|no\.?)|subscriber (?:id|number)|insurance (?:id|number|no\.?)|policy (?:number|no\.?|#)|group (?:number|no\.?|#)|Rx(?: number| no\.?| #)?|prescription (?:number|no\.?|#)|medicare|medicaid)\b/i,
    window: 40,
    pattern: /(?<![A-Za-z0-9-])(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,19}(?![A-Za-z0-9-])/g,
  },
  {
    category: 'health',
    digits: true,
    // Medicare Beneficiary Identifier: eleven characters in a fixed letter/digit order.
    pattern:
      /\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y]{2}\d{2}\b/g,
  },
  {
    category: 'health',
    pattern:
      /\b(?:diagnosed with|diagnosis(?: of)?:?|tested positive for|prescribed)\s+(?<v>[A-Za-z][A-Za-z0-9' -]{2,60}?)(?=[.,;:!?)\n]|\s+(?:and|but|since|last|in|on|at|for|after|which|so)\b|$)/gi,
  },
  {
    category: 'health',
    digits: true,
    // A medicine and its dose.
    pattern: /\b[A-Z][a-z]{3,}\s+\d+(?:\.\d+)?\s?(?:mg|mcg|µg|micrograms?|milligrams?)\b/g,
  },
  // Dates of birth: a date only counts with a birth word before it.
  {
    category: 'dob',
    digits: true,
    context: /\b(?:DOB|D\.O\.B\.?|date of birth|birth ?date|birthday|born(?: on)?)\b/i,
    window: 32,
    pattern: new RegExp(`(?<![\\d/.-])${DATE_VALUE}(?![\\d/-]|\\.\\d)`, 'gi'),
  },
  // Bank routing numbers need their word; the checksum alone passes one number in ten.
  {
    category: 'routing',
    digits: true,
    context: /\b(?:routing|ABA|RTN|transit(?: number)?|wire)\b/i,
    window: 48,
    pattern: /(?<!\d)\d{9}(?!\d)/g,
    valid: abaRouting,
  },
  {
    category: 'routing',
    digits: true,
    context: /\bsort ?code\b/i,
    window: 32,
    pattern: /(?<![\d-])\d{2}[- ]?\d{2}[- ]?\d{2}(?![\d-])/g,
  },
  {
    category: 'routing',
    digits: true,
    // Indian Financial System Code.
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    valid: (value) => /\d/.test(value.slice(5)),
  },
  {
    category: 'routing',
    context: /\b(?:SWIFT|BIC)\b/i,
    window: 32,
    pattern: /\b[A-Z]{6}[A-Z2-9][A-NP-Z0-9](?:[A-Z0-9]{3})?\b/g,
  },
  // Account numbers need their word; "ending in" lets four digits count.
  {
    category: 'account',
    digits: true,
    context:
      /\b(?:account|acct|a\/c|checking|chequing|savings|current account|bank|IBAN|member number|card)\b[^\n]{0,24}\b(?:ending(?: in)?|ends? (?:in|with)|last (?:4|four)(?: digits)?)\s*[:#]?\s*$/i,
    window: 64,
    pattern: /(?<![\d$£€¥₹.,])\d{4}(?![\d,.]\d)(?!\d)/g,
  },
  {
    category: 'account',
    digits: true,
    context:
      /\b(?:account|acct|a\/c|checking|chequing|savings|bank(?:ing)? (?:number|no\.?|details)|brokerage|401\(?k\)?|IRA|pension)\b/i,
    window: 48,
    refuse: AMOUNT,
    pattern: /(?<![\d$£€¥₹.,-])\d(?:[ -]?\d){5,16}(?![\d,.]\d)(?![\d-])/g,
    valid: (value) => !DATE_SHAPE.test(value),
  },
  // Emails.
  {
    category: 'email',
    pattern:
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g,
  },
  // Phone numbers.
  {
    category: 'phone',
    digits: true,
    pattern:
      /(?<![\w+])\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){1,4}(?![\d-])/g,
    valid: (value) => {
      const count = digitsOf(value).length;
      return count >= 8 && count <= 15;
    },
  },
  {
    category: 'phone',
    digits: true,
    refuse: NOT_PERSONAL,
    pattern:
      /(?<![\d-])(?:1[-. ]?)?(?:\([2-9]\d{2}\)\s?|[2-9]\d{2}[-. ])[2-9]\d{2}[-. ]\d{4}(?![\d-])/g,
  },
  {
    category: 'phone',
    digits: true,
    refuse: NOT_PERSONAL,
    // United Kingdom, written with its trunk zero.
    pattern:
      /(?<![\d-])0(?:7\d{3} ?\d{6}|[1-3]\d{1,3}[ -]\d{3,4}[ -]?\d{3,4}|800 ?\d{3} ?\d{3,4})(?![\d-])/g,
    valid: (value) => {
      const count = digitsOf(value).length;
      return count === 10 || count === 11;
    },
  },
  {
    category: 'phone',
    digits: true,
    context:
      /\b(?:phone|tel|telephone|mobile|cell|call|text|whatsapp|sms|fax|number)\b(?: (?:me|us|him|her|them))?(?: (?:at|on))?\s*[:#]?\s*$/i,
    window: 24,
    pattern: /(?<![\d-])\d{10,11}(?![\d-])/g,
  },
  // Street addresses and postal codes.
  {
    category: 'address',
    digits: true,
    pattern: new RegExp(
      `\\b\\d{1,6}[A-Z]?(?:-\\d{1,4})?\\s+(?:(?:N|S|E|W|North|South|East|West)\\.?\\s+)?(?:(?:\\d{1,3}(?:st|nd|rd|th)|[A-Z][A-Za-z'.-]*)\\s+){1,4}(?:${STREET_TYPES})(?:\\s+(?:NW|NE|SW|SE|N|S|E|W)\\b)?(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|Flat|Fl|Floor|#)\\.?\\s*[A-Za-z0-9-]+)?(?:,\\s*[A-Z][A-Za-z.' -]{1,30},\\s*[A-Z]{2}\\s+\\d{5}(?:-\\d{4})?|,\\s*[A-Z][A-Za-z.' -]{1,30}(?:,\\s*[A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2}))?`,
      'g',
    ),
  },
  {
    category: 'address',
    digits: true,
    pattern: /\bP\.?\s?O\.?\s+Box\s+\d{1,8}\b/gi,
  },
  {
    category: 'address',
    digits: true,
    // UK postcode.
    pattern: /\b(?:[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?|GIR) \d[ABD-HJLNP-UW-Z]{2}\b/g,
  },
];

/** A detection's precedence when two overlap: earlier wins. */
const PRECEDENCE: PrivacyCategory[] = [
  'private',
  'name',
  'credential',
  'card',
  // A checksum-valid number beside "routing" is a routing number even when
  // "account" is also nearby.
  'routing',
  'account',
  'ssn',
  'tax_id',
  'national_id',
  'passport',
  'license',
  'health',
  'dob',
  'email',
  'address',
  'phone',
];

function valueSpan(match: RegExpExecArray): [number, number] {
  const indices = (
    match as RegExpExecArray & { indices?: { groups?: Record<string, [number, number]> } }
  ).indices;
  const group = indices?.groups?.v;
  if (group) return group;
  return [match.index, match.index + match[0].length];
}

const LEADING_LOOKBEHIND = /^\(\?<!(\[(?:\\.|[^\]\\])*\]|\\[dDwW])\)/;

/**
 * The engine runs a pattern that starts with a lookbehind about thirty times
 * slower than one that does not. The lookbehind is taken off and the one
 * character before a match is checked in code instead, which means the same.
 * A context rule also gets its words without their end anchor, so a text that
 * never mentions them skips the rule in one fast pass.
 */
function compile(rule: Rule) {
  const flags = rule.pattern.flags.includes('d') ? rule.pattern.flags : `${rule.pattern.flags}d`;
  const lookbehind = LEADING_LOOKBEHIND.exec(rule.pattern.source);
  const source = lookbehind ? rule.pattern.source.slice(lookbehind[0].length) : rule.pattern.source;
  const hint =
    rule.hint ??
    (rule.context
      ? new RegExp(rule.context.source.replace(/(?:\\s\*\[:#\]\?\\s\*)?\$$/, ''), 'i')
      : undefined);
  return {
    ...rule,
    pattern: new RegExp(source, flags),
    notAfter: lookbehind?.[1] ? new RegExp(`^${lookbehind[1]}$`, 'u') : undefined,
    hint,
  };
}

const COMPILED = RULES.map(compile);

/** The text on the same line before `start`, at most `window` characters. */
function before(text: string, start: number, window: number): string {
  const from = Math.max(0, start - window);
  const slice = text.slice(from, start);
  const newline = slice.lastIndexOf('\n');
  return newline >= 0 ? slice.slice(newline + 1) : slice;
}

/**
 * Every value the enabled rules find. Overlaps are resolved by precedence and
 * then by length, so an IBAN is not also an account number and a phone number
 * inside an address is not counted twice.
 */
export function detect(text: string, enabled: ReadonlySet<PrivacyCategory>): Detection[] {
  if (text.length < 4) return [];
  const hasDigit = /\d/.test(text);
  const found: Detection[] = [];
  for (const rule of COMPILED) {
    if (!enabled.has(rule.category)) continue;
    if (rule.digits && !hasDigit) continue;
    if (rule.hint && !rule.hint.test(text)) continue;
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(text); match; match = rule.pattern.exec(text)) {
      if (match[0].length === 0) {
        rule.pattern.lastIndex++;
        continue;
      }
      if (rule.notAfter && match.index > 0 && rule.notAfter.test(text[match.index - 1] ?? '')) {
        // What the lookbehind refused: try again from the next character.
        rule.pattern.lastIndex = match.index + 1;
        continue;
      }
      const [start, end] = valueSpan(match);
      const value = text.slice(start, end);
      if (rule.context && !rule.context.test(before(text, start, rule.window ?? 40))) continue;
      if (rule.refuse?.test(before(text, match.index, 32))) continue;
      if (rule.valid && !rule.valid(value)) continue;
      if (isPlaceholderText(value)) continue;
      found.push({ start, end, category: rule.category });
    }
  }
  return resolveOverlaps(found);
}

export function resolveOverlaps(found: Detection[]): Detection[] {
  const rank = (category: PrivacyCategory) => PRECEDENCE.indexOf(category);
  const ordered = [...found].sort(
    (a, b) => rank(a.category) - rank(b.category) || b.end - b.start - (a.end - a.start),
  );
  const kept: Detection[] = [];
  for (const candidate of ordered) {
    if (kept.some((other) => candidate.start < other.end && other.start < candidate.end)) continue;
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Placeholder syntax: ⟦CATEGORY_N⟧. */
export const PLACEHOLDER = /⟦([A-Z][A-Z_]*_\d{1,6})⟧/g;
const PLACEHOLDER_ONLY = /^⟦[A-Z][A-Z_]*_\d{1,6}⟧$/;
export const isPlaceholderText = (value: string): boolean => PLACEHOLDER_ONLY.test(value);
