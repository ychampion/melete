/**
 * Which controls hold a secret. A field labelled for one is treated as one:
 * its value is withheld and filling it is the person's to do. A page made of
 * ordinary fields is read and filled as before.
 */
import { expect, test } from 'bun:test';
import {
  BARE_CODE_LABELS,
  ORDINARY_FIELD_NAMES,
  ORDINARY_LABELS,
  SECRET_FIELD_NAMES,
  SECRET_LABELS,
} from '../../../test/helpers/secret-labels.ts';
import { redactSecretText } from './redact.ts';
import { attributeWords, isSensitiveControl, sensitiveName } from './visible.ts';

const field = (label: string, role = 'textbox') => ({
  label,
  role,
  required: false,
  sensitive: false,
});

for (const label of SECRET_LABELS)
  test(`a field labelled "${label}" holds a secret`, () => {
    expect(isSensitiveControl(field(label))).toBe(true);
    expect(isSensitiveControl(field(label, 'combobox'))).toBe(true);
    // Page text that names one keeps no value.
    expect(redactSecretText(`${label}: plum river 123-45-6789`)).toBe(`${label}: [redacted]`);
  });

test('an ordinary form holds no secret, and a link or button never does', () => {
  for (const label of ORDINARY_LABELS) {
    expect(sensitiveName.test(label)).toBe(false);
    expect(isSensitiveControl(field(label))).toBe(false);
  }
  for (const label of SECRET_LABELS) {
    expect(isSensitiveControl(field(label, 'link'))).toBe(false);
    expect(isSensitiveControl(field(label, 'button'))).toBe(false);
  }
  expect(redactSecretText('Order number: 48213')).toBe('Order number: 48213');
});

test('a field labelled only as a code or an expiry holds a secret, and page text saying so is kept', () => {
  for (const label of BARE_CODE_LABELS) {
    expect([label, isSensitiveControl(field(label))]).toEqual([label, true]);
    expect([label, isSensitiveControl(field(label, 'spinbutton'))]).toEqual([label, true]);
    expect([label, isSensitiveControl(field(label, 'button'))]).toEqual([label, false]);
  }
  // Only the whole label counts; a sentence or a longer name is ordinary.
  for (const label of ['Promo code', 'Discount code', 'ZIP code', 'Offer expires soon', 'Codes'])
    expect([label, isSensitiveControl(field(label))]).toEqual([label, false]);
  expect(redactSecretText('Offer expires: 2026-10-31')).toBe('Offer expires: 2026-10-31');
  expect(redactSecretText('Code: SUMMER25')).toBe('Code: SUMMER25');
});

test('a field’s name or id is read as words, so a code or card field is known by it', () => {
  for (const name of SECRET_FIELD_NAMES)
    expect([name, isSensitiveControl(field(attributeWords(name)))]).toEqual([name, true]);
  for (const name of ORDINARY_FIELD_NAMES)
    expect([name, isSensitiveControl(field(attributeWords(name)))]).toEqual([name, false]);
  expect(attributeWords('verificationCode')).toBe('verification Code');
  expect(attributeWords('cc_exp-month')).toBe('cc exp month');
});
