import { describe, expect, test } from 'bun:test';
import { fakeProvider } from './fake.ts';
import {
  modelApiMode,
  protocolForApiMode,
  providerKeyProblem,
  providerSelectionProblem,
  providersFromEnv,
  providerUrl,
  requiresResponsesProtocol,
} from './providers.ts';
import type { GatewayProvider } from './types.ts';

const providers = providersFromEnv({ OPENAI_COMPAT_BASE_URL: 'https://models.example.test/v1' });

describe('the API mode a runtime is told to speak', () => {
  test('follows the provider, and the model where a model needs the responses protocol', () => {
    expect(modelApiMode('anthropic', 'claude-sonnet-4-5')).toBe('anthropic_messages');
    expect(modelApiMode('openai', 'gpt-6-astra')).toBe('codex_responses');
    expect(modelApiMode('openai', 'gpt-4.1')).toBe('codex_responses');
    expect(modelApiMode('fireworks', 'accounts/fireworks/models/deepseek-v4p1-flash')).toBe(
      'chat_completions',
    );
    expect(modelApiMode('google', 'gemini-2.5-flash')).toBe('chat_completions');
    expect(modelApiMode('openai-compatible', 'llama3.1')).toBe('chat_completions');
    expect(modelApiMode('openai-compatible', 'gpt-6-astra')).toBe('codex_responses');
    expect(modelApiMode('fake', 'scripted')).toBe('chat_completions');
  });

  test('is always a protocol the gateway serves for that provider', () => {
    const models = ['gpt-6-astra', 'gpt-6-mini', 'gpt-4.1', 'claude-sonnet-4-5', 'llama3.1'];
    for (const provider of providers) {
      for (const model of models) {
        const protocol = protocolForApiMode(modelApiMode(provider.name, model));
        expect(provider.protocols).toContain(protocol);
        if (requiresResponsesProtocol(model) && provider.protocols.includes('responses'))
          expect(protocol).toBe('responses');
      }
    }
  });

  test('names every provider the gateway can be configured with', () => {
    expect(providers.map((provider) => provider.name)).toEqual([
      'fireworks',
      'openai',
      'anthropic',
      'google',
      'openai-compatible',
    ]);
  });
});

describe('an operator-configured OpenAI-compatible endpoint', () => {
  const compatible = (address: string): GatewayProvider => {
    const provider = providersFromEnv({ OPENAI_COMPAT_BASE_URL: address }).at(-1);
    if (provider?.name !== 'openai-compatible') throw new Error('the endpoint was not configured');
    return provider;
  };

  test('may be a plain HTTP model server on the operator network', () => {
    expect(providerUrl(compatible('http://127.0.0.1:11434/v1'), 'chat/completions').href).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
    expect(providerUrl(compatible('https://models.example.net/v1/'), 'responses').href).toBe(
      'https://models.example.net/v1/responses',
    );
  });

  test('still refuses credentials in the address and anything that is not HTTP', () => {
    for (const address of ['http://user:secret@127.0.0.1:11434/v1', 'ftp://127.0.0.1/v1'])
      expect(() => providerUrl(compatible(address), 'chat/completions')).toThrow(
        'OPENAI_COMPAT_BASE_URL',
      );
  });

  test('falls back to the OpenAI key only over HTTPS', () => {
    const key = (address: string, own = '') =>
      providersFromEnv({
        OPENAI_API_KEY: 'openai-secret',
        OPENAI_COMPAT_API_KEY: own,
        OPENAI_COMPAT_BASE_URL: address,
      }).at(-1)?.apiKey;
    expect(key('https://models.example.net/v1')).toBe('openai-secret');
    for (const address of [
      'http://192.168.1.20:11434/v1',
      'HTTP://127.0.0.1:11434/v1',
      ' http://127.0.0.1:11434/v1',
    ])
      expect(key(address)).toBeUndefined();
    expect(key('http://192.168.1.20:11434/v1', 'local-server-key')).toBe('local-server-key');
  });

  test('is the only provider that may leave HTTPS', () => {
    const downgraded: GatewayProvider = {
      name: 'openai',
      baseUrl: 'http://api.openai.com/v1/',
      protocols: ['chat/completions'],
    };
    expect(() => providerUrl(downgraded, 'chat/completions')).toThrow('HTTPS');
    // The name alone grants nothing; only the environment-built provider carries the allowance.
    expect(() =>
      providerUrl({ ...downgraded, name: 'openai-compatible' }, 'chat/completions'),
    ).toThrow('HTTPS');
    for (const provider of providersFromEnv({}))
      expect(new URL(provider.baseUrl).protocol).toBe('https:');
  });
});

describe('a provider selection that can never answer', () => {
  const configured = providersFromEnv({ FIREWORKS_API_KEY: 'key' });

  test('a near miss of the OpenAI-compatible name is answered with the exact name', () => {
    for (const name of ['openai-compat', 'openai_compatible', 'ollama']) {
      const problem = providerSelectionProblem(name, configured);
      expect(problem).toContain(`"${name}"`);
      expect(problem).toContain('"openai-compatible"');
      expect(problem).toContain('OPENAI_COMPAT_BASE_URL');
      expect(problem).toContain('fireworks, openai, anthropic, google');
    }
  });

  test('the exact name without an address says which variable is empty', () => {
    expect(providerSelectionProblem('openai-compatible', configured)).toContain(
      'OPENAI_COMPAT_BASE_URL is empty',
    );
  });

  test('the scripted provider has to be switched on', () => {
    expect(providerSelectionProblem('fake', configured)).toContain(
      'MELETE_ENABLE_FAKE_PROVIDER=true',
    );
    expect(providerSelectionProblem('fake', [...configured, fakeProvider])).toBeNull();
  });

  test('an address the gateway would refuse is reported before the first request', () => {
    const unusable = providersFromEnv({ OPENAI_COMPAT_BASE_URL: 'models.example.net/v1' });
    expect(providerSelectionProblem('openai-compatible', unusable)).toContain(
      'OPENAI_COMPAT_BASE_URL',
    );
    expect(providerSelectionProblem('fireworks', configured)).toBeNull();
  });

  test('an empty key is named by its variable', () => {
    expect(providerKeyProblem('fireworks', configured)).toBeNull();
    expect(providerKeyProblem('anthropic', configured)).toContain('ANTHROPIC_API_KEY');
    const local = providersFromEnv({ OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1' });
    expect(providerKeyProblem('openai-compatible', local)).toContain('OPENAI_COMPAT_API_KEY');
    expect(providerKeyProblem('fake', [fakeProvider])).toBeNull();
  });
});
