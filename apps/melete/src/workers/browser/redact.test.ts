import { expect, test } from 'bun:test';
import { REDACTED, redactSecretText } from './redact.ts';

test('a line naming a secret loses its value while its label stays', () => {
  const tree = [
    '- heading "Sign in to your account" [level=1]',
    '- textbox "One-time code": "482913"',
    '- textbox "Recovery code": whisper-quietly-now',
    '- text: "Your backup code: keep it safe"',
    '- textbox "Email": person@example.com',
    '- \'textbox "Note: private"\': ordinary note',
  ].join('\n');
  expect(redactSecretText(tree).split('\n')).toEqual([
    '- heading "Sign in to your account" [level=1]',
    `- textbox "One-time code": ${REDACTED}`,
    `- textbox "Recovery code": ${REDACTED}`,
    `- text: ${REDACTED}`,
    '- textbox "Email": person@example.com',
    '- \'textbox "Note: private"\': ordinary note',
  ]);
});

test('grouped codes and standalone six to ten digit numbers are blanked anywhere', () => {
  expect(redactSecretText('- paragraph: Keep ABCD-EFGH-IJKL somewhere')).toBe(
    `- paragraph: Keep ${REDACTED} somewhere`,
  );
  expect(redactSecretText('- paragraph: Cards 4111 1111 1111 1111 on file')).toBe(
    `- paragraph: Cards ${REDACTED} on file`,
  );
  expect(redactSecretText('- paragraph: Order reference 48291377.')).toBe(
    `- paragraph: Order reference ${REDACTED}.`,
  );
  expect(redactSecretText('- cell: 123456')).toBe(`- cell: ${REDACTED}`);
  for (const kept of [
    '- paragraph: Due 2026-09-17 at 12:30',
    '- paragraph: Total 1,234,567.89',
    '- paragraph: Build 12345',
    '- paragraph: Tracking 12345678901234',
    '- paragraph: Version 3.1415926',
    '- paragraph: Invoice INV-123456',
    '- link "Open help"',
  ])
    expect(redactSecretText(kept)).toBe(kept);
});
