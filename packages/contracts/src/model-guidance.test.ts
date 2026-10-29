import { describe, expect, test } from 'bun:test';
import { MODEL_GUIDANCE, MODEL_GUIDANCE_TOKEN_LIMIT, modelGuidance } from './model-guidance.ts';

describe('model guidance', () => {
  test('a Nemotron id gets the Nemotron notes through any provider, in any case', () => {
    for (const id of [
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
      'nvidia/Nemotron-3-Ultra-550b-a55b',
      'nvidia/Nemotron-3.5-Super-VL',
      'nvidia/nemotron-3-super-120b-a12b:free',
      '@cf/nvidia/nemotron-3-120b-a12b',
      'accounts/fireworks/models/nemotron-3-super',
      'NEMOTRON-3-SUPER',
    ])
      expect(modelGuidance(id)?.family).toBe('nemotron');
  });

  test('other models get no notes', () => {
    for (const id of [
      'deepseek-v4p1-flash',
      'gpt-6',
      'claude-opus-5-5',
      'nvidia/llama-3.3-70b-instruct',
      'qwen3-235b',
      '',
    ])
      expect(modelGuidance(id)).toBeUndefined();
  });

  test('every family stays short', () => {
    for (const entry of MODEL_GUIDANCE) {
      // The same chars/4 estimate the rest of the prompt is measured with.
      expect(Math.ceil(entry.text.length / 4)).toBeLessThanOrEqual(MODEL_GUIDANCE_TOKEN_LIMIT);
      expect(entry.text.trim()).not.toBe('');
    }
  });

  test('no family switches reasoning by default', () => {
    for (const entry of MODEL_GUIDANCE) expect(entry.chat_template_kwargs).toBeUndefined();
  });
});
