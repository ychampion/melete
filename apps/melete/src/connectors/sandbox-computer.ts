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
 *
 * Each chat works on its own display of the computer (`sandbox/displays.ts`),
 * so every step, every look and the control check address that display only.
 */
import { createHash } from 'node:crypto';
import type { Action, ConnectorManifest, JsonValue } from '@melete/contracts';

type ToolManifest = ConnectorManifest['tools'][number];

import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import {
  type DesktopCommand,
  type DesktopDisplay,
  DOCKER_DESKTOP,
} from '../sandbox/adapters/docker.ts';
import type { ComputerControls } from '../sandbox/computer-control.ts';
import { displayKey } from '../sandbox/displays.ts';
import type { SessionRow } from '../sandbox/sessions.ts';
import { sessionHandle } from '../sandbox/sessions.ts';
import type { DesktopDriver, DesktopScreen } from './sandbox-desktop.ts';
import { screenText } from './screen-text.ts';

const screenOf = (driver: DesktopDriver | null | undefined): DesktopScreen =>
  driver?.screen ?? DOCKER_DESKTOP;

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

/** What every look at the screen gives back, where the screen can be read as text. */
const LOOK =
  'It carries screen_text: each element on screen with role, name, value and box in screen pixels (from the page’s accessibility tree, else OCR); read it rather than guess from pixels.';
/** The same, where it cannot. */
const LOOK_PICTURE =
  'This computer does not give its screen as text, so read the picture itself before you act on it.';

/** The most steps one `computer.batch` carries. */
export const MAX_BATCH_ACTIONS = 5;
/** What a step of a batch may do; looking is what every batch ends with. */
const BATCH_ACTIONS = ['open', 'click', 'type', 'key', 'scroll'] as const;

/** What a desktop offers the tools: its screen, and whether it opens addresses and reads as text. */
export type ComputerToolOptions = {
  screen: DesktopScreen;
  opens: boolean;
  screenText: boolean;
};

/** The computer tools for one desktop: positions within its screen, and only what it can do. */
export function computerToolsFor(options: ComputerToolOptions): ToolManifest[] {
  const { screen, opens } = options;
  const x = { type: 'integer', minimum: 0, maximum: screen.width - 1 };
  const y = { type: 'integer', minimum: 0, maximum: screen.height - 1 };
  const SCREEN = `The screen is ${screen.width}x${screen.height}, origin top left.`;
  const look = options.screenText ? LOOK : LOOK_PICTURE;
  const AFTER = options.screenText
    ? ' A screenshot taken after it, with screen_text, comes with the result.'
    : ' A screenshot taken after it comes with the result.';
  const batchActions = BATCH_ACTIONS.filter((each) => opens || each !== 'open');
  return [
    tool(
      'computer.screenshot',
      `Capture the sandbox desktop. The PNG is kept in the job workspace; the result names it${options.screenText ? ' and the window in front' : ''}. ${look} Every step already ends with one. ${SCREEN}`,
      schema({}),
      'read',
    ),
    ...(opens
      ? [
          tool(
            'computer.open',
            `Open an http or https address in the sandbox browser, the one the person sees and can take over, starting it if needed. Public HTTPS sites load when the sandbox may reach the internet. It succeeds only once the page in front shows the address (a redirect counts); otherwise it fails and says what the window shows.${AFTER}`,
            schema({ url }, ['url']),
            'write_reversible',
          ),
        ]
      : []),
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
      `Do up to ${MAX_BATCH_ACTIONS} steps in order in one call, such as click a field, type, press Tab, type; it stops at the first that fails. Each step is {"action": ${batchActions.slice(0, -1).join(', ')} or ${batchActions.at(-1)}} plus that tool's fields, without step. ${SCREEN}${AFTER}`,
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
                action: { type: 'string', enum: [...batchActions] },
                ...(opens ? { url } : {}),
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
}

/** The computer tools of Melete's own desktop, on a Docker computer. */
export const COMPUTER_TOOLS: ToolManifest[] = computerToolsFor({
  screen: DOCKER_DESKTOP,
  opens: true,
  screenText: true,
});

/** The computer tools a desktop offers. */
export const computerToolsOf = (driver: DesktopDriver): ToolManifest[] =>
  driver.screen === undefined && driver.opens !== false && driver.screenText !== false
    ? COMPUTER_TOOLS
    : computerToolsFor({
        screen: screenOf(driver),
        opens: driver.opens !== false,
        screenText: driver.screenText !== false,
      });

export const COMPUTER_TOOL_NAMES = new Set(COMPUTER_TOOLS.map((each) => each.name));

const BUTTONS = { left: 1, middle: 2, right: 3 } as const;

/** The screen positions are checked against, and whether an address may be opened. */
export type Desk = { screen: DesktopScreen; opens: boolean };
const DOCKER_DESK: Desk = { screen: DOCKER_DESKTOP, opens: true };
/** What a desktop's tools are checked against. */
export const deskOf = (driver: DesktopDriver): Desk => ({
  screen: screenOf(driver),
  opens: driver.opens !== false,
});

function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new ComputerPayloadRefusal(`${what} must be a whole number from ${min} to ${max}`);
  return value;
}

