import { randomBytes } from 'node:crypto';
import type { IdPrefix } from '@melete/contracts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULIDs retain their timestamp prefix without sharing a process-local counter. */
export function newId(prefix: IdPrefix): string {
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let encoded = '';
  for (let i = 0; i < 26; i++) {
    encoded = ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `${prefix}_${encoded}`;
}
