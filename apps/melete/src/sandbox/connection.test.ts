import { expect, test } from 'bun:test';
import { NOT_A_SANDBOX_KEY, sandboxCredentialValue } from './connection.ts';

test("a secret that is not the adapter's key is refused in one sentence that never quotes it", () => {
  // A mail password is sealed as its raw text; the rest are JSON of the wrong shape.
  const password = 'CorrectHorseBatteryStaple2026';
  const cases: [Parameters<typeof sandboxCredentialValue>[0], string][] = [
    ['e2b', password],
    ['modal', password],
    ['e2b', JSON.stringify({ password })],
    ['e2b', JSON.stringify({ api_key: `ak-${password}:as-${password}` })],
    ['modal', JSON.stringify({ api_key: password })],
    ['modal', `{"api_key": "${password}`],
  ];
  for (const [adapter, sealed] of cases) {
    let message = 'accepted';
    try {
      sandboxCredentialValue(adapter, sealed);
    } catch (error) {
      message = (error as Error).message;
    }
    expect([adapter, message]).toEqual([adapter, NOT_A_SANDBOX_KEY]);
    expect(message.includes(password)).toBe(false);
  }
  // The shapes each adapter reads still pass.
  expect(sandboxCredentialValue('e2b', JSON.stringify({ api_key: 'e2b_key' }))).toEqual({
    api_key: 'e2b_key',
  });
  expect(sandboxCredentialValue('modal', JSON.stringify({ api_key: 'ak-id:as-secret' }))).toEqual({
    token_id: 'ak-id',
    token_secret: 'as-secret',
  });
});
