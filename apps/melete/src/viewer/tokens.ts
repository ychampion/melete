/**
 * View tokens: what lets a framed page load its own files.
 *
 * A page framed in Melete has an opaque origin, so it holds no session. Each
 * of its requests carries a token in the address instead. The token names one
 * person, one app, one version, the app's grant generation and the browser
 * session it was issued to, and lasts at most twelve hours. The server checks
 * all of them again on every request: a change to who may open the app, or
 * to the version it shows, or the end of that session, ends the view on its
 * next request. Expiry is only the outer bound; it is what keeps an open app
 * working through a long day without reloading it. The token is signed, not
 * stored.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const VIEW_TTL_SECONDS = 12 * 60 * 60;

export type ViewClaims = {
  principalId: string;
  appId: string;
  versionId: string;
  grantGeneration: number;
  /** Names the browser session without being it: see `sessionTag`. */
  sessionTag: string;
  /** Seconds since the epoch. */
  expiresAt: number;
};

const PART = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9_]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TAG = /^[0-9a-f]{32}$/;

/**
 * What a token says about the session it was issued to: a digest of the
 * session's own digest, which the page can read in its address without
 * learning anything that signs anyone in. The service computes the same
 * value in SQL to find the session again.
 */
export const sessionTag = (sessionDigest: string): string =>
  new Bun.CryptoHasher('sha256').update(`melete view\n${sessionDigest}`).digest('hex').slice(0, 32);

export class ViewTokens {
  private readonly key: Buffer;

  /**
   * With the installation's master key, tokens outlive a restart and every
   * instance accepts each other's. Without one, the key lives as long as the
   * process, and an open view asks for a new token after a restart.
   */
  constructor(
    masterKey?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = masterKey
      ? createHmac('sha256', masterKey).update('melete app view token v1').digest()
      : randomBytes(32);
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(body).digest();
  }

  issue(claims: Omit<ViewClaims, 'expiresAt'>): { token: string; expiresAt: number } {
    const expiresAt = Math.floor(this.now() / 1000) + VIEW_TTL_SECONDS;
    const fields = [
      'v1',
      claims.principalId,
      claims.appId,
      claims.versionId,
      String(claims.grantGeneration),
      claims.sessionTag,
      String(expiresAt),
      randomBytes(9).toString('base64url'),
    ];
    if (
      !ID.test(claims.principalId) ||
      !ID.test(claims.appId) ||
      !HEX64.test(claims.versionId) ||
      !Number.isSafeInteger(claims.grantGeneration) ||
      claims.grantGeneration < 0 ||
      !TAG.test(claims.sessionTag)
    )
      throw new Error(
        'a view token names a principal, an app, a version, a generation and a session',
      );
    const body = Buffer.from(fields.join('.')).toString('base64url');
    return { token: `${body}.${this.mac(body).toString('base64url')}`, expiresAt };
  }

  /** Null for anything absent, malformed, expired or not signed here. */
  verify(token: string | undefined): ViewClaims | null {
    if (!token || token.length > 512) return null;
    const [body, signature, ...rest] = token.split('.');
    if (!body || !signature || rest.length || !PART.test(body) || !PART.test(signature))
      return null;
    const expected = this.mac(body);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const fields = Buffer.from(body, 'base64url').toString('utf8').split('.');
    const [version, principalId, appId, versionId, generation, tag, expires, nonce] = fields;
    if (
      fields.length !== 8 ||
      version !== 'v1' ||
      !principalId ||
      !appId ||
      !versionId ||
      !nonce ||
      !tag ||
      !TAG.test(tag) ||
      !ID.test(principalId) ||
      !ID.test(appId) ||
      !HEX64.test(versionId) ||
      !/^\d{1,9}$/.test(generation ?? '') ||
      !/^\d{1,12}$/.test(expires ?? '')
    )
      return null;
    const expiresAt = Number(expires);
    if (expiresAt * 1000 <= this.now()) return null;
    return {
      principalId,
      appId,
      versionId,
      grantGeneration: Number(generation),
      sessionTag: tag,
      expiresAt,
    };
  }
}
