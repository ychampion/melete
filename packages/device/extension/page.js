/**
 * What the extension runs inside a Melete tab. Each function is injected on
 * its own with `chrome.scripting.executeScript`, so it must not reach outside
 * its own body. They run in the extension's isolated world: the page's own
 * scripts cannot see or call them, and the element list they keep is out of
 * the page's reach.
 *
 * Protected fields are never typed into, and their values are never read:
 * password fields, and fields whose name, id, accessible label or autocomplete
 * says password, passcode, one-time code, OTP, CVV/CVC or card, or whose text
 * is drawn as dots.
 */

/** Show or remove the bar that says Melete is using this tab, with a Stop button. */
export function showBar(on) {
  const id = 'melete-using-this-tab';
  const existing = document.getElementById(id);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText =
    'all: initial; position: fixed; z-index: 2147483647; left: 50%; top: 8px; transform: translateX(-50%);';
  const root = host.attachShadow({ mode: 'closed' });
  const bar = document.createElement('div');
  bar.setAttribute('role', 'status');
  bar.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:6px 8px 6px 12px;border-radius:999px;' +
    'background:#1d2a44;color:#fff;font:500 13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);';
  const text = document.createElement('span');
  text.textContent = 'Melete is using this tab';
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.textContent = 'Stop';
  stop.style.cssText =
    'all:initial;cursor:pointer;padding:4px 12px;border-radius:999px;background:#fff;color:#1d2a44;' +
    'font:600 12px system-ui,sans-serif;';
  stop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop' });
    host.remove();
  });
  bar.append(text, stop);
  root.append(bar);
  document.documentElement.append(host);
}

/**
 * The page's text and the things on it that can be clicked or filled, each
 * with a ref. Each element is described the way `act` describes it again
 * before acting: its role, its name, its tag, what it shows when that differs
 * from its name, and where a link or a form's button leads.
 */
export function readPage(maxBytes, maxElements) {
  const clean = (text) =>
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  const PROTECTED_WORDS =
    /pass(word|code|wd|phrase)|(^|[^a-z])otp([^a-z]|$)|one.?time|cvv|cvc|csc|card/i;
  const isField = (element) =>
    element.isContentEditable ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    (element.tagName === 'INPUT' &&
      !['checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'hidden', 'file'].includes(
        (element.getAttribute('type') ?? 'text').toLowerCase(),
      ));
  const isProtected = (element) => {
    if (!isField(element)) return false;
    if ((element.getAttribute('type') ?? '').toLowerCase() === 'password') return true;
    const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase();
    if (/(^|\s)cc-/.test(autocomplete)) return true;
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id)?.textContent : ''))
      .join(' ');
    const words = [
      element.getAttribute('name'),
      element.id,
      element.getAttribute('aria-label'),
      labelledBy,
      autocomplete,
    ].join(' ');
    if (PROTECTED_WORDS.test(words)) return true;
    // Text drawn as dots is a secret whatever the field is called.
    const secured = getComputedStyle(element).getPropertyValue('-webkit-text-security');
    return Boolean(secured) && secured !== 'none';
  };
  const describe = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type')?.toLowerCase();
    const role = isProtected(element)
      ? 'protected field'
      : element.getAttribute('role') ||
        (tag === 'a'
          ? 'link'
          : tag === 'button' || type === 'submit' || type === 'button'
            ? 'button'
            : tag === 'select'
              ? 'select'
              : type === 'checkbox' || type === 'radio'
                ? type
                : 'field');
    const buttonValue = tag === 'input' && ['submit', 'button'].includes(type) ? element.value : '';
    const name = clean(
      element.getAttribute('aria-label') ||
        (element.id &&
          document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent) ||
        element.closest('label')?.textContent ||
        element.getAttribute('placeholder') ||
        element.getAttribute('title') ||
        buttonValue ||
        element.textContent ||
        element.getAttribute('name') ||
        '',
    );
    const shown = clean(buttonValue || (isField(element) ? '' : element.innerText));
    const address = (value) => {
      try {
        const url = new URL(value, location.href);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '';
      }
    };
    const form = element.form ?? element.closest('form');
    const target =
      tag === 'a' && element.hasAttribute('href')
        ? address(element.getAttribute('href'))
        : role === 'button' && form
          ? address(element.getAttribute('formaction') || form.getAttribute('action') || '')
          : '';
    return {
      role,
      name,
      tag,
      ...(shown && shown !== name ? { shows: shown } : {}),
      ...(target ? { target: target.slice(0, 2048) } : {}),
    };
  };
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  };
  const selector =
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [contenteditable=true]';
  const refs = [];
  const elements = [];
  for (const element of document.querySelectorAll(selector)) {
    if (elements.length >= maxElements) break;
    if (!visible(element)) continue;
    refs.push(element);
    elements.push({ ref: `e${refs.length}`, ...describe(element) });
  }
  globalThis.__meleteRefs = refs;
  const full = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n');
  const bytes = new TextEncoder().encode(full);
  const text =
    bytes.byteLength > maxBytes
      ? new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�$/, '')
      : full;
  return { text, truncated: bytes.byteLength > maxBytes, elements };
}

