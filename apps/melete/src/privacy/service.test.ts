import { expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { attemptEngine } from './service.ts';

test('an attempt’s engine is its own model’s, not the server default’s', async () => {
  const env = loadEnv({
    MELETE_DEFAULT_PROVIDER: 'openai-compatible',
    MELETE_DEFAULT_MODEL: 'llama3.3',
    OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
  });
  const engineOf = attemptEngine(env);
  const cloud = await engineOf({ provider: 'fireworks', model: 'accounts/fireworks/models/small' });
  expect(cloud.providerUrl).toStartWith('https://api.fireworks.ai/');
  expect((await engineOf({ provider: 'openai-compatible', model: 'llama3.3' })).providerUrl).toBe(
    'http://127.0.0.1:11434/v1/',
  );
  // An address connected in the app wins over the environment's.
  const connected = attemptEngine(env, {
    providerAddress: async (provider) =>
      provider === 'openai-compatible' ? 'http://10.0.0.5:8000/v1/' : undefined,
  });
  expect((await connected({ provider: 'openai-compatible', model: 'x' })).providerUrl).toBe(
    'http://10.0.0.5:8000/v1/',
  );
});
