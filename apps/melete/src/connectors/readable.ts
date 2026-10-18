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

/**
 * Where a tag that starts at `start` ends: the `>` outside any quoted attribute
 * value. As in a browser, a quote opens a value only where a value starts,
 * after `=`. A stray quote elsewhere, as in `<div class="row" ">`, is part of an
 * attribute's name, so it never hides the `>` and the text after it: read as a
 * value, it once swallowed every other row of a page's table.
 */
export function tagEnd(html: string, start: number): number {
  // The tokenizer's states from the tag's name to its `>`, as the HTML standard
  // names them; only where the tag ends is kept.
  let state:
    | 'name'
    | 'beforeName'
    | 'attribute'
    | 'afterName'
    | 'beforeValue'
    | 'quoted'
    | 'unquoted'
    | 'afterValue'
    | 'selfClosing' = 'name';
  let quote = '';
  let index = html[start + 1] === '/' ? start + 2 : start + 1;
  while (index < html.length) {
    const character = html[index] as string;
    const space =
      character === ' ' ||
      character === '\t' ||
      character === '\n' ||
      character === '\f' ||
      character === '\r';
    // Each case moves on to the next character, or changes state and reads this one again.
    switch (state) {
      case 'name':
      case 'unquoted':
        if (character === '>') return index;
        if (space) state = 'beforeName';
        else if (character === '/' && state === 'name') state = 'selfClosing';
        break;
      case 'beforeName':
        if (space) break;
        state = character === '/' || character === '>' ? 'afterName' : 'attribute';
        // A `=` here starts an attribute named "=", so it is read as a name.
        if (character !== '=') continue;
        break;
      case 'attribute':
        if (space || character === '/' || character === '>') {
          state = 'afterName';
          continue;
        }
        if (character === '=') state = 'beforeValue';
        break;
      case 'afterName':
        if (space) break;
        if (character === '>') return index;
        if (character === '/') state = 'selfClosing';
        else if (character === '=') state = 'beforeValue';
        else {
          state = 'attribute';
          continue;
        }
        break;
      case 'beforeValue':
        if (space) break;
        if (character === '>') return index;
        if (character === '"' || character === "'") {
          quote = character;
          state = 'quoted';
        } else {
          state = 'unquoted';
          continue;
        }
        break;
      case 'quoted':
        if (character === quote) state = 'afterValue';
        break;
      case 'afterValue':
      case 'selfClosing':
        if (character === '>') return index;
        if (space && state === 'afterValue') state = 'beforeName';
        else if (character === '/' && state === 'afterValue') state = 'selfClosing';
        else {
          state = 'beforeName';
          continue;
        }
        break;
    }
    index += 1;
  }
  return -1;
}

/**
 * Just past the end of the comment that opens at `open` (`<!--`), as a browser
 * ends one: at `-->` or `--!>`, where `<!-->` and `<!--->` are empty comments.
 * One forward scan, so a page of unclosed comments stays linear.
 */
function commentEnd(html: string, open: number): number {
  let at = html.indexOf('--', open + 2);
  while (at !== -1) {
    if (html[at + 2] === '>') return at + 3;
    // `<!--!>` is not a close: the dashes of `<!--` end a comment only before `>`.
    if (at > open + 2 && html[at + 2] === '!' && html[at + 3] === '>') return at + 4;
    at = html.indexOf('--', at + 1);
  }
  return html.length;
}

/** Whether a tag name ends before `character`: at a space, `/`, `>` or the end of the page. */
function endsName(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === '>' ||
    character === '/' ||
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\f' ||
    character === '\r'
  );
}

/** Where the end tag of `name` starts, as a browser finds it: `</name` then a space, `/` or `>`. */
function closingTag(lower: string, name: string, from: number): number {
  let at = lower.indexOf(`</${name}`, from);
  while (at !== -1) {
    if (endsName(lower[at + name.length + 2])) return at;
    at = lower.indexOf(`</${name}`, at + 1);
  }
  return -1;
}

/**
 * Where a script's end tag starts, as a browser finds it. After `<!--` a
 * `<script` opens a nested one whose `</script>` does not end the outer script,
 * the way old pages wrote `<!-- document.write('<script …></script>') -->`; a
 * `-->` undoes both.
 */
function scriptEnd(lower: string, from: number): number {
  let mode: 'data' | 'escaped' | 'nested' = 'data';
  let dashesFrom = 0;
  for (let at = from; at < lower.length; at += 1) {
    const character = lower[at];
    if (character === '>') {
      if (mode !== 'data' && at - 2 >= dashesFrom && lower[at - 1] === '-' && lower[at - 2] === '-')
        mode = 'data';
    } else if (character === '<') {
      const endTag = lower.startsWith('</script', at) && endsName(lower[at + 8]);
      if (mode === 'data' && lower.startsWith('<!--', at)) {
        mode = 'escaped';
        // The dashes of `<!--` count towards a `-->`, so `<!-->` closes at once.
        dashesFrom = at + 2;
        at += 3;
      } else if (endTag && mode !== 'nested') return at;
      else if (endTag) {
        mode = 'escaped';
        at += 7;
      } else if (mode === 'escaped' && lower.startsWith('<script', at) && endsName(lower[at + 7])) {
        mode = 'nested';
        at += 6;
      }
    }
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
  // Only ASCII letters fold, as tag names do: a full lower-casing turns `İ` into
  // two characters, and every position after it would point at the wrong place.
  const lower = html.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
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
    if (html.startsWith('<!--', open)) {
      index = commentEnd(html, open);
      continue;
    }
    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]{0,30})/.exec(html.slice(open, open + 34));
    if (!nameMatch) {
      // A `<` that opens no tag is text, or a declaration such as `<!doctype>`, or
      // a bogus comment such as `<?xml …>` or `</ …>`, which ends at the next `>`.
      const next = html[open + 1];
      if (next === '!' || next === '?' || (next === '/' && open + 2 < html.length)) {
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
    if (!closing && name === 'title') {
      // Every title holds plain text up to its end tag; the first names the page.
      const close = closingTag(lower, 'title', index);
      if (title === null) {
        const raw = html.slice(index, close === -1 ? html.length : close);
        title = decodeEntities(raw).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      }
      const after = close === -1 ? -1 : tagEnd(html, close);
      index = after === -1 ? html.length : after + 1;
      continue;
    }
    if (!closing && SKIPPED.has(name) && !tag.endsWith('/>')) {
      // Everything up to the matching close is dropped, nested or not.
      const close = name === 'script' ? scriptEnd(lower, index) : closingTag(lower, name, index);
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
