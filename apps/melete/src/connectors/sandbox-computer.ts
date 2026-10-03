/**
 * The agent's hands on the desktop inside its sandbox.
 *
 * Each tool is one brokered action on the sandbox connection: the broker
 * admits it, this connector runs it in the agent's own container, and the
 * receipt says what happened. Looking is a read; clicking, typing, pressing a
 * key, scrolling and opening a page change the sandbox and nothing else, so
 * they are `write_reversible` like a command in the same sandbox, bounded by
 * the egress the connection allows. While a person holds control of the
 * computer every one of them is refused, whatever the agent planned before.
 *
 * A screenshot is kept in the job workspace as a PNG, and the receipt carries
 * where, how big, its digest and the title of the window in front.
 */
import { createHash } from 'node:crypto';
import type { Action, ConnectorManifest, JsonValue } from '@melete/contracts';

type ToolManifest = ConnectorManifest['tools'][number];

import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import {
  type DesktopCommand,
  DOCKER_DESKTOP,
  type DockerSandboxProvider,
} from '../sandbox/adapters/docker.ts';
import { computerControls } from '../sandbox/computer-control.ts';
import type { SessionRow } from '../sandbox/sessions.ts';
import { sessionHandle } from '../sandbox/sessions.ts';

/**
 * Every computer action names its step. The broker treats a proposal with the
 * same arguments as the same action, so without a counter a second screenshot
 * would return the first.
 */
const step = {
  type: 'integer',
  minimum: 1,
  maximum: 1_000_000,
  description:
    'Counts your computer actions in this job: 1, 2, 3 and so on. A number used before repeats nothing and returns the earlier result.',
};
const x = { type: 'integer', minimum: 0, maximum: DOCKER_DESKTOP.width - 1 };
const y = { type: 'integer', minimum: 0, maximum: DOCKER_DESKTOP.height - 1 };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  required: ['step', ...required],
  properties: { step, ...properties },
});
const tool = (
  name: string,
  description: string,
  input_schema: Record<string, unknown>,
  effect_class: 'read' | 'write_reversible',
): ToolManifest => ({
  name,
  description,
  input_schema,
  effect_class,
  required_scopes: [name],
  verify: true,
  requires_approval: false,
  record_schema: null,
});

const SCREEN = `The screen is ${DOCKER_DESKTOP.width}x${DOCKER_DESKTOP.height}, origin top left.`;

export const COMPUTER_TOOLS: ToolManifest[] = [
  tool(
    'computer.screenshot',
    `Capture the sandbox desktop. The PNG is kept in the job workspace; the result names it and the window in front. ${SCREEN}`,
    schema({}),
    'read',
  ),
  tool(
    'computer.open',
    'Open an http or https address in the sandbox browser, starting it if needed. Public HTTPS sites load when the sandbox may reach the internet. The result says whether the window moved to the address (navigated) and the title it shows; when navigated is false, the page did not open, so say so rather than describing it.',
    schema({ url: { type: 'string', minLength: 8, maxLength: 2048 } }, ['url']),
    'write_reversible',
  ),
  tool(
    'computer.click',
    `Click at a point on the sandbox desktop. ${SCREEN}`,
    schema(
      {
        x,
        y,
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        clicks: { type: 'integer', minimum: 1, maximum: 3 },
      },
      ['x', 'y'],
    ),
    'write_reversible',
  ),
  tool(
    'computer.type',
    'Type text into whatever has focus on the sandbox desktop.',
    schema({ text: { type: 'string', minLength: 1, maxLength: 4096 } }, ['text']),
    'write_reversible',
  ),
  tool(
    'computer.key',
    'Press keys on the sandbox desktop, in order: names such as Return, Tab, Escape, BackSpace, or combinations such as ctrl+l.',
    schema(
      {
        keys: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string', pattern: '^[A-Za-z0-9_+]{1,48}$' },
        },
      },
      ['keys'],
    ),
    'write_reversible',
  ),
  tool(
    'computer.scroll',
    `Scroll at a point: a positive amount scrolls down, a negative one up, in wheel steps. ${SCREEN}`,
    schema({ x, y, amount: { type: 'integer', minimum: -50, maximum: 50 } }, ['x', 'y', 'amount']),
    'write_reversible',
  ),
];

export const COMPUTER_TOOL_NAMES = new Set(COMPUTER_TOOLS.map((each) => each.name));

const BUTTONS = { left: 1, middle: 2, right: 3 } as const;

function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new ComputerPayloadRefusal(`${what} must be a whole number from ${min} to ${max}`);
  return value;
}

