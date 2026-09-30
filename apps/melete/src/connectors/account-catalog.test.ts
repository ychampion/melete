/**
 * The catalog tells a person where they will sign in and what is asked for
 * before anything starts. Those words must be the connectors' own requests.
 */
import { describe, expect, test } from 'bun:test';
import { ACCOUNT_CATALOG } from '@melete/contracts';
import { GOOGLE_ENDPOINTS, GOOGLE_SIGN_IN_SCOPE } from './google.ts';
import { MICROSOFT_SIGN_IN_SCOPE, microsoftEndpoints } from './microsoft.ts';

const entry = (provider: 'google' | 'microsoft') => {
  const found = ACCOUNT_CATALOG.find((item) => item.provider === provider);
  if (!found) throw new Error(`No catalog entry for ${provider}`);
  return found;
};

describe('the account catalog', () => {
  test('names exactly the scopes each sign-in asks for, each in plain words', () => {
    expect(entry('google').scopes.map((item): string => item.scope)).toEqual(
      GOOGLE_SIGN_IN_SCOPE.split(' '),
    );
    expect(entry('microsoft').scopes.map((item): string => item.scope)).toEqual(
      MICROSOFT_SIGN_IN_SCOPE.split(' '),
    );
    for (const provider of ['google', 'microsoft'] as const)
      for (const item of entry(provider).scopes) expect(item.label.length).toBeGreaterThan(0);
  });

  test('names the host the browser is sent to for each sign-in', () => {
    expect(entry('google').issuer as string).toBe(new URL(GOOGLE_ENDPOINTS.authorize).origin);
    expect(entry('microsoft').issuer as string).toBe(
      new URL(microsoftEndpoints().authorize).origin,
    );
  });
});
