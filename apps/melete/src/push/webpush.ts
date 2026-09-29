/**
 * Web Push without a third party: the message is encrypted for the browser
 * that subscribed (RFC 8291, `aes128gcm`) and the request is signed with this
 * installation's own VAPID key (RFC 8292). The push service that relays it
 * sees neither the words nor who they are for beyond the subscription.
 *
 * Everything here is WebCrypto, so the same code runs in the service and in
 * tests, and the RFC's own example is the test vector.
 */

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
}

/** HKDF with one block of output, which is all RFC 8291 ever asks for. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** An uncompressed P-256 point, 0x04 || x || y, as the coordinates a JWK names. */
function pointToJwk(point: Uint8Array) {
  if (point.length !== 65 || point[0] !== 4) throw new Error('not an uncompressed P-256 point');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(point.slice(1, 33)),
    y: toBase64Url(point.slice(33, 65)),
  };
}

export type VapidKeys = {
  /** The uncompressed public point, base64url: what a browser subscribes with. */
  publicKey: string;
  /** The private scalar, base64url. */
  privateKey: string;
};

/** A fresh key pair for this installation. `configure.ts` writes it once. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const x = fromBase64Url(jwk.x ?? '');
  const y = fromBase64Url(jwk.y ?? '');
  return {
    publicKey: toBase64Url(concat(new Uint8Array([4]), x, y)),
    privateKey: jwk.d ?? '',
  };
}

export type SubscriptionKeys = {
  /** The browser's public point, base64url, as the Push API reports it. */
  p256dh: string;
  /** The browser's 16-byte authentication secret, base64url. */
  auth: string;
};

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Whether a message can be encrypted for these keys: the public key is a point
 * on P-256 and the secret is 16 bytes. Checked when a browser subscribes, so a
 * key that could never be used is refused there instead of failing every send.
 */
export async function subscriptionKeysUsable(keys: SubscriptionKeys): Promise<boolean> {
  if (!BASE64URL.test(keys.p256dh) || !BASE64URL.test(keys.auth)) return false;
  const point = fromBase64Url(keys.p256dh);
  if (point.length !== 65 || point[0] !== 4 || fromBase64Url(keys.auth).length !== 16) return false;
  try {
    await crypto.subtle.importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts one message for one subscription. `sender` and `salt` exist for the
 * RFC's test vector; left out, both are fresh for every message, as they must be.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  options: { sender?: VapidKeys; salt?: Uint8Array; recordSize?: number } = {},
): Promise<Uint8Array> {
  const uaPublic = fromBase64Url(keys.p256dh);
  const authSecret = fromBase64Url(keys.auth);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const recordSize = options.recordSize ?? 4096;

  const sender = options.sender ?? (await generateVapidKeys());
  const asPublic = fromBase64Url(sender.publicKey);
  const asPrivate = await crypto.subtle.importKey(
    'jwk',
    { ...pointToJwk(asPublic), d: sender.privateKey },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const receiver = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, asPrivate, 256),
  );

  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // One record: the plaintext, then the delimiter that marks the last record.
  if (plaintext.length + 1 + 16 > recordSize) throw new Error('payload too large for one record');
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

/**
 * The receiving side, for a push service stand-in in tests and for checking
 * that what left here is what a browser would read.
 */
export async function decryptPayload(
  body: Uint8Array,
  receiver: { publicKey: string; privateKey: string; auth: string },
): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idLength = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const uaPublic = fromBase64Url(receiver.publicKey);
  const uaPrivate = await crypto.subtle.importKey(
    'jwk',
    { ...pointToJwk(uaPublic), d: receiver.privateKey },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const sender = await crypto.subtle.importKey(
    'raw',
    asPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, uaPrivate, 256),
  );
  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(fromBase64Url(receiver.auth), shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext),
  );
  const end = padded.lastIndexOf(2);
  if (end < 0) throw new Error('no record delimiter');
  return padded.slice(0, end);
}

/**
 * The VAPID header for one push service: a short-lived ES256 token for the
 * service's origin, and this installation's public key.
 */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: Date = new Date(),
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    { ...pointToJwk(fromBase64Url(keys.publicKey)), d: keys.privateKey },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      encoder.encode(`${header}.${claims}`),
    ),
  );
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

export type PushTarget = { endpoint: string; keys: SubscriptionKeys };

/** What a push service said: sent, gone for good, or a failure worth trying again. */
export type PushOutcome = 'sent' | 'gone' | 'failed';

/** How long one push service gets to answer before the send counts as failed. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Sends one message to one device. Nothing here throws: keys that cannot be
 * encrypted for, a push service that cannot be reached and one that does not
 * answer in time are all a failed send, so one device never stops the rest.
 */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  vapid: { keys: VapidKeys; subject: string },
  options: {
    ttlSeconds?: number;
    urgency?: 'normal' | 'high';
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PushOutcome> {
  let body: Uint8Array;
  let authorization: string;
  try {
    body = await encryptPayload(encoder.encode(JSON.stringify(payload)), target.keys);
    authorization = await vapidAuthorization(target.endpoint, vapid.keys, vapid.subject);
  } catch {
    return 'failed';
  }
  let response: Response;
  // A timer of its own rather than AbortSignal.timeout, whose timer does not keep the process
  // waiting: the pass must end at the deadline whatever else is pending.
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException('The push service did not answer in time', 'TimeoutError')),
    options.timeoutMs ?? SEND_TIMEOUT_MS,
  );
  try {
    response = await (options.fetcher ?? fetch)(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(options.ttlSeconds ?? 24 * 3600),
        Urgency: options.urgency ?? 'normal',
      },
      body,
      signal: deadline.signal,
    });
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
  if (response.ok) return 'sent';
  // The browser dropped the subscription; it will never accept this endpoint again.
  if (response.status === 404 || response.status === 410) return 'gone';
  return 'failed';
}