/** The desktop command an admitted payload asks for; anything else is refused. */
export function desktopCommandFor(
  action: Pick<Action, 'kind' | 'canonical_payload'>,
): DesktopCommand {
  const payload = action.canonical_payload as Record<string, unknown>;
  integer(payload.step, 1, 1_000_000, 'step');
  switch (action.kind) {
    case 'computer.screenshot':
      return { kind: 'screenshot' };
    case 'computer.open':
      if (typeof payload.url !== 'string' || !/^https?:\/\//i.test(payload.url))
        throw new ComputerPayloadRefusal('an address must start with http:// or https://');
      return { kind: 'open', url: payload.url };
    case 'computer.click': {
      const button = payload.button ?? 'left';
      if (typeof button !== 'string' || !(button in BUTTONS))
        throw new ComputerPayloadRefusal('a button is left, middle or right');
      return {
        kind: 'click',
        x: integer(payload.x, 0, DOCKER_DESKTOP.width - 1, 'x'),
        y: integer(payload.y, 0, DOCKER_DESKTOP.height - 1, 'y'),
        button: BUTTONS[button as keyof typeof BUTTONS],
        count: integer(payload.clicks ?? 1, 1, 3, 'clicks') as 1 | 2 | 3,
      };
    }
    case 'computer.type':
      if (typeof payload.text !== 'string' || !payload.text.length || payload.text.length > 4096)
        throw new ComputerPayloadRefusal('text is 1 to 4096 characters');
      return { kind: 'type', text: payload.text };
    case 'computer.key':
      if (
        !Array.isArray(payload.keys) ||
        !payload.keys.length ||
        payload.keys.length > 16 ||
        payload.keys.some((key) => typeof key !== 'string' || !/^[A-Za-z0-9_+]{1,48}$/.test(key))
      )
        throw new ComputerPayloadRefusal('keys are 1 to 16 names such as Return or ctrl+l');
      return { kind: 'key', keys: payload.keys as string[] };
    case 'computer.scroll': {
      const amount = integer(payload.amount, -50, 50, 'amount');
      if (amount === 0) throw new ComputerPayloadRefusal('a scroll of nothing does nothing');
      return {
        kind: 'scroll',
        x: integer(payload.x, 0, DOCKER_DESKTOP.width - 1, 'x'),
        y: integer(payload.y, 0, DOCKER_DESKTOP.height - 1, 'y'),
        dy: amount,
      };
    }
    default:
      throw new ComputerPayloadRefusal(`${action.kind} is not a computer action`);
  }
}

/** Width and height from a PNG's header, or null when it is not one. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function infoOf(bytes: Uint8Array): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(text(bytes)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

export class HumanControlRefusal extends Error {
  override readonly name = 'HumanControlRefusal';
}

/** The admitted arguments do not describe a computer action; nothing was sent. */
export class ComputerPayloadRefusal extends Error {
  override readonly name = 'ComputerPayloadRefusal';
}

/**
 * Carry out one admitted computer action in the session's container and say
 * what happened, in the words a receipt keeps.
 */
export async function runComputerAction(options: {
  action: Action;
  jobId: string;
  workRoot: string;
  session: SessionRow;
  provider: DockerSandboxProvider;
  signal: AbortSignal;
}): Promise<Record<string, JsonValue>> {
  const { action, session, provider, signal } = options;
  const command = desktopCommandFor(action);
  const handle = sessionHandle(session);
  const held = computerControls.state(session.providerSandboxId);
  if (held.control === 'human')
    throw new HumanControlRefusal(
      'a person has taken control of this computer; wait until they hand it back, then take a fresh screenshot',
    );
  const base: Record<string, JsonValue> = {
    computer: command.kind,
    session_id: session.id,
    sandbox_id: session.providerSandboxId,
    control_epoch: held.epoch,
  };
  const answer = await provider.computer(handle, command, signal);
  // Checked again after the action: a takeover that landed while it ran is said so.
  if (computerControls.state(session.providerSandboxId).epoch !== held.epoch)
    base.control_changed = true;
  if (command.kind !== 'screenshot') return { ...base, ...infoOf(answer) };
  const size = pngSize(answer);
  if (!size) throw new Error('the desktop did not answer with an image');
  const path = `.melete/computer/${action.id}.png`;
  await new LocalWorkspaceFs(options.workRoot).write(options.jobId, path, answer, 0o644);
  const info = infoOf(
    await provider.computer(handle, { kind: 'info' }, signal).catch(() => new Uint8Array()),
  );
  return {
    ...base,
    path,
    width: size.width,
    height: size.height,
    bytes: answer.byteLength,
    sha256: createHash('sha256').update(answer).digest('hex'),
    ...(typeof info.window === 'string' ? { window: info.window } : {}),
    ...(typeof info.browser === 'boolean' ? { browser: info.browser } : {}),
  };
}
