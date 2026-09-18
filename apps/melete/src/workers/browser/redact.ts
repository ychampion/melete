import { sensitiveName } from './visible.ts';

export const REDACTED = '[redacted]';
const GROUPED_CODE = /\b[A-Z0-9]{4}(?:[- ][A-Z0-9]{4}){1,5}\b/g;
/** The same shape in any case, joined by hyphens: `abcd-efgh-ijkl`, `ABC-DEF-GHI-JKL`. */
const HYPHENATED_CODE = /\b[A-Za-z0-9]{3,10}(?:-[A-Za-z0-9]{3,10}){2,7}\b/g;
const STANDALONE_DIGITS = /(?<![\w.,-])\d{6,10}(?![\w-]|[.,]\d)/g;
/** An authenticator seed as sites print it: base32, upper case, sixteen characters or more. */
const BASE32_SEED = /\b[A-Z2-7]{16,}={0,6}\b/g;
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

/**
 * The first look after a handback keeps the shape of the page and none of its contents: every
 * label and role stays, every value goes. A secret a person was shown is as likely to be page
 * text — a recovery list, an authenticator seed, "your code is 48213" — as a form control, and
 * no pattern catches every shape of one. What remains is what a locator needs, which is the
 * argument that withholds the picture as well. A name is still passed through the pattern
 * rules, so a code printed inside a label does not survive there either.
 */
export function withoutValues(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const value = valueStart(line);
      return patterns(value < 0 ? line : line.slice(0, value - 2));
    })
    .join('\n');
}
