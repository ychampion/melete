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
 * - typing a card number: 13 to 19 digits with a card network's prefix and
 *   length that pass the Luhn check, typed at once or in pieces, in any
 *   script's digits and any grouping, into one field or split across fields
 *   one after another; a Luhn-valid number from no network counts only with an
 *   expiry or a code typed right after it;
 * - typing into a field whose accessible name says card number, CVC, CVV,
 *   CSC or security code, or into a card frame a payment provider draws;
 * - typing a card's expiry (`MM/YY`) and its code (3 or 4 digits) one right
 *   after the other;
 * - pasting into a card's field, or into an unnamed one on a page that shows a
 *   card's field;
 * - clicking or pressing Return after clicking into a card's field, which may
 *   pick a saved card the browser offers;
 * - pressing Return, or clicking anything but a field, on a page where card
 *   details were entered since it was opened;
 * - clicking a button or link whose accessible name is a clear pay or buy
 *   phrase ("Pay now", "Place order", "Buy now") on a page that shows a price,
 *   which is how a checkout with a saved card is paid;
 * - a command or code run in the computer that carries a card's number
 *   (`shellPays`).
 *
 * Typed text is buffered per field, in memory, for one reading: what each
 * field holds is followed across steps and the steps of a batch, so a number
 * typed a few digits at a time is read whole. The screen is the accessibility
 * text each step's receipt keeps (`connectors/screen-text.ts`), the latest
 * before the step; every step on the page is read back (`stepsOnPage`).
 *
 * What it cannot see is said plainly, not guessed: a desktop app with no
 * accessibility text (text read off the screen's picture is not used; only a
 * card number typed is still caught there), a field inside a frame from another site (most card
 * forms draw their fields so; the digits still count, the label does not), a
 * page whose text is cut off before the field, text pasted into a named field
 * that is not a card's, and a button whose name says nothing about paying on a
 * page where no card was entered.
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

/**
 * Whether a step enters a card (typing, pasting or picking one) or sends what
 * was entered (a click or Return after it, or a pay button on a priced page).
 */
export type PayKind = 'entry' | 'submit';
type Found = { reason: string; kind: PayKind };

/**
 * Why a step pays, which kind of step it is, where, and the amount the page
 * shows. The amount is page text, shown to the person as what the page says;
 * it never decides anything.
 */
export type PayMoment = {
  reason: string;
  kind: PayKind;
  site: string | null;
  /** The page's origin (scheme, host and port), which a step-up for entering a card covers. */
  origin: string | null;
  amount: string | null;
};

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

/** Where each run of decimal digits outside ASCII starts, by any of its code points. */
const digitZero = new Map<number, number>();
const DECIMAL = /\p{Nd}/u;

/**
 * Text with every decimal digit written as an ASCII one: full-width digits,
 * Arabic-Indic, Devanagari and every other script's. A card field that takes
 * them reads them as the digits they are, so they count the same.
 */
export function asciiDigits(text: string): string {
  return text.normalize('NFKC').replace(/\p{Nd}/gu, (char) => {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x80) return char;
    let zero = digitZero.get(point);
    if (zero === undefined) {
      // Unicode keeps each script's digits 0 to 9 together, in runs of ten.
      let start = point;
      while (DECIMAL.test(String.fromCodePoint(start - 1))) start--;
      zero = point - ((point - start) % 10);
      digitZero.set(point, zero);
    }
    return String(point - zero);
  });
}

