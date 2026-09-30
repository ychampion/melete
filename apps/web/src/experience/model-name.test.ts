import { expect, test } from 'bun:test';
import { modelDisplayName } from './model-name.ts';

test('a Fireworks account path reads as the model it serves', () => {
  expect(modelDisplayName('accounts/fireworks/models/deepseek-v4p1-flash')).toBe(
    'DeepSeek V4.1 Flash',
  );
  expect(modelDisplayName('accounts/fireworks/models/llama-v3p1-70b-instruct')).toBe(
    'Llama V3.1 70B Instruct',
  );
  expect(modelDisplayName('accounts/fireworks/models/kimi-k2-instruct')).toBe('Kimi K2 Instruct');
});

test('the other providers read the way they write their own names', () => {
  expect(modelDisplayName('gpt-4o-mini')).toBe('GPT-4o Mini');
  expect(modelDisplayName('o4-mini')).toBe('o4 Mini');
  expect(modelDisplayName('claude-sonnet-4-5-20250929')).toBe('Claude Sonnet 4.5');
  expect(modelDisplayName('claude-3-5-haiku-latest')).toBe('Claude 3.5 Haiku');
  expect(modelDisplayName('models/gemini-2.5-flash')).toBe('Gemini 2.5 Flash');
  expect(modelDisplayName('qwen2.5:7b')).toBe('Qwen2.5 7B');
});

test('any other identifier reads as its words, and one with none comes back as written', () => {
  expect(modelDisplayName('  ')).toBe('');
  expect(modelDisplayName('my-local-model')).toBe('My Local Model');
  expect(modelDisplayName('20250929')).toBe('20250929');
});
