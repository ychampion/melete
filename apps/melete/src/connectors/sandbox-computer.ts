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
 * where, how big, its digest and the title of the window in front, and the
 * screen as text (`screen-text.ts`): the page's accessibility tree, or OCR, so
 * a model that reads no pictures still knows what is there. Every other action
 * ends with one too, so the agent sees what its step did without asking again;
 * `computer.batch` runs a few steps in order and captures the screen once,
 * after the last.
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
import type { ComputerControls } from '../sandbox/computer-control.ts';
import type { SessionRow } from '../sandbox/sessions.ts';
import { sessionHandle } from '../sandbox/sessions.ts';
import { screenText } from './screen-text.ts';

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

const url = { type: 'string', minLength: 8, maxLength: 2048 };
const button = { type: 'string', enum: ['left', 'middle', 'right'] };
const clicks = { type: 'integer', minimum: 1, maximum: 3 };
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const keys = {
  type: 'array',
  minItems: 1,
  maxItems: 16,
  items: { type: 'string', pattern: '^[A-Za-z0-9_+]{1,48}$' },
};
const amount = { type: 'integer', minimum: -50, maximum: 50 };

const SCREEN = `The screen is ${DOCKER_DESKTOP.width}x${DOCKER_DESKTOP.height}, origin top left.`;
/** What every look at the screen gives back. */
const LOOK =
  'It carries screen_text: each element on screen with role, name, value and box in screen pixels (from the page’s accessibility tree, else OCR); read it rather than guess from pixels.';
/** Said of every action that ends with a screenshot. */
const AFTER = ' A screenshot taken after it, with screen_text, comes with the result.';

/** The most steps one `computer.batch` carries. */
export const MAX_BATCH_ACTIONS = 5;
/** What a step of a batch may do; looking is what every batch ends with. */
const BATCH_ACTIONS = ['open', 'click', 'type', 'key', 'scroll'] as const;

export const COMPUTER_TOOLS: ToolManifest[] = [
  tool(
    'computer.screenshot',
    `Capture the sandbox desktop. The PNG is kept in the job workspace; the result names it and the window in front. ${LOOK} Every step already ends with one. ${SCREEN}`,
    schema({}),
    'read',
  ),
  tool(
    'computer.open',
    `Open an http or https address in the sandbox browser, the one the person sees and can take over, starting it if needed; a later open reuses its window. Public HTTPS sites load when the sandbox may reach the internet. It succeeds only once the page in front shows the address (a site sending you on counts); otherwise it fails and says what the window shows.${AFTER}`,
    schema({ url }, ['url']),
    'write_reversible',
  ),
  tool(
    'computer.click',
    `Click at a point on the sandbox desktop. ${SCREEN}${AFTER}`,
    schema({ x, y, button, clicks }, ['x', 'y']),
    'write_reversible',
  ),
  tool(
    'computer.type',
    `Type text into whatever has focus on the sandbox desktop.${AFTER}`,
    schema({ text }, ['text']),
    'write_reversible',
  ),
  tool(
    'computer.key',
    `Press keys on the sandbox desktop, in order: names such as Return, Tab, Escape, BackSpace, or combinations such as ctrl+l.${AFTER}`,
    schema({ keys }, ['keys']),
    'write_reversible',
  ),
  tool(
    'computer.scroll',
    `Scroll at a point: a positive amount scrolls down, a negative one up, in wheel steps. ${SCREEN}${AFTER}`,
    schema({ x, y, amount }, ['x', 'y', 'amount']),
    'write_reversible',
  ),
  tool(
    'computer.batch',
    `Do up to ${MAX_BATCH_ACTIONS} steps in order in one call, such as click a field, type, press Tab, type; it stops at the first that fails. Each step is {"action": open, click, type, key or scroll} plus that tool's fields, without step. ${SCREEN}${AFTER}`,
    schema(
      {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH_ACTIONS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            properties: {
              action: { type: 'string', enum: [...BATCH_ACTIONS] },
              url,
              x,
              y,
              button,
              clicks,
              text,
              keys,
              amount,
            },
          },
        },
      },
      ['actions'],
    ),
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

/** The desktop command an admitted single-step payload asks for; anything else is refused. */
export function desktopCommandFor(
  action: Pick<Action, 'kind' | 'canonical_payload'>,
): DesktopCommand {
  const payload = action.canonical_payload as Record<string, unknown>;
  integer(payload.step, 1, 1_000_000, 'step');
  return commandOf(action.kind, payload);
}

/**
 * Every desktop command an admitted payload asks for, in order: one for a
 * single action, each step of a batch. A batch with any step refused is
 * refused whole, before anything reaches the desktop.
 */