/** The Luhn check. */
function luhn(digits: string): boolean {
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
 * A card network's own number: its issuer prefix and one of its lengths.
 * Visa, Mastercard (51-55 and 2221-2720), American Express, Diners Club,
 * Discover, JCB, UnionPay, Maestro and Mir.
 */
const NETWORKS: Array<[RegExp, number, number]> = [
  // Visa's 13-digit numbers are long retired, and a European barcode is 13
  // digits from 40 to 44; a 13-digit Visa still counts where something else
  // says it is a card (`cardDigits`).
  [/^4/, 16, 19],
  [/^5[1-5]/, 16, 16],
  [/^2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)/, 16, 16],
  [/^3[47]/, 15, 15],
  // Diners Club: 14, or 16 to 19 on Discover's network; never 15, an IMEI's length.
  [/^3(?:0[0-5]|[689])/, 14, 14],
  [/^3(?:0[0-5]|[689])/, 16, 19],
  [/^6(?:011|5|4[4-9]|22(?:12[6-9]|1[3-9]\d|[2-8]\d\d|9[01]\d|92[0-5]))/, 16, 19],
  [/^35(?:2[89]|[3-8]\d)/, 16, 19],
  [/^62/, 16, 19],
  [/^(?:5018|5020|5038|5893|6304|6759|676[1-3])/, 13, 19],
  [/^220[0-4]/, 16, 19],
];
const networkNumber = (digits: string) =>
  NETWORKS.some(
    ([prefix, shortest, longest]) =>
      digits.length >= shortest && digits.length <= longest && prefix.test(digits),
  ) &&
  (!/^4/.test(digits) || [16, 19].includes(digits.length));

/**
 * Whether digits could be a card's number at all: 13 to 19, a network's first
 * digit (2 to 6), and the Luhn check. A number with no more than this is a
 * card only where something else says so (a card's field, or an expiry and
 * code typed after it): about one in twenty long numbers passes.
 */
export function cardDigits(digits: string): boolean {
  return /^[2-6]\d{12,18}$/.test(digits) && luhn(digits);
}

/**
 * Whether digits are a card's number on their own: they pass `cardDigits` and
 * carry a card network's prefix at one of its lengths. An IMEI, a European
 * barcode or a 20-digit tracking number passes Luhn by design or by chance,
 * but not this.
 */
export function cardNumber(digits: string): boolean {
  return cardDigits(digits) && networkNumber(digits);
}

/** What may stand between the groups of a card's number: spaces, dashes, dots, slashes. */
const GROUPED = /\d+(?:[\s\-./_,·•]{1,3}\d+)*/g;
const BETWEEN = /[\s\-./_,·•]{1,3}/;

/**
 * Whether text holds a number `is` accepts: digits written as one run, or in
 * groups split by up to three spaces, dashes, dots or slashes, where whole
 * groups one after another make the number. A run longer than a card's is read
 * from its start too, since a field that takes 16 digits keeps the first 16.
 * A number is never read from the middle of a longer run, so a long reference
 * or tracking number is not taken for a card.
 */
function holds(text: string, is: (digits: string) => boolean): boolean {
  return found(text, is) !== null;
}

/** The first number in text that `is` accepts, read as `holds` reads it, or null. */
function found(text: string, is: (digits: string) => boolean): string | null {
  if (iban(text)) return null;
  for (const run of asciiDigits(text).match(GROUPED) ?? []) {
    const groups = run.split(BETWEEN);
    for (let start = 0; start < groups.length; start++) {
      let digits = '';
      for (let end = start; end < groups.length; end++) {
        digits += groups[end];
        if (digits.length > 19) break;
        if (digits.length >= 13 && is(digits)) return digits;
      }
    }
    const only = groups[0] as string;
    if (groups.length === 1 && only.length > 19)
      for (let length = 13; length <= 19; length++)
        if (is(only.slice(0, length))) return only.slice(0, length);
  }
  return null;
}

/**
 * Whether text is, whole, a bank account's IBAN with a valid check (mod 97):
 * its digits are not a card's, and a card field would not take its letters.
 */
