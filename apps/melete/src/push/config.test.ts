/**
 * The key pair configure.ts writes is one the service accepts, and without it
 * the service offers no push at all.
 */
import { expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { pushConfig } from './service.ts';
import { generateVapidKeys } from './webpush.ts';

test('a generated key pair is accepted and read', async () => {
  const keys = await generateVapidKeys();
  const env = loadEnv({
    MELETE_VAPID_PUBLIC_KEY: keys.publicKey,
    MELETE_VAPID_PRIVATE_KEY: keys.privateKey,
    MELETE_PUSH_EXTRA_ORIGINS: 'http://127.0.0.1:4999/, https://push.example.org/x',
  });
  const config = pushConfig(env);
  expect(config.keys).toEqual(keys);
  expect(config.subject).toBeNull();
  expect(config.extraOrigins).toEqual(['http://127.0.0.1:4999', 'https://push.example.org']);
});

test('without keys, push is off', () => {
  expect(pushConfig(loadEnv({})).keys).toBeNull();
});

test('a malformed key is refused at start', () => {
  expect(() => loadEnv({ MELETE_VAPID_PUBLIC_KEY: 'not a key' })).toThrow();
});
