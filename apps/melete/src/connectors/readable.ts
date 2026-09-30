/**
 * A web page as a model reads it: the words and the links, without scripts,
 * styles, forms or markup.
 *
 * One pass over the page, in time proportional to its length whatever the
 * markup looks like: no regular expression runs over the whole document, so an
 * unclosed `<script` repeated a million times costs what reading it once does.
 */

/** Elements whose content is never text for a reader. */
const SKIPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'canvas',
  'select',
  'textarea',
  'button',
]);

/** Elements that start a new line. */
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'caption',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'ul',
]);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  times: '×',
  divide: '÷',
};

/** Character references, named and numeric; anything unrecognised stays as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Where a tag that starts at `start` ends: the `>` outside any quoted attribute value. */
function tagEnd(html: string, start: number): number {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

/** Where the end tag of `name` starts, as a browser finds it: `</name` then a space, `/` or `>`. */
function closingTag(lower: string, name: string, from: number): number {
  let at = lower.indexOf(`</${name}`, from);
  while (at !== -1) {
    const next = lower[at + name.length + 2];
    if (next === undefined || next === '>' || next === '/' || /\s/.test(next)) return at;
    at = lower.indexOf(`</${name}`, at + 1);
  }
  return -1;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[2] ?? match[3] ?? match[4]) : undefined;
}

function absoluteLink(href: string | undefined, base: URL | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(decodeEntities(href.trim()), base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    url.hash = '';
    return url.href.length <= 300 ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export type ReadablePage = { title: string | null; text: string };

/**
 * The readable text of an HTML document. Links keep their address as
 * `[words](address)` so a reader can follow one; images keep their alt text.
 */
export function readableText(html: string, base?: string): ReadablePage {
  const baseUrl = (() => {
    try {
      return base ? new URL(base) : undefined;
    } catch {
      return undefined;
    }
  })();
  const lower = html.toLowerCase();
  const out: string[] = [];
  let title: string | null = null;
  let link: { href: string; start: number } | null = null;
  let index = 0;
  const text = (value: string) => {
    if (value) out.push(decodeEntities(value).replace(/[\s ]+/g, ' '));
  };
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      text(html.slice(index));
      break;
    }
    text(html.slice(index, open));
    if (lower.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]{0,30})/.exec(html.slice(open, open + 34));
    if (!nameMatch) {
      // A `<` that opens no tag is text, or a declaration such as `<!doctype>`.
      if (html[open + 1] === '!' || html[open + 1] === '?') {
        const close = html.indexOf('>', open);
        index = close === -1 ? html.length : close + 1;
      } else {
        text('<');
        index = open + 1;
      }
      continue;
    }
    const end = tagEnd(html, open);
    if (end === -1) break;
    const name = (nameMatch[1] as string).toLowerCase();
    const closing = html[open + 1] === '/';
    const tag = html.slice(open, end + 1);
    index = end + 1;
    if (!closing && name === 'title' && title === null) {
      const close = closingTag(lower, 'title', index);
      const raw = html.slice(index, close === -1 ? html.length : close);
      title = decodeEntities(raw).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      const after = close === -1 ? -1 : tagEnd(html, close);
      index = after === -1 ? html.length : after + 1;
      continue;
    }
    if (!closing && SKIPPED.has(name) && !tag.endsWith('/>')) {
      // Everything up to the matching close is dropped, nested or not.
      const close = closingTag(lower, name, index);
      if (close === -1) {
        index = html.length;
        break;
      }
      const after = tagEnd(html, close);
      index = after === -1 ? html.length : after + 1;
      continue;
    }
    if (BLOCKS.has(name)) out.push(name === 'li' && !closing ? '\n- ' : '\n');
    else if ((name === 'td' || name === 'th') && !closing) out.push(' ');
    if (name === 'img' && !closing) {
      const alt = attribute(tag, 'alt');
      if (alt?.trim()) text(` ${alt.trim()} `);
    }
    if (name === 'a') {
      if (!closing) {
        // An anchor left open is text, not a link.
        if (link) out[link.start] = '';
        link = null;
        const href = absoluteLink(attribute(tag, 'href'), baseUrl);
        if (href) {
          link = { href, start: out.length };
          out.push('[');
        }
      } else if (link) {
        const words = out
          .slice(link.start + 1)
          .join('')
          .trim();
        if (words) out.push(`](${link.href})`);
        else out.splice(link.start, 1);
        link = null;
      }
    }
  }
  if (link) out[link.start] = '';
  const joined = out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\[\s*\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: joined };
}
