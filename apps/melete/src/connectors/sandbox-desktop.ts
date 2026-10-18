/**
 * The desktop the `computer.*` tools drive, whichever provider runs the
 * computer.
 *
 * A Docker computer has Melete's own desktop: its own commands, a display per
 * chat, an `open` that starts the browser on an address, and the screen as
 * text. A Maritime computer has Maritime's: a screen of its own size, the
 * actions of Maritime's API and its screenshots, one screen for everyone, and
 * neither `open` nor the screen as text. Both answer the same desktop
 * commands, so the tools, the control checks and the receipts are the same;
 * what one desktop lacks is refused in plain words before anything is sent.
 *
 * Any other provider has no desktop, and nothing here is offered for it.
 */
import type { JsonValue } from '@melete/contracts';
import {
  type DesktopCommand,
  type DesktopDisplay,
  DOCKER_DESKTOP,
  type DockerSandboxProvider,
  isDesktopProvider,
} from '../sandbox/adapters/docker.ts';
import {
  isMaritimeProvider,
  MaritimeApiError,
  type MaritimeProvider,
  maritimeActionsFor,
} from '../sandbox/adapters/maritime.ts';
import {
  SandboxAdapterRefusal,
  type SandboxHandle,
  type SandboxProvider,
} from '../sandbox/types.ts';
import { pngSize } from './sandbox-computer.ts';

export type DesktopScreen = { readonly width: number; readonly height: number };

/** What the computer tools need of a desktop. A Docker provider is one as it is. */
export type DesktopDriver = Pick<DockerSandboxProvider, 'computer'> & {
  /** The screen the tools describe and take positions in; Docker's when absent. */
  readonly screen?: DesktopScreen;
  /** Whether `computer.open` can start the browser on an address; true when absent. */
  readonly opens?: boolean;
  /** Whether the screen can be read as text; true when absent. */
  readonly screenText?: boolean;
};

/** The screen of a Maritime computer, in the frame its screenshots are taken in. */
export const MARITIME_DESKTOP: DesktopScreen = { width: 1200, height: 750 };

/** Said when a person holds a Maritime computer through its own viewer. */
export const MARITIME_HELD =
  'a person is using this computer in its viewer; wait until they hand it back, then take a fresh screenshot';

const json = (value: Record<string, JsonValue>) => new TextEncoder().encode(JSON.stringify(value));

/**
 * A position the model gave in the tools' frame, in the frame of the
 * computer's last screenshot. They are the same unless the computer's
 * screenshots come back at another size, as on a screen set up differently.
 */
export function scaledPoint(
  x: number,
  y: number,
  from: DesktopScreen,
  to: DesktopScreen,
): [number, number] {
  if (from.width === to.width && from.height === to.height) return [x, y];
  // The pixel that holds the centre of the one given, scaled up or down, so the
  // last one lands at the far edge rather than one short. In whole numbers, so
  // no rounding moves it.
  const along = (value: number, a: number, b: number) =>
    Math.min(b - 1, Math.max(0, Math.floor(((2 * value + 1) * b) / (2 * a))));
  return [along(x, from.width, to.width), along(y, from.height, to.height)];
}

/**
 * The desktop of a Maritime computer. Each step is one call to Maritime's
 * actions without the screenshot it would take, because the tools take their
 * own after the step settles. Positions are mapped into the frame of the
 * computer's last screenshot.
 */
export function maritimeDesktop(provider: MaritimeProvider): DesktopDriver {
  /** The frame of each computer's last screenshot, as Maritime takes positions in it. */
  const frames = new Map<string, DesktopScreen>();
  const at = (handle: SandboxHandle, x: number, y: number) =>
    scaledPoint(x, y, MARITIME_DESKTOP, frames.get(handle.providerSandboxId) ?? MARITIME_DESKTOP);
  const step = (handle: SandboxHandle, command: DesktopCommand): DesktopCommand => {
    if (command.kind === 'click' || command.kind === 'scroll') {
      const [x, y] = at(handle, command.x, command.y);
      return { ...command, x, y };
    }
    return command;
  };
  return {
    screen: MARITIME_DESKTOP,
    opens: false,
    screenText: false,
    async computer(
      handle: SandboxHandle,
      command: DesktopCommand,
      signal: AbortSignal,
      _display?: DesktopDisplay,
    ): Promise<Uint8Array> {
      switch (command.kind) {
        case 'screenshot': {
          const shot = await provider.screenshot(handle, signal, 'png');
          const size = pngSize(shot.bytes);
          if (size) frames.set(handle.providerSandboxId, size);
          return shot.bytes;
        }
        case 'info':
          // Maritime says nothing of the window in front.
          return json({});
        case 'text':
          throw new SandboxAdapterRefusal(
            'this computer does not give its screen as text; read the screenshot instead',
          );
        case 'open':
          throw new SandboxAdapterRefusal(
            'this computer cannot open an address by itself; click the browser’s address bar, type the address and press Return',
          );
        case 'input':
          throw new SandboxAdapterRefusal(
            'a person drives this computer in its own viewer, not through the app',
          );
      }
      const actions = maritimeActionsFor(step(handle, command)).map((action) => ({
        ...action,
        noScreenshot: true,
      }));
      try {
        await provider.act(handle, actions, signal);
      } catch (error) {
        if (
          error instanceof MaritimeApiError &&
          error.status === 409 &&
          error.slug === 'human_in_control'
        )
          throw new SandboxAdapterRefusal(MARITIME_HELD);
        throw error;
      }
      return json({});
    },
  };
}

const drivers = new WeakMap<SandboxProvider, DesktopDriver | null>();

/** The desktop of a provider's computers, or null when they have none. */
export function desktopOf(provider: SandboxProvider): DesktopDriver | null {
  if (!provider.capabilities.desktop && !isDesktopProvider(provider)) return null;
  const known = drivers.get(provider);
  if (known !== undefined) return known;
  const driver = isDesktopProvider(provider)
    ? provider
    : isMaritimeProvider(provider)
      ? maritimeDesktop(provider)
      : null;
  drivers.set(provider, driver);
  return driver;
}

/** The screen a desktop's tools describe. */
export const screenOf = (driver: DesktopDriver | null | undefined): DesktopScreen =>
  driver?.screen ?? DOCKER_DESKTOP;

/** The plain sentence a computer tool is refused with where the computer has no desktop. */
export const noDesktop = (adapter: string) =>
  `This computer has no screen to see or use: ${adapterName(adapter)} computers run commands only. Use the terminal tools instead.`;

const NAMES: Record<string, string> = {
  docker: 'Docker',
  e2b: 'E2B',
  daytona: 'Daytona',
  modal: 'Modal',
  maritime: 'Maritime',
};
const adapterName = (adapter: string) => NAMES[adapter] ?? adapter;