function iban(text: string): boolean {
  const compact = asciiDigits(text).replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rest = 0;
  for (const char of moved) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** A run of digits in any script, in groups split as `GROUPED` allows. */
const ANY_GROUPED = /\p{Nd}+(?:[\s\-./_,·•]{1,3}\p{Nd}+)*/gu;

/**
 * Text with each run of digits that holds a card's number replaced, the run
 * whole (with what was typed around the number in it, an expiry or a code):
 * `is` says which numbers count (`cardDigits` hides more than `cardNumber`),
 * and `by` is given the card's own number to write something in its place.
 */
export function replaceCardNumbers(
  text: string,
  is: (digits: string) => boolean,
  by: (digits: string) => string,
): string {
  return text.replace(ANY_GROUPED, (run) => {
    const card = found(run, is);
    return card === null ? run : by(card);
  });
}

/** Whether text holds a card's number on its own (`cardNumber`). */
export const holdsCardNumber = (text: string) => holds(text, cardNumber);
/** Whether text holds a number that is a card's where something else says so (`cardDigits`). */
const holdsCardDigits = (text: string) => holds(text, cardDigits);

const EXPIRY = /^(?:0[1-9]|1[0-2]) ?[/\-.] ?(?:\d{2}|20\d{2})$/;
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

/** A page's origin: its scheme, host and port. */
export function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
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
  // A digit key in any script: 7, ７, ٧ or ७ types the digit it is.
  if (/^\p{Nd}$/u.test(key)) return asciiDigits(key);
  const kp = /^(?:kp_|arabic_|farsi_)([0-9])$/i.exec(key);
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
  /**
   * The agent itself clicked into a card's field on this page: what it picks
   * next (a saved card the browser offers) or presses may pay with no typing.
   */
  cardFocus: boolean;
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
  cardFocus: false,
});

/** Whether a page shows a card's field or a payment provider's card frame anywhere. */
const showsCardFields = (screen: Screen | null) =>
  (screen?.elements ?? []).some((element) => cardField(element));

/**
 * Whether the pieces typed on the page, read in order, carry a card's number
 * or its expiry and code. Each piece is what went into one field in a row.
 */
function piecesPay(typed: State['typed']): boolean {
  const pieces = typed.map((piece) => asciiDigits(piece.text).trim()).filter(Boolean);
  // A number split across fields one after another, however short each is:
  // 4111 · 1111 · 1111 · 1111, or a digit to a field.
  for (let start = 0; start < pieces.length; start++) {
    let digits = '';
    for (let end = start; end < pieces.length; end++) {
      const piece = (pieces[end] as string).replace(/[\s\-./]/g, '');
      if (!/^\d{1,6}$/.test(piece)) break;
      digits += piece;
      if (digits.length >= 13 && cardNumber(digits)) return true;
      if (digits.length > 19) break;
    }
  }
  for (let i = 1; i < pieces.length; i++) {
    const [a, b] = [pieces[i - 1] as string, pieces[i] as string];
    // A card's expiry and its code, one right after the other.
    if ((EXPIRY.test(a) && CODE.test(b)) || (CODE.test(a) && EXPIRY.test(b))) return true;
    // A number that could be a card's, with an expiry or a code right after it.
    if (holdsCardDigits(a) && (EXPIRY.test(b) || CODE.test(b))) return true;
  }
  return false;
}

/**
 * Follow one step from the state before it. Returns why it pays, if it does,
 * and leaves the state as it is after the step (but for the screen, which the
 * caller sets from the step's receipt).
 */
function follow(state: State, step: Pick<ComputerStep, 'kind' | 'payload'>): Found | null {
  let pays: Found | null = null;
  const said = (reason: string, kind: PayKind = 'entry') => {
    pays ??= { reason, kind };
  };
  let unnamed = 0;
  for (const command of commandsOf(step)) {
    if (command.kind === 'open') {
      Object.assign(state, fresh(null), { page: pageOf(command.url) });
      continue;
    }
    if (command.kind === 'click') {
      const target = elementAt(state.screen, command.x, command.y);
      const intoField = Boolean(target && FIELD_ROLES.has(target.role));
      // Once card details are on the page, any click but one into a field may
      // send them: a form's button need not be named, or even be a button.
      if (state.card && !intoField)
        said('It clicks on a page where card details were entered.', 'submit');
      // After clicking into a card's field, a click elsewhere may pick a saved
      // card the browser offers, or pay with it.
      else if (state.cardFocus && !intoField)
        said('It clicks after going into a card’s field, which may pick a saved card or pay.');
      else if (
        target &&
        BUTTON_ROLES.has(target.role) &&
        PAYS.test(target.name.trim()) &&
        priced(state.screen)
      )
        said(`It presses “${target.name.trim()}” on a page with a price.`, 'submit');
      if (target && cardField(target)) state.cardFocus = true;
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
        if (PASTES.test(key)) {
          const into = state.field?.element ?? null;
          if (cardField(into)) said('It pastes into a card’s field.');
          // What is pasted is not known here: into a field with no name of its
          // own, or one not yet read, on a page with a card's fields, it may be one.
          else if (!into?.name.trim() && showsCardFields(state.screen))
            said('It pastes on a page with a card’s fields.');
        }
        if (SENDS.test(key) && state.card)
          said('It sends a form where card details were entered.', 'submit');
        else if (SENDS.test(key) && state.cardFocus)
          said('It presses Return after going into a card’s field.', 'submit');
        if (LEAVES.test(key) || SENDS.test(key))
          // The next field is not known until the screen is read again.
          state.field = { key: `next:${state.field?.key ?? 'none'}:${++unnamed}`, element: null };
      }
    }
  }
  return pays;
}

