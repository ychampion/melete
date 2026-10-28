import { expect, test } from 'bun:test';
import {
  modelPreset,
  modelPresetHint,
  modelPresets,
  recommendedModelIds,
} from './model-presets.ts';
import { modelSupportsVision } from './model-vision.ts';

const superModel = 'nvidia/nemotron-3-super-120b-a12b';
const nano = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
const ultra = 'nvidia/Nemotron-3-Ultra-550b-a55b';
const superVl = 'nvidia/Nemotron-3.5-Super-VL';

test('serverless recommendations put the main model before side calls and research', () => {
  expect(recommendedModelIds('nebius')).toEqual([superModel, nano, ultra, superVl]);
  expect(recommendedModelIds('nebius').some((id) => /omni/i.test(id))).toBe(false);
  for (const preset of modelPresets('nebius')) {
    expect(preset.supportsTools).toBe(true);
    expect(preset.supportsVision).toBe(modelSupportsVision('nebius', preset.id));
  }
  expect(modelPresetHint('nebius', ultra)).toBe('Tool calls · Text only · 1,048,576-token context');
});

test('Super VL is the recommendation that reads photos and scans itself', () => {
  expect(modelPreset('nebius', superVl)).toEqual({
    id: superVl,
    label: 'NVIDIA Nemotron 3.5 Super VL',
    supportsTools: true,
    supportsVision: true,
  });
  expect(modelPresets('nebius').filter((preset) => preset.supportsVision)).toHaveLength(1);
  expect(modelPresetHint('nebius', superVl)).toBe(
    'Tool calls · Reads images · 1,048,576-token context',
  );
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
