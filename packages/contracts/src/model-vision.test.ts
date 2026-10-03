import { expect, test } from 'bun:test';
import { GATEWAY_MAX_REQUEST_BYTES } from './model-budget.ts';
import {
  effectiveVision,
  listedVision,
  listedVisionByModel,
  MAX_CONTEXT_IMAGES,
  MAX_IMAGE_ENCODED_BYTES,
  MAX_REQUEST_IMAGES,
  modelSupportsVision,
  VISION_IMAGE_RESERVE_BYTES,
} from './model-vision.ts';

test('the catalog knows the models that read images', () => {
  for (const [provider, model] of [
    ['anthropic', 'claude-opus-4-1'],
    ['anthropic', 'claude-sonnet-5'],
    ['openai', 'gpt-4o-mini'],
    ['openai', 'gpt-4.1'],
    ['openai', 'gpt-6-astra'],
    ['openai', 'o3'],
    ['chatgpt', 'gpt-5.5'],
    ['google', 'gemini-2.5-pro'],
    ['fireworks', 'accounts/fireworks/models/qwen2p5-vl-32b-instruct'],
    ['fireworks', 'accounts/fireworks/models/llama4-maverick-instruct-basic'],
    ['openai-compatible', 'llava:13b'],
    ['openai-compatible', 'qwen2.5vl:7b'],
    ['openai-compatible', 'gemma3:27b'],
    ['openai-compatible', 'llama3.2-vision'],
  ] as const)
    expect([provider, model, modelSupportsVision(provider, model)]).toEqual([
      provider,
      model,
      true,
    ]);
});

test('anything else reads text only', () => {
  for (const [provider, model] of [
    ['fireworks', 'accounts/fireworks/models/deepseek-v4p1-flash'],
    ['fireworks', 'deepseek-ai/DeepSeek-V4.1-Flash'],
    ['openai', 'gpt-3.5-turbo'],
    ['openai', 'text-embedding-3-large'],
    ['openai-compatible', 'llama3.1:8b'],
    ['openai-compatible', 'mistral-small'],
    ['fake', 'script'],
    ['stub', 'script'],
    ['a-provider-nobody-listed', 'claude-opus-4-1'],
    // A name inherited from Object.prototype is not a provider.
    ['constructor', 'gpt-4o'],
  ] as const)
    expect([provider, model, modelSupportsVision(provider, model)]).toEqual([
      provider,
      model,
      false,
    ]);
});

test("the owner's answer beats the catalog", () => {
  expect(effectiveVision('openai-compatible', 'my-model', true)).toBe(true);
  expect(effectiveVision('anthropic', 'claude-opus-4-1', false)).toBe(false);
  expect(effectiveVision('anthropic', 'claude-opus-4-1', null)).toBe(true);
  expect(effectiveVision('anthropic', 'claude-opus-4-1', undefined)).toBe(true);
});

test('what a provider’s model list says about images', () => {
  expect(listedVision({ id: 'a', supports_image_input: true })).toBe(true);
  expect(listedVision({ id: 'a', supports_image_input: false })).toBe(false);
  expect(listedVision({ id: 'a', architecture: { input_modalities: ['text', 'image'] } })).toBe(
    true,
  );
  expect(listedVision({ id: 'a', architecture: { input_modalities: ['text'] } })).toBe(false);
  expect(listedVision({ id: 'a', capabilities: { image_input: { supported: true } } })).toBe(true);
  expect(listedVision({ id: 'a', capabilities: ['completion', 'vision'] })).toBe(true);
  // Lists that say nothing leave the answer to the catalog.
  expect(listedVision({ id: 'gpt-4o', object: 'model', owned_by: 'openai' })).toBeUndefined();
  expect(listedVision({ id: 'a', supports_image_input: 'yes' })).toBeUndefined();
  expect(listedVision(null)).toBeUndefined();

  const answers = listedVisionByModel({
    data: [
      { id: 'accounts/fireworks/models/deepseek-v4p1-flash', supports_image_input: true },
      { id: 'accounts/fireworks/models/deepseek-v3p2', supports_image_input: false },
      { id: 'accounts/fireworks/models/silent' },
      { id: 42, supports_image_input: true },
    ],
  });
  expect([...answers]).toEqual([
    ['accounts/fireworks/models/deepseek-v4p1-flash', true],
    ['accounts/fireworks/models/deepseek-v3p2', false],
  ]);
  expect([
    ...listedVisionByModel({ models: [{ name: 'models/m', input_modalities: ['image'] }] }),
  ]).toEqual([['m', true]]);
  expect(listedVisionByModel('not a list').size).toBe(0);
});

test('the pictures a request may carry leave room for its text', () => {
  expect(MAX_REQUEST_IMAGES).toBe(MAX_CONTEXT_IMAGES);
  expect(VISION_IMAGE_RESERVE_BYTES).toBe(MAX_REQUEST_IMAGES * MAX_IMAGE_ENCODED_BYTES);
  expect(VISION_IMAGE_RESERVE_BYTES).toBeLessThan(GATEWAY_MAX_REQUEST_BYTES / 2);
});
