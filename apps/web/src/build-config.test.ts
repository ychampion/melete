import { expect, test } from 'bun:test';
import config from '../vite.config.ts';

test('a production build ships no source maps', () => {
  expect((config as { build?: { sourcemap?: unknown } }).build?.sourcemap).toBe(false);
});
