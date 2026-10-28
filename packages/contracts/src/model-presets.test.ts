import { expect, test } from 'bun:test';
import { modelPresetHint, modelPresets, recommendedModelIds } from './model-presets.ts';
import { modelSupportsVision } from './model-vision.ts';

const superModel = 'nvidia/nemotron-3-super-120b-a12b';
const nano = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
const ultra = 'nvidia/Nemotron-3-Ultra-550b-a55b';

test('serverless recommendations put the main model before side calls and research', () => {
  expect(recommendedModelIds('nebius')).toEqual([superModel, nano, ultra]);
  expect(recommendedModelIds('nebius').some((id) => /omni/i.test(id))).toBe(false);
  for (const preset of modelPresets('nebius')) {
    expect(preset.supportsTools).toBe(true);
    expect(preset.supportsVision).toBe(modelSupportsVision('nebius', preset.id));
  }
  expect(modelPresetHint('nebius', ultra)).toBe('Tool calls · Text only · 1,048,576-token context');
});

test('live discovery keeps unlisted presets out and other models selectable', () => {
  expect(recommendedModelIds('nebius', ['another-model', ultra, nano])).toEqual([
    nano,
    ultra,
    'another-model',
  ]);
  expect(recommendedModelIds('nebius', [])).toEqual([]);
  expect(recommendedModelIds('fireworks', ['b', 'a'])).toEqual(['b', 'a']);
  expect(recommendedModelIds('constructor')).toEqual([]);
  expect(modelPresetHint('nebius', 'another-model')).toBeUndefined();
});
