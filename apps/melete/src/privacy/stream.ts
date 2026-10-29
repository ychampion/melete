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
 *
 * Some models write a placeholder back without its brackets ("ACCOUNT_1").
 * That name alone is put back too, but only when this conversation's vault
 * issued it and it stands as a whole word, so "ACCOUNT_10" or a name from
 * another conversation stays as written. A word at the end of a delta that
 * could still grow into such a name is held like a partial placeholder.
 */
import type { Protocol } from './redact.ts';
import { BARE_NAME, bareStandsAlone, PLACEHOLDER_NAME, type Vault } from './vault.ts';

type Slot = {
  channel: string;
  json: boolean;
  target: Record<string, unknown>;
  key: string;
  get(): string;
  set(value: string): void;
};

/** What lies beyond a piece of text: a word running on before it, or more text to come. */
type Edges = { wordBefore?: boolean; more?: boolean };

/** A placeholder, or (the second group) a name written without its brackets. */
const TOKEN_TEXT = new RegExp(`⟦(${PLACEHOLDER_NAME})⟧|(${BARE_NAME})`, 'g');
const TOKEN_JSON = new RegExp(
  `(?:⟦|\\\\u27[eE]6)(${PLACEHOLDER_NAME})(?:⟧|\\\\u27[eE]7)|(${BARE_NAME})`,
  'g',
);
const BARE_SHAPE = new RegExp(BARE_NAME);
const BARE_ALL = new RegExp(BARE_NAME, 'g');
/** The word a text ends with, which may still be arriving. */
const LAST_WORD = /[\p{L}\p{N}_]+$/u;
const ENDS_IN_WORD = /[\p{L}\p{N}_]$/u;
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
    target,
    key,
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
  /** Per channel: whether the text sent on so far ends inside a word. */
  private wordBefore = new Map<string, boolean>();

  constructor(
    private readonly vault: Vault,
    private readonly protocol: Protocol,
  ) {}

  /** Complete placeholders in one string, bracketed or bare. */
  replace(text: string, json: boolean, edges: Edges = {}): string {
    const bare = this.vault.size > 0 && BARE_SHAPE.test(text);
    if (!bare && !text.includes('⟦') && !(json && /\\u27[eE]6/.test(text))) return text;
    return text.replace(
      json ? TOKEN_JSON : TOKEN_TEXT,
      (whole, bracketed: string | undefined, name: string | undefined, offset: number) => {
        if (name !== undefined && !bareStandsAlone(text, offset, whole.length, edges)) return whole;
        const placeholder = `⟦${bracketed ?? name}⟧`;
        const value = this.vault.value(placeholder);
        if (value === undefined) return whole;
        this.restored.add(placeholder);
        this.replacements++;
        return json ? JSON.stringify(value).slice(1, -1) : value;
      },
    );
  }

  /**
   * Where a bare name that may still be arriving begins, or -1: the last word,
   * when it starts a word and this vault has a name it could grow into.
   */
  private bareStart(text: string, wordBefore: boolean): number {
    if (!this.vault.size) return -1;
    // Names are short: only the last few characters can hold the start of one.
    const from = Math.max(0, text.length - 48);
    const word = LAST_WORD.exec(text.slice(from));
    if (!word) return -1;
    const index = from + word.index;
    // A word longer than that, or one that began in text already sent, is no name.
    if (index === 0 ? wordBefore : ENDS_IN_WORD.test(text[index - 1] ?? '')) return -1;
    return this.vault.barePrefix(word[0]) ? index : -1;
  }

  /** Remember whether what a channel sent on ends inside a word. */
  private sent(channel: string, text: string) {
    if (text) this.wordBefore.set(channel, ENDS_IN_WORD.test(text));
  }

  /** Whether raw event text holds a bare name this vault issued. */
  private anyBare(raw: string): boolean {
    for (const match of raw.matchAll(BARE_ALL))
      if (this.vault.bareValue(match[0]) !== undefined) return true;
    return false;
  }

  /**
   * Every string in a parsed JSON value; argument JSON is escaped as JSON. A
   * streamed event's channels were already done, with what came before them
   * in the stream, so `done` names those fields and they are kept as they are.
   */
  private deep(value: unknown, key: string | null, done?: Map<object, Set<string>>): unknown {
    if (typeof value === 'string')
      return this.replace(
        value,
        key === 'arguments' || key === 'partial_json' || looksLikeJson(value),
      );
    if (Array.isArray(value)) return value.map((item) => this.deep(item, key, done));
    const node = object(value);
    if (!node) return value;
    const copy: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(node))
      copy[this.replace(name, false)] = done?.get(node)?.has(name)
        ? child
        : this.deep(child, name, done);
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
    const raw = data.join('\n');
    // Once the vault holds anything, capitals could be a name written bare.
    const bare = this.vault.size > 0 && /[A-Z]/.test(raw);
    // Nothing that could be or start a placeholder, and nothing carried in.
    if (!carried.size && !bare && !/[⟦\\]/.test(raw)) {
      for (const slot of slots) this.sent(slot.channel, slot.get());
      return `${output}${block}${separator}`;
    }
    const before = this.replacements;
    const suffixes = new Map<string, string>();
    let touched = false;
    // Each channel first, with what the previous event handed forward...
    for (const slot of slots) {
      const original = slot.get();
      const wordBefore = this.wordBefore.get(slot.channel) ?? false;
      const text = this.replace((carried.get(slot.channel) ?? '') + original, slot.json, {
        wordBefore,
        more: true,
      });
      const cuts = [partialStart(text, slot.json), this.bareStart(text, wordBefore)].filter(
        (at) => at >= 0,
      );
      const cut = cuts.length ? Math.min(...cuts) : -1;
      const keep = cut >= 0 ? text.slice(0, cut) : text;
      if (cut >= 0) suffixes.set(slot.channel, text.slice(cut));
      this.sent(slot.channel, keep);
      if (keep !== original) {
        slot.set(keep);
        touched = true;
      }
    }
    // ...then complete placeholders anywhere else in the event, when it has any.
    const done = new Map<object, Set<string>>();
    for (const slot of slots)
      done.set(slot.target, (done.get(slot.target) ?? new Set<string>()).add(slot.key));
    const rewritten =
      COMPLETE.test(raw) || (bare && this.anyBare(raw))
        ? (object(this.deep(event, null, done)) ?? event)
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
      if (continuing?.has(slot.channel)) {
        this.carry.set(slot.channel, suffix);
        continue;
      }
      // Nothing follows on this channel now, so a name held at its end is whole.
      const last = this.replace(suffix, slot.json, {
        wordBefore: this.wordBefore.get(slot.channel) ?? false,
      });
      this.sent(slot.channel, last);
      slot.set(slot.get() + last);
    }
    return this.serialize(held.lines, held.event);
  }

  private serialize(lines: string[], event: Record<string, unknown>): string {
    return `${[...lines, `data: ${JSON.stringify(event)}`].join('\n')}\n\n`;
  }
}
