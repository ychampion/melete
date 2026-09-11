/**
 * Identifiers for things that do not have a catalog row yet: a space that is
 * only a directory, and a skill that is only a file.
 *
 * The contract wants a ULID, and these are not ULIDs: they carry no time and
 * they never change. They are derived from the name so the same file has the
 * same id on every machine, which is what makes an id in a bug report useful
 * before the database exists. Real rows replace them.
 */
import { createHash } from 'node:crypto';

/** Crockford base32: no I, L, O or U, so an id can be read aloud. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID-shaped identifier that depends only on the seed. */
export function stableUlid(seed: string): string {
  const digest = createHash('sha256').update(seed, 'utf8').digest();
  const characters: string[] = [];
  for (let i = 0; i < 26; i += 1) {
    characters.push(CROCKFORD[(digest[i] ?? 0) % CROCKFORD.length] ?? '0');
  }
  // The first character of a ULID encodes the top of the timestamp and can only
  // be 0 through 7, so the shape stays valid however the digest fell.
  characters[0] = String((digest[0] ?? 0) % 8);
  return characters.join('');
}
