/**
 * The Markdown an agent writes, cut into blocks the chat draws itself:
 * paragraphs, headings, lists, quotes, tables, rules and code. Nothing here
 * produces HTML. Every piece of text stays text, and React escapes it when it
 * is drawn, so a reply that contains markup shows that markup as written.
 * Links are kept only when they point at the web or at an email address.
 */
import { inlineSpans, type Span } from './inline.ts';

export type Align = 'left' | 'center' | 'right' | null;

export type ListItem = {
  /** The item's first line, with its inline marks still in it. */
  text: string;
  /** A task list item: true when ticked, false when open, null when it is a plain item. */
  checked: boolean | null;
  /** Whatever is indented under the item: more lines, a nested list, code. */
  children: Block[];
};

export type Block =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'code'; lang: string; text: string; terminal: boolean; open: boolean }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'quote'; children: Block[] }
  | { type: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { type: 'rule' };

/** Languages whose blocks are a session at a prompt or what a command printed. */
const TERMINAL = new Set([
  'sh',
  'bash',
  'zsh',
  'shell',
  'console',
  'terminal',
  'shell-session',
  'powershell',
  'ps1',
  'cmd',
  'output',
]);

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const BULLET = /^( *)([-*+])\s+(.*)$/;
const ORDERED = /^( *)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

const blank = (line: string) => line.trim() === '';
const indentOf = (line: string) => line.length - line.trimStart().length;

function listMarker(
  line: string,
): { indent: number; ordered: boolean; n: number; rest: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet && !RULE.test(line))
    return { indent: bullet[1]?.length ?? 0, ordered: false, n: 1, rest: bullet[3] ?? '' };
  const ordered = ORDERED.exec(line);
  if (ordered)
    return {
      indent: ordered[1]?.length ?? 0,
      ordered: true,
      n: Number(ordered[2]),
      rest: ordered[3] ?? '',
    };
  return null;
}

/** A table row's cells, without the outer pipes. A `\|` stays a pipe inside its cell. */
function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/** True when a line would start a block of its own and so ends a paragraph. */
function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    listMarker(line) !== null ||
    (line.includes('|') && next !== undefined && TABLE_DIVIDER.test(next) && next.includes('-'))
  );
}

