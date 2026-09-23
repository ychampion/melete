import { describe, expect, test } from 'bun:test';
import { discoverIssuer, issuerEndpoint, OAuthFailure } from './oauth.ts';

/** A metadata server that answers every well-known path with one document. */
const serving = (document: Record<string, string>) => async (): Promise<Response> =>
  Response.json(document);

const metadata = (issuer: string, overrides: Record<string, string> = {}) => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  revocation_endpoint: `${issuer}/revoke`,
  ...overrides,
});

describe('reading an issuer from its metadata', () => {
  test('takes the endpoints of a document that names the issuer it was fetched for', async () => {
    const found = await discoverIssuer(
      'https://login.example.test/',
      serving(metadata('https://login.example.test')),
    );
    expect(found).toEqual({
      authorizeUrl: 'https://login.example.test/authorize',
      tokenUrl: 'https://login.example.test/token',
      revokeUrl: 'https://login.example.test/revoke',
    });
  });

  test('refuses a document that names another issuer', async () => {
    const refused = await discoverIssuer(
      'https://login.example.test',
      serving(metadata('https://attacker.example.test')),
    ).catch((error) => error);
    expect(refused).toBeInstanceOf(OAuthFailure);
    expect((refused as OAuthFailure).code).toBe('issuer_discovery_failed');
  });

  test('refuses endpoints on this machine from an issuer elsewhere', async () => {
    for (const endpoint of ['token_endpoint', 'authorization_endpoint', 'revocation_endpoint']) {
      const refused = await discoverIssuer(
        'https://login.example.test',
        serving(
          metadata('https://login.example.test', { [endpoint]: 'http://127.0.0.1:9000/local' }),
        ),
      ).catch((error) => error);
      expect([endpoint, (refused as OAuthFailure).code]).toEqual([
        endpoint,
        'issuer_discovery_failed',
      ]);
    }
  });

  test('lets an issuer on this machine name endpoints on this machine', async () => {
    const found = await discoverIssuer(
      'http://127.0.0.1:9000',
      serving(metadata('http://127.0.0.1:9000')),
    );
    expect(found.tokenUrl).toBe('http://127.0.0.1:9000/token');
  });
});

describe('an endpoint a credential may go to', () => {
  test('is on this machine only when the issuer is', () => {
    expect(issuerEndpoint('https://login.example.test/token', 'https://login.example.test')).toBe(
      true,
    );
    expect(issuerEndpoint('http://localhost:9000/token', 'https://login.example.test')).toBe(false);
    expect(issuerEndpoint('http://localhost:9000/token', 'http://localhost:9000')).toBe(true);
    expect(issuerEndpoint('http://login.example.test/token', 'http://localhost:9000')).toBe(false);
  });
});
