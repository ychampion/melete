/**
 * Identity assertions: who a tool call is made for, signed by this
 * installation, for a remote connection that asks for one (`identity: true`
 * in its operator policy).
 *
 * Each is a compact JWT signed with EdDSA (Ed25519), valid for five minutes
 * and for one call: `iss` is the installation's API address, `aud` the
 * connection's server (its endpoint's address, `identityAudience`), `sub` an id for the person that
 * only this audience sees, `ent` every entitlement the person holds, `jti` the
 * action the call carries out and `act` the server's own name for the tool.
 * Melete sends it in the `Melete-Identity` request header, which the model
 * never sees or sets. A server checks the signature against the keys published
 * at `<iss>/.well-known/jwks.json` (or a key its operator pinned), then `iss`,
 * `aud`, `exp` and the entitlements it needs.
 *
 * The signing key is derived from the installation's secret, so every
 * instance signs alike and a restart changes nothing. Nothing the model says
 * reaches an assertion: the broker builds it from the job's stored person and
 * the entitlement table, at the moment of the call.
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { IDENTITY_JWKS_PATH, type IdentityClaims, identityClaims } from '@melete/contracts';

export { IDENTITY_JWKS_PATH };
/** How long an assertion is good for. */
export const ASSERTION_TTL_SECONDS = 5 * 60;

/**
 * The audience of an assertion for a connection: its endpoint's address,
 * without query, fragment or trailing slash. Not just the origin: two servers
 * behind one host (a gateway that serves each from its own path) each get
 * their own audience, so one cannot pass a person's assertion on to the other.
 */
export function identityAudience(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The PKCS #8 prefix of an Ed25519 private key, before its 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export type IdentityJwk = {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
};

export class IdentitySigner {
  private readonly privateKey: KeyObject;
  private readonly pairwiseKey: Buffer;
  readonly jwk: IdentityJwk;

  constructor(
    secret: string,
    readonly issuer: string,
    private readonly now: () => number = Date.now,
  ) {
    const seed = createHmac('sha256', secret).update('melete identity assertion v1').digest();
    this.pairwiseKey = createHmac('sha256', secret).update('melete pairwise subject v1').digest();
    this.privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const exported = createPublicKey(this.privateKey).export({ format: 'jwk' }) as { x: string };
    const kid = createHash('sha256').update(exported.x).digest('hex').slice(0, 16);
    this.jwk = { kty: 'OKP', crv: 'Ed25519', x: exported.x, kid, alg: 'EdDSA', use: 'sig' };
  }

  /** The published key set. */
  jwks(): { keys: IdentityJwk[] } {
    return { keys: [this.jwk] };
  }

  /**
   * The person's id at one audience: stable for that server, different at
   * every other, and not the account id or an email.
   */
  subjectFor(audience: string, principalId: string): string {
    const mac = createHmac('sha256', this.pairwiseKey)
      .update(`${audience}\0${principalId}`)
      .digest();
    return `p_${mac.toString('base64url')}`;
  }

  issue(input: {
    audience: string;
    principalId: string;
    entitlements: readonly string[];
    actionId: string;
    tool: string;
  }): string {
    const iat = Math.floor(this.now() / 1000);
    const claims: IdentityClaims = identityClaims.parse({
      iss: this.issuer,
      aud: input.audience,
      sub: this.subjectFor(input.audience, input.principalId),
      ent: [...new Set(input.entitlements)].sort(),
      jti: input.actionId,
      act: input.tool,
      iat,
      exp: iat + ASSERTION_TTL_SECONDS,
    });
    const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.jwk.kid }));
    const body = b64url(JSON.stringify(claims));
    const signature = sign(null, Buffer.from(`${header}.${body}`), this.privateKey);
    return `${header}.${body}.${b64url(signature)}`;
  }
}

/**
 * Checks an assertion as a connection's server would: signature against the
 * key, then issuer, audience and time. Null for anything that fails. Melete
 * itself never needs this; it is here for tests and as the reference a server
 * can follow.
 */
export function verifyAssertion(
  token: string,
  jwk: Pick<IdentityJwk, 'x' | 'kid'>,
  expected: { issuer: string; audience: string },
  now = Date.now(),
): IdentityClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (head.alg !== 'EdDSA' || head.kid !== jwk.kid) return null;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    if (!verify(null, Buffer.from(`${header}.${body}`), key, Buffer.from(signature, 'base64url')))
      return null;
    const claims = identityClaims.parse(
      JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    );
    const seconds = Math.floor(now / 1000);
    if (claims.iss !== expected.issuer || claims.aud !== expected.audience) return null;
    if (claims.exp <= seconds || claims.iat > seconds + 60) return null;
    return claims;
  } catch {
    return null;
  }
}
