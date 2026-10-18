/**
 * The moment the agent's own browser or computer is about to pay.
 *
 * The agent's own computer may do anything a person could do at it, with no
 * question asked, except pay: entering a card, or pressing the button that
 * buys, is a money move like any other (`money.ts`) and needs the person's own
 * step-up, bound to that one action (`step-up.ts`). It is told apart here, by
 * a fixed rule over what the step does and what the screen showed before it,
 * never by a model and never from a picture:
 *
 * - typing a card number: 13 to 19 digits from a card network (2 to 6 first)
 *   that pass the Luhn check, typed at once or in pieces, into one field or
 *   split across fields of 4 to 6 digits one after another;
 * - typing into a field whose accessible name says card number, CVC, CVV,
 *   CSC or security code, or into a card frame a payment provider draws;
 * - typing a card's expiry (`MM/YY`) and its code (3 or 4 digits) one right
 *   after the other;
 * - pressing Return, or clicking anything but a field, on a page where card
 *   details were entered since it was opened;
 * - clicking a button or link whose accessible name is a clear pay or buy
 *   phrase ("Pay now", "Place order", "Buy now") on a page that shows a price,
 *   which is how a checkout with a saved card is paid.
 *
 * Typed text is buffered per field: what each field holds is followed across
 * steps and the steps of a batch, so a number typed a few digits at a time is
 * read whole. The screen is the accessibility text each step's receipt keeps
 * (`connectors/screen-text.ts`), the latest before the step.
 *
 * What it cannot see is said plainly, not guessed: a desktop app with no
 * accessibility text (text read off the screen's picture is not used; only a
 * card number typed is still caught there), a field inside a frame from another site (most card
 * forms draw their fields so; the digits still count, the label does not), a
 * page whose text is cut off before the field, text pasted from the clipboard
 * into a field not named as a card's, and a button whose name says nothing
 * about paying. Commands run in the computer's terminal are not read here.
 */
import type { JsonObject, JsonValue } from '@melete/contracts';

/** One element of the screen, as a receipt's screen text writes it. */
export type ScreenElement = {
  ref: string;
  role: string;
  name: string;
  states: string[];
  box: [number, number, number, number];
};

/** The screen after a step, as far as this rule reads it. */
export type Screen = { url: string | null; elements: ScreenElement[] };

/** One step on the computer: the tool and its arguments, and the screen after it when it ran. */
export type ComputerStep = { kind: string; payload: JsonObject; after: Screen | null };

/** Why a step pays, where, and for how much when the page says. */
export type PayMoment = { reason: string; site: string | null; amount: string | null };

const LINE =
  /^([nt]\d{1,15}) ([A-Za-z][\w-]{0,47})(?: ("(?:[^"\\]|\\.)*"))?(?: value=("(?:[^"\\]|\\.)*"))?(?: \[([^\]]*)\])? box=(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/;

const unquote = (quoted: string | undefined): string => {
  if (!quoted) return '';
  try {
    return String(JSON.parse(quoted));
  } catch {
    return '';
  }
};

/** A receipt's screen text read back into elements, or null when it has none. */
export function screenOf(value: JsonValue | undefined): Screen | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = value as JsonObject;
  if (typeof text.lines !== 'string') return null;
  const url = typeof text.url === 'string' ? text.url : null;
  // Only the page's own accessibility data counts; text read off a picture never does.
  if (text.source !== 'accessibility') return { url, elements: [] };
  const elements: ScreenElement[] = [];
  for (const line of text.lines.split('\n')) {
    const found = LINE.exec(line);
    if (!found) continue;
    elements.push({
      ref: found[1] as string,
      role: (found[2] as string).toLowerCase(),
      name: unquote(found[3]),
      states: (found[5] ?? '').split(' ').filter(Boolean),
      box: [Number(found[6]), Number(found[7]), Number(found[8]), Number(found[9])],
    });
  }
  return { url, elements };
}

/* ---------- what is typed ---------- */