/** The desktop command an admitted single-step payload asks for; anything else is refused. */
export function desktopCommandFor(
  action: Pick<Action, 'kind' | 'canonical_payload'>,
  desk: Desk = DOCKER_DESK,
): DesktopCommand {
  const payload = action.canonical_payload as Record<string, unknown>;
  integer(payload.step, 1, 1_000_000, 'step');
  return commandOf(action.kind, payload, desk);
}

/**
 * Every desktop command an admitted payload asks for, in order: one for a
 * single action, each step of a batch. A batch with any step refused is
 * refused whole, before anything reaches the desktop.
 */
export function desktopCommandsFor(
  action: Pick<Action, 'kind' | 'canonical_payload'>,
  desk: Desk = DOCKER_DESK,
): DesktopCommand[] {
  if (action.kind !== 'computer.batch') return [desktopCommandFor(action, desk)];
  const offered = BATCH_ACTIONS.filter((each) => desk.opens || each !== 'open');
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
      !(offered as readonly unknown[]).includes(step.action)
    )
      throw new ComputerPayloadRefusal(
        `step ${index + 1} of the batch names no action: one of ${offered.join(', ')}`,
      );
    try {
      return commandOf(`computer.${step.action}`, step, desk);
    } catch (error) {
      if (error instanceof ComputerPayloadRefusal)
        throw new ComputerPayloadRefusal(`step ${index + 1} of the batch: ${error.message}`);
      throw error;
    }
  });
}

