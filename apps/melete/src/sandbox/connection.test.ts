import { expect, test } from 'bun:test';
import {
  NOT_A_SANDBOX_KEY,
  sandboxCredentialValue,
  sandboxSpecFor,
  sandboxTimeZone,
} from './connection.ts';

test("a sandbox is made in the person's time zone, and a zone that is not one is left out", () => {
  const spec = (timeZone?: string | null) =>
    sandboxSpecFor(
      {
        adapter: 'e2b',
        image: 'base',
        egress: 'deny_all',
        persistence: 'ephemeral',
        lifetime_seconds: 600,
      },
      { project: 'p', connectionId: 'conn_1', spaceId: 'sp_1', session: 'sbx_1', timeZone },
    ).env;
  expect(spec('Europe/Paris')).toEqual({ LANG: 'C.UTF-8', TZ: 'Europe/Paris' });
  expect(spec(null)).toEqual({ LANG: 'C.UTF-8' });
  // An unknown zone or anything that is not a zone name reads as UTC, not as text in the shell.
  expect(sandboxTimeZone('Not/AZone')).toBe('UTC');
  expect(sandboxTimeZone('$(reboot)')).toBe('UTC');
  expect(sandboxTimeZone(undefined)).toBeNull();
  // An old name a browser reports is given as the name the sandbox's zone files know.
  expect(sandboxTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata');
  expect(sandboxTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
  expect(spec('Europe/Kiev')).toEqual({ LANG: 'C.UTF-8', TZ: 'Europe/Kyiv' });
});

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
