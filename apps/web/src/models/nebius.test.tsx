import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModelSettings } from './api.ts';
import { ModelConnect } from './ModelConnect.tsx';

const settings: ModelSettings = {
  active: {
    provider: 'nebius',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    source: 'app',
    connected: true,
    vision: false,
    vision_source: 'catalog',
    provider_vision: null,
    updated_at: null,
  },
  operator_default: { provider: 'nebius', model: 'nvidia/nemotron-3-super-120b-a12b' },
  providers: [
    {
      provider: 'nebius',
      label: 'Nebius Token Factory',
      method: 'key',
      key: { state: 'set', last_four: '1234', updated_at: null },
      base_url: null,
      base_url_source: null,
      connected: true,
      lists_models: true,
    },
  ],
  can_edit: true,
  can_store_keys: true,
  secondary: {
    model: { provider: 'nebius', model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', connected: true },
    uses: { side_tasks: 'secondary', scheduled: 'primary' },
    can_edit: true,
    leaves_local_primary: false,
    updated_at: null,
  },
};

test('the same Settings picker offers Nebius recommendations for primary and secondary models', () => {
  for (const target of ['primary', 'secondary'] as const) {
    const html = renderToStaticMarkup(
      <ModelConnect settings={settings} onChanged={() => {}} target={target} />,
    );
    expect(html).toContain('Nebius Token Factory');
    expect(html).toContain('Test connection');
    expect(html).toContain('NVIDIA Nemotron 3 Super');
    expect(html).toContain('NVIDIA Nemotron 3 Nano');
    expect(html).toContain('NVIDIA Nemotron 3 Ultra');
    expect(html).toContain('NVIDIA Nemotron 3.5 Super VL');
    expect(html.indexOf('NVIDIA Nemotron 3 Super')).toBeLessThan(
      html.indexOf('NVIDIA Nemotron 3 Nano'),
    );
    expect(html).toContain('Tool calls · Text only · 262,144-token context');
    expect(html).not.toContain('Nano Omni');
    expect(html).toContain(target === 'primary' ? 'Use this model' : 'Use as secondary');
  }
});
