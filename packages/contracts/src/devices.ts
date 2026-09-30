/**
 * A person's own computer, connected to their agent.
 *
 * A small companion program runs on the computer and holds one outbound
 * connection to the service: nothing on the computer listens for the service.
 * The person pairs it with a short one-time code from Settings, chooses what it
 * may do, and can change that or revoke it at any time. The agent reaches it
 * through the broker like any other connection, so a command or a file write
 * waits for the person's approval unless one of their rules already covers it.
 *
 * What the companion may do is decided twice: once here, where Settings keeps
 * the person's choice, and once on the computer, where the companion keeps its
 * own. Either side can refuse, and the effective permission is what both allow.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';

/** What a connected computer may be asked to do. Each is off unless the person turns it on. */
export const DEVICE_CAPABILITIES = [
  'commands',
  'files',
  'open_url',
  'screenshot',
  'browser',
] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export const deviceCapabilities = z
  .strictObject({
    commands: z.boolean(),
    files: z.boolean(),
    open_url: z.boolean(),
    screenshot: z.boolean(),
    /**
     * Use the person's own browser, signed in as them, through the browser
     * extension they installed and switched on. Off unless chosen; absent in
     * settings saved before it existed, which reads as off.
     */
    browser: z.boolean().default(false),
  })
  .meta({ id: 'DeviceCapabilities' });
export type DeviceCapabilities = z.infer<typeof deviceCapabilities>;

/** Running commands is the widest grant, so it starts off; the rest start on. */
export const DEFAULT_DEVICE_CAPABILITIES: DeviceCapabilities = {
  commands: false,
  files: true,
  open_url: true,
  screenshot: false,
  browser: false,
};

export const DEVICE_PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const;
export const devicePlatform = z.enum(DEVICE_PLATFORMS);
export type DevicePlatform = z.infer<typeof devicePlatform>;

/**
 * A folder the person chose on the computer. `name` is how the agent refers to
 * it (the first segment of every file path); `path` is where it is on that
 * computer, shown to the person and never used by the service to open anything.
 */
export const deviceFolder = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/),
  path: z.string().min(1).max(1024),
});
export type DeviceFolder = z.infer<typeof deviceFolder>;

export const DEVICE_LIMITS = {
  /** How long a pairing code can be used, once. */
  pairing_ttl_ms: 10 * 60_000,
  /** How long one poll may wait for work before answering empty. */
  poll_wait_ms: 25_000,
  /** A computer not heard from for this long is offline. */
  offline_after_ms: 60_000,
  /** Default and longest wall clock for one command. */
  default_command_timeout_ms: 30_000,
  max_command_timeout_ms: 120_000,
  /**
   * The longest command, in characters. The approval shows every character of
   * a command before it runs, so a longer one is refused rather than shown cut.
   */
  max_command_chars: 3_000,
  /** Each of stdout and stderr is kept up to this many bytes; the rest is counted and dropped. */
  max_output_bytes: 65_536,
  /** The largest file read or written in one call. */
  max_file_bytes: 1_048_576,
  /** The most directory entries one listing returns. */
  max_list_entries: 500,
  /** The largest screenshot kept. */
  max_screenshot_bytes: 8_388_608,
  /** The most folders one computer may offer. */
  max_folders: 20,
  /** The most page text one browser read returns. */
  max_page_text_bytes: 131_072,
  /** The most interactive elements one browser read lists. */
  max_page_elements: 200,
} as const;

/** How the agent asks for one thing on the computer. The tool name is `device.<tool>`. */
export const DEVICE_TOOLS = [
  'status',
  'list_files',
  'read_file',
  'write_file',
  'run',
  'open_url',
  'screenshot',
  'browser_open',
  'browser_read',
  'browser_click',
  'browser_type',
  'browser_screenshot',
] as const;
export type DeviceTool = (typeof DEVICE_TOOLS)[number];

/** Which capability each tool needs. `status` needs none: the agent may always ask what is there. */
export const DEVICE_TOOL_CAPABILITY: Record<DeviceTool, DeviceCapability | null> = {
  status: null,
  list_files: 'files',
  read_file: 'files',
  write_file: 'files',
  run: 'commands',
  open_url: 'open_url',
  screenshot: 'screenshot',
  browser_open: 'browser',
  browser_read: 'browser',
  browser_click: 'browser',
  browser_type: 'browser',
  browser_screenshot: 'browser',
};

