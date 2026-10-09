import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { chromiumAvailable, chromiumMissingReason } from './available.ts';

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
(chromiumAvailable ? test : test.skip)(
  'thousands of accessible buttons are listed up to the cap, fields first, without unbounded locator round trips',
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
      expect(result.reason).toBe('');
      // The look lists the most it may, the field first, and says how many more there are.
      expect(result.listed).toBe(128);
      expect(result.first).toBe('textbox');
      expect(result.unlisted).toBe(3001 - 128);
      expect(result.note).toContain('up to 2873 more are not listed');
      // One search per listed control, and one per listed button for its form, never one per
      // control on the page.
      expect(result.counts).toBeLessThanOrEqual(2 * 128);
      expect(result.evaluations).toBeLessThanOrEqual(2 * 128);
      expect(result.handles).toBeLessThanOrEqual(128);
      expect(result.snapshots).toBe(1);
      expect(result.metrics.observations).toBe(1);
      expect(result.metrics.dispatched_inputs).toBe(0);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  },
  40_000,
);
