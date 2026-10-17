/**
 * Settings › Usage, Home's starters and the chat's limit banner, drawn in a
 * real Chromium at a phone's 390 px width with the app's own stylesheets, in
 * light and in dark: nothing runs off the side, the text keeps its contrast
 * tokens, and the keyboard reaches every control in reading order.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_STARTERS, fillStarter } from '@melete/contracts/starters';
import { type Browser, chromium, type Page } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { StarterList } from '../screens/Starters.tsx';
import { CapBannerLine } from './Usage.tsx';
import { usageFixture } from './usage-fixture.ts';
import { YourUsageView } from './YourUsage.tsx';
import { capBanner } from './your-usage.ts';

// Playwright's pipe to the browser hangs under Bun on Windows; elsewhere this
// runs wherever Chromium is installed (bunx playwright install chromium).
const available = process.platform !== 'win32' && existsSync(chromium.executablePath());
const suite = available ? describe : describe.skip;

const src = join(import.meta.dir, '..');
const css = [
  'design/tokens.css',
  'design/base.css',
  'shell/shell.css',
  'screens/home.css',
  'models/models.css',
  'models/your-usage.css',
]
  .map((file) => readFileSync(join(src, file), 'utf8'))
  .join('\n');

const now = new Date('2026-10-13T15:00:00Z');
const usage = usageFixture({
  computer_seconds: 8100,
  notice: {
    level: 'warning',
    period: 'month',
    scope: 'person',
    message: "You have used 82% of this month's model allowance.",
    resets_at: '2026-11-01T00:00:00.000Z',
  },
});
const starters = DEFAULT_STARTERS.map((starter) => fillStarter(starter, 'Rancho Santa Margarita'));

function page(body: string, theme: 'light' | 'dark') {
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body><main class="page">${body}</main></body></html>`;
}

const markup = renderToStaticMarkup(
  <>
    <div className="home-compose">
      <textarea aria-label="Ask Melete" />
      <StarterList starters={starters} onPick={() => {}} onDismiss={() => {}} />
    </div>
    <CapBannerLine banner={capBanner(usage.notice, now, 'UTC')} />
    <YourUsageView data={usage} now={now} />
    <YourUsageView data={usageFixture({ caps: null, runs: [] })} now={now} />
  </>,
);

let browser: Browser;
let tab: Page;

beforeAll(async () => {
  if (!available) return;
  browser = await chromium.launch();
  tab = await browser.newPage({ viewport: { width: 390, height: 844 } });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

suite('at 390 px', () => {
  for (const theme of ['light', 'dark'] as const)
    test(`nothing runs off the side, in ${theme}`, async () => {
      await tab.emulateMedia({ colorScheme: theme });
      await tab.setContent(page(markup, theme));
      const wide = await tab.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const over = [...document.querySelectorAll('main *')]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && (box.right > width + 0.5 || box.left < -0.5);
          })
          .map((element) => `${element.tagName}.${element.className}`);
        return { scroll: document.documentElement.scrollWidth, width, over };
      });
      expect(wide.over).toEqual([]);
      expect(wide.scroll).toBeLessThanOrEqual(wide.width);
      // The page follows the theme: dark draws on the dark surface.
      const surface = await tab.evaluate(
        () => getComputedStyle(document.querySelector('.yu-section') as Element).backgroundColor,
      );
      expect(surface).toBe(theme === 'dark' ? 'rgb(22, 23, 25)' : 'rgb(255, 255, 255)');
      // Every starter is a full button, big enough to tap.
      const heights = await tab.$$eval('.starter', (buttons) =>
        buttons.map((button) => button.getBoundingClientRect().height),
      );
      expect(heights).toHaveLength(6);
      for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    });

  test('the keyboard reaches the starters, putting them away, the banner link and each run', async () => {
    await tab.setContent(page(markup, 'light'));
    await tab.focus('textarea');
    const order: string[] = [];
    for (let step = 0; step < 9; step++) {
      await tab.keyboard.press('Tab');
      order.push(
        await tab.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return `${active?.tagName.toLowerCase()}:${active?.textContent?.trim().slice(0, 24)}`;
        }),
      );
    }
    expect(order).toEqual([
      'button:Hide these',
      'button:Coffee shops nearby',
      'button:Remind me to stretch',
      'button:Tech news as a PDF',
      'button:Pull facts from a file',
      'button:Watch a page',
      'button:Plan a trip',
      'a:See your usage',
      // Only work with a chat to open is a link; the watch that failed is not.
      'a:Plan a 3-day trip to Lis',
    ]);
    // A focused starter shows its ring.
    await tab.focus('.starter');
    const ring = await tab.evaluate(
      () => getComputedStyle(document.activeElement as Element).outlineStyle,
    );
    expect(ring).toBe('solid');
  });
});
