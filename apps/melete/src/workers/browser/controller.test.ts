import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { chromiumAvailable, chromiumMissingReason } from './available.ts';

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
(chromiumAvailable ? test : test.skip)(
  'thousands of accessible buttons hit the schema cap before unbounded locator round trips',
  async () => {
    const child = Bun.spawn(
      [
        'node',
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        fileURLToPath(new URL('../../../test/helpers/browser-schema.ts', import.meta.url)),
      ],
      { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
    );
    const timeout = setTimeout(() => child.kill(), 30_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      const result = JSON.parse(stdout);
      expect(result.reason).toBe('schema_too_large');
      expect(result.counts).toBeLessThanOrEqual(129);
      expect(result.evaluations).toBeLessThanOrEqual(129);
      expect(result.handles).toBe(0);
      expect(result.snapshots).toBe(0);
      expect(result.metrics.observations).toBe(0);
      expect(result.metrics.dispatched_inputs).toBe(0);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  },
  40_000,
);