/** Whether digits are a card's number: 13 to 19, a network's first digit, and the Luhn check. */
export function cardDigits(digits: string): boolean {
  if (!/^[2-6]\d{12,18}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Whether text holds a card's number: digits written as one run, or in groups
 * split by single spaces or dashes, where whole groups one after another make
 * a card's number. A run longer than a card's is read from its start too,
 * since a field that takes 16 digits keeps the first 16. A number is never
 * read from the middle of a longer run, so a long reference or tracking
 * number is not taken for a card.
 */
export function holdsCardNumber(text: string): boolean {
  for (const run of text.normalize('NFKC').match(/\d+(?:[ -]\d+)*/g) ?? []) {
    const groups = run.split(/[ -]/);
    for (let start = 0; start < groups.length; start++) {
      let digits = '';
      for (let end = start; end < groups.length; end++) {
        digits += groups[end];
        if (digits.length > 19) break;
        if (digits.length >= 13 && cardDigits(digits)) return true;
      }
    }
    const only = groups[0] as string;
    if (groups.length === 1 && only.length > 19)
      for (let length = 13; length <= 19; length++)
        if (cardDigits(only.slice(0, length))) return true;
  }
  return false;
}

const EXPIRY = /^(?:0[1-9]|1[0-2]) ?\/ ?(?:\d{2}|20\d{2})$/;
const CODE = /^\d{3,4}$/;

/* ---------- what is on the screen ---------- */

/** A field a card's number or code goes in, by its accessible name. */
const CARD_FIELD =
  /\b(?:card ?number|card no\b|number on (?:the |your )?card|credit card(?: number)?|debit card(?: number)?|cc ?(?:number|num)|cvc2?|cvv2?|csc|security code|card verification|card code)\b/i;
/** A frame a payment provider draws a card's fields in, by the title it gives it. */
const CARD_FRAME =
  /\b(?:card|payment) (?:number |input |details )?(?:frame|field|input)|secure (?:card|payment)/i;
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'iframe']);

export const cardField = (element: ScreenElement | null): boolean =>
  !!element &&
  ((FIELD_ROLES.has(element.role) && CARD_FIELD.test(element.name)) ||
    (element.role === 'iframe' && CARD_FRAME.test(element.name)));

/** A button's name that clearly pays or buys, read whole: "Pay now", "Pay $24.99", "Place order". */
const PAYS =
  /^(?:pay(?: now| securely| (?:with|by) (?:card|[a-z ]+pay)|\s*[$€£¥₹]\s*[\d.,]+| [\d.,]+\s*(?:usd|eur|gbp))?|buy(?: now| it now)?|purchase(?: now)?|complete (?:my |your |the )?(?:order|purchase|payment)|place (?:my |your |the )?order|submit (?:my |your |the )?(?:order|payment)|confirm (?:and pay|(?:my |your |the )?(?:order|purchase|payment))|order now|donate(?: now)?|subscribe(?: now)?|start (?:my |your )?(?:paid )?(?:subscription|membership))(?:\s*[-–·:]?\s*(?:[$€£¥₹]\s*[\d.,]+|[\d.,]+\s*(?:usd|eur|gbp)))?$/i;
const BUTTON_ROLES = new Set(['button', 'link', 'menuitem']);

/** An amount of money as a page writes it: `$24.99`, `€ 1.249,00`, `24.99 USD`. */
const PRICE =
  /(?:[$€£¥₹]\s?\d[\d,.]*\d|\b\d[\d,.]*\d?\s?(?:USD|EUR|GBP|CAD|AUD|JPY|INR)\b|\b(?:USD|EUR|GBP|CAD|AUD|JPY|INR)\s?\d[\d,.]*\d?)/;

/** The amount the page says it charges, when it says one plainly; null rather than a guess. */
function amountOn(screen: Screen | null, button: ScreenElement | null): string | null {
  const own = button?.name.match(PRICE)?.[0];
  if (own) return own.trim();
  const totals = (screen?.elements ?? [])
    .filter((element) => /\b(?:total|amount due|you pay|to pay|order total)\b/i.test(element.name))
    .flatMap((element) => element.name.match(PRICE)?.[0] ?? []);
  const distinct = [...new Set(totals.map((each) => each.trim()))];
  if (distinct.length === 1) return distinct[0] as string;
  const all = [
    ...new Set((screen?.elements ?? []).flatMap((element) => element.name.match(PRICE)?.[0] ?? [])),
  ];
  return all.length === 1 ? (all[0] as string).trim() : null;
}

const priced = (screen: Screen | null) =>
  (screen?.elements ?? []).some((element) => PRICE.test(element.name));

/** The element a click at a point lands on: the smallest that holds it, controls first. */
function elementAt(screen: Screen | null, x: number, y: number): ScreenElement | null {
  const under = (screen?.elements ?? []).filter(({ box: [left, top, width, height] }) => {
    return width > 0 && height > 0 && x >= left && x < left + width && y >= top && y < top + height;
  });
  const area = (element: ScreenElement) => element.box[2] * element.box[3];
  const controls = under.filter(
    (element) => BUTTON_ROLES.has(element.role) || FIELD_ROLES.has(element.role),
  );
  const pool = controls.length ? controls : under;
  return pool.sort((a, b) => area(a) - area(b))[0] ?? null;
}

const focusedOn = (screen: Screen | null): ScreenElement | null =>
  screen?.elements.find((element) => element.states.includes('focused')) ?? null;

/** Where a page is, for the person: its host. */
function siteOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

