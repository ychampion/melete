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
  type JsonValue,
  type Receipt,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Connector, ConnectorContext } from '../connectors/types.ts';
import { type DeviceHub, sharedDeviceHub } from './hub.ts';
import { DevicePathError, devicePath, openableUrl } from './paths.ts';

const pathArgument = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  description:
    'A shared folder name, then a path inside it with forward slashes, e.g. "Projects/notes/todo.md". device.status lists the folder names.',
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
      "Check the person's connected computer: whether it is online, what it allows, and the names of its shared folders.",
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
      "Run a shell command on the person's computer, as them, in one of their shared folders. The person approves the exact command first.",
    input_schema: object(
      {
        command: { type: 'string', minLength: 1, maxLength: 20_000 },
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
    description: "Open a web page in the default browser on the person's computer.",
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
    return tool === 'screenshot' ? 45_000 : 30_000;
  };

  /** Arguments as they will be sent, or a refusal in plain words. */
  const argumentsFor = (
    tool: DeviceTool,
    payload: Record<string, unknown>,
    device: DeviceRow,
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
        return { url: openableUrl(payload.url) };
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
      case 'screenshot': {
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
            path: `device/${file}`,
            bytes: bytes.byteLength,
            width: bytes.readUInt32BE(16),
            height: bytes.readUInt32BE(20),
            content_hash: hash,
          },
          ref: hash,
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
    allows: effectiveCapabilities(device.capabilities, device.local_capabilities),
    folders: device.folders.map((folder) => folder.name),
  });

  return {
    manifest,
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
      },
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
        sent = argumentsFor(tool, action.canonical_payload, device);
      } catch (error) {
        if (error instanceof DevicePathError) return refused(error.message);
        throw error;
      }
      const outcome = await hub.call(
        device.id,
        { id: action.id, tool, arguments: sent },
        timeoutFor(tool, sent),
        ctx.signal,
      );
      if (outcome.kind === 'not_delivered')
        return refused(
          outcome.reason === 'disconnected'
            ? `${device.name} was disconnected, so nothing was sent.`
            : `${device.name} is not connected right now, so nothing was sent.`,
        );
      if (outcome.kind === 'no_answer')
        return {
          outcome: 'unknown',
          reason: `${device.name} received this but did not answer in time. It may have happened.`,
        };
      if (!outcome.reply.ok)
        return refused(`${device.name} refused: ${cap(outcome.reply.error.message, 300)}`);
      const { detail, ref } = await detailFor(tool, sent, outcome.reply.result, ctx, action);
      return { outcome: 'succeeded', receipt: receiptFor(action, detail, ref) };
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
      hub.disconnect(options.deviceId);
    },
  };
}
