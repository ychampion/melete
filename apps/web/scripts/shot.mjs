import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5180/#/design';
const out = process.argv[3] ?? 'C:/Users/gamin/AppData/Local/Temp/claude/shot.png';
const width = Number(process.argv[4] ?? 1440);
const theme = process.argv[5] ?? 'light';
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width, height: 900 },
  colorScheme: theme === 'dark' ? 'dark' : 'light',
});
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(process.argv[7] ?? 1500));
await page.screenshot({ path: out, fullPage: process.argv[6] === 'full' });
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
);
console.log(JSON.stringify({ errors, overflow }));
await browser.close();
