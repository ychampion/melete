/**
 * Keeps new credentials out of the computer. A connected account must never
 * become a way to hand the computer a credential of its own: a service that
 * answers with a freshly made token (a rotated personal token, a deploy or
 * runner token, an npm login) would put a usable secret where the account's
 * own never goes. Adapters refuse the requests that make them; this guard is
 * the second line, on every answer that comes back: an answer holding one is
 * not passed on.
 *
 * The patterns are the services' documented token prefixes followed by
 * enough token characters that ordinary text does not match by chance.
 */

/** Credentials a service may hand out, by name, as they appear in an answer. */
export const MINTED_CREDENTIALS = {
  gitlab_personal: /glpat-[A-Za-z0-9_-]{20,}/,
  gitlab_deploy: /gldt-[A-Za-z0-9_-]{20,}/,
  gitlab_runner: /glrt-[A-Za-z0-9_-]{20,}/,
  gitlab_trigger: /glptt-[A-Za-z0-9_-]{20,}/,
  npm: /npm_[A-Za-z0-9]{36}/,
} as const satisfies Record<string, RegExp>;
export type MintedCredential = keyof typeof MINTED_CREDENTIALS;

/** The longest stretch a pattern needs to recognise a credential. */
const LONGEST_TRIGGER = 64;

/** The first kind of credential `text` holds, or null. */
export function credentialIn(
  text: string | Buffer,
  kinds: readonly MintedCredential[],
): MintedCredential | null {
  const value = typeof text === 'string' ? text : text.toString('latin1');
  for (const kind of kinds) if (MINTED_CREDENTIALS[kind].test(value)) return kind;
  return null;
}

/** Thrown when an answer holds a credential; nothing after the bytes before it is passed on. */
export class CredentialInAnswer extends Error {
  constructor(readonly kind: MintedCredential) {
    super(`the answer held a new ${kind.replace('_', ' ')} credential, so it was not passed on`);
  }
}

/**
 * Checks an answer as it streams. Each `feed` returns the bytes that are safe
 * to pass on and keeps back the last few, so a credential split across two
 * chunks is seen whole before any of it leaves. Throws `CredentialInAnswer`
 * as soon as one is seen.
 */
export class CredentialStreamGuard {
  private held = Buffer.alloc(0);

  constructor(private readonly kinds: readonly MintedCredential[]) {}

  feed(chunk: Buffer): Buffer {
    if (!this.kinds.length) return chunk;
    const joined = Buffer.concat([this.held, chunk]);
    const found = credentialIn(joined, this.kinds);
    if (found) throw new CredentialInAnswer(found);
    const keep = Math.min(joined.length, LONGEST_TRIGGER - 1);
    this.held = joined.subarray(joined.length - keep);
    return joined.subarray(0, joined.length - keep);
  }

  end(): Buffer {
    const rest = this.held;
    this.held = Buffer.alloc(0);
    return rest;
  }
}