export function desktopCommandsFor(
  action: Pick<Action, 'kind' | 'canonical_payload'>,
): DesktopCommand[] {
  if (action.kind !== 'computer.batch') return [desktopCommandFor(action)];
  const payload = action.canonical_payload as Record<string, unknown>;
  integer(payload.step, 1, 1_000_000, 'step');
  const steps = payload.actions;
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_BATCH_ACTIONS)
    throw new ComputerPayloadRefusal(`a batch is 1 to ${MAX_BATCH_ACTIONS} steps`);
  return steps.map((each: unknown, index) => {
    const step = each as Record<string, unknown> | null;
    if (
      !step ||
      typeof step !== 'object' ||
      Array.isArray(step) ||
      !(BATCH_ACTIONS as readonly unknown[]).includes(step.action)
    )
      throw new ComputerPayloadRefusal(
        `step ${index + 1} of the batch names no action: one of ${BATCH_ACTIONS.join(', ')}`,
      );
    try {
      return commandOf(`computer.${step.action}`, step);
    } catch (error) {
      if (error instanceof ComputerPayloadRefusal)
        throw new ComputerPayloadRefusal(`step ${index + 1} of the batch: ${error.message}`);
      throw error;
    }
  });
}

function commandOf(kind: string, payload: Record<string, unknown>): DesktopCommand {
  switch (kind) {
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
      throw new ComputerPayloadRefusal(`${kind} is not a computer action`);
  }
}

/** Width and height from a PNG's header, or null when it is not one. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const decoded = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function infoOf(bytes: Uint8Array): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(decoded(bytes)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

export class HumanControlRefusal extends Error {
  override readonly name = 'HumanControlRefusal';
}

/** An open after which the page in front is not the address asked for: the step did not happen. */
export class ComputerOpenFailed extends Error {
  override readonly name = 'ComputerOpenFailed';
}

const shortText = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim()
    ? value.trim().length > max
      ? `${value.trim().slice(0, max - 1)}…`
      : value.trim()
    : null;

/**
 * Why an open did not bring the address to the front, with what the window
 * shows instead, as the desktop said; null when it did, or for any other step.
 */
export function openFailure(
  command: DesktopCommand,
  info: Record<string, JsonValue>,
): string | null {
  if (command.kind !== 'open' || info.navigated !== false) return null;
  const address = shortText(info.address, 300);
  const title = shortText(info.window, 200);
  const shows =
    address && title
      ? `${address} ("${title}")`
      : (address ?? (title ? `"${title}"` : 'nothing it could read'));
  const reason = shortText(info.reason, 200);
  return `the browser did not open ${shortText(command.url, 300)}${reason ? `: ${reason}` : ''}. The window in front shows ${shows}. Look at the screen and try again in this browser, which the person can see; one started from a command is hidden from them`;
}

/** The admitted arguments do not describe a computer action; nothing was sent. */
export class ComputerPayloadRefusal extends Error {
  override readonly name = 'ComputerPayloadRefusal';
}

/** A pause after a step, so the screenshot shows what it did rather than the frame before. */
const SETTLE_MS = 300;

/**
 * Capture the screen, keep the PNG in the job workspace at a path named for
 * the action, and say where, how big and what it is.
 */
async function capture(
  options: { action: Action; jobId: string; workRoot: string },
  provider: DockerSandboxProvider,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
): Promise<Record<string, JsonValue>>;
async function capture(
  options: { action: Action; jobId: string; workRoot: string },
  provider: DockerSandboxProvider,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
  /** Asked once the picture is in hand; true discards it unsaved. */
  takenOver: () => Promise<boolean>,
): Promise<Record<string, JsonValue> | null>;
async function capture(
  options: { action: Action; jobId: string; workRoot: string },
  provider: DockerSandboxProvider,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
  takenOver?: () => Promise<boolean>,
): Promise<Record<string, JsonValue> | null> {
  const answer = await provider.computer(handle, { kind: 'screenshot' }, signal);
  const size = pngSize(answer);
  if (!size) throw new Error('the desktop did not answer with an image');
  if (takenOver && (await takenOver())) return null;
  const path = `.melete/computer/${options.action.id}.png`;
  await new LocalWorkspaceFs(options.workRoot).write(options.jobId, path, answer, 0o644);
  return {
    path,
    width: size.width,
    height: size.height,
    bytes: answer.byteLength,
    sha256: createHash('sha256').update(answer).digest('hex'),
  };
}

const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The screen as text, or why it could not be read; never a failure of the step. */
async function readScreen(
  provider: DockerSandboxProvider,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
): Promise<JsonValue> {
  try {
    return screenText(await provider.computer(handle, { kind: 'text' }, signal));
  } catch (error) {
    return { unavailable: `the screen's text could not be read: ${said(error)}` };
  }
}

/**
 * Carry out one admitted computer action in the session's container and say
 * what happened, in the words a receipt keeps. Every action but a screenshot
 * ends with one, taken after it, unless a person took the computer meanwhile:
 * a screenshot that fails after the action ran is said so, and never turns a
 * step that happened into a failure.
 */
