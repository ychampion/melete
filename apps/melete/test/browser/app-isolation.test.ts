/**
 * What a published app can and cannot do, in real browsers. The stack is the
 * real web server and the real isolation headers (app-isolation-stack.ts);
 * the app is adversarial and reports what it managed.
 *
 * Runs wherever Chromium and Firefox are installed for Playwright
 * (`bunx playwright install chromium firefox`). Playwright's pipe hangs under
 * Bun on Windows, so it is skipped there. The CI job sets
 * MELETE_APP_ISOLATION_PROOF=1, which turns a missing browser into a failure
 * rather than a skip.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { type Browser, type BrowserType, chromium, firefox, type Page } from 'playwright';
import { VIEW_PREFIX } from '../../src/viewer/headers.ts';
import { DATA, type IsolationStack, startIsolationStack } from './app-isolation-stack.ts';

setDefaultTimeout(60_000);

const required = process.env.MELETE_APP_ISOLATION_PROOF === '1';
const engines: [string, BrowserType][] = [
  ['Chromium', chromium],
  ['Firefox', firefox],
];

let stack: IsolationStack;
beforeAll(async () => {
  stack = await startIsolationStack();
});
afterAll(async () => {
  await stack?.stop();
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every probe either says it was blocked or names a harmless outcome; none says LEAKED. */
function expectNothingLeaked(results: Record<string, string>) {
  for (const [name, value] of Object.entries(results))
    expect(value.startsWith('LEAKED'), `${name}: ${value}`).toBe(false);
  for (const name of [
    'cookie',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'api',
    'api_credentials',
    'fetch',
    'websocket',
    'popup',
  ])
    expect(results[name], name).toStartWith('blocked');
  expect(results.origin).toBe('opaque');
  // Its own files load: the policy names where they are, even from an opaque origin.
  expect(results.classicScript).toBe('ran');
  expect(results.moduleScript).toBe('ran');
  expect(results.ownImage).toBe('loaded');
  expect(results.ownStyle).toBe('rgb(1, 2, 3)');
  expect(results.externalImage).toBe('blocked');
}

for (const [name, engine] of engines) {
  const installed = process.platform !== 'win32' && existsSync(engine.executablePath());
  if (required && !installed)
    test(`${name} is installed for the isolation proof`, () => {
      throw new Error(
        `${name} is not installed: bunx playwright install --with-deps ${name.toLowerCase()}`,
      );
    });
  const suite = installed ? describe : describe.skip;

  suite(`a published app in ${name}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test("an app cannot read Melete's cookies, storage or API, opened framed or directly", async () => {
      stack.hits.length = 0;
      page = await browser.newPage();
      await page.goto(`${stack.web}/`);
      await page.waitForFunction('window.__results', null, { timeout: 20_000 });
      const results = (await page.evaluate('window.__results')) as Record<string, string>;
      expectNothingLeaked(results);
      expect(results.topNavigation).toStartWith('blocked');
      expect(results.parentDocument).toStartWith('blocked');
      expect(results.parentStorage).toStartWith('blocked');
      // The bridge answers with what the page fetched for this viewer, and nothing else.
      expect(JSON.parse(results.bridgeData ?? 'null')).toEqual(DATA);

      // The app's own file requests carry no session, and a module script asks as `null`.
      const files = stack.observed.filter(
        (seen) =>
          seen.path.startsWith(`/api${VIEW_PREFIX}tok/`) && !seen.path.endsWith('index.html'),
      );
      expect(files.length).toBeGreaterThan(3);
      expect(files.filter((seen) => seen.session)).toEqual([]);
      expect(files.find((seen) => seen.path.endsWith('/probe.js'))?.origin).toBe('null');

      // Opened as a page of its own, the app is not served at all.
      const direct = await page.goto(`${stack.web}/api${VIEW_PREFIX}tok/index.html`);
      expect(direct?.status()).toBe(403);
      expect(await page.content()).not.toContain('probe.js');

      // And were that refusal to fail, the policy alone still holds in a top-level page.
      await page.goto(`${stack.web}/api${VIEW_PREFIX}direct/index.html`);
      // Read from outside the page: the page's own policy refuses the evaluated
      // script a waitForFunction would run in it.
      for (let tries = 0; tries < 80; tries++) {
        if ((await page.textContent('#out'))?.startsWith('{')) break;
        await settle(250);
      }
      expectNothingLeaked(
        JSON.parse((await page.textContent('#out')) ?? '{}') as Record<string, string>,
      );
      await page.close();
    });

    test('an app cannot fetch, load or navigate anywhere outside its bundle', async () => {
      stack.hits.length = 0;
      page = await browser.newPage();
      await page.goto(`${stack.web}/`);
      await page.waitForFunction('window.__results', null, { timeout: 20_000 });
      // The frames post a form elsewhere and then move themselves elsewhere; give both time.
      await settle(2_000);
      expect(stack.hits).toEqual([]);
      await page.close();
    });

    test('the Melete app refuses to be framed by another site', async () => {
      page = await browser.newPage();
      await page.goto(`${stack.elsewhere}/frames-melete.html`);
      await settle(1_000);
      const child = page.frames().find((frame) => frame !== page.mainFrame());
      let title = '';
      try {
        // A frame that loaded answers at once; a blocked one may never answer.
        title = (await Promise.race([child?.title(), settle(5_000).then(() => '')])) ?? '';
      } catch {
        title = '';
      }
      expect(title).not.toBe('Melete');
      await page.close();
    });
  });
}
