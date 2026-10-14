import { createHash } from 'node:crypto';

/**
 * Melete names its tools with dots (`web.search`, `run.finish`), and Anthropic's
 * Messages API refuses a tool name outside `^[a-zA-Z0-9_-]{1,128}$` with a 400
 * on every call. The gateway renames such tools on the way out and puts the
 * real names back on the way in, so the engine, the broker and every receipt
 * keep the names they have.
 *
 * A name always maps to the same wire name for the same set of names, so the
 * request a conversation sends stays byte-stable from turn to turn and the
 * provider's prompt cache still matches.
 */
const WIRE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const LIMIT = 128;

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

function wireName(name: string, taken: Set<string>): string {
  let base = name.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
  if (base.length > LIMIT) {
    const digest = createHash('sha256').update(name).digest('hex').slice(0, 8);
    base = `${base.slice(0, LIMIT - digest.length - 1)}_${digest}`;
  }
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `_${n}`;
    candidate = `${base.slice(0, LIMIT - suffix.length)}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Renames the tools of one Messages API request whose names the API refuses:
 * the tool definitions, the tool calls already in the conversation, and a
 * forced tool choice. Returns null when every name is already accepted. The
 * given body is not changed; the parts that change are copied.
 */
export function encodeToolNames(body: Record<string, unknown>): ToolNameCodec | null {
  const all = toolNamesIn(body);
  const invalid = [...new Set(all.filter((name) => name && !WIRE_NAME.test(name)))];
  if (invalid.length === 0) return null;
  // A wire name never takes the name of a tool that is sent as it is.
  const taken = new Set(all.filter((name) => WIRE_NAME.test(name)));
  const toWire = new Map<string, string>();
  for (const name of invalid) toWire.set(name, wireName(name, taken));
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Puts the engine's tool names back into a reply. Only a JSON `"name"` field
 * whose whole value is a wire name is changed; the same words inside text the
 * model wrote are escaped in the JSON and never match.
 */
export function toolNameDecoder(names: ReadonlyMap<string, string>): (text: string) => string {
  if (names.size === 0) return (text) => text;
  const pattern = new RegExp(
    `"name"(\\s*:\\s*)"(${[...names.keys()].map(escapeRegExp).join('|')})"`,
    'g',
  );
  return (text) =>
    text.replace(
      pattern,
      (_match, gap: string, wire: string) => `"name"${gap}${JSON.stringify(names.get(wire))}`,
    );
}

/**
 * The decoder for a streamed reply: a server-sent event can be split across
 * chunks anywhere, so text is held back to the last complete line.
 */
export class ToolNameStream {
  private pending = '';
  private readonly decode: (text: string) => string;

  constructor(names: ReadonlyMap<string, string>) {
    this.decode = toolNameDecoder(names);
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
