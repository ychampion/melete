/**
 * Compose's variable substitution, applied to the Compose files with the values
 * deploy/.env holds, so `melete check` sees what `docker compose` would run
 * without asking Docker. It follows the Compose specification's interpolation
 * section: `$$` is a literal `$`; `$NAME` and `${NAME}`; `${NAME:-default}` and
 * `${NAME-default}`; `${NAME:?message}` and `${NAME?message}`, which refuse an
 * empty or unset value; `${NAME:+other}` and `${NAME+other}`. A default or an
 * alternative may itself contain substitutions.
 *
 * Only the values given are read. Compose would also take the shell's
 * environment over deploy/.env; a check that read the shell would judge
 * whichever terminal it happened to run in.
 */

export type Missing = { name: string; message: string };

export class InterpolationError extends Error {}

type Values = Readonly<Record<string, string>>;

/** The text with every substitution made; each required variable that is missing is added to `missing`. */
export function interpolate(text: string, values: Values, missing: Missing[] = []): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== '$') {
      out += char;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === '$') {
      out += '$';
      index += 2;
      continue;
    }
    if (next === '{') {
      const end = closingBrace(text, index + 2);
      if (end < 0) throw new InterpolationError(`an unclosed \${ in ${JSON.stringify(text)}`);
      out += substitute(text.slice(index + 2, end), values, missing);
      index = end + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index + 1))?.[0];
    if (name) {
      out += values[name] ?? '';
      index += 1 + name.length;
      continue;
    }
    out += '$';
    index += 1;
  }
  return out;
}

/** The index of the `}` that closes a `${` whose body starts at `start`, counting nested ones. */
function closingBrace(text: string, start: number): number {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '$' && text[index + 1] === '$') {
      index += 1;
      continue;
    }
    if (text[index] === '$' && text[index + 1] === '{') {
      depth += 1;
      index += 1;
    } else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function substitute(body: string, values: Values, missing: Missing[]): string {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/.exec(body);
  if (!match?.[1]) throw new InterpolationError(`\${${body}} is not a variable substitution`);
  const [, name, operator, rest = ''] = match;
  const value = values[name];
  const set = value !== undefined;
  const nonEmpty = set && value !== '';
  switch (operator) {
    case undefined:
      return value ?? '';
    case ':-':
      return nonEmpty ? value : interpolate(rest, values, missing);
    case '-':
      return set ? value : interpolate(rest, values, missing);
    case ':+':
      return nonEmpty ? interpolate(rest, values, missing) : '';
    case '+':
      return set ? interpolate(rest, values, missing) : '';
    case ':?':
    case '?':
      if (operator === ':?' ? nonEmpty : set) return value ?? '';
      missing.push({ name, message: interpolate(rest, values, missing) });
      return '';
    default:
      throw new InterpolationError(`\${${body}} uses an operator Compose does not have`);
  }
}

/** Every string in a parsed Compose document, substituted; keys are left as they are. */
export function interpolateDocument<T>(document: T, values: Values, missing: Missing[] = []): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return interpolate(node, values, missing);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
    return node;
  };
  return walk(document) as T;
}