function commandOf(kind: string, payload: Record<string, unknown>, desk: Desk): DesktopCommand {
  const { width, height } = desk.screen;
  switch (kind) {
    case 'computer.screenshot':
      return { kind: 'screenshot' };
    case 'computer.open':
      if (!desk.opens)
        throw new ComputerPayloadRefusal(
          'this computer cannot open an address by itself; click the browser’s address bar, type the address and press Return',
        );
      if (typeof payload.url !== 'string' || !/^https?:\/\//i.test(payload.url))
        throw new ComputerPayloadRefusal('an address must start with http:// or https://');
      return { kind: 'open', url: payload.url };
    case 'computer.click': {
      const button = payload.button ?? 'left';
      if (typeof button !== 'string' || !(button in BUTTONS))
        throw new ComputerPayloadRefusal('a button is left, middle or right');
      return {
        kind: 'click',
        x: integer(payload.x, 0, width - 1, 'x'),
        y: integer(payload.y, 0, height - 1, 'y'),
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
        x: integer(payload.x, 0, width - 1, 'x'),
        y: integer(payload.y, 0, height - 1, 'y'),
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
 * How a step that may lead to another page (`leadsAway`) waits for it,
 * read from the title of the window in front: a link starts loading, and the
 * window still shows the page it left until the new one lands.
 */
export type PageWatch = {
  /** How long after the step the window is watched for another page before it counts as the same one. */
  startMs: number;
  /** The longest a page that started to change is waited for before the screen is captured anyway. */
  landMs: number;
  /** How often the window's title is read. */
  pollMs: number;
};
export const PAGE_WATCH: PageWatch = { startMs: 1_500, landMs: 8_000, pollMs: 250 };

/**
 * Keys that can take the browser to another page: Enter submits a form or an
 * address, Alt+Left and Alt+Right go back and forward, F5 and Ctrl+R reload.
 * Each is matched with any other modifiers held, so Ctrl+Return or
 * Ctrl+Shift+R count too.
 */
const NAVIGATING_KEYS: readonly ((parts: readonly string[]) => boolean)[] = [
  (parts) => ['return', 'enter', 'kp_enter'].includes(parts.at(-1) ?? ''),
  (parts) => parts.includes('alt') && ['left', 'right'].includes(parts.at(-1) ?? ''),
  (parts) => parts.at(-1) === 'f5',
  (parts) => parts.includes('ctrl') && parts.at(-1) === 'r',
];

const navigatingKey = (name: string) => {
  const parts = name.toLowerCase().split('+');
  return NAVIGATING_KEYS.some((matches) => matches(parts));
};

/**
 * Whether a step can take the browser to another page: a click on a link, a
 * key that submits or navigates, or typing that ends in a newline, which
 * presses Return. Other typing, other keys and scrolling stay on their page.
 */
export function leadsAway(command: DesktopCommand): boolean {
  switch (command.kind) {
    case 'click':
      return true;
    case 'key':
      return command.keys.some(navigatingKey);
    case 'type':
      return /[\r\n]$/.test(command.text);
    default:
      return false;
  }
}

/** Titles a browser window shows while no page has landed in it yet. */
const BLANK_TITLE =
  /^(?:chromium|new tab - chromium|about:blank - chromium|untitled - chromium)?$/i;

/** Said with a step whose new page had not landed when the screen was captured. */
export const PAGE_STILL_LOADING =
  'The step led to another page, which was still loading when the screen was captured, so the screenshot and screen_text may show the page before it. Take a screenshot before describing the new page.';
/** Said with a step whose new page was never captured. */
export const PAGE_NOT_OBSERVED =
  'The step led to another page, but nothing of that page was observed. Take a screenshot before describing it.';

type Landing = { changed: boolean; settled: boolean; window: string };

/**
 * Wait for the page a step led to: the window in front is read until its
 * title moves off the one the step left, then until it holds still. A step
 * after which it does not move within `startMs` stayed on its page. Null when
 * a person took the computer meanwhile.
 */
async function watchPage(
  from: string,
  started: number,
  watch: PageWatch,
  readWindow: () => Promise<string | null>,
  takenOver: () => Promise<boolean>,
): Promise<Landing | null> {
  let last = from;
  let changed = false;
  let still = 0;
  for (;;) {
    const elapsed = performance.now() - started;
    if (!changed && elapsed >= watch.startMs) return { changed, settled: true, window: last };
    if (changed && elapsed >= watch.landMs) return { changed, settled: false, window: last };
    await Bun.sleep(watch.pollMs);
    if (await takenOver()) return null;
    const now = await readWindow();
    // A window that cannot be read says nothing more: what is known so far stands.
    if (now === null) return { changed, settled: !changed, window: last };
    if (!changed) {
      if (now === from) continue;
      changed = true;
    }
    // Two more reads of one real page's title in a row: it has landed.
    still = now === last && !BLANK_TITLE.test(now) ? still + 1 : 0;
    last = now;
    if (still >= 2) return { changed, settled: true, window: now };
  }
}

/**
 * Capture the screen, keep the PNG in the job workspace at a path named for
 * the action, and say where, how big and what it is.
 */
type CaptureOptions = {
  action: Action;
  jobId: string;
  workRoot: string;
  display?: DesktopDisplay | null;
};

async function capture(
  options: CaptureOptions,
  provider: DesktopDriver,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
): Promise<Record<string, JsonValue>>;
async function capture(
  options: CaptureOptions,
  provider: DesktopDriver,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
  /** Asked once the picture is in hand; true discards it unsaved. */
  takenOver: () => Promise<boolean>,
): Promise<Record<string, JsonValue> | null>;
async function capture(
  options: CaptureOptions,
  provider: DesktopDriver,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
  takenOver?: () => Promise<boolean>,
): Promise<Record<string, JsonValue> | null> {
  const answer = await provider.computer(
    handle,
    { kind: 'screenshot' },
    signal,
    options.display ?? undefined,
  );
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
  provider: DesktopDriver,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
  display?: DesktopDisplay | null,
): Promise<JsonValue> {
  if (provider.screenText === false)
    return { unavailable: 'this computer does not give its screen as text; read the screenshot' };
  try {
    return screenText(
      await provider.computer(handle, { kind: 'text' }, signal, display ?? undefined),
    );
  } catch (error) {
    return { unavailable: `the screen's text could not be read: ${said(error)}` };
  }
}

/**
 * How long a check that a person is there is given to pass by itself (some
 * only look for a moment) before the screen is read again. One still there
 * then is the person's to pass.
 */
export const CHALLENGE_WAIT_MS = 8_000;

/** The bot check the screen's text shows, by who drew it; null when it shows none. */
export function challengeShown(screen: JsonValue): string | null {
  if (!screen || typeof screen !== 'object' || Array.isArray(screen)) return null;
  const challenge = (screen as Record<string, JsonValue>).challenge;
  return typeof challenge === 'string' ? challenge : null;
}

/** The screen read again after a check had its moment, unless a person took the computer. */
async function lookPastChallenge(
  screen: JsonValue,
  provider: DesktopDriver,
  handle: ReturnType<typeof sessionHandle>,
  signal: AbortSignal,
  waitMs: number,
  takenOver: () => Promise<boolean>,
  display?: DesktopDisplay | null,
): Promise<JsonValue> {
  if (!challengeShown(screen) || waitMs <= 0) return screen;
  await Bun.sleep(waitMs);
  if (await takenOver()) return screen;
  return readScreen(provider, handle, signal, display);
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
  provider: DesktopDriver;
  /** Who drives each computer, as every service instance sees it. */
  controls: ComputerControls;
  signal: AbortSignal;
  /** How long to wait after the last step before the screenshot. */
  settleMs?: number;
  /** How long a bot check is given to pass by itself; `CHALLENGE_WAIT_MS` unless set. */
  challengeWaitMs?: number;
  /** How a step that may lead to another page waits for it (`leadsAway`); `PAGE_WATCH` unless set. */
  pageWatch?: PageWatch;
  /** The chat's display of the computer; absent means display 0, as before displays. */
  display?: DesktopDisplay | null;
}): Promise<Record<string, JsonValue>> {
  const { action, session, provider, signal, controls } = options;
  const display = options.display ?? null;
  const commands = desktopCommandsFor(action, deskOf(provider));
  const handle = sessionHandle(session);
  // Who drives this display, not the computer: a person on another chat's
  // display holds that one only.
  const key = displayKey(session.providerSandboxId, display?.number ?? 0);
  const held = await controls.state(key);
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
    ...(display ? { display: display.number, computer_id: display.id } : {}),
  };
  if (first.kind === 'screenshot') {
    const picture = await capture(options, provider, handle, signal);
    if ((await controls.state(key)).epoch !== held.epoch) base.control_changed = true;
    const info = infoOf(
      await provider
        .computer(handle, { kind: 'info' }, signal, display ?? undefined)
        .catch(() => new Uint8Array()),
    );
    const moved = async () => {
      const now = await controls.state(key);
      return now.control === 'human' || now.epoch !== held.epoch;
    };
    let screen = await lookPastChallenge(
      await readScreen(provider, handle, signal, display),
      provider,
      handle,
      signal,
      options.challengeWaitMs ?? CHALLENGE_WAIT_MS,
      moved,
      display,
    );
    // Read after the picture: what a person who took the computer meanwhile
    // has on the screen, what they type included, is never returned.
    const after = await controls.state(key);
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
      const now = await controls.state(key);
      if (now.control === 'human' || now.epoch !== held.epoch) {
        stopped = `a person took control of this computer before step ${index + 1}; the rest did not run`;
        break;
      }
    }
    let answer: Uint8Array;
    try {
      answer = await provider.computer(handle, command, signal, display ?? undefined);
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
  if ((await controls.state(key)).epoch !== held.epoch) base.control_changed = true;
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
  const started = performance.now();
  const settle = options.settleMs ?? (commands.at(-1)?.kind === 'open' ? 0 : SETTLE_MS);
  if (settle > 0) await Bun.sleep(settle);
  // A person who takes the computer while the screen settles, or while it is
  // captured, is never shown to the model: checked before the capture and
  // again before the picture is kept.
  const takenOver = async () => {
    const now = await controls.state(key);
    return now.control === 'human' || now.epoch !== held.epoch;
  };
  if (await takenOver()) return notTaken;
  // A step that led to another page is captured once that page has
  // landed, so the screen the model is shown is the page it would describe.
  // The window it left is the one the step itself read, right after it.
  const from = steps.at(-1)?.window;
  const last = commands[steps.length - 1];
  let landing: Landing | null = null;
  if (last && leadsAway(last) && typeof from === 'string' && from) {
    landing = await watchPage(
      from,
      started,
      options.pageWatch ?? PAGE_WATCH,
      async () => {
        try {
          const info = infoOf(
            await provider.computer(handle, { kind: 'info' }, signal, display ?? undefined),
          );
          return typeof info.window === 'string' ? info.window : null;
        } catch {
          return null;
        }
      },
      takenOver,
    );
    if (!landing) return notTaken;
  }
  const landed: Record<string, JsonValue> = landing
    ? {
        ...done,
        window: landing.window,
        page_changed: landing.changed,
        ...(landing.changed && !landing.settled ? { page_note: PAGE_STILL_LOADING } : {}),
      }
    : done;
  try {
    const picture = await capture(options, provider, handle, signal, takenOver);
    if (!picture) return notTaken;
    const screen = await lookPastChallenge(
      await readScreen(provider, handle, signal, display),
      provider,
      handle,
      signal,
      options.challengeWaitMs ?? CHALLENGE_WAIT_MS,
      takenOver,
      display,
    );
    // Read after the picture: a person who took the computer meanwhile is not shown either.
    if (await takenOver()) return notTaken;
    return { ...landed, ...picture, screen_text: screen };
  } catch (error) {
    return {
      ...landed,
      screenshot: `not taken: ${said(error)}`,
      ...(landing?.changed ? { page_note: PAGE_NOT_OBSERVED } : {}),
    };
  }
}
