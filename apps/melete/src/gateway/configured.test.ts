import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { configuredProviders } from './configured.ts';

function configure(source: Record<string, string>) {
  const warnings: string[] = [];
  const providers = configuredProviders(loadEnv(source), (warning) => warnings.push(warning));
  return { providers, warnings };
}

describe('the providers a service starts with', () => {
  test('a misspelt OpenAI-compatible provider stops start-up and names the exact spelling', () => {
    expect(() =>
      configure({
        MELETE_DEFAULT_PROVIDER: 'openai-compat',
        OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
      }),
    ).toThrow('"openai-compatible"');
    expect(() => configure({ MELETE_DEFAULT_PROVIDER: 'openai-compatible' })).toThrow(
      'OPENAI_COMPAT_BASE_URL is empty',
    );
    expect(() =>
      configure({
        MELETE_DEFAULT_PROVIDER: 'openai-compatible',
        OPENAI_COMPAT_BASE_URL: 'models.example.net/v1',
      }),
    ).toThrow('OPENAI_COMPAT_BASE_URL');
    // An unusable address stops start-up even while another provider is selected.
    expect(() => configure({ OPENAI_COMPAT_BASE_URL: 'ftp://models.example.net/v1' })).toThrow(
      'OPENAI_COMPAT_BASE_URL',
    );
  });

  test('the scripted provider exists only when it is switched on', () => {
    expect(() => configure({ MELETE_DEFAULT_PROVIDER: 'fake' })).toThrow(
      'MELETE_ENABLE_FAKE_PROVIDER=true',
    );
    const { providers, warnings } = configure({
      MELETE_DEFAULT_PROVIDER: 'fake',
      MELETE_ENABLE_FAKE_PROVIDER: 'true',
    });
    expect(providers.at(-1)?.fake).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('a selected provider without a key starts, and says which variable is empty', () => {
    const { providers, warnings } = configure({});
    expect(providers.map((provider) => provider.name)).toContain('fireworks');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('FIREWORKS_API_KEY');
    expect(configure({ FIREWORKS_API_KEY: 'key' }).warnings).toEqual([]);
  });

  test('a local model server over plain HTTP is accepted with the key Compose passes', () => {
    const { providers, warnings } = configure({
      MELETE_DEFAULT_PROVIDER: 'openai-compatible',
      OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
      // Compose hands an unset variable over as an empty string.
      OPENAI_COMPAT_API_KEY: '',
      OPENAI_API_KEY: 'shared-key',
    });
    expect(providers.at(-1)).toMatchObject({
      name: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      apiKey: 'shared-key',
      allowHttp: true,
    });
    expect(warnings).toEqual([]);
  });
});
