/**
 * The agent's reach into a person's own computer, as a broker connector.
 *
 * Each paired computer is one connection with this connector. The tools are
 * the same on every computer; the connection's scopes say which of them the
 * agent is offered, and those follow what both Settings and the companion
 * allow. This connector checks the capability again against the stored row at
 * every call, validates every path and address before anything leaves the
 * service, and hands the request to the computer through the hub. The
 * companion checks all of it once more on the computer.
 *
 * The tool set is kept in this module, apart from the workspace and sandbox
 * tools, so the two can be unified once both settle. Where a shape already
 * exists it is reused: `device.run` takes `command`, `cwd` and `timeout_ms`
 * like `terminal.run`, and its receipt carries `exit_code`, `timed_out` and
 * `output` like a command in the workspace.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Action,
  type ConnectorManifest,
  DEVICE_LIMITS,
  DEVICE_TOOL_CAPABILITY,
  DEVICE_TOOLS,
  type DeviceCapabilities,
  type DeviceFolder,
  type DeviceTool,
  type DispatchResult,
  deviceChannelOf,
  type JsonObject,
  type JsonValue,
  type Receipt,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { ConnectorFaultError } from '../connectors/faults.ts';
import type { Connector, ConnectorContext } from '../connectors/types.ts';
import { type DeviceHub, sharedDeviceHub } from './hub.ts';
import {
  DevicePathError,
  devicePath,
  namesLocalNetwork,
  openableUrl,
  pageAddress,
} from './paths.ts';

const pathArgument = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  description:
    'A shared folder name, then a path inside it with forward slashes, e.g. "Projects/notes/todo.md". device.status lists the folder names.',
};

const tabArgument = {
  type: 'integer',
  minimum: 0,
  description: 'The tab id device.browser_open returned.',
};
/** What an element was when the tab was last read; also what the extension checks before acting. */
const elementShape = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', maxLength: 40 },
    name: { type: 'string', maxLength: 300 },
    tag: { type: 'string', maxLength: 40 },
    shows: { type: 'string', maxLength: 300 },
    target: { type: 'string', maxLength: 2048 },
  },
  required: ['role', 'name'],
};
const expectArgument = {
  type: 'object',
  additionalProperties: false,
  description:
    'Filled in by Melete from the latest device.browser_read of the tab: the page and the element the person approves. Leave it out.',
  properties: {
    url: { type: 'string', maxLength: 2048 },
    title: { type: 'string', maxLength: 1024 },
    element: elementShape,
  },
  required: ['url', 'element'],
};
const refArgument = {
  type: 'string',
  pattern: '^e[0-9]{1,5}$',
  description: 'The ref device.browser_read gave the element, like "e12".',
};

