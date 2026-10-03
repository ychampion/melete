/**
 * MELETE_MASTER_KEY seals every credential the database holds, so a backup set
 * that carried it would open itself. A backup stores deploy/.env with the key's
 * value removed, and beside it only the key's fingerprint, a one-way hash that
 * lets a restore confirm the key the operator supplies is the one the database
 * was sealed with. The operator keeps the key apart from the backups.
 */
import { createHash } from 'node:crypto';
import { parseEnvFile } from '../../../deploy/scripts/provider-settings.ts';

export const MASTER_KEY = 'MELETE_MASTER_KEY';
/** The file in a backup set that holds the fingerprint. */
export const FINGERPRINT_FILE = 'master-key.fingerprint';

/** `sha256:<hex>` of the key, under a label of its own so the hash is used for nothing else. */
export const masterKeyFingerprint = (key: string): string =>
  `sha256:${createHash('sha256').update(`melete master key fingerprint\n${key.trim()}`).digest('hex')}`;

/**
 * deploy/.env's text with the master key's value removed, every other line as
 * it was, and the key itself; null when the file sets none.
 */
export function withoutMasterKey(text: string): { text: string; key: string | null } {
  const key = parseEnvFile(text)[MASTER_KEY]?.trim() || null;
  const line = new RegExp(`^([ \\t]*(?:export[ \\t]+)?${MASTER_KEY}[ \\t]*=).*$`, 'gm');
  return { text: text.replace(line, '$1'), key };
}
