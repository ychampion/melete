import { createHash } from 'node:crypto';

/**
 * Melete names its tools with dots (`web.search`, `run.finish`), and Anthropic's
 * Messages API refuses a tool name outside `^[a-zA-Z0-9_-]{1,128}$` with a 400
 * on every call. The gateway renames such tools on the way out and puts the
 * real names back on the way in, so the engine, the broker and every receipt
 * keep the names they have.
 *
 * A tool's wire name depends on its own name alone: the name made safe, then
 * `_` and the first eight hex digits of its SHA-256 (`web.search` leaves as
 * `web__search_` and eight digits). It does not depend on which other tools a
 * request carries, their order, or what the conversation called earlier, so a
 * tool call already in the history leaves under the same name on every later
 * turn. The request stays byte-stable, the provider's prompt cache still
 * matches, and a history the provider checks for edits is the history it sent.
 */
const WIRE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const LIMIT = 128;
/** Hex digits of the name's digest a wire name carries, unless it would clash. */
const DIGITS = 8;
const MAX_DIGITS = 64;

export interface ToolNameCodec {
  /** The request as it leaves, with every invalid tool name replaced. */
  body: Record<string, unknown>;
  /** Wire name to the name the engine gave. */
  names: ReadonlyMap<string, string>;
}

type Block = Record<string, unknown>;

function isObject(value: unknown): value is Block {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolNamesIn(body: Block): string[] {
  const found: string[] = [];
  if (Array.isArray(body.tools))
    for (const tool of body.tools)
      if (isObject(tool) && typeof tool.name === 'string') found.push(tool.name);
  if (Array.isArray(body.messages))
    for (const message of body.messages)
      if (isObject(message) && Array.isArray(message.content))
        for (const block of message.content)
          if (isObject(block) && block.type === 'tool_use' && typeof block.name === 'string')
            found.push(block.name);
  const choice = body.tool_choice;
  if (isObject(choice) && choice.type === 'tool' && typeof choice.name === 'string')
    found.push(choice.name);
  return found;
}

/**
 * The wire name of a tool name the API refuses: the name with each dot as `__` and any other
 * character it refuses as `_`, cut to fit, then `_` and `digits` hex digits of its SHA-256.
 */
export function toolWireName(name: string, digits = DIGITS): string {
  const base = name.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
  const digest = createHash('sha256').update(name).digest('hex').slice(0, digits);
  return `${base.slice(0, LIMIT - digest.length - 1)}_${digest}`;
}

/**
 * The wire name of each refused name. Each is `toolWireName(name)` unless that equals a name
 * the request sends as it is, or another refused name's wire name: then the names involved
 * carry more of their digest, whatever order they came in. Only a name made to match another's
 * whole digest is left, and it takes a counted suffix, in name order.
 */
function wireNames(invalid: readonly string[], valid: ReadonlySet<string>): Map<string, string> {
  const digits = new Map(invalid.map((name) => [name, DIGITS]));
  for (;;) {
    const wires = new Map(invalid.map((name) => [name, toolWireName(name, digits.get(name))]));
    const uses = new Map<string, number>();
    for (const wire of wires.values()) uses.set(wire, (uses.get(wire) ?? 0) + 1);
    const clashing = invalid.filter((name) => {
      const wire = wires.get(name) ?? '';
      return valid.has(wire) || (uses.get(wire) ?? 0) > 1;
    });
    if (clashing.length === 0) return wires;
    if (clashing.every((name) => (digits.get(name) ?? DIGITS) < MAX_DIGITS)) {
      for (const name of clashing) digits.set(name, (digits.get(name) ?? DIGITS) + DIGITS);
      continue;
    }
    const taken = new Set([...valid, ...wires.values()]);
    for (const name of [...clashing].sort()) {
      const base = wires.get(name) ?? toolWireName(name, MAX_DIGITS);
      taken.delete(base);
      let candidate = base;
      for (let n = 2; valid.has(candidate) || taken.has(candidate); n++) {
        const suffix = `_${n}`;
        candidate = `${base.slice(0, LIMIT - suffix.length)}${suffix}`;
      }
      taken.add(candidate);
      wires.set(name, candidate);
    }
    return wires;
  }
}

/**
 * Renames the tools of one Messages API request whose names the API refuses:
 * the tool definitions, the tool calls already in the conversation, and a
 * forced tool choice. Returns null when every name is already accepted. The
 * given body is not changed; the parts that change are copied. A call's input
 * is never changed.
 */
export function encodeToolNames(body: Record<string, unknown>): ToolNameCodec | null {
  const all = toolNamesIn(body);
  const invalid = [...new Set(all.filter((name) => name && !WIRE_NAME.test(name)))];
  if (invalid.length === 0) return null;
  // A wire name never takes the name of a tool that is sent as it is.
  const toWire = wireNames(invalid, new Set(all.filter((name) => WIRE_NAME.test(name))));
  const rename = <T extends Block>(block: T): T => {
    const wire = typeof block.name === 'string' ? toWire.get(block.name) : undefined;
    return wire ? { ...block, name: wire } : block;
  };

  const out: Record<string, unknown> = { ...body };
  if (Array.isArray(body.tools))
    out.tools = body.tools.map((tool) => (isObject(tool) ? rename(tool) : tool));
  if (Array.isArray(body.messages))
    out.messages = body.messages.map((message) =>
      isObject(message) && Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.map((block) =>
              isObject(block) && block.type === 'tool_use' ? rename(block) : block,
            ),
          }
        : message,
    );
  if (isObject(body.tool_choice) && body.tool_choice.type === 'tool')
    out.tool_choice = rename(body.tool_choice);
  return { body: out, names: new Map([...toWire].map(([name, wire]) => [wire, name])) };
}

