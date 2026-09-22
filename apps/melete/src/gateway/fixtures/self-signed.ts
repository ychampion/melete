/**
 * A throwaway TLS pair for the CONNECT tests, built when the test runs.
 *
 * The gateway terminates TLS for a provider host, so the test's client has to
 * verify the gateway's own certificate against that host name — which means the
 * certificate has to name it. A committed key is the wrong way to hold one: a
 * `BEGIN PRIVATE KEY` in a public repository is what every secret scanner is
 * built to find, and a certificate that names a real host has to be given a
 * long life to stay usable, which is a worse thing to keep than to make. This
 * pair exists for the length of one test and is valid for a day.
 *
 * Node can generate the key but not the certificate, so the few hundred bytes
 * of DER are written out here rather than taking a dependency or a system
 * `openssl` the test would then have to skip without.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

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
/** An unused-bits count of zero, then the payload. */
const bits = (value: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));

function objectId(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const bytes = [(arcs[0] ?? 0) * 40 + (arcs[1] ?? 0)];
  for (const arc of arcs.slice(2)) {
    const base128: number[] = [];
    let rest = arc;
    // Every byte but the last carries the continuation bit.
    do {
      base128.unshift((rest & 0x7f) | (base128.length > 0 ? 0x80 : 0));
      rest >>>= 7;
    } while (rest > 0);
    bytes.push(...base128);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const pad = (value: number): string => String(value).padStart(2, '0');
const utcTime = (at: Date): Buffer =>
  tlv(
    0x17,
    Buffer.from(
      `${pad(at.getUTCFullYear() % 100)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
        `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`,
      'ascii',
    ),
  );

const attribute = (oid: string, value: string): Buffer => set(sequence(objectId(oid), utf8(value)));

const pem = (label: string, der: Buffer): string =>
  `-----BEGIN ${label}-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

/**
 * A self-signed certificate for `host`, and the key that signed it. The client
 * trusts it as a certificate authority and checks the host name against it, so
 * it carries `CA:TRUE` and the host as a subject alternative name — the two
 * extensions that verification actually reads.
 */
export function selfSignedPair(host: string): { cert: Buffer; key: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ecdsaWithSha256 = sequence(objectId('1.2.840.10045.4.3.2'));

  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f; // a serial number is a positive integer
  const from = new Date(Date.now() - 60_000);
  const until = new Date(Date.now() + 24 * 60 * 60_000);
  const name = sequence(attribute('2.5.4.3', host), attribute('2.5.4.10', 'Melete local tests'));

  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ecdsaWithSha256,
    name, // issuer, which for a self-signed certificate is the subject
    sequence(utcTime(from), utcTime(until)),
    name,
    spki,
    tlv(
      0xa3,
      sequence(
        sequence(objectId('2.5.29.19'), boolean(true), octets(sequence(boolean(true)))),
        sequence(objectId('2.5.29.17'), octets(sequence(tlv(0x82, Buffer.from(host, 'ascii'))))),
      ),
    ),
  );

  const certificate = sequence(tbs, ecdsaWithSha256, bits(sign('sha256', tbs, privateKey)));
  return {
    cert: Buffer.from(pem('CERTIFICATE', certificate)),
    key: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
  };
}
