import { sensitiveName } from './visible.ts';

export const REDACTED = '[redacted]';
const GROUPED_CODE = /\b[A-Z0-9]{4}(?:[- ][A-Z0-9]{4}){1,5}\b/g;
const STANDALONE_DIGITS = /(?<![\w.,-])\d{6,10}(?![\w-]|[.,]\d)/g;

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

/**
 * The first observation after a person hands back may still show what they typed or were shown.
 * This is a fixed rule rather than a judgement: a line that names a secret loses its value, and
 * grouped codes and standalone runs of six to ten digits are blanked wherever they appear.
 */
export function redactSecretText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const value = sensitiveName.test(line) ? valueStart(line) : -1;
      const kept = value < 0 ? line : `${line.slice(0, value)}${REDACTED}`;
      return kept.replace(GROUPED_CODE, REDACTED).replace(STANDALONE_DIGITS, REDACTED);
    })
    .join('\n');
}