/**
 * Where on the computer a request is carried out. The companion answers
 * `main`; the browser extension, through the companion's browser bridge,
 * answers `browser`. Each holds its own outbound poll.
 */
export const DEVICE_CHANNELS = ['main', 'browser'] as const;
export type DeviceChannel = (typeof DEVICE_CHANNELS)[number];
export const deviceChannelOf = (tool: DeviceTool): DeviceChannel =>
  tool.startsWith('browser_') ? 'browser' : 'main';

export const deviceView = z
  .strictObject({
    id: z.string(),
    connection_id: z.string(),
    name: z.string(),
    platform: devicePlatform,
    /** What the person allows from Settings. */
    capabilities: deviceCapabilities,
    /** What the companion on the computer allows. A capability is usable only when both allow it. */
    local_capabilities: deviceCapabilities,
    folders: z.array(deviceFolder),
    status: z.enum(['online', 'offline', 'revoked']),
    /** Whether the browser extension on this computer is switched on and connected now. */
    browser_connected: z.boolean(),
    companion_version: z.string().nullable(),
    paired_at: timestamp,
    last_seen_at: timestamp.nullable(),
    revoked_at: timestamp.nullable(),
  })
  .meta({ id: 'Device' });
export type DeviceView = z.infer<typeof deviceView>;

export const deviceListResponse = z.strictObject({ devices: z.array(deviceView) });
export const deviceResponse = z.strictObject({ device: deviceView });

export const devicePairingRequest = z.strictObject({
  capabilities: deviceCapabilities.default(DEFAULT_DEVICE_CAPABILITIES),
});
export const devicePairingResponse = z
  .strictObject({
    /** Eight letters and digits, shown as two groups of four. Usable once. */
    code: z.string(),
    expires_at: timestamp,
  })
  .meta({ id: 'DevicePairing' });

export const deviceUpdateRequest = z.strictObject({
  capabilities: deviceCapabilities.partial(),
});

/* ---------- what the companion sends ---------- */

/** A pairing code as typed: any case, with or without the dash or spaces. */
export const devicePairRequest = z.strictObject({
  code: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(80),
  platform: devicePlatform,
  companion_version: z.string().max(40),
  capabilities: deviceCapabilities,
  folders: z.array(deviceFolder).max(DEVICE_LIMITS.max_folders),
});
export const devicePairResponse = z.strictObject({
  device_id: z.string(),
  /** Shown once. The service keeps only its hash. */
  token: z.string(),
  name: z.string(),
  capabilities: deviceCapabilities,
});

/** Sent when the companion starts and whenever its own settings change. */
export const deviceHelloRequest = z.strictObject({
  companion_version: z.string().max(40),
  capabilities: deviceCapabilities,
  folders: z.array(deviceFolder).max(DEVICE_LIMITS.max_folders),
});
export const deviceHelloResponse = z.strictObject({
  device_id: z.string(),
  name: z.string(),
  capabilities: deviceCapabilities,
});

export const deviceRequest = z
  .strictObject({
    id: z.string(),
    tool: z.enum(DEVICE_TOOLS),
    arguments: z.record(z.string(), z.unknown()),
    /** The latest moment the answer is still wanted, in milliseconds since the epoch. */
    deadline: z.number().int(),
  })
  .meta({ id: 'DeviceRequest' });
export type DeviceRequest = z.infer<typeof deviceRequest>;

export const devicePollResponse = z.strictObject({ requests: z.array(deviceRequest) });

export const DEVICE_ERROR_CODES = [
  'capability_off',
  'outside_folders',
  'not_found',
  'too_large',
  'invalid_request',
  'failed',
  /** The browser tab named is not one this computer opened for the agent. */
  'unknown_tab',
  /** Password fields and similar are never typed into or read. */
  'protected_field',
] as const;
export const deviceResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(DEVICE_ERROR_CODES), message: z.string().max(500) }),
  }),
]);
export type DeviceResult = z.infer<typeof deviceResult>;