/**
 * Click, or type into, the element `readPage` named `ref`, only if the tab is
 * still on the page the person approved and the ref still names the element
 * they approved. Anything else is refused and reported, and nothing is done.
 * Protected fields are never typed into.
 */
export function act(tool, ref, expected, text, submit) {
  const clean = (value) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  const PROTECTED_WORDS =
    /pass(word|code|wd|phrase)|(^|[^a-z])otp([^a-z]|$)|one.?time|cvv|cvc|csc|card/i;
  const isField = (element) =>
    element.isContentEditable ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    (element.tagName === 'INPUT' &&
      !['checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'hidden', 'file'].includes(
        (element.getAttribute('type') ?? 'text').toLowerCase(),
      ));
  const isProtected = (element) => {
    if (!isField(element)) return false;
    if ((element.getAttribute('type') ?? '').toLowerCase() === 'password') return true;
    const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase();
    if (/(^|\s)cc-/.test(autocomplete)) return true;
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id)?.textContent : ''))
      .join(' ');
    const words = [
      element.getAttribute('name'),
      element.id,
      element.getAttribute('aria-label'),
      labelledBy,
      autocomplete,
    ].join(' ');
    if (PROTECTED_WORDS.test(words)) return true;
    const secured = getComputedStyle(element).getPropertyValue('-webkit-text-security');
    return Boolean(secured) && secured !== 'none';
  };
  const describe = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type')?.toLowerCase();
    const role = isProtected(element)
      ? 'protected field'
      : element.getAttribute('role') ||
        (tag === 'a'
          ? 'link'
          : tag === 'button' || type === 'submit' || type === 'button'
            ? 'button'
            : tag === 'select'
              ? 'select'
              : type === 'checkbox' || type === 'radio'
                ? type
                : 'field');
    const buttonValue = tag === 'input' && ['submit', 'button'].includes(type) ? element.value : '';
    const name = clean(
      element.getAttribute('aria-label') ||
        (element.id &&
          document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent) ||
        element.closest('label')?.textContent ||
        element.getAttribute('placeholder') ||
        element.getAttribute('title') ||
        buttonValue ||
        element.textContent ||
        element.getAttribute('name') ||
        '',
    );
    const shown = clean(buttonValue || (isField(element) ? '' : element.innerText));
    const address = (value) => {
      try {
        const url = new URL(value, location.href);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '';
      }
    };
    const form = element.form ?? element.closest('form');
    const target =
      tag === 'a' && element.hasAttribute('href')
        ? address(element.getAttribute('href'))
        : role === 'button' && form
          ? address(element.getAttribute('formaction') || form.getAttribute('action') || '')
          : '';
    return {
      role,
      name,
      tag,
      ...(shown && shown !== name ? { shows: shown } : {}),
      ...(target ? { target: target.slice(0, 2048) } : {}),
    };
  };
  const said = (element) => `${element.role} "${element.name}"`;

  const want = expected && typeof expected === 'object' ? expected : null;
  if (!want || typeof want.url !== 'string' || !want.element || typeof want.element !== 'object')
    return {
      ok: false,
      code: 'invalid_request',
      message: 'Nothing is clicked or typed without the page and element the person approved.',
    };
  const here = `${location.origin}${location.pathname}`;
  if (here !== want.url)
    return {
      ok: false,
      code: 'page_changed',
      message: `The tab is now on ${here}, not on ${want.url} as approved. Nothing was done; read the page again.`,
    };
  const index = Number(String(ref).slice(1)) - 1;
  const element = globalThis.__meleteRefs?.[index];
  if (!element?.isConnected)
    return { ok: false, code: 'not_found', message: 'That element is gone. Read the page again.' };
  const now = describe(element);
  for (const key of ['role', 'name', 'tag', 'shows', 'target'])
    if ((now[key] ?? '') !== (want.element[key] ?? ''))
      return {
        ok: false,
        code: 'page_changed',
        message: `That element is now ${said(now)}, not ${said(want.element)} as approved. Nothing was done; read the page again.`,
      };
  if (tool === 'browser_click') {
    element.scrollIntoView({ block: 'center' });
    element.click();
    return { ok: true };
  }
  if (isProtected(element))
    return {
      ok: false,
      code: 'protected_field',
      message:
        'Passwords, one-time codes and card details are never typed. Ask the person to enter it.',
    };
  const editable =
    element.isContentEditable ||
    element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' &&
      !['checkbox', 'radio', 'submit', 'button', 'file', 'image', 'reset', 'hidden'].includes(
        (element.getAttribute('type') ?? 'text').toLowerCase(),
      ));
  if (!editable)
    return { ok: false, code: 'invalid_request', message: 'That is not a text field.' };
  element.scrollIntoView({ block: 'center' });
  element.focus();
  if (element.isContentEditable) element.textContent = text;
  else {
    // Set through the prototype so frameworks that track the value see the change.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    if (setter) setter.call(element, text);
    else element.value = text;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  if (submit) {
    const form = element.closest('form');
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
  }
  return { ok: true };
}
