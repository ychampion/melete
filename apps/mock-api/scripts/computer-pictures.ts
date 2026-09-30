/**
 * Draws the pictures the mock shows as its agent's browser: a booking page with a time chosen,
 * and the same page once the table is held. Each is written twice, as the service would send
 * it: a PNG for the page as last seen, and a JPEG for a live frame.
 *
 * `node apps/mock-api/scripts/computer-pictures.ts` from the repository root. Chromium is launched
 * from Node, as the browser worker does: a Bun launch of it can stall on Windows.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'computer');
mkdirSync(out, { recursive: true });

const slots = ['6:45 PM', '7:00 PM', '7:30 PM', '8:00 PM', '8:30 PM'];
const page = (held: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d1b19; background: #fbf8f4; }
  header { height: 60px; display: flex; align-items: center; gap: 28px; padding: 0 40px; border-bottom: 1px solid #e8e1d8; background: #fff; }
  .brand { font: 700 19px Georgia, serif; letter-spacing: -.01em; }
  nav { display: flex; gap: 22px; color: #6d655c; font-size: 14px; }
  .grow { flex: 1; }
  .who { width: 32px; height: 32px; border-radius: 50%; background: #d9cbb8; }
  .hero { height: 250px; background: linear-gradient(135deg, #7b3f2a, #c07a4f 55%, #e7c39a); position: relative; }
  .hero .shade { position: absolute; inset: 0; background: linear-gradient(180deg, transparent 40%, rgba(0,0,0,.45)); }
  .hero h1 { position: absolute; left: 40px; bottom: 44px; margin: 0; color: #fff; font: 600 40px Georgia, serif; }
  .hero p { position: absolute; left: 40px; bottom: 18px; margin: 0; color: #f6e9dc; font-size: 15px; }
  main { display: grid; grid-template-columns: 1fr 340px; gap: 32px; padding: 28px 40px; }
  h2 { font: 600 18px Georgia, serif; margin: 0 0 10px; }
  .about { color: #574f47; }
  .tags { display: flex; gap: 8px; margin-top: 14px; }
  .tag { padding: 4px 10px; border-radius: 999px; background: #efe7dc; font-size: 13px; color: #5c5249; }
  .card { background: #fff; border: 1px solid #e8e1d8; border-radius: 14px; padding: 20px; box-shadow: 0 6px 20px rgba(60,40,20,.06); }
  .row { display: flex; gap: 8px; margin-bottom: 14px; }
  .field { flex: 1; border: 1px solid #ddd3c7; border-radius: 9px; padding: 8px 10px; font-size: 13px; color: #6d655c; }
  .field b { display: block; color: #1d1b19; font-size: 14px; font-weight: 600; }
  .slots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .slot { border: 1px solid #c9b49c; border-radius: 9px; padding: 9px 0; text-align: center; font-weight: 600; color: #7b3f2a; }
  .slot.on { background: #7b3f2a; color: #fff; border-color: #7b3f2a; }
  .go { margin-top: 16px; border-radius: 10px; padding: 12px; text-align: center; font-weight: 600; background: #1d1b19; color: #fff; }
  .held { display: flex; gap: 12px; align-items: center; padding: 14px; border-radius: 10px; background: #edf6ee; color: #25533a; font-weight: 600; }
  .tick { width: 26px; height: 26px; border-radius: 50%; background: #2f7a4e; color: #fff; display: grid; place-items: center; font-size: 15px; }
</style></head><body>
<header><span class="brand">Tablefinder</span><nav><span>Tonight</span><span>Neighbourhoods</span><span>Saved</span></nav><span class="grow"></span><span class="who"></span></header>
<div class="hero"><div class="shade"></div><h1>Luna Trattoria</h1><p>Italian · $$ · Greenwich Village · 4.7 (2,341)</p></div>
<main>
  <section><h2>About</h2><p class="about">Hand-rolled pasta, a wood oven and a short list of natural wines. The back room seats up to eight; the counter is kept for walk-ins.</p>
  <div class="tags"><span class="tag">Tonight</span><span class="tag">3 guests</span><span class="tag">Dinner</span></div></section>
  <aside class="card">${
    held
      ? '<h2>Your table</h2><div class="held"><span class="tick">✓</span>Reserved · tonight 7:30 PM · 3 guests</div><div class="go">View reservation</div>'
      : `<h2>Reserve</h2><div class="row"><div class="field">Date<b>Tonight</b></div><div class="field">Guests<b>3</b></div></div><div class="slots">${slots
          .map((slot) => `<div class="slot${slot === '7:30 PM' ? ' on' : ''}">${slot}</div>`)
          .join('')}</div><div class="go">Reserve 7:30 PM</div>`
  }</aside>
</main></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1024, height: 768 } });
for (const [name, held] of [
  ['booking', false],
  ['reserved', true],
] as const) {
  await tab.setContent(page(held));
  await tab.screenshot({ path: join(out, `${name}.png`) });
  await tab.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 72 });
}
await browser.close();
process.stdout.write(`computer pictures: wrote ${out}\n`);
