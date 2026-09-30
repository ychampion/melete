import { expect, test } from 'bun:test';
import { describeFailure } from './faults.ts';

const shown = (message: string) => describeFailure(new Error(message));

test('a failure shown to the model keeps its reason and drops any credential it quoted', () => {
  const cases: Array<[message: string, secret: string, kept: string]> = [
    [
      'fetch failed for https://alice:hunter2@api.example.com/v1/items',
      'hunter2',
      'api.example.com',
    ],
    ['401 from upstream: Authorization: Bearer abc.def.ghi123', 'abc.def.ghi123', '401'],
    ['upstream said: Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz', 'upstream said'],
    ['invalid api key sk-proj-ABCDEF1234567890XYZ', 'ABCDEF1234567890XYZ', 'invalid api key'],
    ['key AKIAIOSFODNN7EXAMPLE was refused', 'AKIAIOSFODNN7EXAMPLE', 'was refused'],
    ['bad grant: refresh_token=1//0gAbC/dEf-GhI_jk', '0gAbC', 'bad grant'],
    ['could not open file:///srv/share/private/notes.md', 'private', 'could not open'],
    ['cannot read host:/etc/melete/config.yml', '/etc/melete', 'cannot read'],
  ];
  for (const [message, secret, kept] of cases) {
    const line = shown(message);
    expect(line).not.toContain(secret);
    expect(line).toContain(kept);
  }
});

test('an ordinary failure reads as it was written', () => {
  expect(shown('mailbox busy, try again in a minute')).toBe('mailbox busy, try again in a minute');
  expect(shown('fetch failed for https://example.com/page?token=abc')).toBe(
    'fetch failed for https://example.com/page',
  );
});
