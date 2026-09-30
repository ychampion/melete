/**
 * Puts real values back into a model's reply before it leaves the gateway.
 *
 * A reply streams as server-sent events whose text arrives in small deltas, so a
 * placeholder can be cut anywhere: "⟦ACC" in one event and "OUNT_1⟧" in the
 * next, or across two network chunks inside one event. Each text channel (the
 * answer, the reasoning, each tool call's argument JSON) is followed on its own.
 * An event whose channel ends in what could be the start of a placeholder is held
 * until the next event arrives: if that event continues the same channel the
 * partial text moves forward into it, otherwise the held event is released
 * exactly as it was. Values inserted into argument JSON are JSON-escaped.
 */
import type { Protocol } from './redact.ts';
import type { Vault } from './vault.ts';

type Slot = { channel: string; json: boolean; get(): string; set(value: string): void };

const TOKEN_TEXT = /⟦([A-Z][A-Z_]*_\d{1,6})⟧/g;
const TOKEN_JSON = /(?:⟦|\\u27[eE]6)([A-Z][A-Z_]*_\d{1,6})(?:⟧|\\u27[eE]7)/g;
const OPEN_PARTIAL = /^⟦[A-Z0-9_]{0,40}$/;
/** A whole placeholder somewhere in an event's raw JSON, written plainly or escaped. */
const COMPLETE = /⟦[A-Z][A-Z_]*_\d{1,6}⟧|\\u27[eE]6[A-Z][A-Z_]*_\d{1,6}\\+u27[eE]7/;
const ESCAPED_OPENER = '\\u27e6';

function escapedPartial(suffix: string): boolean {
  const head = suffix.slice(0, ESCAPED_OPENER.length).toLowerCase();
  if (suffix.length <= ESCAPED_OPENER.length) return ESCAPED_OPENER.startsWith(head);
  if (head !== ESCAPED_OPENER) return false;
  return /^[A-Z0-9_]{0,40}(?:\\(?:u(?:2(?:7[eE]?)?)?)?)?$/.test(
    suffix.slice(ESCAPED_OPENER.length),
  );
}

/** Where a placeholder that may still be arriving begins, or -1. */
export function partialStart(text: string, json: boolean): number {
  let found = -1;
  const floor = Math.max(0, text.length - 64);
  for (let index = text.length - 1; index >= floor; index--) {
    const char = text[index];
    if (char === '⟦' && OPEN_PARTIAL.test(text.slice(index))) found = index;
    else if (json && char === '\\' && escapedPartial(text.slice(index))) found = index;
  }
  return found;
}

/** A whole reply that is itself JSON text, such as a structured answer: values go in escaped. */
function looksLikeJson(value: string): boolean {
  const first = value.trimStart()[0];
  const last = value.trimEnd().at(-1);
  return (first === '{' && last === '}') || (first === '[' && last === ']');
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function field(target: Record<string, unknown>, key: string, channel: string, json: boolean): Slot {
  return {
    channel,
    json,
    get: () => String(target[key]),
    set: (value) => {
      target[key] = value;
    },
  };
}

/** The text channels one event carries. */
function slotsOf(event: Record<string, unknown>, protocol: Protocol): Slot[] {
  const slots: Slot[] = [];
  if (protocol === 'chat/completions') {
    const choices = Array.isArray(event.choices) ? event.choices : [];
    for (const [position, raw] of choices.entries()) {
      const choice = object(raw);
      const delta = object(choice?.delta);
      if (!choice || !delta) continue;
      const index = typeof choice.index === 'number' ? choice.index : position;
      for (const key of ['content', 'reasoning_content', 'reasoning'])
        if (typeof delta[key] === 'string')
          slots.push(field(delta, key, `c${index}:${key}`, false));
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const [order, rawCall] of calls.entries()) {
        const call = object(rawCall);
        const fn = object(call?.function);
        if (!call || !fn || typeof fn.arguments !== 'string') continue;
        const slot = typeof call.index === 'number' ? call.index : order;
        slots.push(field(fn, 'arguments', `c${index}:tool${slot}`, true));
      }
    }
  } else if (protocol === 'responses') {
    const type = String(event.type ?? '');
    if (type.endsWith('.delta') && typeof event.delta === 'string') {
      const item = event.item_id ?? event.output_index ?? '';
      const part = event.content_index ?? event.summary_index ?? '';
      slots.push(field(event, 'delta', `${type}:${item}:${part}`, type.includes('arguments')));
    }
  } else if (event.type === 'content_block_delta') {
    const delta = object(event.delta);
    if (delta)
      for (const key of ['text', 'thinking', 'partial_json'])
        if (typeof delta[key] === 'string')
          slots.push(field(delta, key, `m${String(event.index ?? 0)}`, key === 'partial_json'));
  }
  return slots;
}

type Held = {
  lines: string[];
  event: Record<string, unknown>;
  slots: Slot[];
  suffixes: Map<string, string>;
};

