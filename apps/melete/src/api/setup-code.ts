/**
 * The one-time code that claims a new installation. Whoever reaches a fresh
 * install first would otherwise become its owner, so an installation that has
 * a code accepts the first account only with it.
 *
 * A code comes from one of two places. `melete init` makes one, prints it once
 * with a link that carries it, and keeps only its digest, as
 * `MELETE_SETUP_CODE_HASH` in deploy/.env. `melete account setup-code` issues a
 * new one into the database, for an operator who lost the first or provisions
 * installs without `init`. An installation with neither is open to its first
 * visitor, as a local install on 127.0.0.1 always has been.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

/** How long a code from `melete account setup-code` lasts. */
export const SETUP_CODE_HOURS = 72;

/** Letters and digits nobody misreads: no 0/O, 1/I/L, or U. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** A new code: 20 characters in groups of four, about 98 bits. */
export function newSetupCode(): string {
  const chars = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [0, 4, 8, 12, 16].map((at) => chars.slice(at, at + 4).join('')).join('-');
}

/** The code as typed, without spaces, dashes or case. */
export const normalizeSetupCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** What is kept of a code: the SHA-256 of its normal form, in hex. */
export const setupCodeHash = (code: string) =>
  createHash('sha256').update(normalizeSetupCode(code)).digest('hex');

/** The link that opens setup with the code filled in. The fragment never reaches a server log. */
export function setupLink(webUrl: string, code: string): string {
  const url = new URL('/', webUrl);
  url.hash = `/welcome?${new URLSearchParams({ code })}`;
  return url.href;
}

const sameDigest = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Whether creating the first account needs a code here. */
export async function setupCodeRequired(
  sql: Sql | TransactionSql,
  configuredHash: string | undefined,
): Promise<boolean> {
  if (configuredHash) return true;
  const [issued] = await sql`select 1 from setup_code limit 1`;
  return Boolean(issued);
}

/**
 * Checks a code inside the setup transaction and spends a database code that
 * matched. True when the code is the configured one or an unused, unexpired
 * issued one.
 */
export async function spendSetupCode(
  tx: TransactionSql,
  configuredHash: string | undefined,
  code: string,
): Promise<boolean> {
  const hash = setupCodeHash(code);
  if (configuredHash && sameDigest(hash, configuredHash.toLowerCase())) return true;
  const spent = await tx`update setup_code set used_at = now()
    where code_hash = ${hash} and used_at is null and expires_at > now() returning code_hash`;
  return spent.length > 0;
}

/**
 * Issues a new code for an installation that has no owner yet. Earlier issued
 * codes stop working. Null once an owner exists.
 */
export async function issueSetupCode(sql: Sql): Promise<{ code: string; expiresAt: Date } | null> {
  const code = newSetupCode();
  const expiresAt = new Date(Date.now() + SETUP_CODE_HOURS * 3_600_000);
  const issued = await sql.begin(async (tx) => {
    const [installed] = await tx`select id from owner limit 1`;
    if (installed) return false;
    await tx`update setup_code set used_at = now() where used_at is null`;
    await tx`insert into setup_code (code_hash, expires_at)
      values (${setupCodeHash(code)}, ${expiresAt.toISOString()})`;
    return true;
  });
  return issued ? { code, expiresAt } : null;
}
