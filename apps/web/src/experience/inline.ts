export type Span = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };

// `code` first so its contents stay literal, then **bold**, then *italic* or
// _italic_. An asterisk with a space on its inner side is left as text.
const PATTERN = /`([^`]+)`|\*\*(\S(?:.*?\S)?)\*\*|\*(\S(?:[^*]*?\S)?)\*|\b_(\S(?:[^_]*?\S)?)_\b/g;

/** One line of an answer cut into plain, bold, italic and code spans. */
export function inlineSpans(line: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of line.matchAll(PATTERN)) {
    const at = match.index ?? 0;
    if (at > last) spans.push({ kind: 'text', text: line.slice(last, at) });
    const [, code, strong, em, underscored] = match;
    if (code !== undefined) spans.push({ kind: 'code', text: code });
    else if (strong !== undefined) spans.push({ kind: 'strong', text: strong });
    else spans.push({ kind: 'em', text: em ?? underscored ?? '' });
    last = at + match[0].length;
  }
  if (last < line.length) spans.push({ kind: 'text', text: line.slice(last) });
  return spans;
}