export class Rehydrator {
  /** Placeholders this reply used that were put back. */
  readonly restored = new Set<string>();
  /** Every replacement made, so a change is seen even for a placeholder met before. */
  private replacements = 0;
  private buffer = '';
  private held: Held | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly protocol: Protocol,
  ) {}

  /** Complete placeholders in one string. */
  replace(text: string, json: boolean): string {
    if (!text.includes('⟦') && !(json && /\\u27[eE]6/.test(text))) return text;
    return text.replace(json ? TOKEN_JSON : TOKEN_TEXT, (whole, name: string) => {
      const placeholder = `⟦${name}⟧`;
      const value = this.vault.value(placeholder);
      if (value === undefined) return whole;
      this.restored.add(placeholder);
      this.replacements++;
      return json ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  /** Every string in a parsed JSON value; argument JSON is escaped as JSON. */
  private deep(value: unknown, key: string | null): unknown {
    if (typeof value === 'string')
      return this.replace(
        value,
        key === 'arguments' || key === 'partial_json' || looksLikeJson(value),
      );
    if (Array.isArray(value)) return value.map((item) => this.deep(item, key));
    const node = object(value);
    if (!node) return value;
    const copy: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(node)) copy[name] = this.deep(child, name);
    return copy;
  }

  /** A whole JSON reply, for a request that did not stream. */
  json(text: string): string {
    try {
      const parsed: unknown = JSON.parse(text);
      const before = this.replacements;
      const result = this.deep(parsed, null);
      return this.replacements === before ? text : JSON.stringify(result);
    } catch {
      return this.replace(text, false);
    }
  }

  /** Feed decoded stream text; returns what may be sent on now. */
  push(chunk: string): string {
    this.buffer += chunk;
    let output = '';
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary) break;
      const block = this.buffer.slice(0, boundary.index);
      const separator = boundary[0];
      this.buffer = this.buffer.slice(boundary.index + separator.length);
      output += this.block(block, separator);
    }
    return output;
  }

  /** The end of the stream: release anything held and any unterminated tail. */
  end(): string {
    let output = this.release(null);
    if (this.buffer) {
      output += this.block(this.buffer, '');
      output += this.release(null);
      this.buffer = '';
    }
    return output;
  }

  private block(block: string, separator: string): string {
    const lines = block.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (!data.length) return `${block}${separator}`;
    let event: Record<string, unknown> | null = null;
    try {
      event = object(JSON.parse(data.join('\n')));
    } catch {
      event = null;
    }
    if (!event) return this.release(null) + this.replace(block, false) + separator;
    const slots = slotsOf(event, this.protocol);
    let output = this.release(new Set(slots.map((slot) => slot.channel)));
    const carried = this.carry;
    this.carry = new Map();
    // Nothing that could be or start a placeholder, and nothing carried in.
    if (!carried.size && !/[⟦\\]/.test(data.join('\n'))) return `${output}${block}${separator}`;
    const before = this.replacements;
    const suffixes = new Map<string, string>();
    let touched = false;
    // Each channel first, with what the previous event handed forward...
    for (const slot of slots) {
      const original = slot.get();
      const text = this.replace((carried.get(slot.channel) ?? '') + original, slot.json);
      const cut = partialStart(text, slot.json);
      const keep = cut >= 0 ? text.slice(0, cut) : text;
      if (cut >= 0) suffixes.set(slot.channel, text.slice(cut));
      if (keep !== original) {
        slot.set(keep);
        touched = true;
      }
    }
    // ...then complete placeholders anywhere else in the event, when it has any.
    const rewritten = COMPLETE.test(data.join('\n'))
      ? (object(this.deep(event, null)) ?? event)
      : event;
    touched ||= this.replacements !== before;
    const kept = lines.filter((line) => !line.startsWith('data:'));
    if (suffixes.size) {
      this.held = {
        lines: kept,
        event: rewritten,
        slots: slotsOf(rewritten, this.protocol),
        suffixes,
      };
      return output;
    }
    output += touched ? this.serialize(kept, rewritten) : `${block}${separator}`;
    return output;
  }

  /** Partial text a released event handed forward, by channel. */
  private carry = new Map<string, string>();

  /**
   * Release the held event. Channels the next event continues hand their partial
   * text forward; the others get it back, so nothing is lost or reordered.
   */
  private release(continuing: Set<string> | null): string {
    const held = this.held;
    if (!held) return '';
    this.held = null;
    for (const slot of held.slots) {
      const suffix = held.suffixes.get(slot.channel);
      if (suffix === undefined) continue;
      if (continuing?.has(slot.channel)) this.carry.set(slot.channel, suffix);
      else slot.set(slot.get() + suffix);
    }
    return this.serialize(held.lines, held.event);
  }

  private serialize(lines: string[], event: Record<string, unknown>): string {
    return `${[...lines, `data: ${JSON.stringify(event)}`].join('\n')}\n\n`;
  }
}
