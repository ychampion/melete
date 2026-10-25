import { expect, test } from 'bun:test';
import { namedOption } from './options.ts';

const options = [
  { id: 'send_redacted', label: 'Send a redacted version' },
  { id: 'keep_private', label: 'Keep it private' },
];

test('a reply that is an option label, however it is typed, names that option', () => {
  for (const reply of [
    'Send a redacted version',
    'send a redacted version',
    '  SEND A REDACTED VERSION.  ',
    'Send a redacted version!',
    '"Send a redacted version"',
    '“Send a redacted version.”',
    'Send  a\tredacted\nversion',
    'Send a redacted-version',
  ])
    expect(namedOption(reply, options)?.id).toBe('send_redacted');
  expect(namedOption('keep it private.', options)?.id).toBe('keep_private');
});

test('a reply that says more or less than a label names nothing', () => {
  for (const reply of [
    '',
    '   ',
    '...',
    'Yes, that’s fine, send the redacted version. It’s just a car shopping question.',
    'Send a redacted version please',
    'Please send a redacted version',
    'redacted',
    'Send',
    'send_redacted',
    '1',
    "Don't keep it private",
    'Keep it private or send a redacted version',
  ])
    expect(namedOption(reply, options)).toBeNull();
});

test('two options that read the same when typed are told apart by neither', () => {
  expect(
    namedOption('yes', [
      { id: 'a', label: 'Yes' },
      { id: 'b', label: 'Yes!' },
    ]),
  ).toBeNull();
});
