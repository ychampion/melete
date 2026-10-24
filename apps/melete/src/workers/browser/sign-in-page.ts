/**
 * What a saved sign-in looks for on a page, run inside Chromium: the username,
 * password and one-time code fields of a sign-in form, and what the page shows
 * once the form is sent. Each function here is serialized into the page, so it
 * uses nothing from outside its own body.
 *
 * The fields found are marked with an attribute carrying a fresh nonce, so the
 * worker can reach exactly them through Playwright, and the marks are taken
 * off again once the step is over. Nothing here reads a field's value back
 * except to say whether a field is empty.
 */

/** What a saved sign-in step came to, in the words the service turns into a receipt. */
export type SignInStepOutcome =
  | 'signed_in'
  | 'code_asked'
  | 'form_not_found'
  | 'not_accepted'
  | 'wrong_site'
  | 'insecure_site'
  | 'captcha'
  /** The form would have put the password in the page's address; it was held back. */
  | 'unsafe_form'
  /** The username went, and the page then asked for no password. */
  | 'username_sent';

/**
 * The longest a sign-in step goes on starting anything new, counted from when the worker was
 * asked: past it no page is opened, followed or typed into. What is already under way then
 * still ends by its own limits: typing and sending what was typed (each request the guard lets
 * through is cut off after ten seconds, the wait for the page's answer after ten), a load cut
 * to the bound, the last look, and the clearing of the password field, about a minute in all.
 */
export const SIGN_IN_STEP_MS = 90_000;

/**
 * How long the service waits for a sign-in step's answer: past the step's own bound and what
 * may still be under way when it passes, so the service never reports a failure while the
 * worker goes on to sign in.
 */
export const SIGN_IN_REQUEST_MS = 180_000;

