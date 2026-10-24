/**
 * A loopback OpenID Connect provider, for tests only. It publishes OpenID
 * metadata and a key set, approves every authorization request at once (as a
 * person signing in would), and answers the code with an ID token. The token
 * endpoint checks PKCE, the redirect address, the client secret and that each
 * code is used once. A test shapes the next ID tokens through `claims` and
 * `signing`, so the service can be seen refusing each kind of bad token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose';

export type FakeOidcSigning =
  /** RS256 with the published key: a good token. */
  | 'published'
  /** RS256 with a key the provider never published. */
  | 'unpublished'
  /** `alg: none`, no signature at all. */
  | 'none'
  /** HS256 with the published public key as the shared secret: algorithm confusion. */
  | 'hs256-public-key'
  /**
   * RS256 with an unpublished key that the token's own header offers, inline
   * (`jwk`) and by address (`jku`, `x5u`): a verifier must never take a key
   * from the token itself.
   */
  | 'header-key';

export type FakeOidc = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Merged over the standard claims of every ID token issued from now on; `undefined` removes one. */
  claims: Record<string, unknown>;
  signing: FakeOidcSigning;
  authorizeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  /** How often anything fetched the key set a `header-key` token points at. */
  headerKeyFetches: number;
  /** A token signed with the published key, for back-channel logout. */
  sign(claims: JWTPayload, typ?: string): Promise<string>;
  stop(): Promise<void>;
};

export async function startFakeOidc(
  options: { clientId?: string; clientSecret?: string; basicOnly?: boolean } = {},
): Promise<FakeOidc> {
  const clientId = options.clientId ?? 'melete-test-client';
  const clientSecret = options.clientSecret ?? 'melete-test-secret';
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256', { extractable: true });
  const otherJwk: JWK = { ...(await exportJWK(other.publicKey)), kid: 'k2', alg: 'RS256' };
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; nonce: string | null }
  >();
  let origin = '';

  const fake: FakeOidc = {
    issuer: '',
    clientId,
    clientSecret,
    claims: {},
    signing: 'published',
    authorizeRequests: [],
    tokenRequests: [],
    headerKeyFetches: 0,
    sign: (claims, typ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1', ...(typ ? { typ } : {}) })
        .sign(privateKey),
    stop: async () => {
      await server.stop(true);
    },
  };

  const idToken = async (nonce: string | null): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: origin,
      aud: clientId,
      sub: 'subject-1',
      email: 'person@example.test',
      email_verified: true,
      iat: now,
      exp: now + 300,
      ...(nonce ? { nonce } : {}),
    };
    for (const [name, value] of Object.entries(fake.claims)) {
      if (value === undefined) delete claims[name];
      else claims[name] = value;
    }
    const payload = claims as JWTPayload;
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    switch (fake.signing) {
      case 'none':
        return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
      case 'hs256-public-key':
        return new SignJWT(payload)
          .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
          .sign(new TextEncoder().encode(JSON.stringify(jwk)));
      case 'unpublished':
        return new SignJWT(payload)
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .sign(other.privateKey);
      case 'header-key':
        return new SignJWT(payload)
          .setProtectedHeader({
            alg: 'RS256',
            kid: 'k2',
            jwk: otherJwk,
            jku: `${origin}/header-jwks`,
            x5u: `${origin}/header-jwks`,
          })
          .sign(other.privateKey);
      default:
        return new SignJWT(payload)
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .sign(privateKey);
    }
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/openid-configuration')
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: options.basicOnly
            ? ['client_secret_basic']
            : ['client_secret_post', 'client_secret_basic'],
          backchannel_logout_supported: true,
        });
      if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
      if (url.pathname === '/header-jwks') {
        fake.headerKeyFetches += 1;
        return Response.json({ keys: [otherJwk] });
      }
      if (url.pathname === '/authorize') {
        fake.authorizeRequests.push(url.searchParams);
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        const code = `code-${randomBytes(12).toString('hex')}`;
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri: back.href,
          clientId: url.searchParams.get('client_id') ?? '',
          nonce: url.searchParams.get('nonce'),
        });
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        return new Response(null, { status: 302, headers: { location: back.href } });
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const fields = new URLSearchParams(await request.text());
        fake.tokenRequests.push(fields);
        const grant = codes.get(fields.get('code') ?? '');
        codes.delete(fields.get('code') ?? '');
        const basic = request.headers.get('authorization');
        const secretOk = options.basicOnly
          ? basic === `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
          : fields.get('client_secret') === clientSecret;
        const verified =
          grant &&
          secretOk &&
          fields.get('grant_type') === 'authorization_code' &&
          grant.clientId === clientId &&
          fields.get('client_id') === clientId &&
          grant.redirectUri === fields.get('redirect_uri') &&
          createHash('sha256')
            .update(fields.get('code_verifier') ?? '')
            .digest('base64url') === grant.challenge;
        if (!verified || !grant) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({
          access_token: `access-${randomBytes(12).toString('hex')}`,
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: await idToken(grant.nonce),
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  fake.issuer = origin;
  return fake;
}