export function parseMarkdown(source: string): Block[] {
  return parseLines(source.replace(/\r\n?/g, '\n').split('\n'));
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? '';
    if (blank(line)) {
      at += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] ?? '```';
      const lang = (fence[2] ?? '').toLowerCase();
      const indent = indentOf(line);
      const body: string[] = [];
      at += 1;
      let open = true;
      while (at < lines.length) {
        const inner = lines[at] ?? '';
        const close = inner.trim();
        if (
          close.startsWith(mark[0] ?? '`') &&
          close.length >= mark.length &&
          /^([`~])\1*$/.test(close)
        ) {
          open = false;
          at += 1;
          break;
        }
        body.push(indent > 0 && indentOf(inner) >= indent ? inner.slice(indent) : inner);
        at += 1;
      }
      blocks.push({
        type: 'code',
        lang,
        text: body.join('\n'),
        terminal: TERMINAL.has(lang),
        open,
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1]?.length ?? 1) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, text: heading[2] ?? '' });
      at += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (at < lines.length && !blank(lines[at] ?? '')) {
        const quoted = QUOTE.exec(lines[at] ?? '');
        inner.push(quoted ? (quoted[1] ?? '') : (lines[at] ?? ''));
        at += 1;
      }
      blocks.push({ type: 'quote', children: parseLines(inner) });
      continue;
    }

    const next = lines[at + 1];
    if (
      line.includes('|') &&
      next !== undefined &&
      TABLE_DIVIDER.test(next) &&
      next.includes('-')
    ) {
      const head = cells(line);
      const align = cells(next).map(alignOf);
      const rows: string[][] = [];
      at += 2;
      while (at < lines.length && !blank(lines[at] ?? '') && (lines[at] ?? '').includes('|')) {
        const row = cells(lines[at] ?? '');
        rows.push(head.map((_, column) => row[column] ?? ''));
        at += 1;
      }
      blocks.push({ type: 'table', head, align: head.map((_, i) => align[i] ?? null), rows });
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      const list: Extract<Block, { type: 'list' }> = {
        type: 'list',
        ordered: marker.ordered,
        start: marker.n,
        items: [],
      };
      const base = marker.indent;
      while (at < lines.length) {
        const current = lines[at] ?? '';
        const item = listMarker(current);
        if (!item || item.indent > base + 1 || item.ordered !== list.ordered) break;
        if (item.indent < base) break;
        // The item's own lines: everything indented past its marker, and
        // single blank lines between them.
        const content: string[] = [];
        at += 1;
        while (at < lines.length) {
          const following = lines[at] ?? '';
          if (blank(following)) {
            const after = lines[at + 1];
            if (after !== undefined && !blank(after) && indentOf(after) > base) {
              content.push('');
              at += 1;
              continue;
            }
            break;
          }
          const sibling = listMarker(following);
          if (sibling && sibling.indent <= base + 1) break;
          if (!sibling && indentOf(following) <= base && content.length === 0) {
            // A lazy continuation of the item's first line.
            if (startsBlock(following, lines[at + 1])) break;
            content.push(`  ${following.trim()}`);
            at += 1;
            continue;
          }
          if (!sibling && indentOf(following) <= base) break;
          content.push(following);
          at += 1;
        }
        const task = TASK.exec(item.rest);
        const shift = Math.min(...content.filter((l) => !blank(l)).map(indentOf), 99);
        const dedented = content.map((l) => l.slice(Math.min(shift, indentOf(l))));
        // Lines that only continue the first one join it; the rest are its children.
        let firstLine = task ? (task[2] ?? '') : item.rest;
        let rest = dedented;
        while (rest.length > 0 && !blank(rest[0] ?? '') && !startsBlock(rest[0] ?? '', rest[1])) {
          firstLine = `${firstLine}\n${(rest[0] ?? '').trim()}`;
          rest = rest.slice(1);
        }
        list.items.push({
          text: firstLine,
          checked: task ? task[1] !== ' ' : null,
          children: parseLines(rest),
        });
        // A blank line between items keeps the list going.
        while (at < lines.length && blank(lines[at] ?? '')) {
          const after = listMarker(lines[at + 1] ?? '');
          if (after && after.indent === base && after.ordered === list.ordered) at += 1;
          else break;
        }
      }
      blocks.push(list);
      continue;
    }

    const paragraph: string[] = [];
    while (at < lines.length) {
      const current = lines[at] ?? '';
      if (blank(current)) break;
      if (paragraph.length > 0 && startsBlock(current, lines[at + 1])) break;
      paragraph.push(current.trim());
      at += 1;
    }
    blocks.push({ type: 'paragraph', lines: paragraph });
  }
  return blocks;
}

/* ---------- inline ---------- */

/** A link; `internal` is a place in Melete itself, opened in place rather than in a new tab. */
export type Inline = Span | { kind: 'link'; text: string; href: string; internal?: boolean };

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * The address a link may open, or null. Only web and email addresses pass;
 * `javascript:`, `data:`, `vbscript:`, `file:` and anything that does not
 * parse are refused, whatever their case or the spaces and control
 * characters hidden in them.
 */
export function safeHref(raw: string): string | null {
  // Browsers drop these before reading a scheme, so they are dropped here too.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  const cleaned = raw.trim().replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (!cleaned) return null;
  if (/^mailto:/i.test(cleaned)) return /^mailto:[^@\s]+@[^@\s]+$/i.test(cleaned) ? cleaned : null;
  try {
    const url = new URL(cleaned);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** A web address (http or https) a source or page link may open, or null. */
export function webHref(raw: string): string | null {
  const href = safeHref(raw);
  return href && /^https?:/i.test(href) ? href : null;
}

/**
 * A place in Melete itself, as the agent names one: `#/apps/app_01…`. Only a
 * hash route of plain path characters passes, so it can only move this page
 * to one of its own views.
 */
export function appHref(raw: string): string | null {
  const cleaned = raw.trim();
  return /^#\/[A-Za-z0-9_-][A-Za-z0-9._~/?=&%-]{0,300}$/.test(cleaned) && !cleaned.includes('..')
    ? cleaned
    : null;
}

/**
 * The endings a bare address is known by when it is written without
 * `https://` ("amazon.com/dp/B0F3PQHWTZ"). Only common site endings, so a file
 * name such as `index.html`, `notes.md` or `fw9.pdf` stays text.
 */
const SITE_ENDINGS =
  'com|org|net|edu|gov|io|co|ai|app|dev|me|us|uk|ca|de|fr|in|info|xyz|tv|gg|eu|au|jp|nl|ch|es|it|so|ly|fm|news|blog|shop|store|site|tech|cloud|page|online';

// [text](url "title"), <https://…>, a bare https:// address, an address
// written without its scheme (example.com/path), or a place in Melete
// (#/apps/app_01…).
const LINK = new RegExp(
  [
    String.raw`\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)`,
    String.raw`<((?:https?:\/\/|mailto:)[^>\s]+)>`,
    String.raw`\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]`,
    String.raw`(?<![\w@./:#-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:${SITE_ENDINGS})(?![\w-])(?:\/[^\s<>()]*[^\s<>().,;:!?'"])?)`,
    String.raw`(?<![\w/])(#\/[A-Za-z0-9_-][A-Za-z0-9._~/?=&%-]*[A-Za-z0-9_/-])`,
  ].join('|'),
  'g',
);

/** One line cut into plain, bold, italic, code and link spans. */
export function inlineMarks(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (text) out.push(...inlineSpans(text));
  };
  // Code spans keep their contents literal, so a link inside one is not a link.
  const codeRanges = [...line.matchAll(/`[^`]+`/g)].map((m) => [
    m.index ?? 0,
    (m.index ?? 0) + m[0].length,
  ]);
  const inCode = (at: number) => codeRanges.some(([from = 0, to = 0]) => at >= from && at < to);
  for (const match of line.matchAll(LINK)) {
    const at = match.index ?? 0;
    if (inCode(at) || at < last) continue;
    const [whole, label, target, angled, bare, place] = match;
    // A shortened address ("site.com/p/…/A-1") leads nowhere real: it stays text.
    const written = !label && !angled && !place;
    if (written && /^[^\s]*…/.test(line.slice(at))) continue;
    const internal = appHref(target ?? place ?? '');
    const href =
      internal ??
      (bare ? safeHref(`https://${bare}`) : place ? null : safeHref(target ?? angled ?? whole));
    pushText(line.slice(last, at));
    if (href)
      out.push({
        kind: 'link',
        text: label ?? angled ?? whole,
        href,
        ...(internal ? { internal: true } : {}),
      });
    else out.push({ kind: 'text', text: label ?? whole });
    last = at + whole.length;
  }
  pushText(line.slice(last));
  return out;
}