export async function runComputerAction(options: {
  action: Action;
  jobId: string;
  workRoot: string;
  session: SessionRow;
  provider: DockerSandboxProvider;
  /** Who drives each computer, as every service instance sees it. */
  controls: ComputerControls;
  signal: AbortSignal;
  /** How long to wait after the last step before the screenshot. */
  settleMs?: number;
}): Promise<Record<string, JsonValue>> {
  const { action, session, provider, signal, controls } = options;
  const commands = desktopCommandsFor(action);
  const handle = sessionHandle(session);
  const held = await controls.state(session.providerSandboxId);
  if (held.control === 'human')
    throw new HumanControlRefusal(
      'a person has taken control of this computer; wait until they hand it back, then take a fresh screenshot',
    );
  const batch = action.kind === 'computer.batch';
  const first = commands[0] as DesktopCommand;
  const base: Record<string, JsonValue> = {
    computer: batch ? 'batch' : first.kind,
    session_id: session.id,
    sandbox_id: session.providerSandboxId,
    control_epoch: held.epoch,
  };
  if (first.kind === 'screenshot') {
    const picture = await capture(options, provider, handle, signal);
    if ((await controls.state(session.providerSandboxId)).epoch !== held.epoch)
      base.control_changed = true;
    const info = infoOf(
      await provider.computer(handle, { kind: 'info' }, signal).catch(() => new Uint8Array()),
    );
    let screen = await readScreen(provider, handle, signal);
    // Read after the picture: what a person who took the computer meanwhile
    // has on the screen, what they type included, is never returned.
    const after = await controls.state(session.providerSandboxId);
    if (after.control === 'human' || after.epoch !== held.epoch) {
      base.control_changed = true;
      screen = { unavailable: 'not read: a person took control of this computer' };
    }
    return {
      ...base,
      ...picture,
      ...(typeof info.window === 'string' ? { window: info.window } : {}),
      ...(typeof info.browser === 'boolean' ? { browser: info.browser } : {}),
      screen_text: screen,
    };
  }
  const steps: Record<string, JsonValue>[] = [];
  let stopped: string | null = null;
  for (const [index, command] of commands.entries()) {
    if (index > 0) {
      // A person who takes the computer between steps stops the rest.
      const now = await controls.state(session.providerSandboxId);
      if (now.control === 'human' || now.epoch !== held.epoch) {
        stopped = `a person took control of this computer before step ${index + 1}; the rest did not run`;
        break;
      }
    }
    let answer: Uint8Array;
    try {
      answer = await provider.computer(handle, command, signal);
    } catch (error) {
      // The first step failing is the action failing, as for a single step.
      if (index === 0) throw error;
      stopped = `step ${index + 1} (${command.kind}) failed: ${said(error)}; the steps after it did not run`;
      break;
    }
    const info = infoOf(answer);
    // An open that left another page in front did not happen: the steps
    // after it would act on the wrong page.
    const notOpened = openFailure(command, info);
    if (notOpened) {
      if (index === 0) throw new ComputerOpenFailed(notOpened);
      stopped = `step ${index + 1} (open) failed: ${notOpened}; the steps after it did not run`;
      break;
    }
    steps.push({ computer: command.kind, ...info });
  }
  // Checked again after the action: a takeover that landed while it ran is said so.
  if ((await controls.state(session.providerSandboxId)).epoch !== held.epoch)
    base.control_changed = true;
  const done: Record<string, JsonValue> = batch
    ? {
        ...base,
        steps,
        completed: steps.length,
        requested: commands.length,
        ...(stopped ? { stopped } : {}),
      }
    : { ...base, ...(steps[0] ?? {}) };
  const notTaken = {
    ...done,
    control_changed: true,
    screenshot: 'not taken: a person took control',
  };
  if (base.control_changed) return notTaken;
  const settle = options.settleMs ?? (commands.at(-1)?.kind === 'open' ? 0 : SETTLE_MS);
  if (settle > 0) await Bun.sleep(settle);
  // A person who takes the computer while the screen settles, or while it is
  // captured, is never shown to the model: checked before the capture and
  // again before the picture is kept.
  const takenOver = async () => {
    const now = await controls.state(session.providerSandboxId);
    return now.control === 'human' || now.epoch !== held.epoch;
  };
  if (await takenOver()) return notTaken;
  try {
    const picture = await capture(options, provider, handle, signal, takenOver);
    if (!picture) return notTaken;
    const screen = await readScreen(provider, handle, signal);
    // Read after the picture: a person who took the computer meanwhile is not shown either.
    if (await takenOver()) return notTaken;
    return { ...done, ...picture, screen_text: screen };
  } catch (error) {
    return { ...done, screenshot: `not taken: ${said(error)}` };
  }
}
