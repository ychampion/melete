import { expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { PrivacyRouter } from './router.ts';
import { settingsView, updateSettings } from './routes.ts';
import { attemptEngine, providerAddress } from './service.ts';
import { MemoryPrivacyStore } from './store.ts';

test('an attempt’s engine is its own model’s, not the server default’s', async () => {
  const env = loadEnv({
    MELETE_DEFAULT_PROVIDER: 'openai-compatible',
    MELETE_DEFAULT_MODEL: 'llama3.3',
    OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
  });
  const engineOf = attemptEngine(env);
  const cloud = await engineOf({ provider: 'fireworks', model: 'accounts/fireworks/models/small' });
  expect(cloud.protocol).toBe('chat/completions');
  // A cloud model's address is never one the owner could confirm as their own.
  expect(cloud.providerUrl).toBeUndefined();
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

test('Anthropic through a gateway on this network is never offered as the person’s own model', async () => {
  const env = loadEnv({
    MELETE_DEFAULT_PROVIDER: 'anthropic',
    MELETE_DEFAULT_MODEL: 'claude-sonnet-4-5',
    ANTHROPIC_API_KEY: 'anthropic-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4610',
  });
  const anthropic = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
  // The privacy checks before an attempt are given no address that could be confirmed as local.
  expect(providerAddress(env)).toBeUndefined();
  expect((await attemptEngine(env)(anthropic)).providerUrl).toBeUndefined();
  const settings = { providerAddress: async () => 'http://127.0.0.1:4610/v1/' };
  expect((await attemptEngine(env, settings)(anthropic)).providerUrl).toBeUndefined();
  // Settings › Privacy shows no local model address, and it cannot be marked as one.
  const router = new PrivacyRouter({ store: new MemoryPrivacyStore() });
  const view = await settingsView(router, 'spc_1', providerAddress(env));
  expect(view.model_address_local).toBe(false);
  expect(view.model_address).toBeNull();
  await expect(
    updateSettings(router, 'spc_1', { model_on_device: true }, providerAddress(env)),
  ).rejects.toThrow('can’t be marked as yours');
});
