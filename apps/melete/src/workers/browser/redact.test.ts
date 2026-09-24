import { expect, test } from 'bun:test';
import { handbackLabel, handbackUrl, REDACTED, redactSecretText, withoutValues } from './redact.ts';

/** How a page shows a person a secret, in the shapes a real sign-in uses. */
const SHOWN = [
  '- textbox "Password": hunter2',
  '- textbox "One-time code": "482913"',
  '- textbox "Enter code": 48213',
  '- textbox "Memorable word": swordfish',
  '- textbox "First pet\'s name": Mittens',
  '- textbox "Account": 12345678901',
  '- text: recovery key abcd-efgh-ijkl',
  '- text: key ABC-DEF-GHI-JKL',
  '- text: JBSWY3DPEHPK3PXP',
  '- text: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.c2ln',
  '- paragraph: Backup code: ABCD-EFGH-IJKL',
].join('\n');
const SECRETS = [
  'hunter2',
  '482913',
  '48213',
  'swordfish',
  'Mittens',
  '12345678901',
  'abcd-efgh-ijkl',
  'ABC-DEF-GHI-JKL',
  'JBSWY3DPEHPK3PXP',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'ABCD-EFGH-IJKL',
];

test('the first look after a handback keeps labels and roles and no contents', () => {
  const kept = withoutValues(SHOWN);
  for (const secret of SECRETS) expect([secret, kept.includes(secret)]).toEqual([secret, false]);
  // What a locator needs is still there: every role, and every name a control was given.
  expect(kept.split('\n')).toEqual([
    '- textbox "Password"',
    '- textbox "One-time code"',
    '- textbox "Enter code"',
    '- textbox "Memorable word"',
    '- textbox "First pet\'s name"',
    '- textbox "Account"',
    '- text',
    '- text',
    '- text',
    '- text',
    '- paragraph',
  ]);
});

test('a name that carries a code loses it, and an ordinary page keeps its shape', () => {
  expect(withoutValues('- heading "Your account" [level=1]')).toBe('- heading [level=1]');
  expect(withoutValues('- textbox "Code ABCD-EFGH-IJKL"')).toBe(`- textbox "Code ${REDACTED}"`);
  expect(withoutValues('- link "Open help"')).toBe('- link "Open help"');
  expect(withoutValues('- button "Save note"')).toBe('- button "Save note"');
});

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

test('a later look blanks seeds, tokens and grouped codes in any case', () => {
  for (const [line, blanked] of [
    ['- text: JBSWY3DPEHPK3PXP', `- text: ${REDACTED}`],
    ['- text: seed JBSWY3DPEHPK3PXPJBSWY3DP', `- text: seed ${REDACTED}`],
    [
      '- text: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.c2ln',
      `- text: ${REDACTED}`,
    ],
    ['- text: recovery key abcd-efgh-ijkl', `- text: recovery key ${REDACTED}`],
    ['- text: key ABC-DEF-GHI-JKL', `- text: key ${REDACTED}`],
  ] as const)
    expect([line, redactSecretText(line)]).toEqual([line, blanked]);
  // Ordinary hyphenated prose is not a code, and stays.
  for (const kept of [
    '- paragraph: a state-of-the-art mother-in-law joke',
    '- paragraph: the up-to-date read-me file',
    '- paragraph: a well-thought-out plan',
  ])
    expect([kept, redactSecretText(kept)]).toEqual([kept, kept]);
});

