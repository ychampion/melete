import { expect, test } from 'bun:test';
import type { ModelSettings } from './api.ts';
import { canSetVision, visionLine } from './ModelConnect.tsx';

const active = (
  vision: boolean,
  vision_source: 'catalog' | 'app' | 'operator',
): ModelSettings['active'] => ({
  provider: 'fireworks',
  model: 'accounts/fireworks/models/deepseek-v4p1-flash',
  source: 'operator',
  connected: true,
  vision,
  vision_source,
  updated_at: null,
});

const settings = (over: Partial<ModelSettings> = {}): ModelSettings => ({
  active: active(false, 'catalog'),
  operator_default: {
    provider: 'fireworks',
    model: 'accounts/fireworks/models/deepseek-v4p1-flash',
  },
  providers: [
    {
      provider: 'fireworks',
      label: 'Fireworks',
      method: 'key',
      key: { state: 'operator', last_four: null, updated_at: null },
      base_url: null,
      base_url_source: null,
      connected: true,
      lists_models: true,
    },
  ],
  can_edit: true,
  can_store_keys: true,
  ...over,
});

test('the models screen says what the model does with screenshots, and where that came from', () => {
  expect(visionLine(active(false, 'catalog'))).toEqual({
    text: 'Gets screenshots as text: where each was saved and its size',
    hint: 'Melete doesn’t know this model to read images. If it does, turn this on.',
  });
  expect(visionLine(active(true, 'catalog')).text).toBe('Sees screenshots as pictures');
  expect(visionLine(active(true, 'catalog')).hint).toBe(
    'This model reads images, by Melete’s list.',
  );
  expect(visionLine(active(true, 'app')).hint).toBe('You set this for this model.');
  expect(visionLine(active(false, 'operator')).hint).toBe('Set in the server’s configuration.');
});

test('only the owner, on a connected model they could choose, can change it', () => {
  expect(canSetVision(settings())).toBe(true);
  expect(canSetVision(settings({ can_edit: false }))).toBe(false);
  expect(
    canSetVision(settings({ active: { ...active(false, 'catalog'), connected: false } })),
  ).toBe(false);
  expect(
    canSetVision(settings({ active: { ...active(false, 'catalog'), provider: 'fake' } })),
  ).toBe(false);
});
