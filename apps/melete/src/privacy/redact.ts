/**
 * Swaps sensitive details in an outbound model request for placeholders.
 *
 * It works on the whole request body, not on the pieces that assembled it:
 * the system prompt, injected memory, conversation history, tool results, file
 * contents and replayed reasoning all arrive here as strings in one JSON value,
 * so nothing added later can slip past. Only structural fields are left alone:
 * the model name, roles, types, ids, tool names, and opaque or signed reasoning.
 */
import type { PrivacyCategory } from '@melete/contracts';
import { isInlineImage } from '../gateway/images.ts';
import { type Detection, detect, resolveOverlaps } from './detect.ts';
import { type KnownValue, knownPattern, startsCleanly, type Vault } from './vault.ts';

export type Protocol = 'chat/completions' | 'responses' | 'messages';

/** Fields that are structure, not content. */
const STRUCTURAL = new Set([
  'model',
  'role',
  'type',
  'id',
  'call_id',
  'tool_call_id',
  'tool_use_id',
  'item_id',
  'name',
  'signature',
  'encrypted_content',
  'stream',
  // The answer's schema is the service's own, never the person's words.
  'response_format',
  'output_config',
  'format',
  'stream_options',
  'tool_choice',
  'parallel_tool_calls',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'n',
  'seed',
  'reasoning_effort',
  'store',
  'include',
  'previous_response_id',
  'prompt_cache_key',
  'cache_control',
  'format',
  'status',
]);

type Cached = { text: string; used: string[] };

export type RedactorOptions = {
  enabled: ReadonlySet<PrivacyCategory>;
  known?: KnownValue[];
  /** Extra spans a local model found for a string; looked up, never computed here. */
  extra?: (text: string) => Detection[] | undefined;
  /** Shared across the requests of one conversation; cleared when settings change. */
  cache?: Map<string, Cached>;
};

const CACHE_LIMIT = 20_000;

const looksLikeJson = (value: string) => {
  const first = value.trimStart()[0];
  const last = value.trimEnd().at(-1);
  return (first === '{' && last === '}') || (first === '[' && last === ']');
};
const NEUTRAL: Record<string, string> = { '⟦': '⟪', '⟧': '⟫' };

export class Redactor {
  /** Placeholders this request carries, in first-use order. */
  readonly used = new Set<string>();
  private readonly known: { pattern: RegExp; category: PrivacyCategory }[];

  constructor(
    readonly vault: Vault,
    private readonly options: RedactorOptions,
  ) {
    this.known = (options.known ?? []).flatMap((value) => {
      const pattern = knownPattern(value);
      return pattern ? [{ pattern, category: value.category }] : [];
    });
  }

  /**
   * One string. `vault` mode only swaps spellings this conversation already
   * mapped: it is for signed or provider-authored reasoning, whose bytes must
   * come back exactly as the provider produced them.
   */
  text(input: string, mode: 'full' | 'vault' = 'full'): string {
    if (input.length < 3) return input;
    const cacheKey = mode === 'full' ? input : `\u0000v${input}`;
    const hit = this.options.cache?.get(cacheKey);
    if (hit) {
      this.note(hit.used);
      return hit.text;
    }
    const used: string[] = [];
    const source =
      mode === 'full' ? input.replace(/[⟦⟧]/g, (char) => NEUTRAL[char] ?? char) : input;
    const spans = this.spans(source, mode);
    let output = source;
    if (spans.length) {
      let cursor = 0;
      const parts: string[] = [];
      for (const span of spans) {
        parts.push(source.slice(cursor, span.start));
        const placeholder = this.vault.assign(span.category, source.slice(span.start, span.end));
        parts.push(placeholder);
        used.push(placeholder);
        cursor = span.end;
      }
      parts.push(source.slice(cursor));
      output = parts.join('');
    }
    this.note(used);
    const cache = this.options.cache;
    if (cache) {
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(cacheKey, { text: output, used });
    }
    return output;
  }

