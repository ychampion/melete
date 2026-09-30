/**
 * What the extension runs inside a Melete tab. Each function is injected on
 * its own with `chrome.scripting.executeScript`, so it must not reach outside
 * its own body. They run in the extension's isolated world: the page's own
 * scripts cannot see or call them, and the element list they keep is out of
 * the page's reach.
 *
 * Protected fields (passwords, one-time codes, card numbers) are never typed
 * into, and their values are never read.
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

/** The page's text and the things on it that can be clicked or filled, each with a ref. */
export function readPage(maxBytes, maxElements) {
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
    const isProtected = element.matches(
      'input[type=password], input[autocomplete*="password"], input[autocomplete*="one-time-code"], input[autocomplete^="cc-"], input[autocomplete*=" cc-"]',
    );
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type')?.toLowerCase();
    const role =
      element.getAttribute('role') ||
      (tag === 'a'
        ? 'link'
        : tag === 'button' || type === 'submit' || type === 'button'
          ? 'button'
          : tag === 'select'
            ? 'select'
            : type === 'checkbox' || type === 'radio'
              ? type
              : 'field');
    const label =
      element.getAttribute('aria-label') ||
      (element.id &&
        document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent) ||
      element.closest('label')?.textContent ||
      element.getAttribute('placeholder') ||
      element.getAttribute('title') ||
      (tag === 'input' && ['submit', 'button'].includes(type) ? element.value : '') ||
      element.textContent ||
      element.getAttribute('name') ||
      '';
    refs.push(element);
    elements.push({
      ref: `e${refs.length}`,
      role: isProtected ? 'protected field' : role,
      name: label.replace(/\s+/g, ' ').trim().slice(0, 300),
    });
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

/** Click the element `readPage` named `ref`. */
export function clickRef(ref) {
  const index = Number(String(ref).slice(1)) - 1;
  const element = globalThis.__meleteRefs?.[index];
  if (!element?.isConnected)
    return { ok: false, code: 'not_found', message: 'That element is gone. Read the page again.' };
  element.scrollIntoView({ block: 'center' });
  element.click();
  return { ok: true };
}

/** Type into the field `readPage` named `ref`. Protected fields are refused. */
export function typeRef(ref, text, submit) {
  const index = Number(String(ref).slice(1)) - 1;
  const element = globalThis.__meleteRefs?.[index];
  if (!element?.isConnected)
    return { ok: false, code: 'not_found', message: 'That element is gone. Read the page again.' };
  if (
    element.matches(
      'input[type=password], input[autocomplete*="password"], input[autocomplete*="one-time-code"], input[autocomplete^="cc-"], input[autocomplete*=" cc-"]',
    )
  )
    return {
      ok: false,
      code: 'protected_field',
      message:
        'Passwords, one-time codes and card numbers are never typed. Ask the person to enter it.',
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