type Frame = { array: boolean; input: boolean; key: string | null; expectKey: boolean };

/**
 * Puts the engine's names back into one JSON text, read token by token rather than parsed, so
 * every other byte (numbers past double precision included) is kept as it came. A string is
 * replaced only when it is the value of a `"name"` member, outside any `"input"` member, and
 * its whole value is a wire name: a tool call's input and the text the model wrote keep what
 * they say. Text around the JSON, such as a server-sent event's `data: `, is passed through.
 */
function renameJson(text: string, names: ReadonlyMap<string, string>): string {
  const stack: Frame[] = [];
  let out = '';
  let copied = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    const top = stack[stack.length - 1];
    if (char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) break;
      const raw = text.slice(at, end + 1);
      if (top && !top.array && top.expectKey) {
        top.key = raw.includes('\\') ? (JSON.parse(raw) as string) : raw.slice(1, -1);
        top.expectKey = false;
      } else if (top && !top.array && !top.input && top.key === 'name') {
        const original = raw.includes('\\') ? undefined : names.get(raw.slice(1, -1));
        if (original !== undefined) {
          out += text.slice(copied, at) + JSON.stringify(original);
          copied = end + 1;
        }
      }
      at = end;
    } else if (char === '{' || char === '[') {
      const input = !!top && (top.input || (!top.array && top.key === 'input'));
      stack.push({ array: char === '[', input, key: null, expectKey: char === '{' });
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',' && top && !top.array) {
      top.expectKey = true;
      top.key = null;
    }
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Puts the engine's tool names back into a whole JSON reply. */
export function toolNameDecoder(names: ReadonlyMap<string, string>): (text: string) => string {
  if (names.size === 0) return (text) => text;
  return (text) => renameJson(text, names);
}

/**
 * The decoder for a streamed reply: a server-sent event can be split across
 * chunks anywhere, so text is held back to the last complete line, and each
 * line, one event's data, is read on its own, the same way as a whole reply.
 */
export class ToolNameStream {
  private pending = '';

  constructor(private readonly names: ReadonlyMap<string, string>) {}

  private decode(text: string): string {
    if (this.names.size === 0) return text;
    return text
      .split('\n')
      .map((line) => renameJson(line, this.names))
      .join('\n');
  }

  push(text: string): string {
    const whole = this.pending + text;
    const cut = whole.lastIndexOf('\n') + 1;
    this.pending = whole.slice(cut);
    return cut === 0 ? '' : this.decode(whole.slice(0, cut));
  }

  end(): string {
    const rest = this.pending;
    this.pending = '';
    return this.decode(rest);
  }
}
