/**
 * The one-time code that claims a new installation. Whoever reaches a fresh
 * install first would otherwise become its owner, so an installation that has
 * a code accepts the first account only with it.
 *
 * A code comes from one of two places. `melete init` makes one, prints it once
 * with a link that carries it, and keeps only its digest, as
 * `MELETE_SETUP_CODE_HASH` in deploy/.env. `melete account setup-code` issues a
 * new one into the database, for an operator who lost the first or provisions
 * installs without `init`. Both follow the same rules: the service records the
 * configured digest in the database the first time it starts with it, so that
 * code too works once, expires SETUP_CODE_HOURS later, and stops working when
 * `account setup-code` issues another. An installation with neither is open to its first
 * visitor only while every address it is configured with is on this machine,
 * as a local install on 127.0.0.1 always has been, or when its operator sets
 * MELETE_SETUP_OPEN=true on purpose.
 */
import { createHash, randomInt } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

/**
 * How long a setup code lasts: one from `melete account setup-code` from when
 * it is issued, the one `melete init` printed from when the service first
 * starts with it.
 */
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

/** The settings that say who can reach the sign-in page, as the service or deploy/.env has them. */
export type ClaimSettings = {
  MELETE_PUBLIC_URL?: string | undefined;
  MELETE_WEB_ORIGIN?: string | undefined;
  /** True only when the operator chose to let the first visitor in without a code. */
  MELETE_SETUP_OPEN?: boolean | undefined;
};

/** A host only this machine reaches: localhost (and names under it), 127.0.0.0/8 or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The first configured address that names another machine, MELETE_PUBLIC_URL
 * before MELETE_WEB_ORIGIN, or null when each is unset or on this machine. An
 * address that is not a URL counts as another machine's.
 */
export function publicAddress(settings: ClaimSettings): string | null {
  for (const value of [settings.MELETE_PUBLIC_URL, settings.MELETE_WEB_ORIGIN]) {
    const address = value?.trim();
    if (!address) continue;
    let hostname: string;
    try {
      hostname = new URL(address).hostname;
    } catch {
      return address;
    }
    if (!isLoopbackHost(hostname)) return address;
  }
  return null;
}

/**
 * Whether an installation with no setup code still turns its first visitor
 * away: it names an address other machines reach, and the operator has not
 * set MELETE_SETUP_OPEN=true.
 */
export const openClaimRefused = (settings: ClaimSettings): boolean =>
  settings.MELETE_SETUP_OPEN !== true && publicAddress(settings) !== null;

/** The answer to a first account attempted where no code exists and none may be skipped. */
export const SETUP_CODE_NOT_ISSUED =
  'This installation can be reached from other machines, so its first account needs a setup code, and none has been made yet. Whoever runs it can make one on the host with `bun run melete account setup-code`, or set MELETE_SETUP_OPEN=true to let the first visitor in without one.';

/**
 * What the operator is told at start while no account exists and the claim is
 * decided by the address alone; null when there is nothing to say.
 */
export async function claimNotice(
  sql: Sql,
  settings: ClaimSettings & { MELETE_SETUP_CODE_HASH?: string | undefined },
): Promise<string | null> {
  const address = publicAddress(settings);
  if (address === null) return null;
  const [installed] = await sql`select 1 from owner limit 1`;
  if (installed || (await setupCodeRequired(sql, settings.MELETE_SETUP_CODE_HASH))) return null;
  return settings.MELETE_SETUP_OPEN === true
    ? `WARNING: MELETE_SETUP_OPEN=true and no account exists yet, so whoever opens ${address} first becomes this installation's owner. Create your account now, or run bun run melete account setup-code and set MELETE_SETUP_OPEN=false.`
    : `No account exists yet, and ${address} can be reached from other machines, so creating it needs a setup code. Run bun run melete account setup-code on this host to make one.`;
}

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
 * Records the code `melete init` configured (MELETE_SETUP_CODE_HASH) as a
 * database code, so it follows an issued code's rules: it lasts
 * SETUP_CODE_HOURS from now, works once, and a newer `account setup-code`
 * cancels it. Only the first call for a digest records it; later ones, at
 * every start, change nothing, so neither a restart nor a cancelled code
 * brings it back. Nothing is recorded once an owner exists.
 */
export async function recordConfiguredCode(
  sql: Sql | TransactionSql,
  configuredHash: string | undefined,
): Promise<void> {
  const hash = configuredHash?.trim().toLowerCase();
  if (!hash) return;
  await sql`insert into setup_code (code_hash, expires_at)
    select ${hash}, now() + make_interval(hours => ${SETUP_CODE_HOURS})
    where not exists (select 1 from owner)
    on conflict (code_hash) do nothing`;
}

/**
 * Checks a code inside the setup transaction and spends it when it matched.
 * True when the code is an unused, unexpired one: the configured code, under
 * the same rules as an issued one (recordConfiguredCode), or an issued one.
 */
export async function spendSetupCode(
  tx: TransactionSql,
  configuredHash: string | undefined,
  code: string,
): Promise<boolean> {
  const hash = setupCodeHash(code);
  await recordConfiguredCode(tx, configuredHash);
  const spent = await tx`update setup_code set used_at = now()
    where code_hash = ${hash} and used_at is null and expires_at > now() returning code_hash`;
  return spent.length > 0;
}

/**
 * Issues a new code for an installation that has no owner yet. Earlier codes
 * stop working, the configured one included. Null once an owner exists.
 */
export async function issueSetupCode(
  sql: Sql,
  configuredHash?: string,
): Promise<{ code: string; expiresAt: Date } | null> {
  const code = newSetupCode();
  const expiresAt = await sql.begin(async (tx) => {
    const [installed] = await tx`select id from owner limit 1`;
    if (installed) return null;
    // Recorded first, so the cancellation below reaches the configured code
    // even when the service has not started with it yet.
    await recordConfiguredCode(tx, configuredHash);
    await tx`update setup_code set used_at = now() where used_at is null`;
    // Timed by the database's clock, which is the one spending it checks.
    const [row] = await tx<
      { expires_at: Date | string }[]
    >`insert into setup_code (code_hash, expires_at)
      values (${setupCodeHash(code)}, now() + make_interval(hours => ${SETUP_CODE_HOURS}))
      returning expires_at`;
    return row ? new Date(row.expires_at) : null;
  });
  return expiresAt ? { code, expiresAt } : null;
}
