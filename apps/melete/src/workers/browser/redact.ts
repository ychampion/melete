import { sensitiveName } from './visible.ts';

export const REDACTED = '[redacted]';
const GROUPED_CODE = /\b[A-Z0-9]{4}(?:[- ][A-Z0-9]{4}){1,5}\b/g;
/** The same shape in any case, joined by hyphens: `abcd-efgh-ijkl`, `ABC-DEF-GHI-JKL`. */
const HYPHENATED_CODE = /\b[A-Za-z0-9]{3,10}(?:-[A-Za-z0-9]{3,10}){2,7}\b/g;
const STANDALONE_DIGITS = /(?<![\w.,-])\d{6,10}(?![\w-]|[.,]\d)/g;
/** An authenticator seed as sites print it: base32, upper case, sixteen characters or more. */
const BASE32_SEED = /\b[A-Z2-7]{16,}={0,6}\b/g;
/** The same seed in lower or mixed case, told apart from a long word by carrying a digit. */
const MIXED_SEED = /\b(?=[A-Za-z2-7]*[2-7])(?=[A-Za-z2-7]*[A-Za-z])[A-Za-z2-7]{16,}={0,6}\b/g;
/**
 * On a handed-back page four digits or more in a control's name may be a code, however a site
 * spaces them: `48213`, `482 913`, `482-913`, `4 8 2 1 3`.
 */
const DIGIT_RUN = /\d(?:[\s-]?\d){3,}/g;
/**
 * A code made of letters, named as one: a run of five letters or more straight after a code,
 * token, key, PIN, passcode or OTP word, in any case (`Use code KXQPMZ`, `Use code kxqpmz`), and
 * each upper-case run of five or more that follows it in a list (`Backup codes: KXQPMZ WQERTY`).
 * The word itself is matched in the usual cases, so `Keyboard` and `Keynote` are not triggers.
 */
const LETTER_CODE =
  /\b((?:[Cc]odes?|CODES?|[Tt]okens?|TOKENS?|[Kk]eys?|KEYS?|PIN|[Pp]in|[Pp]asscodes?|PASSCODES?|OTP|[Oo]tp)\b[\s:=#-]*)[A-Za-z]{5,}\b((?:[\s,;]+[A-Z]{5,}\b)*)/g;
/** A word of a control's name, with dash-joined groups kept together as one token. */
const WORD = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;
/**
 * A path segment that may be a token: its letters and digits, with separators taken out, run to
 * six or more and mix both. `7f3k9x`, `zqpath-9f3a` and a long hex id qualify; `page-2`, `v2` and
 * `getting-started` do not.
 */
function mixedToken(segment: string): boolean {
  const run = segment.replace(/[^A-Za-z0-9]/g, '');
  return run.length >= 6 && /\d/.test(run) && /[A-Za-z]/.test(run);
}
/**
 * A path segment of twenty letters or digits or more with no separator in it, which a readable
 * path rarely has and a token of letters alone (`qwertyuiopasdfghjklzxcvbnm`) does.
 */
const UNBROKEN_RUN = /^[A-Za-z0-9]{20,}$/;
/** A JSON web token, with or without the bearer word in front of it. */
const TOKEN = /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/g;

/** Where a snapshot line's value starts: after the first `: ` outside a quoted name, or -1. */
function valueStart(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length - 1; index++) {
    const character = line[index];
    if (character === '\\') index++;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ':' && line[index + 1] === ' ') return index + 2;
  }
  return -1;
}

/** A hyphenated run is a code when its groups are all the same length; a phrase is not. */
function evenGroups(run: string): boolean {
  const groups = run.split('-');
  return groups.every((group) => group.length === (groups[0] ?? '').length);
}

function patterns(line: string): string {
  return line
    .replace(TOKEN, REDACTED)
    .replace(BASE32_SEED, REDACTED)
    .replace(MIXED_SEED, REDACTED)
    .replace(GROUPED_CODE, REDACTED)
    .replace(HYPHENATED_CODE, (run) => (evenGroups(run) ? REDACTED : run))
    .replace(STANDALONE_DIGITS, REDACTED);
}

/**
 * What a page still shows, with the shapes of a secret blanked: a line that names one loses its
 * value, and grouped codes, authenticator seeds, tokens and standalone runs of six to ten digits
 * go wherever they appear. Build and tracking numbers are deliberately kept. This is a fixed
 * rule rather than a judgement about a page.
 */
export function redactSecretText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const value = sensitiveName.test(line) ? valueStart(line) : -1;
      return patterns(value < 0 ? line : `${line.slice(0, value)}${REDACTED}`);
    })
    .join('\n');
}

/** The roles a locator acts on. Their names are what an agent can click or fill by. */
const CONTROL_ROLES = new Set([
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'button',
  'link',
  'spinbutton',
]);

/** A snapshot entry: its indent and dash, an optional quote, the role, the name, and the rest. */
const ENTRY = /^(\s*- )('?)([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/;

/**
 * A control's name on a handed-back page. Buttons and links are named from what they show, so a
 * code can sit in one; the secret shapes go, and so does any run of four or more digits, any word
 * that mixes letters and digits over six characters or more (`K7QP2X`, `8f3k-9x2m`), and a code
 * named as one. `iPhone15` and `Windows11` go too while the page is handed back; that is the cost.
 */
export function handbackLabel(label: string): string {
  return patterns(label)
    .replace(DIGIT_RUN, REDACTED)
    .replace(
      LETTER_CODE,
      (_, lead: string, rest: string) =>
        `${lead}${REDACTED}${rest.replace(/[A-Z]{5,}/g, REDACTED)}`,
    )
    .replace(WORD, (word) => (mixedToken(word) ? REDACTED : word));
}

/**
 * Where a handed-back page is, as the agent may see it: scheme, host and a path whose segments
 * went through the same filter as a control's name, with no query, fragment or credentials. A
 * magic link or a reset code can sit in a path segment as easily as in a query.
 */
export function handbackUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  const path = url.pathname
    .split('/')
    .map((raw) => {
      // Matrix parameters (`;jsessionid=...`) go the way of the query string.
      const segment = raw.split(';')[0] ?? '';
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return encodeURIComponent(REDACTED);
      }
      const kept =
        mixedToken(decoded) || UNBROKEN_RUN.test(decoded) ? REDACTED : handbackLabel(decoded);
      return kept === decoded ? segment : encodeURIComponent(kept);
    })
    .join('/');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * A look at a page a person has handed back keeps the shape of the page and none of its
 * contents. Every value goes. Headings, cells, list items, options, images and text are named
 * from what the page shows, so their names go too; only the controls a locator acts on keep a
 * name, passed through the secret shapes. A secret a person was shown is as likely to be page
 * text — a recovery list, an authenticator seed, "your code is 48213" — as a form control, and
 * no pattern catches every shape of one, which is also why the picture is withheld.
 */
export function withoutValues(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const value = valueStart(line);
      const entry = value < 0 ? line : line.slice(0, value - 2);
      const match = ENTRY.exec(entry);
      if (!match) return patterns(entry);
      const [, lead, quote, role = '', name, rest] = match;
      const kept = name !== undefined && CONTROL_ROLES.has(role) ? ` "${handbackLabel(name)}"` : '';
      // What follows the name is attributes such as [level=1], and a quoted entry's closing quote.
      return patterns(`${lead}${quote}${role}${kept}${rest}`);
    })
    .join('\n');
}
