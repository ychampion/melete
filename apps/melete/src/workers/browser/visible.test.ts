/**
 * Which controls hold a secret. A field labelled for one is treated as one:
 * its value is withheld and filling it is the person's to do. A page made of
 * ordinary fields is read and filled as before.
 */
import { expect, test } from 'bun:test';
import { ORDINARY_LABELS, SECRET_LABELS } from '../../../test/helpers/secret-labels.ts';
import { redactSecretText } from './redact.ts';
import { isSensitiveControl, sensitiveName } from './visible.ts';

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