const pageOf = (url: string | null) => {
  try {
    const parsed = url ? new URL(url) : null;
    return parsed ? `${parsed.origin}${parsed.pathname}` : null;
  } catch {
    return null;
  }
};

/* ---------- following the steps ---------- */

type Command =
  | { kind: 'open'; url: string }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string[] }
  | { kind: 'other' };

/** The commands a step runs, in order: one, or each step of a batch. */
function commandsOf(step: Pick<ComputerStep, 'kind' | 'payload'>): Command[] {
  const one = (kind: string, payload: JsonObject): Command => {
    if (kind === 'computer.open' && typeof payload.url === 'string')
      return { kind: 'open', url: payload.url };
    if (kind === 'computer.click' && typeof payload.x === 'number' && typeof payload.y === 'number')
      return { kind: 'click', x: payload.x, y: payload.y };
    if (kind === 'computer.type' && typeof payload.text === 'string')
      return { kind: 'type', text: payload.text };
    if (kind === 'computer.key' && Array.isArray(payload.keys))
      return {
        kind: 'key',
        keys: payload.keys.filter((key) => typeof key === 'string') as string[],
      };
    return { kind: 'other' };
  };
  if (step.kind !== 'computer.batch') return [one(step.kind, step.payload)];
  return (Array.isArray(step.payload.actions) ? step.payload.actions : []).map((each) =>
    each && typeof each === 'object' && !Array.isArray(each)
      ? one(`computer.${String((each as JsonObject).action)}`, each as JsonObject)
      : { kind: 'other' },
  );
}

/** Keys that move focus out of a field, and the ones that send a form. */
const LEAVES = /^(?:tab|iso_left_tab|shift\+tab|escape|up|down|ctrl\+l|alt\+d|f6)$/i;
const SENDS = /^(?:return|enter|kp_enter)$/i;
const PASTES = /^(?:ctrl\+v|ctrl\+shift\+v|shift\+insert|super\+v)$/i;
/** A key that types one character, by its name. */
const TYPED_KEY: Record<string, string> = { space: ' ', minus: '-', slash: '/', kp_divide: '/' };
const typedBy = (key: string): string | null => {
  if (/^[0-9]$/.test(key)) return key;
  const kp = /^kp_([0-9])$/i.exec(key);
  if (kp) return kp[1] as string;
  return TYPED_KEY[key.toLowerCase()] ?? null;
};

type State = {
  screen: Screen | null;
  page: string | null;
  /** The field being typed in: an element's reference, or one reached by a key whose name is not known yet. */
  field: { key: string; element: ScreenElement | null } | null;
  /** What each field on this page holds, as typed. */
  held: Map<string, string>;
  /** What was typed on this page, in order, one entry per field typed into in a row. */
  typed: Array<{ text: string; key: string }>;
  /** Card details were entered on this page. */
  card: boolean;
};

const fresh = (screen: Screen | null): State => ({
  screen,
  page: pageOf(screen?.url ?? null),
  field: focusedOn(screen)
    ? { key: (focusedOn(screen) as ScreenElement).ref, element: focusedOn(screen) }
    : null,
  held: new Map(),
  typed: [],
  card: false,
});

/** Whether the pieces typed on the page, read in order, carry a card's number or its expiry and code. */
function piecesPay(typed: State['typed']): boolean {
  const pieces = typed.map((piece) => piece.text.trim()).filter(Boolean);
  // A number split across short fields one after another: 4111 · 1111 · 1111 · 1111.
  for (let start = 0; start < pieces.length; start++) {
    let digits = '';
    for (let end = start; end < pieces.length; end++) {
      const piece = (pieces[end] as string).replace(/[ -]/g, '');
      if (!/^\d{4,6}$/.test(piece)) break;
      digits += piece;
      if (digits.length >= 13 && cardDigits(digits)) return true;
      if (digits.length > 19) break;
    }
  }
  // A card's expiry and its code, one right after the other.
  for (let i = 1; i < pieces.length; i++) {
    const [a, b] = [pieces[i - 1] as string, pieces[i] as string];
    if ((EXPIRY.test(a) && CODE.test(b)) || (CODE.test(a) && EXPIRY.test(b))) return true;
  }
  return false;
}

/**
 * Follow one step from the state before it. Returns why it pays, if it does,
 * and leaves the state as it is after the step (but for the screen, which the
 * caller sets from the step's receipt).
 */
