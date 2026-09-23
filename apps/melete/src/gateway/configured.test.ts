import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { configuredProviders, signInIssuers } from './configured.ts';
import { authorizeUrl, CHATGPT, type OAuthIssuer } from './oauth.ts';

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

  test('a local model server over plain HTTP is accepted with its own key', () => {
    const { providers, warnings } = configure({
      MELETE_DEFAULT_PROVIDER: 'openai-compatible',
      OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
      OPENAI_COMPAT_API_KEY: 'local-server-key',
      OPENAI_API_KEY: 'shared-key',
    });
    expect(providers.at(-1)).toMatchObject({
      name: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      apiKey: 'local-server-key',
      allowHttp: true,
    });
    expect(warnings).toEqual([]);
  });

  test('the OpenAI key stands in for an empty endpoint key over HTTPS only', () => {
    // Compose hands an unset variable over as an empty string.
    const shared = { MELETE_DEFAULT_PROVIDER: 'openai-compatible', OPENAI_COMPAT_API_KEY: '' };
    const secure = configure({
      ...shared,
      OPENAI_COMPAT_BASE_URL: 'https://models.example.net/v1',
      OPENAI_API_KEY: 'shared-key',
    });
    expect(secure.providers.at(-1)?.apiKey).toBe('shared-key');
    expect(secure.warnings).toEqual([]);
    const plain = configure({
      ...shared,
      OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
      OPENAI_API_KEY: 'shared-key',
    });
    expect(plain.providers.at(-1)?.apiKey).toBeUndefined();
    expect(plain.warnings).toHaveLength(1);
    expect(plain.warnings[0]).toContain('OPENAI_COMPAT_API_KEY is empty');
    expect(plain.warnings[0]).toContain('never sent to a plain http:// endpoint');
  });
});

describe('the ChatGPT sign-in client', () => {
  const chatgpt = (source: Record<string, string>) =>
    signInIssuers(loadEnv(source)).chatgpt as OAuthIssuer;

  test('is the Codex CLI public client unless the operator names another', () => {
    expect(chatgpt({}).clientId).toBe(CHATGPT.clientId);
    expect(chatgpt({ MELETE_CHATGPT_CLIENT_ID: '' }).clientId).toBe(CHATGPT.clientId);
    const own = chatgpt({ MELETE_CHATGPT_CLIENT_ID: 'app_melete_registered' });
    expect(own.clientId).toBe('app_melete_registered');
    expect(new URL(authorizeUrl(own, 'state', 'challenge')).searchParams.get('client_id')).toBe(
      'app_melete_registered',
    );
  });
});
