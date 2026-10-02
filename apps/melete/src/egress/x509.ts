/**
 * The few X.509 certificates the egress relay needs, written as DER.
 *
 * Node and Bun generate keys but not certificates, and the shapes needed here
 * are small and fixed, so they are written out rather than taken from a
 * dependency: a certificate authority whose name constraints permit only the
 * adapters' DNS subtrees and exclude every IP address, and short-lived leaves
 * for one host each, signed by it. Both use ECDSA P-256 with SHA-256.
 */
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto';

const length = (size: number): Buffer => {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

/** One DER tag-length-value. */
const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const integer = (value: Buffer): Buffer =>
  tlv(0x02, (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const utf8 = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'));
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octets = (value: Buffer): Buffer => tlv(0x04, value);
/** A BIT STRING with `unused` trailing bits in its last byte. */
const bits = (value: Buffer, unused = 0): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([unused]), value]));

function objectId(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const bytes = [(arcs[0] ?? 0) * 40 + (arcs[1] ?? 0)];
  for (const arc of arcs.slice(2)) {
    const base128: number[] = [];
    let rest = arc;
    do {
      base128.unshift((rest & 0x7f) | (base128.length > 0 ? 0x80 : 0));
      rest >>>= 7;
    } while (rest > 0);
    bytes.push(...base128);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
/** UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(at: Date): Buffer {
  const rest =
    `${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  const year = at.getUTCFullYear();
  return year < 2050
    ? tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`, 'ascii'))
    : tlv(0x18, Buffer.from(`${pad(year, 4)}${rest}`, 'ascii'));
}

const name = (common: string): Buffer =>
  sequence(
    set(sequence(objectId('2.5.4.10'), utf8('Melete'))),
    set(sequence(objectId('2.5.4.3'), utf8(common))),
  );

const extension = (oid: string, critical: boolean, value: Buffer): Buffer =>
  sequence(objectId(oid), ...(critical ? [boolean(true)] : []), octets(value));

const ECDSA_SHA256 = sequence(objectId('1.2.840.10045.4.3.2'));

export const pem = (label: string, der: Buffer): string =>
  `-----BEGIN ${label}-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

/** The DER inside the first PEM block of `label`. */
export function derOf(label: string, text: string): Buffer {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(text);
  if (!match?.[1]) throw new Error(`no ${label} in the text`);
  return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
}

/** A positive serial of 16 random bytes. */
function serial(): Buffer {
  const value = randomBytes(16);
  value[0] = ((value[0] ?? 0) & 0x7f) | 0x01;
  return value;
}

/** RFC 5280 method 1: the SHA-1 of the public key's bits, the uncompressed EC point. */
export function keyIdentifier(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y) throw new Error('an EC public key was expected');
  return createHash('sha1')
    .update(
      Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, 'base64url'),
        Buffer.from(jwk.y, 'base64url'),
      ]),
    )
    .digest();
}

function signed(tbs: Buffer, key: KeyObject): Buffer {
  return sequence(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, { key, dsaEncoding: 'der' })));
}

export type KeyPair = { privateKey: KeyObject; publicKey: KeyObject };

export function newKeyPair(): KeyPair {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

/**
 * A self-signed CA that may sign for `permitted` DNS subtrees and nothing
 * else: no other name, and no IP address of either family.
 */
export function certificateAuthority(input: {
  keys: KeyPair;
  commonName: string;
  permitted: readonly string[];
  notBefore: Date;
  notAfter: Date;
}): Buffer {
  if (!input.permitted.length) throw new Error('a constrained CA needs at least one name');
  const spki = input.keys.publicKey.export({ type: 'spki', format: 'der' });
  const subject = name(input.commonName);
  const subtrees = input.permitted.map((entry) =>
    sequence(tlv(0x82, Buffer.from(entry.toLowerCase().replace(/^\./, ''), 'ascii'))),
  );
  const excluded = [sequence(tlv(0x87, Buffer.alloc(8))), sequence(tlv(0x87, Buffer.alloc(32)))];
  const constraints = sequence(
    tlv(0xa0, Buffer.concat(subtrees)),
    tlv(0xa1, Buffer.concat(excluded)),
  );
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial()),
    ECDSA_SHA256,
    subject,
    sequence(time(input.notBefore), time(input.notAfter)),
    subject,
    spki,
    tlv(
      0xa3,
      sequence(
        extension('2.5.29.19', true, sequence(boolean(true), integer(Buffer.from([0])))),
        // keyCertSign and cRLSign.
        extension('2.5.29.15', true, bits(Buffer.from([0x06]), 1)),
        extension('2.5.29.14', false, octets(keyIdentifier(input.keys.publicKey))),
        extension('2.5.29.30', true, constraints),
      ),
    ),
  );
  return signed(tbs, input.keys.privateKey);
}

/** A server certificate for one host, signed by the CA whose key and certificate are given. */
export function leafCertificate(input: {
  host: string;
  keys: KeyPair;
  caCert: Buffer;
  caKey: KeyObject;
  caCommonName: string;
  notBefore: Date;
  notAfter: Date;
}): Buffer {
  const spki = input.keys.publicKey.export({ type: 'spki', format: 'der' });
  const caKeyId = keyIdentifier(new X509Certificate(input.caCert).publicKey);
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial()),
    ECDSA_SHA256,
    name(input.caCommonName),
    sequence(time(input.notBefore), time(input.notAfter)),
    name(input.host),
    spki,
    tlv(
      0xa3,
      sequence(
        extension('2.5.29.19', true, sequence()),
        // digitalSignature.
        extension('2.5.29.15', true, bits(Buffer.from([0x80]), 7)),
        extension('2.5.29.37', false, sequence(objectId('1.3.6.1.5.5.7.3.1'))),
        extension('2.5.29.17', false, sequence(tlv(0x82, Buffer.from(input.host, 'ascii')))),
        extension('2.5.29.14', false, octets(keyIdentifier(input.keys.publicKey))),
        extension('2.5.29.35', false, sequence(tlv(0x80, caKeyId))),
      ),
    ),
  );
  return signed(tbs, input.caKey);
}