function typeInto(state: State, text: string, said: (reason: string) => void): void {
  text = asciiDigits(text);
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
    const unseen = state.screen === null;
    if (follow(state, earlier)) state.card = true;
    const after = earlier.after;
    if (after) {
      // A click that left a card's field focused went into it, though the
      // screen before it was not known.
      const clickedIn =
        cardField(focusedOn(after)) && commandsOf(earlier).some((each) => each.kind === 'click');
      // Another page: what was typed on the one before stays there.
      if (pageOf(after.url) !== state.page && after.url) {
        state = fresh(after);
        if (clickedIn && unseen) state.cardFocus = true;
      } else {
        if (clickedIn) state.cardFocus = true;
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
  const found = follow(state, step);
  if (!found) return null;
  const target =
    step.kind === 'computer.click' &&
    typeof step.payload.x === 'number' &&
    typeof step.payload.y === 'number'
      ? elementAt(screen, step.payload.x, step.payload.y)
      : null;
  const url = screen?.url ?? state.page;
  return {
    reason: found.reason,
    kind: found.kind,
    site: siteOf(url),
    origin: originOf(url),
    amount: amountOn(screen, target),
  };
}

/** How far back on one page the steps are read, at most. */
export const PAGE_STEPS = 400;

/**
 * The steps to read before a new one, oldest first, from the newest before it
 * back: every step on the page the latest screen shows, back to the step that
 * opened it or the last one on another page, up to `PAGE_STEPS`. A number
 * typed slowly, or padded with other steps, is still read whole.
 */
export function stepsOnPage(newestFirst: readonly ComputerStep[]): ComputerStep[] {
  const kept: ComputerStep[] = [];
  let page: string | null | undefined;
  for (const step of newestFirst) {
    if (kept.length >= PAGE_STEPS) break;
    const url = step.after?.url ?? null;
    if (url) {
      const here = pageOf(url);
      if (page === undefined) page = here;
      else if (here !== page) break;
    }
    kept.push(step);
    if (step.kind === 'computer.open') break;
  }
  return kept.reverse();
}

/** The tools that run a command or code in the agent's own computer. */
const SHELL_TOOLS = new Set([
  'terminal.run',
  'exec.run',
  'exec.python',
  'process.start',
  'process.write',
]);

/**
 * Whether a command or code run in the agent's computer carries a card's
 * number (`cardNumber`, so a network's prefix, length and the Luhn check):
 * typing it with xdotool, posting it with curl, or filling it from a script.
 */
export function shellPays(kind: string, payload: JsonObject): string | null {
  if (!SHELL_TOOLS.has(kind)) return null;
  const texts: string[] = [];
  for (const key of ['command', 'code', 'text', 'script', 'input', 'stdin']) {
    const value = payload[key];
    if (typeof value === 'string') texts.push(value);
  }
  for (const key of ['argv', 'args']) {
    const value = payload[key];
    if (Array.isArray(value))
      for (const each of value) if (typeof each === 'string') texts.push(each);
  }
  return texts.some((text) => holdsCardNumber(text))
    ? 'It runs a command with a card number in it.'
    : null;
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
