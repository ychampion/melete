/** Recommended models within a provider's live list. These do not route work. */
import { modelContextWindow } from './model-budget.ts';

export type ModelPreset = {
  id: string;
  label: string;
  supportsTools: boolean;
  supportsVision: boolean;
};

/** Public serverless models, in recommendation order. Dedicated endpoints use their own ids. */
const PRESETS: Readonly<Record<string, readonly ModelPreset[]>> = {
  nebius: [
    {
      id: 'nvidia/nemotron-3-super-120b-a12b',
      label: 'NVIDIA Nemotron 3 Super',
      supportsTools: true,
      supportsVision: false,
    },
    {
      id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
      label: 'NVIDIA Nemotron 3 Nano',
      supportsTools: true,
      supportsVision: false,
    },
    {
      id: 'nvidia/Nemotron-3-Ultra-550b-a55b',
      label: 'NVIDIA Nemotron 3 Ultra',
      supportsTools: true,
      supportsVision: false,
    },
  ],
};

export function modelPresets(provider: string): readonly ModelPreset[] {
  return Object.hasOwn(PRESETS, provider) ? (PRESETS[provider] ?? []) : [];
}

export function modelPreset(provider: string, model: string): ModelPreset | undefined {
  return modelPresets(provider).find((preset) => preset.id === model);
}

/** A successful list stays authoritative: never add a recommendation it did not return. */
export function recommendedModelIds(provider: string, listed?: readonly string[]): string[] {
  const recommendations = modelPresets(provider).map((preset) => preset.id);
  if (listed === undefined) return recommendations;
  const recommended = new Set(recommendations);
  return [
    ...recommendations.filter((id) => listed.includes(id)),
    ...listed.filter((id) => !recommended.has(id)),
  ];
}

/** Capabilities and the served context limit beside the model picker. */
export function modelPresetHint(provider: string, model: string): string | undefined {
  const preset = modelPreset(provider, model);
  if (!preset) return undefined;
  return `${preset.supportsTools ? 'Tool calls' : 'No tool calls'} · ${preset.supportsVision ? 'Reads images' : 'Text only'} · ${modelContextWindow(model).toLocaleString('en-US')}-token context`;
}
