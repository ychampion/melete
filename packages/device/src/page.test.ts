/**
 * The functions the extension injects into a Melete tab, run in a real
 * Chromium page the way `chrome.scripting.executeScript` runs them: each one
 * on its own, from its source text, with nothing from this module in scope.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { type Browser, chromium, type Page } from 'playwright';

// Playwright's pipe to the browser hangs under Bun on Windows; elsewhere this
// runs wherever Chromium is installed (bunx playwright install chromium).
const available = process.platform !== 'win32' && existsSync(chromium.executablePath());
const suite = available ? describe : describe.skip;

type Element = { ref: string; role: string; name: string; tag?: string; shows?: string };
type Outcome = { ok: boolean; code?: string; message?: string };

const source = (await import(new URL('../extension/page.js', import.meta.url).href)) as Record<
  string,
  (...args: unknown[]) => unknown
>;

const PAGE = `<!doctype html><html><head><title>Account settings</title></head><body>
<form action="/settings/save">
  <label for="email">Email</label><input id="email" name="email">
  <input type="password" name="pw" aria-label="Your secret">
  <input name="otp_code" placeholder="Code">
  <input id="cardNumber" placeholder="Number">
  <input aria-label="Passcode">
  <input autocomplete="cc-csc" placeholder="Security">
  <input id="hidden-typing" style="-webkit-text-security: disc" placeholder="PIN">
  <button id="primary" type="button">Save</button>
</form>
<a href="/help?from=settings">Help</a>
<script>window.clicked = []; document.getElementById('primary').addEventListener('click', () => window.clicked.push(document.getElementById('primary').textContent));</script>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  if (!available) return;
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function open() {
  page = await browser.newPage();
  await page.route('https://bank.example/**', (route) =>
    route.fulfill({ body: PAGE, contentType: 'text/html' }),
  );
  await page.goto('https://bank.example/settings?session=secret');
}

/** Run one injected function from its source, as the extension does. */
const inPage = <T>(name: string, ...args: unknown[]) =>
  page.evaluate(({ code, values }) => new Function(`return (${code})(...arguments)`)(...values), {
    code: String(source[name]),
    values: args,
  }) as Promise<T>;

const read = () =>
  inPage<{ elements: Element[] }>('readPage', 131_072, 200).then((result) => result.elements);
const approved = (element: Element) => {
  const { ref: _ref, ...described } = element;
  return { url: 'https://bank.example/settings', title: 'Account settings', element: described };
};

// Starting a browser on a busy machine takes longer than a unit test's default.
setDefaultTimeout(30_000);

suite('the page the extension acts on', () => {
  test('protected fields are recognised by more than their type', async () => {
    await open();
    const elements = await read();
    const roleOf = (name: string) => elements.find((element) => element.name === name)?.role;
    expect(roleOf('Email')).toBe('field');
    for (const name of ['Your secret', 'Code', 'Number', 'Passcode', 'Security', 'PIN'])
      expect([name, roleOf(name)]).toEqual([name, 'protected field']);
    const help = elements.find((element) => element.name === 'Help');
    // A link says where it goes, without its query.
    expect(help).toMatchObject({ role: 'link', tag: 'a', target: 'https://bank.example/help' });
  });

  test('a click goes through when the page and the element are as approved', async () => {
    await open();
    const save = (await read()).find((element) => element.name === 'Save') as Element;
    expect(save).toMatchObject({ role: 'button', tag: 'button' });
    expect(
      await inPage<Outcome>('act', 'browser_click', save.ref, approved(save), '', false),
    ).toEqual({ ok: true });
    expect(await page.evaluate<string[]>('window.clicked')).toEqual(['Save']);
  });

  test('an element whose label changed after the read is not clicked', async () => {
    await open();
    const save = (await read()).find((element) => element.name === 'Save') as Element;
    await page.evaluate(`document.getElementById('primary').textContent = 'Delete account'`);
    const outcome = await inPage<Outcome>(
      'act',
      'browser_click',
      save.ref,
      approved(save),
      '',
      false,
    );
    expect(outcome).toMatchObject({ ok: false, code: 'page_changed' });
    expect(outcome.message).toContain('Delete account');
    expect(await page.evaluate<string[]>('window.clicked')).toEqual([]);
  });

  test('a ref that names another element after a later read is not clicked', async () => {
    await open();
    const save = (await read()).find((element) => element.name === 'Save') as Element;
    await page.evaluate(`{
      const other = document.createElement('button');
      other.type = 'button';
      other.textContent = 'Close account';
      document.querySelector('form').prepend(other);
    }`);
    await read();
    const outcome = await inPage<Outcome>(
      'act',
      'browser_click',
      save.ref,
      approved(save),
      '',
      false,
    );
    expect(outcome).toMatchObject({ ok: false, code: 'page_changed' });
  });

  test('a tab that moved to another page is not acted on', async () => {
    await open();
    const save = (await read()).find((element) => element.name === 'Save') as Element;
    await page.evaluate(`history.pushState({}, '', '/close-account')`);
    const outcome = await inPage<Outcome>(
      'act',
      'browser_click',
      save.ref,
      approved(save),
      '',
      false,
    );
    expect(outcome).toMatchObject({ ok: false, code: 'page_changed' });
    expect(outcome.message).toContain('https://bank.example/close-account');
  });

  test('nothing is done without the approved page and element', async () => {
    await open();
    const save = (await read()).find((element) => element.name === 'Save') as Element;
    expect(await inPage<Outcome>('act', 'browser_click', save.ref, null, '', false)).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  test('typing goes into an ordinary field and never into a protected one', async () => {
    await open();
    const elements = await read();
    const email = elements.find((element) => element.name === 'Email') as Element;
    expect(
      await inPage<Outcome>(
        'act',
        'browser_type',
        email.ref,
        approved(email),
        'me@example.com',
        false,
      ),
    ).toEqual({ ok: true });
    expect(await page.inputValue('#email')).toBe('me@example.com');
    const pin = elements.find((element) => element.name === 'PIN') as Element;
    expect(
      await inPage<Outcome>('act', 'browser_type', pin.ref, approved(pin), '1234', false),
    ).toMatchObject({ ok: false, code: 'protected_field' });
    expect(await page.inputValue('#hidden-typing')).toBe('');
  });
});