type ToolShape = {
  description: string;
  input_schema: Record<string, unknown>;
  effect_class: 'read' | 'write_reversible' | 'write_external';
  requires_approval: boolean;
  verify: boolean;
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

export const DEVICE_TOOL_SHAPES: Record<DeviceTool, ToolShape> = {
  status: {
    description:
      "Check the person's connected computer: whether it is online, what it allows, and the names of its shared folders. It is theirs, not yours: what it allows says nothing about your own computer and terminal.",
    input_schema: object({}),
    effect_class: 'read',
    requires_approval: false,
    verify: false,
  },
  list_files: {
    description: "List a folder on the person's computer, inside the folders they shared.",
    input_schema: object({ path: pathArgument }, ['path']),
    effect_class: 'read',
    requires_approval: false,
    verify: false,
  },
  read_file: {
    description: "Read a text file on the person's computer, inside the folders they shared.",
    input_schema: object({ path: pathArgument }, ['path']),
    effect_class: 'read',
    requires_approval: false,
    verify: false,
  },
  write_file: {
    description:
      "Write a text file on the person's computer, inside the folders they shared. The person approves it first.",
    input_schema: object(
      {
        path: pathArgument,
        content: { type: 'string', maxLength: DEVICE_LIMITS.max_file_bytes },
      },
      ['path', 'content'],
    ),
    effect_class: 'write_external',
    requires_approval: true,
    verify: true,
  },
  run: {
    description:
      "Run a shell command on the person's computer, as them, in one of their shared folders. The person approves the exact command first. Use it only when they ask for their computer; run other commands on your own.",
    input_schema: object(
      {
        command: { type: 'string', minLength: 1, maxLength: DEVICE_LIMITS.max_command_chars },
        cwd: {
          ...pathArgument,
          description:
            'The shared folder, or a folder inside it, to run in. Defaults to the first shared folder.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 100,
          maximum: DEVICE_LIMITS.max_command_timeout_ms,
        },
      },
      ['command'],
    ),
    effect_class: 'write_external',
    requires_approval: true,
    verify: false,
  },
  open_url: {
    description:
      "Open a web page in the default browser on the person's computer. An address on that computer or its local network is opened only after the person approves it.",
    input_schema: object({ url: { type: 'string', minLength: 1, maxLength: 2048 } }, ['url']),
    effect_class: 'write_reversible',
    requires_approval: false,
    verify: false,
  },
  screenshot: {
    description: "Take a screenshot of the person's screen.",
    input_schema: object({}),
    effect_class: 'read',
    requires_approval: false,
    verify: false,
  },
  browser_open: {
    description:
      "Open a page in the person's own browser, where they are already signed in. Use this for any site that needs their account: bills, insurance, school, government and other portals. Returns a tab id for the other browser tools.",
    input_schema: object({ url: { type: 'string', minLength: 1, maxLength: 2048 } }, ['url']),
    effect_class: 'write_reversible',
    requires_approval: false,
    verify: false,
  },
  browser_read: {
    description:
      "Read a tab opened with device.browser_open in the person's own browser: its address, title, visible text, and the links, buttons and fields on it, each with a ref for device.browser_click and device.browser_type.",
    input_schema: object({ tab_id: tabArgument }, ['tab_id']),
    effect_class: 'read',
    requires_approval: false,
    verify: false,
  },
  browser_click: {
    description:
      "Click a link or button, by the ref device.browser_read gave it, in a tab of the person's own browser. Read the tab first: the person approves the page and the element that read showed, and nothing is clicked if either has changed since.",
    input_schema: object({ tab_id: tabArgument, ref: refArgument, expect: expectArgument }, [
      'tab_id',
      'ref',
    ]),
    effect_class: 'write_external',
    requires_approval: true,
    verify: false,
  },
  browser_type: {
    description:
      "Type text into a field, by the ref device.browser_read gave it, in a tab of the person's own browser. Password fields are never typed into. The person approves it first.",
    input_schema: object(
      {
        tab_id: tabArgument,
        ref: refArgument,
        text: { type: 'string', maxLength: DEVICE_LIMITS.max_typed_chars },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        expect: expectArgument,
      },
      ['tab_id', 'ref', 'text'],
    ),
    effect_class: 'write_external',
    requires_approval: true,
    verify: false,
  },
  browser_screenshot: {
    description:
      "Take a screenshot of a tab opened with device.browser_open in the person's own browser.",
    input_schema: object({ tab_id: tabArgument }, ['tab_id']),
    effect_class: 'read',
    requires_approval: false,
    verify: false,
  },
};

export const deviceToolName = (tool: DeviceTool) => `device.${tool}`;

export function deviceManifest(name: string): ConnectorManifest {
  return {
    name: 'device',
    version: '0.1.0',
    provider: 'device',
    description: `The person's own computer, ${name}, reached through the companion they paired.`,
    credentials: [],
    health: true,
    tools: DEVICE_TOOLS.map((tool) => ({
      name: deviceToolName(tool),
      description: DEVICE_TOOL_SHAPES[tool].description.replace(
        "the person's computer",
        `the person's computer "${name}"`,
      ),
      input_schema: DEVICE_TOOL_SHAPES[tool].input_schema,
      effect_class: DEVICE_TOOL_SHAPES[tool].effect_class,
      required_scopes: [deviceToolName(tool)],
      verify: DEVICE_TOOL_SHAPES[tool].verify,
      requires_approval: DEVICE_TOOL_SHAPES[tool].requires_approval,
      record_schema: null,
    })),
  };
}

/** A capability is usable only when both Settings and the companion allow it. */
export function effectiveCapabilities(
  granted: DeviceCapabilities,
  local: DeviceCapabilities,
): DeviceCapabilities {
  return {
    commands: granted.commands && local.commands,
    files: granted.files && local.files,
    open_url: granted.open_url && local.open_url,
    screenshot: granted.screenshot && local.screenshot,
    browser: Boolean(granted.browser && local.browser),
  };
}

/** The connection scopes for a computer: `device.status` always, the rest as allowed. */
export function deviceScopes(granted: DeviceCapabilities, local: DeviceCapabilities): string[] {
  const allowed = effectiveCapabilities(granted, local);
  return DEVICE_TOOLS.filter((tool) => {
    const capability = DEVICE_TOOL_CAPABILITY[tool];
    return capability === null || allowed[capability];
  }).map(deviceToolName);
}

const CAPABILITY_WORDS: Record<keyof DeviceCapabilities, string> = {
  commands: 'Running commands',
  files: 'Using files',
  open_url: 'Opening web pages',
  screenshot: 'Taking screenshots',
  browser: 'Using your browser',
};

type DeviceRow = {
  id: string;
  name: string;
  platform: string;
  capabilities: DeviceCapabilities;
  local_capabilities: DeviceCapabilities;
  folders: DeviceFolder[];
  revoked_at: Date | null;
  connection_status: string;
};

/* What the companion answers, checked before any of it reaches a receipt. */
const listResult = z.object({
  entries: z
    .array(
      z.object({
        name: z.string().max(1024),
        kind: z.enum(['file', 'directory', 'other']),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(DEVICE_LIMITS.max_list_entries),
  truncated: z.boolean(),
});
const readResult = z.object({
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  binary: z.boolean(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
const writeResult = z.object({
  bytes: z.number().int().nonnegative(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
const runResult = z.object({
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  duration_ms: z.number().nonnegative(),
  cwd: z.string().max(2048),
});
const openResult = z.object({ opened: z.literal(true) });
const screenshotResult = z.object({ png_base64: z.string() });
const tabResult = z.object({
  tab_id: z.number().int().nonnegative(),
  url: z.string().max(4096),
  title: z.string().max(1024),
});
const pageResult = tabResult.extend({
  text: z.string(),
  truncated: z.boolean(),
  elements: z
    .array(
      z.object({
        ref: z.string().regex(/^e[0-9]{1,5}$/),
        role: z.string().max(40),
        name: z.string().max(300),
        tag: z.string().max(40).optional(),
        shows: z.string().max(300).optional(),
        target: z.string().max(2048).optional(),
      }),
    )
    .max(DEVICE_LIMITS.max_page_elements),
});

/** The page and element a click or an entry is approved against. */
const approvedTarget = z.strictObject({
  url: z.string().max(2048),
  title: z.string().max(1024).optional(),
  element: z.strictObject({
    role: z.string().max(40),
    name: z.string().max(300),
    tag: z.string().max(40).optional(),
    shows: z.string().max(300).optional(),
    target: z.string().max(2048).optional(),
  }),
});

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const cap = (text: string, bytes: number) => {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.byteLength <= bytes
    ? text
    : new TextDecoder().decode(buffer.subarray(0, bytes)).replace(/�$/, '');
};
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type DeviceConnectorOptions = {
  deviceId: string;
  connectionId: string;
  name: string;
  sql: Sql;
  /** Where job workspaces live: a screenshot is kept in `<workRoot>/<job_id>/device/`. */
  workRoot: string;
  hub?: DeviceHub;
};

/**
 * A companion answer that does not have the shape its tool promises. The
 * reason names the first field that was wrong, in words a person can read.
 * A reading tool changed nothing, so it simply failed; for any other tool the
 * computer may already have done the work, so the outcome is unknown.
 */
export function unreadableReply(
  tool: DeviceTool,
  device: string,
  error: z.ZodError,
): DispatchResult {
  const issue = error.issues[0];
  const field = issue?.path.length ? issue.path.join('.') : 'the answer';
  const reason = `${device} answered in a form Melete could not read: ${field.slice(0, 80)} was not what this tool returns.`;
  return DEVICE_TOOL_SHAPES[tool].effect_class === 'read'
    ? { outcome: 'failed', reason, retryable: false }
    : { outcome: 'unknown', reason: `${reason} It may have happened on the computer.` };
}

export function createDeviceConnector(options: DeviceConnectorOptions): Connector {
  const hub = options.hub ?? sharedDeviceHub;
  const manifest = deviceManifest(options.name);

  const load = async (): Promise<DeviceRow | undefined> => {
    const [row] = await options.sql<DeviceRow[]>`select d.id, d.name, d.platform, d.capabilities,
        d.local_capabilities, d.folders, d.revoked_at, c.status as connection_status
      from paired_device d join connection c on c.id = d.connection_id
      where d.id = ${options.deviceId}`;
    return row;
  };

  const checkIdentity = (action: Action, ctx: ConnectorContext) => {
    if (
      action.job_id !== ctx.job_id ||
      action.id !== ctx.idempotency_key ||
      action.id !== action.idempotency_key ||
      action.connection_id !== options.connectionId
    )
      throw new Error('connector action identity mismatch');
  };

  const receiptFor = (
    action: Action,
    detail: Record<string, JsonValue>,
    externalRef: string | null = null,
  ): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: externalRef,
    detail: { device: options.name, ...detail },
    received_at: new Date().toISOString(),
    late: false,
  });

  const refused = (reason: string): DispatchResult => ({
    outcome: 'failed',
    reason,
    retryable: false,
  });

  const toolOf = (action: Pick<Action, 'kind'>): DeviceTool | undefined => {
    const name = action.kind.startsWith('device.') ? action.kind.slice('device.'.length) : '';
    return (DEVICE_TOOLS as readonly string[]).includes(name) ? (name as DeviceTool) : undefined;
  };

  const timeoutFor = (tool: DeviceTool, payload: Record<string, unknown>) => {
    if (tool === 'run') {
      const asked = payload.timeout_ms;
      const timeout =
        typeof asked === 'number' && Number.isInteger(asked)
          ? asked
          : DEVICE_LIMITS.default_command_timeout_ms;
      // The companion stops the command at its timeout; this leaves room for
      // collecting the request and posting the answer back.
      return timeout + 15_000;
    }
    return tool === 'screenshot' || tool === 'browser_screenshot' ? 45_000 : 30_000;
  };

  const tabOf = (payload: Record<string, unknown>) => {
    const tab = payload.tab_id;
    if (typeof tab !== 'number' || !Number.isInteger(tab) || tab < 0)
      throw new DevicePathError('Name a tab by the id device.browser_open returned.');
    return tab;
  };
  const refOf = (payload: Record<string, unknown>) => {
    if (typeof payload.ref !== 'string' || !/^e[0-9]{1,5}$/.test(payload.ref))
      throw new DevicePathError('Name the element by the ref device.browser_read gave it.');
    return payload.ref;
  };

  const expectOf = (payload: Record<string, unknown>) => {
    const parsed = approvedTarget.safeParse(payload.expect);
    if (!parsed.success)
      throw new DevicePathError(
        'Read the tab with device.browser_read first; a click or an entry is approved against that read.',
      );
    return parsed.data;
  };

  /** Arguments as they will be sent, or a refusal in plain words. */
  const argumentsFor = (
    tool: DeviceTool,
    payload: Record<string, unknown>,
    device: DeviceRow,
    approved: boolean,
  ): Record<string, unknown> => {
    switch (tool) {
      case 'list_files':
      case 'read_file':
        devicePath(payload.path, device.folders);
        return { path: payload.path };
      case 'write_file': {
        devicePath(payload.path, device.folders);
        if (typeof payload.content !== 'string')
          throw new DevicePathError('The content to write is required.');
        if (Buffer.byteLength(payload.content) > DEVICE_LIMITS.max_file_bytes)
          throw new DevicePathError('That is more than a file write may carry.');
        if (!/[^/]$/.test(String(payload.path)) || !String(payload.path).includes('/'))
          throw new DevicePathError('Name a file inside a shared folder.');
        return { path: payload.path, content: payload.content };
      }
      case 'run': {
        if (typeof payload.command !== 'string' || !payload.command.trim())
          throw new DevicePathError('A command is required.');
        // Counted as the approval counts it, so nothing runs that was not shown whole.
        if (payload.command.length > DEVICE_LIMITS.max_command_chars)
          throw new DevicePathError(
            'That command is too long to show in full for approval. Put it in a script file first.',
          );
        const timeout = payload.timeout_ms;
        if (
          timeout !== undefined &&
          (typeof timeout !== 'number' ||
            !Number.isInteger(timeout) ||
            timeout < 100 ||
            timeout > DEVICE_LIMITS.max_command_timeout_ms)
        )
          throw new DevicePathError(
            'The timeout must be a whole number of milliseconds within the cap.',
          );
        // A named folder must be a shared one. Without one, the command runs in
        // the first shared folder, or in the person's home folder when none is
        // shared: a command is not bounded by folders either way, and the
        // approval shows exactly what will run.
        const cwd = payload.cwd === undefined ? device.folders[0]?.name : payload.cwd;
        if (cwd !== undefined) devicePath(cwd, device.folders);
        return {
          command: payload.command,
          ...(cwd === undefined ? {} : { cwd }),
          timeout_ms: timeout ?? DEVICE_LIMITS.default_command_timeout_ms,
        };
      }
      case 'open_url':
      case 'browser_open':
        // The computer opens a local address only when the person approved
        // this action, which is what this mark tells it.
        return { url: openableUrl(payload.url), ...(approved ? { local_approved: true } : {}) };
      case 'browser_read':
      case 'browser_screenshot':
        return { tab_id: tabOf(payload) };
      case 'browser_click':
        return { tab_id: tabOf(payload), ref: refOf(payload), expect: expectOf(payload) };
      case 'browser_type': {
        if (typeof payload.text !== 'string' || payload.text.length > DEVICE_LIMITS.max_typed_chars)
          throw new DevicePathError(
            `The text to type is required, up to ${DEVICE_LIMITS.max_typed_chars.toLocaleString('en')} characters.`,
          );
        return {
          tab_id: tabOf(payload),
          ref: refOf(payload),
          text: payload.text,
          submit: payload.submit === true,
          expect: expectOf(payload),
        };
      }
      default:
        return {};
    }
  };

  /** The receipt detail for a companion's successful answer. */
  const detailFor = async (
    tool: DeviceTool,
    sent: Record<string, unknown>,
    result: Record<string, unknown>,
    ctx: ConnectorContext,
    action: Action,
  ): Promise<{ detail: Record<string, JsonValue>; ref: string | null }> => {
    switch (tool) {
      case 'list_files': {
        const parsed = listResult.parse(result);
        return {
          detail: {
            path: String(sent.path),
            entries: parsed.entries.map((entry) => ({
              name: cap(entry.name, 255),
              kind: entry.kind,
              ...(entry.size === undefined ? {} : { size: entry.size }),
            })),
            truncated: parsed.truncated,
          },
          ref: null,
        };
      }
      case 'read_file': {
        const parsed = readResult.parse(result);
        return {
          detail: {
            path: String(sent.path),
            content: cap(parsed.content, DEVICE_LIMITS.max_file_bytes).replaceAll('\0', '�'),
            bytes: parsed.bytes,
            binary: parsed.binary,
            content_hash: parsed.content_hash,
          },
          ref: parsed.content_hash,
        };
      }
      case 'write_file': {
        const parsed = writeResult.parse(result);
        const expected = digest(String(sent.content));
        if (parsed.content_hash !== expected)
          throw new Error('the computer reported different content than was sent');
        return {
          detail: { path: String(sent.path), bytes: parsed.bytes, content_hash: expected },
          ref: expected,
        };
      }
      case 'run': {
        const parsed = runResult.parse(result);
        const stdout = cap(parsed.stdout, DEVICE_LIMITS.max_output_bytes).replaceAll('\0', '�');
        const stderr = cap(parsed.stderr, DEVICE_LIMITS.max_output_bytes).replaceAll('\0', '�');
        return {
          detail: {
            command: String(sent.command),
            cwd: parsed.cwd,
            exit_code: parsed.exit_code,
            timed_out: parsed.timed_out,
            // One view of what it printed, as a command in the workspace reports it.
            output: [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : ''),
            stdout,
            stderr,
            stdout_truncated: parsed.stdout_truncated,
            stderr_truncated: parsed.stderr_truncated,
            duration_ms: Math.round(parsed.duration_ms),
          },
          ref: null,
        };
      }
      case 'open_url':
        openResult.parse(result);
        return { detail: { url: String(sent.url) }, ref: null };
      case 'screenshot':
      case 'browser_screenshot': {
        const parsed = screenshotResult.parse(result);
        const bytes = Buffer.from(parsed.png_base64, 'base64');
        if (bytes.byteLength > DEVICE_LIMITS.max_screenshot_bytes)
          throw new Error('the screenshot is larger than the cap');
        if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC))
          throw new Error('the screenshot is not a PNG image');
        if (!/^job_[A-Za-z0-9]+$/.test(ctx.job_id)) throw new Error('invalid trusted job scope');
        const folder = path.join(options.workRoot, ctx.job_id, 'device');
        await mkdir(folder, { recursive: true });
        const file = `screenshot-${action.id}.png`;
        await writeFile(path.join(folder, file), bytes, { mode: 0o600 });
        const hash = digest(bytes);
        return {
          detail: {
            ...(tool === 'browser_screenshot' ? { tab_id: Number(sent.tab_id) } : {}),
            // Which computer's screen this is, so the privacy router can apply
            // that computer's own setting to the picture.
            device_id: options.deviceId,
            path: `device/${file}`,
            bytes: bytes.byteLength,
            width: bytes.readUInt32BE(16),
            height: bytes.readUInt32BE(20),
            content_hash: hash,
          },
          ref: hash,
        };
      }
      case 'browser_open':
      case 'browser_click': {
        const parsed = tabResult.parse(result);
        return {
          detail: {
            tab_id: parsed.tab_id,
            ...(tool === 'browser_click' ? { ref: String(sent.ref) } : {}),
            url: cap(parsed.url, 2048),
            title: cap(parsed.title, 300),
          },
          ref: null,
        };
      }
      case 'browser_type': {
        const parsed = tabResult.parse(result);
        return {
          detail: {
            tab_id: parsed.tab_id,
            ref: String(sent.ref),
            // What was typed is in the approved action; the receipt does not repeat it.
            characters: String(sent.text).length,
            submitted: sent.submit === true,
            url: cap(parsed.url, 2048),
            title: cap(parsed.title, 300),
          },
          ref: null,
        };
      }
      case 'browser_read': {
        const parsed = pageResult.parse(result);
        return {
          detail: {
            tab_id: parsed.tab_id,
            url: cap(parsed.url, 2048),
            title: cap(parsed.title, 300),
            text: cap(parsed.text, DEVICE_LIMITS.max_page_text_bytes).replaceAll('\0', '\uFFFD'),
            truncated: parsed.truncated,
            // Kept whole, as the page described them: a click or an entry is
            // approved against these and the extension compares them exactly.
            elements: parsed.elements.map((element) => ({
              ref: element.ref,
              role: element.role,
              name: element.name,
              ...(element.tag === undefined ? {} : { tag: element.tag }),
              ...(element.shows === undefined ? {} : { shows: element.shows }),
              ...(element.target === undefined ? {} : { target: element.target }),
            })),
          },
          ref: null,
        };
      }
      default:
        return { detail: {}, ref: null };
    }
  };

  const statusDetail = (device: DeviceRow): Record<string, JsonValue> => ({
    name: device.name,
    platform: device.platform,
    online: hub.online(device.id),
    browser_connected: hub.online(device.id, 'browser'),
    allows: effectiveCapabilities(device.capabilities, device.local_capabilities),
    folders: device.folders.map((folder) => folder.name),
  });

  /**
   * Bind a click or an entry to what the person will see: the tab's page
   * address (origin and path; a query can hold secrets and is left out) and
   * title, and the element the ref named, all from the latest read of that tab
   * on this computer. Whatever the model put there is replaced. Without such a
   * read, or with a ref that read did not give, it is refused here.
   */
  const bind = async (payload: JsonObject, tx: Query): Promise<JsonObject> => {
    const tab = payload.tab_id;
    const ref = payload.ref;
    const [read] =
      typeof tab === 'number'
        ? await tx`select receipt from action
            where connection_id = ${options.connectionId} and kind = 'device.browser_read'
              and status = 'succeeded' and receipt->'detail'->>'tab_id' = ${String(tab)}
            order by (receipt->>'received_at')::timestamptz desc limit 1`
        : [];
    const detail = (read?.receipt as { detail?: Record<string, unknown> } | undefined)?.detail;
    const element = (Array.isArray(detail?.elements) ? detail.elements : []).find(
      (entry) => (entry as { ref?: unknown }).ref === ref,
    ) as Record<string, JsonValue> | undefined;
    const address = typeof detail?.url === 'string' ? pageAddress(detail.url) : null;
    if (!detail || !element || !address)
      throw new BrokerFault(
        'payload_invalid',
        `Read tab ${String(tab)} with device.browser_read first; ${String(ref)} must come from its latest read.`,
      );
    const { ref: _ref, ...described } = element;
    return {
      ...payload,
      expect: {
        url: address,
        ...(typeof detail.title === 'string' ? { title: detail.title } : {}),
        element: described,
      },
    };
  };

  return {
    manifest,
    /** Only a click and an entry name a ref; everything else passes as proposed. */
    async prepare(payload, _ctx, tx) {
      return typeof payload.ref === 'string' ? bind(payload, tx) : payload;
    },
    catalog: {
      audience: 'owner',
      source: 'connector',
      examples: {
        'device.status': ['my laptop', 'my computer', 'is my laptop connected'],
        'device.list_files': ['files on my laptop', 'what is in my folder on my computer'],
        'device.read_file': ['read a file on my laptop'],
        'device.write_file': ['save a file on my laptop', 'write to my computer'],
        'device.run': ['run a command on my laptop', 'terminal on my computer', 'shell'],
        'device.open_url': ['open this page in my browser', 'show me the page'],
        'device.screenshot': ['look at my screen', 'screenshot'],
        'device.browser_open': [
          'log in',
          'my account',
          'pay my bill',
          'insurance portal',
          'school portal',
          'government website',
          'signed in',
        ],
        'device.browser_read': ['read the page in my browser', 'what does my account say'],
        'device.browser_click': ['click the button', 'click the link'],
        'device.browser_type': ['fill in the form', 'type into the field'],
        'device.browser_screenshot': ['screenshot of the page'],
      },
    },

    asksFirst(action) {
      return (
        (action.kind === deviceToolName('open_url') ||
          action.kind === deviceToolName('browser_open')) &&
        namesLocalNetwork(action.canonical_payload.url)
      );
    },

    dispatchBudgetMs(action) {
      const tool = toolOf(action);
      return tool ? timeoutFor(tool, action.canonical_payload) + 5_000 : 30_000;
    },

    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      const tool = toolOf(action);
      if (!tool) return refused('That is not something a connected computer does.');
      const device = await load();
      if (!device || device.revoked_at || device.connection_status === 'revoked')
        return refused('This computer was disconnected, so nothing was sent.');
      const capability = DEVICE_TOOL_CAPABILITY[tool];
      if (capability) {
        if (!device.capabilities[capability])
          return refused(
            `${CAPABILITY_WORDS[capability]} is turned off for ${device.name} in Settings.`,
          );
        if (!device.local_capabilities[capability])
          return refused(`${CAPABILITY_WORDS[capability]} is turned off on ${device.name} itself.`);
      }
      if (tool === 'status')
        return { outcome: 'succeeded', receipt: receiptFor(action, statusDetail(device)) };
      let sent: Record<string, unknown>;
      try {
        sent = argumentsFor(
          tool,
          action.canonical_payload,
          device,
          Boolean(action.authorization_ref),
        );
      } catch (error) {
        if (error instanceof DevicePathError) return refused(error.message);
        throw error;
      }
      const channel = deviceChannelOf(tool);
      const outcome = await hub.call(
        device.id,
        { id: action.id, tool, arguments: sent },
        timeoutFor(tool, sent),
        ctx.signal,
        channel,
      );
      if (outcome.kind === 'not_delivered') {
        if (outcome.reason === 'disconnected')
          return refused(`${device.name} was disconnected, so nothing was sent.`);
        if (outcome.reason === 'capability_off')
          return refused(
            `${capability ? CAPABILITY_WORDS[capability] : 'This'} was turned off for ${device.name} before it collected this, so nothing was sent.`,
          );
        // Nothing left the service. The action waits for the computer, or for
        // its browser, and goes as soon as it connects again.
        throw new ConnectorFaultError({
          kind: 'destination_offline',
          detail:
            channel === 'browser'
              ? `The browser on ${device.name} is not connected right now; this waits for it.`
              : `${device.name} is not connected right now; this waits for it.`,
        });
      }
      if (outcome.kind === 'no_answer')
        return {
          outcome: 'unknown',
          reason: `${device.name} received this but did not answer in time. It may have happened.`,
        };
      if (!outcome.reply.ok)
        return refused(`${device.name} refused: ${cap(outcome.reply.error.message, 300)}`);
      let answered: Awaited<ReturnType<typeof detailFor>>;
      try {
        answered = await detailFor(tool, sent, outcome.reply.result, ctx, action);
      } catch (error) {
        if (error instanceof z.ZodError) return unreadableReply(tool, device.name, error);
        throw error;
      }
      return { outcome: 'succeeded', receipt: receiptFor(action, answered.detail, answered.ref) };
    },

    async verify(action, ctx) {
      checkIdentity(action, ctx);
      const tool = toolOf(action);
      if (tool !== 'write_file')
        return tool === 'run' || tool === 'open_url'
          ? {
              decision: 'undecided',
              reason: 'What this did on the computer cannot be checked afterwards.',
            }
          : { decision: 'unsupported', reason: 'reading has no effect to verify' };
      const device = await load();
      if (!device || device.revoked_at || device.connection_status === 'revoked')
        return { decision: 'undecided', reason: 'the computer was disconnected' };
      const payload = action.canonical_payload;
      const outcome = await hub.call(
        device.id,
        {
          id: `${action.id}:verify:${Date.now()}`,
          tool: 'read_file',
          arguments: { path: payload.path },
        },
        30_000,
      );
      if (outcome.kind !== 'reply' || !outcome.reply.ok)
        return { decision: 'undecided', reason: 'the computer could not be asked' };
      const parsed = readResult.safeParse(outcome.reply.result);
      const expected = digest(String(payload.content));
      if (!parsed.success || parsed.data.content_hash !== expected)
        return {
          decision: 'undecided',
          reason: 'the file on the computer differs from the action',
        };
      const evidence = { path: String(payload.path), content_hash: expected };
      return {
        decision: 'succeeded',
        evidence,
        receipt: receiptFor(action, evidence, expected),
      };
    },

    async health() {
      const online = hub.online(options.deviceId);
      return {
        status: online ? 'ok' : 'degraded',
        detail: online ? 'the computer is connected' : 'the computer is not connected right now',
        checked_at: new Date().toISOString(),
      };
    },

    /** The connection is gone: nothing more is handed to the computer. */
    async retire() {
      hub.disconnect(options.deviceId, false);
    },
  };
}
