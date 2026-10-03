/**
 * Database errors as they may be printed. libpq repeats parts of the
 * connection string in some errors (a malformed one is echoed back as an
 * "invalid percent-encoded token"), and Compose or a client may print the URL
 * itself. Before a database error reaches output, the URL, its password and
 * the bundled database's password are replaced with `***`, wherever and however
 * they appear.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from '../../../deploy/scripts/provider-settings.ts';

const HIDDEN = '***';

/** The values to hide: the URL, its password as written and decoded, and POSTGRES_PASSWORD. */
export function databaseSecrets(env: Record<string, string> | null): string[] {
  const url = env?.DATABASE_URL?.trim() ?? '';
  const values = [url, env?.POSTGRES_PASSWORD?.trim() ?? ''];
  // The password as written: after the scheme's user and before the last @, even
  // when the URL is malformed and no parser accepts it.
  const written = /^[a-z][a-z0-9+.-]*:\/\/[^:/@]*:(.*)@[^@]*$/i.exec(url)?.[1] ?? '';
  values.push(written);
  try {
    values.push(decodeURIComponent(written));
  } catch {
    // A malformed escape: the written form above is what an error would repeat.
  }
  // Longest first, so a password inside the URL never leaves the rest of the URL behind.
  return [...new Set(values.filter((value) => value.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
}

/** deploy/.env's database secrets; none when there is no file. */
export function installationSecrets(deployDir: string): string[] {
  const path = join(deployDir, '.env');
  return existsSync(path) ? databaseSecrets(parseEnvFile(readFileSync(path, 'utf8'))) : [];
}

/** The text with every secret, any URL's password and libpq's echoed tokens hidden. */
export function redact(text: string, secrets: readonly string[]): string {
  let hidden = text;
  for (const secret of secrets) hidden = hidden.split(secret).join(HIDDEN);
  return hidden
    .replace(/(postgres(?:ql)?:\/\/[^:/@\s"']*:)[^\s"']*@/gi, `$1${HIDDEN}@`)
    .replace(/(invalid percent-encoded token:\s*)"[^"]*"/gi, `$1"${HIDDEN}"`)
    .replace(/(password=)\S+/gi, `$1${HIDDEN}`);
}