test('on a handed-back page only controls keep a name, and it loses any code in it', () => {
  const tree = [
    '- heading "Your code is 48213" [level=1]',
    '- table:',
    '  - row "7f3k-9x2m zqcell":',
    '    - cell "7f3k-9x2m"',
    '    - cell "zqcell"',
    '- img "zqalt"',
    '- listbox:',
    '  - option "zqoption" [selected]',
    '- list:',
    '  - listitem "abcd-efgh-ijkl"',
    '- button "Copy jbswy3dpehpk3pxp"',
    '- button "Copy 48213"',
    '- link "zqlinkname-JBSWY3DPEHPK3PXP":',
    '  - /url: /verify/zqhref',
    '- \'textbox "Note: private"\': typed during takeover',
    '- button "Continue"',
  ].join('\n');
  const kept = withoutValues(tree);
  for (const secret of [
    '48213',
    '7f3k-9x2m',
    'zqcell',
    'zqalt',
    'zqoption',
    'abcd-efgh-ijkl',
    'jbswy3dpehpk3pxp',
    'JBSWY3DPEHPK3PXP',
    'zqhref',
    'typed during takeover',
  ])
    expect([secret, kept.includes(secret)]).toEqual([secret, false]);
  expect(kept.split('\n')).toEqual([
    '- heading [level=1]',
    '- table:',
    '  - row:',
    '    - cell',
    '    - cell',
    '- img',
    '- listbox:',
    '  - option [selected]',
    '- list:',
    '  - listitem',
    `- button "Copy ${REDACTED}"`,
    `- button "Copy ${REDACTED}"`,
    `- link "zqlinkname-${REDACTED}":`,
    '  - /url',
    '- \'textbox "Note: private"\'',
    '- button "Continue"',
  ]);
});

test('a control label on a handed-back page loses seeds, codes and digit runs', () => {
  expect(handbackLabel('Copy jbswy3dpehpk3pxp')).toBe(`Copy ${REDACTED}`);
  expect(handbackLabel('Use code 48213')).toBe(`Use code ${REDACTED}`);
  expect(handbackLabel('Recovery ABCD-EFGH-IJKL')).toBe(`Recovery ${REDACTED}`);
  for (const kept of ['Continue', 'Sign out', 'Page 2 of 3', 'internationalization settings'])
    expect([kept, handbackLabel(kept)]).toEqual([kept, kept]);
});

test('a code in a control label is caught however the site spaces its digits', () => {
  for (const [label, kept] of [
    ['Use 482 913', 'Use '],
    ['Use 482-913', 'Use '],
    ['Code 4 8 2 1 3', 'Code '],
    ['Code 12 34 56', 'Code '],
    ['Copy 48213', 'Copy '],
  ] as const)
    expect([label, handbackLabel(label)]).toEqual([label, `${kept}${REDACTED}`]);
  for (const kept of ['Step 2 of 3', 'Top 10 results', 'Call 911'])
    expect([kept, handbackLabel(kept)]).toEqual([kept, kept]);
});

test('a handed-back URL keeps its host and path shape and loses what could be a code', () => {
  const redacted = encodeURIComponent(REDACTED);
  for (const [url, seen] of [
    ['https://id.example.com/account?ticket=abc#done', 'https://id.example.com/account'],
    ['https://user:pw@example.com/settings/profile', 'https://example.com/settings/profile'],
    ['https://example.com/reset/482913', `https://example.com/reset/${redacted}`],
    ['https://example.com/verify/482-913/', `https://example.com/verify/${redacted}/`],
    ['https://example.com/totp/JBSWY3DPEHPK3PXP', `https://example.com/totp/${redacted}`],
    ['https://example.com/confirm/abcd-efgh-ijkl', `https://example.com/confirm/${redacted}`],
    [
      'https://example.com/magic/f3a9c2e8b7d14a6c9e0f1a2b3c4d5e6f',
      `https://example.com/magic/${redacted}`,
    ],
    ['https://example.com/help/getting-started', 'https://example.com/help/getting-started'],
    ['https://example.com/orders/page-2', 'https://example.com/orders/page-2'],
    ['http://127.0.0.1:3130/verify', 'http://127.0.0.1:3130/verify'],
  ] as const)
    expect([url, handbackUrl(url)]).toEqual([url, seen]);
  expect(handbackUrl('not a url')).toBe('');
});