  /** Every span to swap: what this conversation already knows first, then the detectors. */
  spans(text: string, mode: 'full' | 'vault' = 'full'): Detection[] {
    const certain: Detection[] = [];
    const aliases = this.vault.aliases();
    if (aliases) {
      aliases.lastIndex = 0;
      for (let match = aliases.exec(text); match; match = aliases.exec(text)) {
        if (!startsCleanly(text, match.index, match[0])) {
          aliases.lastIndex = match.index + 1;
          continue;
        }
        const entry = this.vault.matchEntry(match);
        if (entry)
          certain.push({
            start: match.index,
            end: match.index + match[0].length,
            category: entry.category,
          });
      }
    }
    if (mode === 'vault') return resolveOverlaps(certain);
    for (const { pattern, category } of this.known) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (!startsCleanly(text, match.index, match[0])) {
          pattern.lastIndex = match.index + 1;
          continue;
        }
        certain.push({ start: match.index, end: match.index + match[0].length, category });
      }
    }
    const firm = resolveOverlaps(certain);
    const extra = this.options.extra?.(text) ?? [];
    return resolveOverlaps([...extra, ...detect(text, this.options.enabled)], firm);
  }

  /** A whole request body, copied; the input is not modified. */
  body(body: Record<string, unknown>, protocol: Protocol): Record<string, unknown> {
    return this.walk(body, protocol, null) as Record<string, unknown>;
  }

  /**
   * `inner` is set inside JSON text (tool arguments, tool results): there the
   * protocol's field names mean nothing, so a `name`, `id` or `type` a tool
   * wrote is content like any other, and so are its keys.
   */
  private walk(value: unknown, protocol: Protocol, key: string | null, inner = false): unknown {
    if (typeof value === 'string') {
      // Tool arguments and most tool results are JSON text: its escapes would
      // glue words together ("\nCard"), so it is read as JSON, not as prose.
      if (key === 'arguments' || looksLikeJson(value)) return this.encodedJson(value, protocol);
      return this.text(value);
    }
    if (Array.isArray(value)) return value.map((item) => this.walk(item, protocol, key, inner));
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    if (inner) {
      const copy: Record<string, unknown> = {};
      for (const [field, child] of Object.entries(node))
        copy[this.text(field)] = this.walk(child, protocol, field, true);
      return copy;
    }
    // Signed thinking must reach the provider byte for byte; redacted thinking is opaque.
    if (node.type === 'redacted_thinking') return node;
    // A picture's bytes are not text: read as text, base64 can look like a card
    // or an account and be mangled. The router decides whether it goes at all.
    if (isInlineImage(node)) return node;
    if (node.type === 'thinking' && typeof node.thinking === 'string')
      return { ...node, thinking: this.text(node.thinking, 'vault') };
    if (node.type === 'reasoning' && protocol === 'responses') return this.reasoning(node);
    const copy: Record<string, unknown> = {};
    // A tool call's input object (messages protocol) is what the tool gets: content throughout.
    const toolInput = typeof node.type === 'string' && node.type.endsWith('tool_use');
    for (const [field, child] of Object.entries(node)) {
      copy[field] = STRUCTURAL.has(field)
        ? child
        : this.walk(child, protocol, field, toolInput && field === 'input');
    }
    return copy;
  }

  /** Reasoning items the provider wrote: summaries are only reverse-mapped. */
  private reasoning(node: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...node };
    for (const field of ['summary', 'content']) {
      const parts = node[field];
      if (!Array.isArray(parts)) continue;
      copy[field] = parts.map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? { ...part, text: this.text((part as { text: string }).text, 'vault') }
          : part,
      );
    }
    return copy;
  }

  /** Tool arguments are JSON text: redact field by field and keep it valid JSON. */
  private encodedJson(value: string, protocol: Protocol): string {
    const cacheKey = `\u0000j${value}`;
    const hit = this.options.cache?.get(cacheKey);
    if (hit) {
      this.note(hit.used);
      return hit.text;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return this.text(value);
    }
    const outer = this.captured;
    const inner: string[] = [];
    this.captured = inner;
    let output: string;
    try {
      const serialized = JSON.stringify(this.walk(parsed, protocol, null, true));
      // Unchanged arguments keep the model's own bytes.
      output = inner.length === 0 && serialized === JSON.stringify(parsed) ? value : serialized;
    } finally {
      this.captured = outer;
    }
    outer?.push(...inner);
    this.options.cache?.set(cacheKey, { text: output, used: inner });
    return output;
  }

  /** Placeholders a cached result carries count for this request too. */
  private note(placeholders: readonly string[]) {
    for (const placeholder of placeholders) this.used.add(placeholder);
    this.captured?.push(...placeholders);
  }

  /** Collects what a nested JSON string used, so its cached result can report it. */
  private captured: string[] | null = null;
}
