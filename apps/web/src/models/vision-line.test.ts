import { expect, test } from 'bun:test';
import type { ModelSettings } from './api.ts';
import { canSetVision, visionLine } from './ModelConnect.tsx';

const active = (
  vision: boolean,
  vision_source: 'catalog' | 'app' | 'operator',
  provider_vision: boolean | null = null,
): ModelSettings['active'] => ({
  provider: 'fireworks',
  model: 'accounts/fireworks/models/deepseek-v4p1-flash',
  source: 'operator',
  connected: true,
  vision,
  vision_source,
  provider_vision,
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
  secondary: {
    model: null,
    uses: { side_tasks: 'secondary', scheduled: 'primary' },
    can_edit: true,
    leaves_local_primary: false,
    updated_at: null,
  },
  ...over,
});

test('the image switch says what it does, whether it is on, and where that came from', () => {
  expect(visionLine(active(false, 'catalog'))).toEqual({
    text: 'Send screenshots as pictures',
    hint: 'Off: it is told only where each screenshot was saved and its size. Melete doesn’t know this model to read images. If it does, turn this on.',
  });
  expect(visionLine(active(true, 'catalog')).text).toBe('Send screenshots as pictures');
  expect(visionLine(active(true, 'catalog')).hint).toBe(
    'On: it sees each screenshot. This model reads images, by Melete’s list.',
  );
  // The provider's answer informs; the switch stays the owner's.
  expect(visionLine(active(false, 'catalog', true)).hint).toBe(
    'Off: it is told only where each screenshot was saved and its size. Your provider says this model can read images. Turn this on to send it screenshots as pictures.',
  );
  expect(visionLine(active(true, 'app')).hint).toBe(
    'On: it sees each screenshot. You set this for this model.',
  );
  expect(visionLine(active(false, 'operator')).hint).toBe(
    'Off: it is told only where each screenshot was saved and its size. Set in the server’s configuration.',
  );
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
