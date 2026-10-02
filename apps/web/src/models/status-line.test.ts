import { expect, test } from 'bun:test';
import type { ModelProviderStatus } from './api.ts';
import { statusLine } from './ModelConnect.tsx';

const fireworks = (
  state: 'unset' | 'set' | 'operator',
  connected: boolean,
): ModelProviderStatus => ({
  provider: 'fireworks',
  label: 'Fireworks',
  method: 'key',
  key: { state, last_four: state === 'set' ? 'ab12' : null, updated_at: null },
  base_url: null,
  base_url_source: null,
  connected,
  lists_models: true,
});

test('a tick only for a key that is really there', () => {
  expect(statusLine(fireworks('operator', true))).toEqual({
    text: 'Set by the operator',
    tone: 'ok',
  });
  expect(statusLine(fireworks('unset', false), true)).toEqual({
    text: 'Server default · needs a key',
    tone: 'attention',
  });
  expect(statusLine(fireworks('operator', false), true).tone).not.toBe('ok');
  expect(statusLine(fireworks('unset', false)).text).toBe('Not connected');
});
