/**
 * What a preview of a server in an agent's computer can and cannot do, in
 * real browsers. The stack is the real web server, the real preview proxy and
 * the real isolation headers (preview-isolation-stack.ts); the previewed page
 * is adversarial and reports what it managed.
 *
 * Runs wherever Chromium and Firefox are installed for Playwright. Playwright's
 * pipe hangs under Bun on Windows, so it is skipped there. The CI job sets
 * MELETE_APP_ISOLATION_PROOF=1, which turns a missing browser into a failure.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { type Browser, type BrowserType, chromium, firefox } from 'playwright';
import { type PreviewStack, startPreviewStack } from './preview-isolation-stack.ts';

setDefaultTimeout(60_000);

const required = process.env.MELETE_APP_ISOLATION_PROOF === '1';
const engines: [string, BrowserType][] = [
  ['Chromium', chromium],
  ['Firefox', firefox],
];

let stack: PreviewStack;
beforeAll(async () => {
  stack = await startPreviewStack();
});
afterAll(async () => {
  await stack?.stop();
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const [name, engine] of engines) {
  const installed = process.platform !== 'win32' && existsSync(engine.executablePath());
  if (required && !installed)
    test(`${name} is installed for the preview proof`, () => {
      throw new Error(`${name} is not installed: bunx playwright install --with-deps ${name}`);
    });
  const suite = installed ? describe : describe.skip;

  suite(`a preview in ${name}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test('a preview never forwards the Melete cookie, and the page runs in an opaque origin', async () => {
      stack.reached.length = 0;
      stack.strayed.length = 0;
      stack.elsewhere.length = 0;
      const page = await browser.newPage();
      await page.goto(`${stack.web}/`);
      await page.waitForFunction('window.__results', null, { timeout: 20_000 });
      const results = (await page.evaluate('window.__results')) as Record<string, string>;
      for (const [probe, value] of Object.entries(results))
        expect(value.startsWith('LEAKED'), `${probe}: ${value}`).toBe(false);
      for (const probe of ['cookie', 'localStorage', 'api', 'api_credentials', 'parentDocument'])
        expect(results[probe], probe).toStartWith('blocked');
      expect(results.origin).toBe('opaque');
      // Its own files, linked from the root, load through the preview.
      expect(results.moduleScript).toBe('ran');
      expect(results.ownStyle).toBe('rgb(1, 2, 3)');
      expect(results.ownImage).toBe('loaded');
      expect(stack.reached.map((seen) => seen.path)).toEqual(
        expect.arrayContaining(['/', '/src/main.js', '/src/probe.js', '/assets/style.css']),
      );
      // The browser sent the Lax session cookie with the frame's document; none of it got through.
      expect(
        stack.reached.filter((seen) => seen.cookie !== null || seen.authorization !== null),
      ).toEqual([]);

      // Opened as a page of its own, the preview is not served at all.
      const direct = await page.goto(`${stack.web}/api${stack.path}`);
      expect(direct?.status()).toBe(403);
      await page.close();
    });

    test('a preview cannot reach a port the process did not declare', async () => {
      stack.strayed.length = 0;
      stack.elsewhere.length = 0;
      const page = await browser.newPage();
      await page.goto(`${stack.web}/`);
      await page.waitForFunction('window.__results', null, { timeout: 20_000 });
      const results = (await page.evaluate('window.__results')) as Record<string, string>;
      await settle(1_500);
      expect(results.undeclared).toStartWith('blocked');
      expect(results.undeclaredImage).toBe('blocked');
      expect(results.websocket).toStartWith('blocked');
      expect(stack.strayed).toEqual([]);
      expect(stack.elsewhere).toEqual([]);
      await page.close();
    });
  });
}
