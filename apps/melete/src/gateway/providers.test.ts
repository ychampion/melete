import { describe, expect, test } from 'bun:test';
import {
  modelApiMode,
  protocolForApiMode,
  providersFromEnv,
  requiresResponsesProtocol,
} from './providers.ts';

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
