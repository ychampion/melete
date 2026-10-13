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
  | 'captcha';

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
};

/** What the page shows after a sign-in step was sent. */
export type SignInState = {
  password: boolean;
  /** The password field the worker filled still holds something. */
  filled: boolean;
  code: boolean;
  username: boolean;
};

type Element = {
  tagName: string;
  type: string;
  name: string;
  id: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  autocomplete: string;
  placeholder: string;
  form: { elements: ArrayLike<Element> } | null;
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
  const doc = (
    globalThis as unknown as {
      document: { querySelectorAll(selector: string): ArrayLike<Element> };
      getComputedStyle(element: Element): { visibility: string; display: string };
    }
  ).document;
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
  const inForm = (element: Element) =>
    !scope || Array.from(scope.elements).includes(element as never);
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
  // With a password field, the field just before it is its username; without
  // one, only a field that says it is one (a first step that asks for the
  // username alone), never any text box on the page.
  const username = password ? (hinted.at(-1) ?? candidates.at(-1)) : hinted[0];

  const filled = [username, password, code, ...boxes].filter(Boolean) as Element[];
  const form = filled.find((element) => element.form)?.form ?? null;
  const submit = form
    ? Array.from(form.elements).find(
        (element) =>
          ['BUTTON', 'INPUT'].includes(element.tagName) &&
          ((element.tagName === 'BUTTON' && !element.hasAttribute('type')) ||
            ['submit', 'image'].includes((element.getAttribute('type') ?? '').toLowerCase())) &&
          element.getClientRects().length > 0 &&
          !element.disabled,
      )
    : undefined;

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
  };
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