test('a code of letters alone is caught in a control name, and ordinary names are kept', () => {
  for (const [label, seen] of [
    ['Use code KXQPMZ', `Use code ${REDACTED}`],
    ['Key: QWERTYUI', `Key: ${REDACTED}`],
    ['Recovery key ABCDEFG', `Recovery key ${REDACTED}`],
    ['Your PIN is', 'Your PIN is'],
    ['OTP HJKLMN', `OTP ${REDACTED}`],
    ['Token=ZXCVBN', `Token=${REDACTED}`],
    // Any case, and five letters or nine and more, right after the word.
    ['Use code kxqpmz', `Use code ${REDACTED}`],
    ['Use code Kxqpmz', `Use code ${REDACTED}`],
    ['Code KXQPM', `Code ${REDACTED}`],
    ['Copy key ABCDE', `Copy key ${REDACTED}`],
    ['Token ABCDEFGHIJKL', `Token ${REDACTED}`],
    // Every code in a list, not only the first.
    ['Backup codes: KXQPMZ WQERTY', `Backup codes: ${REDACTED} ${REDACTED}`],
    ['Codes KXQPMZ, WQERTY; ZXCVBN', `Codes ${REDACTED}, ${REDACTED}; ${REDACTED}`],
  ] as const)
    expect([label, handbackLabel(label)]).toEqual([label, seen]);
  for (const kept of ['Enter code', 'Code of CONDUCT', 'Keyboard SHORTCUTS', 'Continue'])
    expect([kept, handbackLabel(kept)]).toEqual([kept, kept]);
});

test('a word mixing letters and digits over six characters is caught in a control name', () => {
  for (const [label, seen] of [
    ['Code K7QP2X', `Code ${REDACTED}`],
    ['Copy K7QP2X9M', `Copy ${REDACTED}`],
    ['Copy 8f3k-9x2m', `Copy ${REDACTED}`],
    ['Continue K7QP2X', `Continue ${REDACTED}`],
    // The accepted cost while a page is handed back.
    ['Buy iPhone15', `Buy ${REDACTED}`],
  ] as const)
    expect([label, handbackLabel(label)]).toEqual([label, seen]);
  for (const kept of ['Page 2 of 3', 'Open v2 settings', 'Play H264', 'Step 12'])
    expect([kept, handbackLabel(kept)]).toEqual([kept, kept]);
  // The tree keeps a button's name only through the same filter.
  expect(withoutValues('- button "Copy K7QP2X9M"')).toBe(`- button "Copy ${REDACTED}"`);
});

test('a handed-back URL loses a long unbroken run, even of letters alone', () => {
  const redacted = encodeURIComponent(REDACTED);
  for (const [url, seen] of [
    [
      'https://example.com/login/magic/qwertyuiopasdfghjklzxcvbnm',
      `https://example.com/login/magic/${redacted}`,
    ],
    ['https://example.com/r/ABCDEFGHIJKLMNOPQRST', `https://example.com/r/${redacted}`],
    ['https://example.com/settings/notifications', 'https://example.com/settings/notifications'],
    [
      'https://example.com/help/a-very-long-readable-article-name',
      'https://example.com/help/a-very-long-readable-article-name',
    ],
  ] as const)
    expect([url, handbackUrl(url)]).toEqual([url, seen]);
});

test('a handed-back URL loses short mixed tokens, encoded tokens and matrix parameters', () => {
  const redacted = encodeURIComponent(REDACTED);
  for (const [url, seen] of [
    ['https://example.com/verify/zqpath-9f3a/', `https://example.com/verify/${redacted}/`],
    ['https://example.com/r/7f3k9x', `https://example.com/r/${redacted}`],
    ['https://example.com/r/abc123/next', `https://example.com/r/${redacted}/next`],
    // Percent-encoded, the token is judged by what it decodes to.
    ['https://example.com/r/%61%62%63%31%32%33', `https://example.com/r/${redacted}`],
    ['https://example.com/login;jsessionid=AB12CD34EF', 'https://example.com/login'],
    ['https://example.com/a;b=1/c;d=2', 'https://example.com/a/c'],
    // Readable paths keep their shape.
    ['https://example.com/v2/users', 'https://example.com/v2/users'],
    ['https://example.com/orders/page-2', 'https://example.com/orders/page-2'],
    ['https://example.com/help/getting-started', 'https://example.com/help/getting-started'],
  ] as const)
    expect([url, handbackUrl(url)]).toEqual([url, seen]);
});