function follow(state: State, step: Pick<ComputerStep, 'kind' | 'payload'>): string | null {
  let pays: string | null = null;
  const said = (reason: string) => {
    pays ??= reason;
  };
  let unnamed = 0;
  for (const command of commandsOf(step)) {
    if (command.kind === 'open') {
      Object.assign(state, fresh(null), { page: pageOf(command.url) });
      continue;
    }
    if (command.kind === 'click') {
      const target = elementAt(state.screen, command.x, command.y);
      // Once card details are on the page, any click but one into a field may
      // send them: a form's button need not be named, or even be a button.
      if (state.card && !(target && FIELD_ROLES.has(target.role)))
        said('It clicks on a page where card details were entered.');
      else if (
        target &&
        BUTTON_ROLES.has(target.role) &&
        PAYS.test(target.name.trim()) &&
        priced(state.screen)
      )
        said(`It presses “${target.name.trim()}” on a page with a price.`);
      state.field = target ? { key: target.ref, element: target } : null;
      continue;
    }
    if (command.kind === 'type') {
      typeInto(state, command.text, said);
      continue;
    }
    if (command.kind === 'key') {
      for (const key of command.keys) {
        const char = typedBy(key);
        if (char !== null) {
          typeInto(state, char, said);
          continue;
        }
        if (/^backspace$/i.test(key) && state.field) {
          const now = state.held.get(state.field.key) ?? '';
          state.held.set(state.field.key, now.slice(0, -1));
          continue;
        }
        if (PASTES.test(key) && cardField(state.field?.element ?? null))
          said('It pastes into a card’s field.');
        if (SENDS.test(key) && state.card) said('It sends a form where card details were entered.');
        if (LEAVES.test(key) || SENDS.test(key))
          // The next field is not known until the screen is read again.
          state.field = { key: `next:${state.field?.key ?? 'none'}:${++unnamed}`, element: null };
      }
    }
  }
  return pays;
}

function typeInto(state: State, text: string, said: (reason: string) => void): void {
  const field = state.field ?? { key: 'none', element: null };
  state.field = field;
  const holds = (state.held.get(field.key) ?? '') + text;
  state.held.set(field.key, holds);
  // Typing on in the same field, at once or a key at a time, adds to its piece.
  const last = state.typed.at(-1);
  if (last && last.key === field.key) last.text += text;
  else state.typed.push({ text, key: field.key });
  if (cardField(field.element)) said('It types into a card’s field.');
  else if (holdsCardNumber(holds) || holdsCardNumber(text)) said('It types a card number.');
  else if (piecesPay(state.typed)) said('It types card details.');
}

/**
 * Whether this step pays, from the steps before it on the same computer in
 * this work, oldest first, each with the screen after it. Pure, so every
 * boundary is pinned by a test.
 */
export function payMoment(
  before: readonly ComputerStep[],
  step: Pick<ComputerStep, 'kind' | 'payload'>,
): PayMoment | null {
  let state = fresh(null);
  for (const earlier of before) {
    if (follow(state, earlier)) state.card = true;
    const after = earlier.after;
    if (after) {
      // Another page: what was typed on the one before stays there.
      if (pageOf(after.url) !== state.page && after.url) state = fresh(after);
      else {
        state.screen = after;
        // The screen says which field has focus now; what a key moved to takes its name.
        const focused = focusedOn(after);
        if (focused && state.field && state.field.key !== focused.ref) {
          const carried = state.field.key.startsWith('next:')
            ? (state.held.get(state.field.key) ?? '')
            : '';
          if (carried) {
            state.held.set(focused.ref, (state.held.get(focused.ref) ?? '') + carried);
            for (const piece of state.typed)
              if (piece.key === state.field.key) piece.key = focused.ref;
          }
          state.field = { key: focused.ref, element: focused };
        } else if (focused && !state.field) state.field = { key: focused.ref, element: focused };
        else if (focused && state.field) state.field.element = focused;
      }
    }
  }
  const screen = state.screen;
  const reason = follow(state, step);
  if (!reason) return null;
  const target =
    step.kind === 'computer.click' &&
    typeof step.payload.x === 'number' &&
    typeof step.payload.y === 'number'
      ? elementAt(screen, step.payload.x, step.payload.y)
      : null;
  return { reason, site: siteOf(screen?.url ?? state.page), amount: amountOn(screen, target) };
}

/* ---------- the browser worker ---------- */

/**
 * Whether a step in the browser worker pays: a fill whose value is a card's
 * number, or a click on a control whose name clearly pays. A field named as a
 * card's is already handed to the person by the worker itself, who types it.
 */
export function browserPays(kind: string, payload: JsonObject): string | null {
  if (
    kind === 'browser.fill' &&
    typeof payload.value === 'string' &&
    holdsCardNumber(payload.value)
  )
    return 'It types a card number.';
  if (
    kind === 'browser.click' &&
    typeof payload.name === 'string' &&
    BUTTON_ROLES.has(String(payload.role ?? '').toLowerCase()) &&
    PAYS.test(payload.name.trim())
  )
    return `It presses “${payload.name.trim()}”.`;
  return null;
}

export { siteOf };
