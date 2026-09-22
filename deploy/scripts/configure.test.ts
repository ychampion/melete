import { describe, expect, test } from 'bun:test';
import { configureOptions } from './configure.ts';
import { DEFAULT_NODE_NAME } from './tailscale-origin.ts';

describe('the configuration generator options', () => {
  test('the documented options are read', () => {
    expect(configureOptions([])).toEqual({ fake: false, nodeName: null });
    expect(configureOptions(['--fake'])).toEqual({ fake: true, nodeName: null });
    expect(configureOptions(['--tailscale'])).toEqual({
      fake: false,
      nodeName: DEFAULT_NODE_NAME,
    });
    expect(configureOptions(['--fake', '--tailscale', '--tailscale-hostname', 'desk'])).toEqual({
      fake: true,
      nodeName: 'desk',
    });
  });

  test('a misspelt option is refused before anything is written', () => {
    for (const [args, unknown] of [
      [['--fak'], '--fak'],
      [['-fake'], '-fake'],
      [['fake'], 'fake'],
      [['--tailscale', '--tailscale-host', 'desk'], '--tailscale-host'],
    ] as const)
      expect(() => configureOptions(args)).toThrow(`Unknown option ${unknown}.`);
  });
});
