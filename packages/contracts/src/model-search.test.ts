import { expect, test } from 'bun:test';
import { effectiveNativeSearch, modelSupportsNativeSearch } from './model-search.ts';

test('native search is known per provider and model, like vision', () => {
  expect(modelSupportsNativeSearch('anthropic', 'claude-sonnet-4-5')).toBe(true);
  expect(modelSupportsNativeSearch('anthropic', 'claude-opus-5-5')).toBe(true);
  expect(modelSupportsNativeSearch('anthropic', 'claude-3-haiku-20240307')).toBe(false);
  expect(modelSupportsNativeSearch('openai', 'gpt-5.1')).toBe(true);
  expect(modelSupportsNativeSearch('openai', 'gpt-4.1-nano')).toBe(false);
  expect(modelSupportsNativeSearch('openai', 'gpt-4o-audio-preview')).toBe(false);
  expect(modelSupportsNativeSearch('google', 'gemini-2.5-pro')).toBe(false);
  expect(modelSupportsNativeSearch('fireworks', 'accounts/fireworks/models/kimi-k2')).toBe(false);
  expect(modelSupportsNativeSearch('nobody', 'claude-sonnet-4-5')).toBe(false);
});

test('the operator can say otherwise, but not for a provider with no search tool', () => {
  expect(effectiveNativeSearch('anthropic', 'claude-sonnet-4-5', false)).toBe(false);
  expect(effectiveNativeSearch('openai', 'my-fine-tune', true)).toBe(true);
  expect(effectiveNativeSearch('fireworks', 'any', true)).toBe(false);
  expect(effectiveNativeSearch('openai', 'gpt-5', undefined)).toBe(true);
});