/** The origin of an address, or null for one that has none (about:blank, a data: page). */
export function originOf(address: string | undefined): string | null {
  if (!address) return null;
  try {
    const url = new URL(address);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** What a sign-in step found on the page. */
export type SignInFields = {
  username: boolean;
  password: boolean;
  /** One field for the code, or one box per digit. */
  code: 'none' | 'single' | 'boxes';
  /** How many digit boxes, when the code is typed one digit per box. */
  boxes: number;
  submit: boolean;
  /** More than one password field and none says it is the current one: a sign-up or change form. */
  ambiguous: boolean;
  /** Where the form the fields are in sends them, by its submit button; empty with no form. */
  action: string;
  /** How that form sends them: `get` puts them in the address. Empty with no form. */
  method: string;
};

/** What the page shows after a sign-in step was sent. */
export type SignInState = {
  password: boolean;
  /** The password field the worker filled still holds something. */
  filled: boolean;
  code: boolean;
  username: boolean;
};

declare const pageForm: unique symbol;
/**
 * A form, as the code here may only read it: through the prototype's own getters and methods
 * (see `formRead`). A form's fields are reachable as its properties, so a field named `action`,
 * `method`, `elements`, `id` or `getAttribute` shadows that property on the form itself: a
 * hidden `<input name="action">`, common on sign-in pages, would stand in for its address.
 */
type Form = { readonly [pageForm]: true };

type Element = {
  tagName: string;
  type: string;
  name: string;
  id: string;
  className: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  autocomplete: string;
  placeholder: string;
  textContent: string | null;
  formAction?: string;
  formMethod?: string;
  parentElement: Element | null;
  form: Form | null;
  labels: ArrayLike<{ textContent: string | null }> | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  getClientRects(): { length: number };
  compareDocumentPosition(other: Element): number;
};

/**
 * Finds the sign-in form's fields and marks them `data-melete-sign-in` with
 * `<nonce>:username`, `:password`, `:code`, `:code<n>` or `:submit`. Runs in the page.
 */
export function markSignInFields(nonce: string): SignInFields {
  const { document: doc, location } = globalThis as unknown as {
    document: { querySelectorAll(selector: string): ArrayLike<Element>; title: string };
    location: { pathname: string };
  };
  // A form's own fields shadow its properties, so each is read through the prototype's getter,
  // and its attributes through Element's own method.
  const page = globalThis as unknown as {
    HTMLFormElement: { prototype: object };
    Element: { prototype: { getAttribute(this: unknown, name: string): string | null } };
  };
  const formRead = (form: Form, name: 'action' | 'method' | 'elements'): unknown =>
    Object.getOwnPropertyDescriptor(page.HTMLFormElement.prototype, name)?.get?.call(form);
  const formElements = (form: Form) =>
    Array.from((formRead(form, 'elements') ?? []) as ArrayLike<Element>);
  const formAttribute = (form: Form, name: string) =>
    page.Element.prototype.getAttribute.call(form, name);
  const style = (element: Element) =>
    (
      globalThis as unknown as {
        getComputedStyle(element: Element): { visibility: string; display: string };
      }
    ).getComputedStyle(element);
  const usable = (element: Element) =>
    element.getClientRects().length > 0 &&
    style(element).visibility !== 'hidden' &&
    style(element).display !== 'none' &&
    !element.disabled &&
    !element.readOnly;
  const words = (element: Element) =>
    [
      element.name,
      element.id,
      element.getAttribute('aria-label') ?? '',
      element.placeholder ?? '',
      ...Array.from(element.labels ?? []).map((label) => label.textContent ?? ''),
    ]
      .join(' ')
      .toLowerCase();
  const CODE =
    /(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verification.?code|security.?code|auth(entication)?.?code|passcode|two.?factor|token)([^a-z]|$)/;
  const USER =
    /(^|[^a-z])(user(name)?|e-?mail|login|log.?in|account|identifier|identity|phone|mobile|member)([^a-z]|$)/;
  const SEARCH = /(^|[^a-z])(search|query|q)([^a-z]|$)/;
  // What a sign-in's username-only first step says it is, and what a box asking for an email
  // for anything else (a newsletter, a password reset, a sign-up, a search) says.
  const LOGIN =
    /(^|[^a-z])(sign.?in|log.?in|logon|sign.?on|sso|auth|authenticate|identifier)([^a-z]|$)/;
  const NOT_LOGIN =
    /news.?letter|subscri|sign.?up|regist|join|forgot|reset|recover|search|contact|feedback|wait.?list|notif|invite|promo|create.?account/;
  const NOT_LOGIN_AROUND = /news.?letter|subscri|sign.?up|footer|forgot|reset|recover|search/;
  for (const old of Array.from(doc.querySelectorAll('[data-melete-sign-in]')))
    old.removeAttribute('data-melete-sign-in');
  const mark = (element: Element, what: string) =>
    element.setAttribute('data-melete-sign-in', `${nonce}:${what}`);
  const inputs = Array.from(doc.querySelectorAll('input')).filter(usable);
  const textual = (element: Element) =>
    ['text', 'email', 'tel', 'number', ''].includes(
      (element.getAttribute('type') ?? '').toLowerCase(),
    );
  const codeLike = (element: Element) =>
    /one-time-code/i.test(element.autocomplete) || (textual(element) && CODE.test(words(element)));
  const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & 4) !== 0;

  const passwords = inputs.filter((element) => element.type === 'password');
  const current = passwords.filter((element) => /current-password/i.test(element.autocomplete));
  const plain = passwords.filter((element) => !/new-password/i.test(element.autocomplete));
  const password = current[0] ?? (plain.length === 1 ? plain[0] : undefined);
  const ambiguous = !current.length && plain.length > 1;

  // Digit boxes: six or more single-character fields, side by side, for one code.
  const singles = inputs.filter(
    (element) => element.getAttribute('maxlength') === '1' && textual(element),
  );
  const boxes = singles.length >= 6 && singles.length <= 8 ? singles : [];
  const code = boxes.length ? undefined : inputs.find(codeLike);

  const scope = password?.form ?? code?.form ?? null;
  const inForm = (element: Element) => !scope || formElements(scope).includes(element);
  const candidates = inputs.filter(
    (element) =>
      textual(element) &&
      element !== code &&
      !boxes.includes(element) &&
      !codeLike(element) &&
      !SEARCH.test(words(element)) &&
      inForm(element) &&
      (!password || before(element, password)),
  );
  const hinted = candidates.filter(
    (element) =>
      /username|email/i.test(element.autocomplete) ||
      element.type === 'email' ||
      USER.test(words(element)),
  );
  const submitOf = (form: Form | null) =>
    form
      ? formElements(form).find(
          (element) =>
            ['BUTTON', 'INPUT'].includes(element.tagName) &&
            ((element.tagName === 'BUTTON' && !element.hasAttribute('type')) ||
              ['submit', 'image'].includes((element.getAttribute('type') ?? '').toLowerCase())) &&
            element.getClientRects().length > 0 &&
            !element.disabled,
        )
      : undefined;
  const said = (element: Element | undefined) =>
    element
      ? `${element.textContent ?? ''} ${element.getAttribute('value') ?? ''} ${element.getAttribute('aria-label') ?? ''}`.toLowerCase()
      : '';
  const formSays = (form: Form | null) =>
    form
      ? `${formAttribute(form, 'id') ?? ''} ${formAttribute(form, 'name') ?? ''} ${formAttribute(form, 'class') ?? ''} ${formAttribute(form, 'action') ?? ''} ${formAttribute(form, 'aria-label') ?? ''}`.toLowerCase()
      : '';
  // A field asking for the username alone is a sign-in's first step only when it, its form or
  // the page says so, and nothing in or around it says it is for a newsletter, a reset, a
  // sign-up or a search: typing the username into anything else would send it there.
  const firstStep = (element: Element) => {
    const form = element.form;
    const button = said(submitOf(form));
    if (NOT_LOGIN.test(`${words(element)} ${formSays(form)} ${button}`)) return false;
    for (let around = element.parentElement; around; around = around.parentElement)
      if (
        around.tagName === 'FOOTER' ||
        NOT_LOGIN_AROUND.test(`${around.id} ${around.className}`.toLowerCase())
      )
        return false;
    if (/username|webauthn/i.test(element.autocomplete)) return true;
    if (LOGIN.test(`${formSays(form)} ${button}`)) return true;
    return (
      LOGIN.test(`${location.pathname} ${doc.title}`.toLowerCase()) &&
      inputs.filter(textual).length === 1
    );
  };
  // With a password field, the field just before it is its username; without
  // one, only a field that is a sign-in's first step, never any text box on the page.
  const username = password ? (hinted.at(-1) ?? candidates.at(-1)) : hinted.find(firstStep);

  const filled = [username, password, code, ...boxes].filter(Boolean) as Element[];
  const form = filled.find((element) => element.form)?.form ?? null;
  const submit = submitOf(form);
  // What the browser itself would do with the form: a submit button's own formaction and
  // formmethod come before the form's.
  const action = !form
    ? ''
    : submit?.getAttribute('formaction')
      ? (submit.formAction ?? '')
      : String(formRead(form, 'action') ?? '');
  const method = !form
    ? ''
    : (submit?.getAttribute('formmethod')
        ? (submit.formMethod ?? '')
        : String(formRead(form, 'method') ?? '')
      ).toLowerCase();

  if (!ambiguous) {
    if (username) mark(username, 'username');
    if (password) mark(password, 'password');
    if (code) mark(code, 'code');
    for (const [index, box] of boxes.entries()) mark(box, `code${index}`);
    if (submit) mark(submit, 'submit');
  }
  return {
    username: Boolean(username) && !ambiguous,
    password: Boolean(password) && !ambiguous,
    code: ambiguous ? 'none' : boxes.length ? 'boxes' : code ? 'single' : 'none',
    boxes: boxes.length,
    submit: Boolean(submit) && !ambiguous,
    ambiguous,
    action,
    method,
  };
}

/**
 * Holds back the browser's own sending of the sign-in form the step marked when that would put
 * what it holds in the page's address (a GET) or send it to another origin, unless the page's
 * script already took the submit over, as a single-page site's does. It listens last, on the
 * window, so it sees whether the page's own handlers prevented the submit. Runs in the page;
 * `signInSubmitHeld` reads what it held back and takes it off.
 */
export function guardSignInSubmit(nonce: string): void {
  type Submit = {
    target: unknown;
    submitter: Element | null;
    defaultPrevented: boolean;
    preventDefault(): void;
  };
  const win = globalThis as unknown as Record<string, unknown> & {
    location: { href: string; origin: string };
    addEventListener(type: string, listener: (event: Submit) => void): void;
    removeEventListener(type: string, listener: (event: Submit) => void): void;
  };
  const key = `__meleteSignIn_${nonce}`;
  // A form's own fields shadow its properties, so each is read through the prototype's getter.
  const page = globalThis as unknown as { HTMLFormElement: { prototype: object } };
  const formRead = (form: Form, name: string): unknown =>
    Object.getOwnPropertyDescriptor(page.HTMLFormElement.prototype, name)?.get?.call(form);
  const formElements = (form: Form) =>
    Array.from((formRead(form, 'elements') ?? []) as ArrayLike<Element>);
  const listener = (event: Submit) => {
    if (event.defaultPrevented) return;
    const form = event.target;
    let held: 'elsewhere' | 'address' | '' = '';
    try {
      if (!(form instanceof (page.HTMLFormElement as unknown as new () => Form))) return;
      const marked = formElements(form).some((element) =>
        (element.getAttribute('data-melete-sign-in') ?? '').startsWith(`${nonce}:`),
      );
      if (!marked) return;
      const submitter = event.submitter;
      const method = (
        submitter?.getAttribute('formmethod')
          ? (submitter.formMethod ?? '')
          : String(formRead(form, 'method') ?? '')
      ).toLowerCase();
      const action = submitter?.getAttribute('formaction')
        ? (submitter.formAction ?? '')
        : String(formRead(form, 'action') ?? '');
      let elsewhere = true;
      try {
        const url = new URL(action, win.location.href);
        elsewhere = /^https?:$/.test(url.protocol) && url.origin !== win.location.origin;
      } catch {}
      if (method !== 'get' && !elsewhere) return;
      held = elsewhere ? 'elsewhere' : 'address';
    } catch {
      // A form this cannot read is held back: the guard never lets through what it could not check.
      held = 'elsewhere';
    }
    event.preventDefault();
    win[key] = held;
  };
  win.addEventListener('submit', listener);
  win[`${key}_off`] = () => win.removeEventListener('submit', listener);
}

/** What `guardSignInSubmit` held back: `address`, `elsewhere`, or nothing. Runs in the page. */
export function signInSubmitHeld(nonce: string): string {
  const win = globalThis as unknown as Record<string, unknown>;
  const key = `__meleteSignIn_${nonce}`;
  const held = win[key];
  const off = win[`${key}_off`];
  if (typeof off === 'function') off();
  delete win[key];
  delete win[`${key}_off`];
  return typeof held === 'string' ? held : '';
}

/** Takes off every mark a step left. Runs in the page. */
export function unmarkSignInFields(): void {
  const doc = (
    globalThis as unknown as {
      document: { querySelectorAll(selector: string): ArrayLike<Element> };
    }
  ).document;
  for (const element of Array.from(doc.querySelectorAll('[data-melete-sign-in]')))
    element.removeAttribute('data-melete-sign-in');
}

/**
 * How much the page says, roughly: the length of its visible text and its
 * number of elements. Never any of the text itself. Runs in the page.
 */
export function pageMeasure(): string {
  const doc = (
    globalThis as unknown as {
      document: {
        body: { innerText: string } | null;
        getElementsByTagName(name: string): { length: number };
      };
    }
  ).document;
  return `${doc.body?.innerText.length ?? 0}:${doc.getElementsByTagName('*').length}`;
}

/**
 * What the page shows now, for telling a sign-in that worked from one that did
 * not: a password field, whether the one that was filled still holds something,
 * a code field, a username field. Runs in the page.
 */
export function signInState(nonce: string): SignInState {
  const doc = (
    globalThis as unknown as {
      document: {
        querySelectorAll(selector: string): ArrayLike<Element>;
        querySelector(selector: string): Element | null;
      };
    }
  ).document;
  const style = (element: Element) =>
    (
      globalThis as unknown as {
        getComputedStyle(element: Element): { visibility: string; display: string };
      }
    ).getComputedStyle(element);
  const shown = (element: Element) =>
    element.getClientRects().length > 0 &&
    style(element).visibility !== 'hidden' &&
    style(element).display !== 'none';
  const inputs = Array.from(doc.querySelectorAll('input')).filter(shown);
  const words = (element: Element) =>
    `${element.name} ${element.id} ${element.getAttribute('aria-label') ?? ''} ${element.placeholder ?? ''} ${Array.from(
      element.labels ?? [],
    )
      .map((label) => label.textContent ?? '')
      .join(' ')}`.toLowerCase();
  const filledPassword = doc.querySelector(`[data-melete-sign-in="${nonce}:password"]`);
  return {
    password: inputs.some((element) => element.type === 'password'),
    filled: Boolean(filledPassword && shown(filledPassword) && filledPassword.value !== ''),
    code:
      inputs.some(
        (element) =>
          /one-time-code/i.test(element.autocomplete) ||
          /(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verification.?code|security.?code|auth(entication)?.?code|passcode|two.?factor)([^a-z]|$)/.test(
            words(element),
          ),
      ) || inputs.filter((element) => element.getAttribute('maxlength') === '1').length >= 6,
    username: inputs.some(
      (element) => /username|email/i.test(element.autocomplete) || element.type === 'email',
    ),
  };
}
