/**
 * The encryption is RFC 8291's own worked example, byte for byte, so a
 * browser reads what this sends. The VAPID token verifies against the public
 * key a browser subscribed with.
 */
import { describe, expect, test } from 'bun:test';
import {
  decryptPayload,
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  sendPush,
  subscriptionKeysUsable,
  toBase64Url,
  vapidAuthorization,
} from './webpush.ts';

// RFC 8291, section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  receiver: {
    privateKey: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    publicKey:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  },
  sender: {
    privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    publicKey:
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  },
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('subscription keys', () => {
  test('only a P-256 point and a 16-byte secret are accepted', async () => {
    const browser = await generateVapidKeys();
    const auth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    expect(await subscriptionKeysUsable({ p256dh: browser.publicKey, auth })).toBe(true);
    expect(await subscriptionKeysUsable({ p256dh: RFC.receiver.publicKey, auth: RFC.auth })).toBe(
      true,
    );
    for (const keys of [
      { p256dh: 'A'.repeat(80), auth },
      { p256dh: `B${'A'.repeat(86)}`, auth },
      { p256dh: `${browser.publicKey.slice(0, -2)}!!`, auth },
      { p256dh: browser.publicKey, auth: 'A'.repeat(24) },
      { p256dh: browser.publicKey, auth: `${auth.slice(0, -1)}*` },
    ])
      expect(await subscriptionKeysUsable(keys)).toBe(false);
  });
});

describe('RFC 8291 aes128gcm', () => {
  test('encrypting the example gives the example body exactly', async () => {
    const body = await encryptPayload(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.receiver.publicKey, auth: RFC.auth },
      { sender: RFC.sender, salt: fromBase64Url(RFC.salt) },
    );
    // 86 octets of header and 58 of ciphertext. The example's Content-Length line says
    // 145, but its body, shown right below it, is these 144 octets.
    expect(body.length).toBe(144);
    expect(toBase64Url(body)).toBe(RFC.body);
  });

  test('the example body decrypts to the example text', async () => {
    const plain = await decryptPayload(fromBase64Url(RFC.body), {
      ...RFC.receiver,
      auth: RFC.auth,
    });
    expect(new TextDecoder().decode(plain)).toBe(RFC.plaintext);
  });

  test('a fresh message round-trips with fresh keys and salt', async () => {
    const browser = await generateVapidKeys();
    const auth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const body = await encryptPayload(new TextEncoder().encode('{"title":"One decision"}'), {
      p256dh: browser.publicKey,
      auth,
    });
    const plain = await decryptPayload(body, { ...browser, auth });
    expect(new TextDecoder().decode(plain)).toBe('{"title":"One decision"}');
  });
});

describe('VAPID', () => {
  test('the token names the push service origin and verifies with the public key', async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(
      'https://push.example.net/push/abc',
      keys,
      'mailto:owner@example.com',
      new Date('2026-09-27T10:00:00Z'),
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match ?? [];
    expect(k).toBe(keys.publicKey);
    const payload = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString());
    expect(payload).toMatchObject({
      aud: 'https://push.example.net',
      sub: 'mailto:owner@example.com',
    });
    const verifier = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifier,
      fromBase64Url(signature ?? ''),
      new TextEncoder().encode(`${head}.${claims}`),
    );
    expect(ok).toBe(true);
  });
});

describe('sending', () => {
  const vapid = { subject: 'mailto:owner@example.com' };
  const target = async () => {
    const browser = await generateVapidKeys();
    const auth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    return {
      browser,
      auth,
      sub: { endpoint: 'https://push.example.net/p/1', keys: { p256dh: browser.publicKey, auth } },
    };
  };

  test('the push service receives an encrypted body the browser can read', async () => {
    const keys = await generateVapidKeys();
    const { browser, auth, sub } = await target();
    let seen: Request | null = null;
    const outcome = await sendPush(
      sub,
      { title: 'Hello' },
      { ...vapid, keys },
      {
        fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
          seen = new Request(String(input), init);
          return new Response(null, { status: 201 });
        }) as typeof fetch,
      },
    );
    expect(outcome).toBe('sent');
    const request = seen as unknown as Request;
    expect(request.headers.get('content-encoding')).toBe('aes128gcm');
    expect(request.headers.get('authorization')).toStartWith('vapid t=');
    const plain = await decryptPayload(new Uint8Array(await request.arrayBuffer()), {
      ...browser,
      auth,
    });
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ title: 'Hello' });
  });

  test('a subscription the browser dropped is reported gone', async () => {
    const keys = await generateVapidKeys();
    const { sub } = await target();
    const answer = (status: number) =>
      (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(await sendPush(sub, {}, { ...vapid, keys }, { fetcher: answer(410) })).toBe('gone');
    expect(await sendPush(sub, {}, { ...vapid, keys }, { fetcher: answer(404) })).toBe('gone');
    expect(await sendPush(sub, {}, { ...vapid, keys }, { fetcher: answer(500) })).toBe('failed');
  });
  test('keys that cannot be encrypted for are a failed send, not a thrown error', async () => {
    const keys = await generateVapidKeys();
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const broken = [
      { p256dh: 'A'.repeat(80), auth: 'A'.repeat(22) },
      { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) },
    ];
    for (const bad of broken)
      expect(
        await sendPush(
          { endpoint: 'https://push.example.net/p/2', keys: bad },
          {},
          { ...vapid, keys },
          { fetcher },
        ),
      ).toBe('failed');
    expect(called).toBe(false);
  });

  test('a push service that never answers is given up on', async () => {
    const keys = await generateVapidKeys();
    const { sub } = await target();
    const silent = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await sendPush(sub, {}, { ...vapid, keys }, { fetcher: silent, timeoutMs: 50 })).toBe(
      'failed',
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
