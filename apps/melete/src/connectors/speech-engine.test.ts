import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import {
  CALL_START_WINDOW_MS,
  callUpstreamUrl,
  elevenLabsSpeechEngine,
  verifyUpstreamToken,
} from './speech-engine.ts';

const KEY = 'sk_test_speech_engine_key';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A JWT as ElevenLabs signs one: HS256 with the SHA-256 of the key as the secret. */
function upstreamJwt(
  claims: Record<string, unknown>,
  key = KEY,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
) {
  const secret = createHash('sha256').update(key, 'utf8').digest();
  const body = `${b64(header)}.${b64(claims)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

const now = Date.UTC(2026, 9, 18, 12, 0, 0);
const seconds = Math.floor(now / 1000);
const good = {
  iss: 'https://api.elevenlabs.io/convai/speech-engine',
  sub: 'convai_speech_engine_upstream',
  iat: seconds - 5,
  exp: seconds + 60,
};

describe('the upstream connection proves it is from ElevenLabs', () => {
  test('a current token signed for this key is accepted, with or without Bearer', () => {
    expect(verifyUpstreamToken(upstreamJwt(good), KEY, now)).toBe(true);
    expect(verifyUpstreamToken(`Bearer ${upstreamJwt(good)}`, KEY, now)).toBe(true);
  });

  test('a data-residency key signs with its base key', () => {
    expect(verifyUpstreamToken(upstreamJwt(good), `${KEY}_residency_eu`, now)).toBe(true);
  });

  test('anything else is refused', () => {
    expect(verifyUpstreamToken(undefined, KEY, now)).toBe(false);
    expect(verifyUpstreamToken('not.a.jwt', KEY, now)).toBe(false);
    expect(verifyUpstreamToken(upstreamJwt(good, 'sk_another_key'), KEY, now)).toBe(false);
    expect(verifyUpstreamToken(upstreamJwt({ ...good, iss: 'https://evil.test' }), KEY, now)).toBe(
      false,
    );
    expect(verifyUpstreamToken(upstreamJwt({ ...good, sub: 'someone_else' }), KEY, now)).toBe(
      false,
    );
    expect(
      verifyUpstreamToken(upstreamJwt({ ...good, exp: seconds - 120 }), KEY, now),
      'expired past the leeway',
    ).toBe(false);
    expect(verifyUpstreamToken(upstreamJwt({ ...good, iat: seconds + 600 }), KEY, now)).toBe(false);
    expect(verifyUpstreamToken(upstreamJwt({ ...good, exp: undefined }), KEY, now)).toBe(false);
    expect(
      verifyUpstreamToken(upstreamJwt(good, KEY, { alg: 'none' }), KEY, now),
      'only HS256',
    ).toBe(false);
  });
});

describe('where ElevenLabs connects', () => {
  test('only a public https address can take calls', () => {
    expect(callUpstreamUrl('https://melete.example.test')).toBe(
      'wss://melete.example.test/api/voice/call/upstream',
    );
    expect(callUpstreamUrl('https://example.test/melete/')).toBe(
      'wss://example.test/melete/api/voice/call/upstream',
    );
    expect(callUpstreamUrl('http://localhost:3000')).toBeNull();
    expect(callUpstreamUrl(undefined)).toBeNull();
  });
});

/** ElevenLabs, faked: the engine store and the token endpoint, with every request kept. */
function fakeElevenLabs(engines: { speech_engine_id: string; name: string }[] = []) {
  const requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
  let tokenExp: number | null = null;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({
      method,
      path: url.pathname,
      key: new Headers(init?.headers).get('xi-api-key'),
      body,
    });
    if (url.pathname === '/v1/speech-engine' && method === 'GET')
      return Response.json({ speech_engines: engines, has_more: false });
    if (url.pathname === '/v1/speech-engine' && method === 'POST') {
      engines.push({ speech_engine_id: 'seng_made', name: body.name });
      return Response.json({ speech_engine_id: 'seng_made' }, { status: 201 });
    }
    if (url.pathname.startsWith('/v1/speech-engine/') && method === 'PATCH')
      return Response.json({ speech_engine_id: url.pathname.split('/').at(-1) });
    if (url.pathname === '/v1/convai/conversation/token') {
      const token = tokenExp === null ? 'opaque-token' : `x.${b64({ exp: tokenExp })}.y`;
      return Response.json({ token, conversation_id: `conv_${requests.length}` });
    }
    return Response.json({ detail: { status: 'not_found' } }, { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    requests,
    setTokenExp: (exp: number | null) => {
      tokenExp = exp;
    },
  };
}

const options = (fake: ReturnType<typeof fakeElevenLabs>, extra = {}) => ({
  apiKey: KEY,
  fetch: fake.fetch,
  wsUrl: 'wss://melete.example.test/api/voice/call/upstream',
  name: 'Melete calls (melete.example.test)',
  ...extra,
});

describe('the engine and a call token', () => {
  test('the engine is made once, pointed at this service, with no recording kept', async () => {
    const fake = fakeElevenLabs();
    const voice = elevenLabsSpeechEngine(options(fake));
    const first = await voice.start();
    await voice.start();
    const made = fake.requests.filter((request) => request.method === 'POST');
    expect(made).toHaveLength(1);
    const settings = made[0]?.body as {
      speech_engine: { ws_url: string };
      privacy: unknown;
      tts: { model_id?: string };
    };
    expect(settings.speech_engine.ws_url).toBe('wss://melete.example.test/api/voice/call/upstream');
    expect(settings.privacy).toEqual({ record_voice: false });
    // The voice-mode model is multilingual, which an English engine refuses: the engine keeps its own.
    expect(settings.tts.model_id).toBeUndefined();
    expect(first.conversationId).toMatch(/^conv_/);
    // Every request carries the key; nothing here is for a browser.
    expect(fake.requests.every((request) => request.key === KEY)).toBe(true);
    const tokens = fake.requests.filter((r) => r.path === '/v1/convai/conversation/token');
    expect(tokens).toHaveLength(2);
  });

  test('a streaming model an English engine takes is used for calls', async () => {
    const fake = fakeElevenLabs();
    await elevenLabsSpeechEngine(options(fake, { streamingModel: 'eleven_flash_v2' })).start();
    const made = fake.requests.find((request) => request.method === 'POST')?.body as {
      tts: { model_id?: string };
    };
    expect(made.tts.model_id).toBe('eleven_flash_v2');
  });

  test('an engine already there by name is brought in step, not duplicated', async () => {
    const fake = fakeElevenLabs([
      { speech_engine_id: 'seng_existing', name: 'Melete calls (melete.example.test)' },
    ]);
    await elevenLabsSpeechEngine(options(fake)).start();
    expect(fake.requests.some((request) => request.method === 'POST')).toBe(false);
    expect(fake.requests.find((request) => request.method === 'PATCH')?.path).toBe(
      '/v1/speech-engine/seng_existing',
    );
  });

  test('an engine the operator named is used as it is', async () => {
    const fake = fakeElevenLabs();
    await elevenLabsSpeechEngine(options(fake, { engineId: 'seng_operator' })).start();
    expect(fake.requests.map((request) => request.method)).toEqual(['GET']);
    expect(fake.requests[0]?.path).toBe('/v1/convai/conversation/token');
  });

  test('the token is short-lived: it expires within minutes, sooner when the provider says so', async () => {
    const fake = fakeElevenLabs();
    const voice = elevenLabsSpeechEngine(options(fake));
    const before = Date.now();
    const opaque = await voice.start();
    expect(opaque.expiresAt.getTime()).toBeGreaterThan(before);
    expect(opaque.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + CALL_START_WINDOW_MS);
    fake.setTokenExp(Math.floor(Date.now() / 1000) + 30);
    const stated = await voice.start();
    expect(stated.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
  });
});
