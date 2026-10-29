/**
 * What the model saw: the pieces of a cloud request that came from the person
 * and from tools, as they left after redaction, so the person can set them
 * beside what they see. Only that redacted text is kept. The values behind its
 * placeholders stay in the conversation's sealed vault, which alone maps them
 * back, and only for the person's own screen.
 */
import { createHash } from 'node:crypto';
import type { PrivacyCategory, PrivacySeen } from '@melete/contracts';
import type { Protocol } from './redact.ts';
import { placeholderCategory } from './vault.ts';

export type SeenSource = 'you' | 'tool';

/** One message's text as it was sent: the person's own words, or one tool's result. */
export type SeenPart = {
  source: SeenSource;
  tool: string | null;
  text: string;
  truncated: boolean;
  /** Of the whole piece, so one re-sent in a later request is kept once. */
  digest: string;
};

/** The longest piece kept. A long web page is cut here; the model saw it all. */
export const SEEN_PART_LIMIT = 12_000;
/**
 * The newest pieces of one request that are kept. A request re-sends the
 * conversation so far, and what is already kept is skipped; this keeps a lost
 * record of earlier pieces from landing on the current turn all at once.
 */
export const SEEN_PARTS_PER_REQUEST = 24;
/**
 * Bounded history, per conversation. The newest 240 pieces keep their text, at
 * most 2.88 million characters. Older pieces are blanked, whole answers at a
 * time and oldest first: the text goes and the row stays, so the same piece
 * re-sent in a later request is still recognised and never shown as that later
 * answer's. The answer being recorded is never blanked whole, only its oldest
 * pieces past the limit.
 */
export const SEEN_PARTS_PER_CONVERSATION = 240;
/**
 * A blanked row holds only its digest and ids. Past 2,400 rows in one
 * conversation, ten times the pieces that keep their text, the oldest blanked
 * rows are deleted. A request carries only its newest 24 pieces, so a piece
 * that old is rarely re-sent.
 */
export const SEEN_ROWS_PER_CONVERSATION = 2_400;

const PLACEHOLDER = /⟦[A-Z][A-Z_]*_\d{1,6}⟧/g;

/** The plain text inside a message's content, in order. Pictures carry none. */
function textOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textOf);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return ['text', 'content', 'output'].flatMap((key) => textOf(node[key]));
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A piece cut at the limit, never through the middle of a placeholder. */
function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= SEEN_PART_LIMIT) return { text, truncated: false };
  let end = SEEN_PART_LIMIT;
  const open = text.lastIndexOf('⟦', end);
  if (open !== -1 && text.indexOf('⟧', open) >= end) end = open;
  return { text: text.slice(0, end), truncated: true };
}

function part(source: SeenSource, tool: string | null, pieces: string[]): SeenPart | null {
  const whole = pieces.filter((piece) => piece.trim()).join('\n\n');
  if (!whole.trim()) return null;
  const digest = createHash('sha256')
    .update(`${source}\u0000${tool ?? ''}\u0000${whole}`)
    .digest('hex');
  return { source, tool, ...cut(whole), digest };
}

/**
 * The person's messages and the tools' results in a request body, one piece
 * per message, in the order sent. System and developer text, the assistant's
 * own words and its tool calls are not pieces: none of it is what the person
 * or their sources said.
 */
export function sentParts(body: Record<string, unknown>, protocol: Protocol): SeenPart[] {
  const parts: (SeenPart | null)[] = [];
  const names = new Map<string, string>();
  if (protocol === 'responses') {
    const input = body.input;
    if (typeof input === 'string')
      return [part('you', null, [input])].filter(Boolean) as SeenPart[];
    for (const item of Array.isArray(input) ? input : []) {
      const node = record(item);
      if (!node) continue;
      if (node.type === 'function_call' && typeof node.call_id === 'string')
        names.set(node.call_id, String(node.name ?? ''));
      else if (node.type === 'function_call_output')
        parts.push(part('tool', names.get(String(node.call_id)) || null, textOf(node.output)));
      else if (node.role === 'user') parts.push(part('you', null, textOf(node.content)));
    }
    return parts.filter((entry): entry is SeenPart => entry !== null);
  }
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const message = record(raw);
    if (!message) continue;
    if (message.role === 'assistant') {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const node = record(call);
        const name = record(node?.function)?.name;
        if (typeof node?.id === 'string' && typeof name === 'string') names.set(node.id, name);
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const node = record(block);
        if (node?.type === 'tool_use' && typeof node.id === 'string')
          names.set(node.id, String(node.name ?? ''));
      }
    } else if (message.role === 'tool') {
      parts.push(
        part('tool', names.get(String(message.tool_call_id)) || null, textOf(message.content)),
      );
    } else if (message.role === 'user') {
      // Anthropic tool results arrive inside the person's turn, each its own piece.
      if (!Array.isArray(message.content)) {
        parts.push(part('you', null, textOf(message.content)));
        continue;
      }
      const own: string[] = [];
      for (const block of message.content) {
        const node = record(block);
        if (node?.type === 'tool_result')
          parts.push(
            part('tool', names.get(String(node.tool_use_id)) || null, textOf(node.content)),
          );
        else own.push(...textOf(block));
      }
      parts.push(part('you', null, own));
    }
  }
  return parts.filter((entry): entry is SeenPart => entry !== null);
}

/** JSON a tool returned, laid out to read. The content is the same as sent. */
function readable(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

export type VaultLookup = (
  placeholder: string,
) => { category: PrivacyCategory; value: string } | undefined;

/**
 * One kept piece as the view draws it: plain runs of text, and each
 * placeholder with its kind and, for the person's own screen, the value it
 * stands for. A placeholder the vault no longer holds keeps a null value.
 */
export function seenSegments(text: string, lookup: VaultLookup) {
  const shown = readable(text);
  const segments: PrivacySeen['parts'][number]['segments'] = [];
  let cursor = 0;
  for (const match of shown.matchAll(PLACEHOLDER)) {
    const placeholder = match[0];
    const category = placeholderCategory(placeholder);
    if (!category) continue;
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: shown.slice(cursor, start) });
    const entry = lookup(placeholder);
    segments.push({ placeholder, category, value: entry?.value ?? null });
    cursor = start + placeholder.length;
  }
  if (cursor < shown.length) segments.push({ text: shown.slice(cursor) });
  return segments;
}
