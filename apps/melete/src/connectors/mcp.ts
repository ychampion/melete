import {
  type Action,
  type ConnectorHealth,
  type ConnectorTool,
  canonicalizePayload,
  connectorTool,
  type DispatchResult,
  type JsonObject,
  jsonObject,
  jsonSchema,
  mcpHttpUrl,
  mcpOperatorPolicy,
  mcpStdioLaunch,
  SERVER_NOTES_MAX,
  type VerifyResult,
} from '@melete/contracts';
import { z } from 'zod';
import { asConnectorFault, ConnectorFaultError } from './faults.ts';
import { type McpParamHeader, mcpParamHeaders, mcpParamHeaderValues } from './mcp-headers.ts';
import {
  MCP_CLIENT_INFO,
  MCP_HANDSHAKE_VERSIONS,
  MCP_PROTOCOL_VERSION,
  McpProtocolError,
  type McpTransport,
  type McpTransportOptions,
  mcpClientCapabilities,
  openHttpMcpTransport,
  openStdioMcpTransport,
} from './mcp-transport.ts';
import { appOnly, type PageSource, readPageResource, toolPageUri } from './mcp-ui.ts';
import { MAX_TOOL_SCHEMA_BYTES, toolSchemaFits } from './schema-budget.ts';
import type { ConnectorContext } from './types.ts';

const endpoint = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('stdio'),
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(64).default([]),
    })
    .strict(),
  z
    .object({
      transport: z.literal('http'),
      url: mcpHttpUrl,
    })
    .strict(),
  /** A stdio server in a container of its own; only an isolating launcher can start it. */
  z
    .object({
      transport: z.literal('container'),
      launch: mcpStdioLaunch,
    })
    .strict(),
]);

/** Parsed from authenticated operator installation or configuration, never a tool call. */
export const mcpServerConfig = mcpOperatorPolicy.safeExtend({ endpoint });
export type McpServerConfig = z.infer<typeof mcpServerConfig>;

const serverTool = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(16_000).optional(),
  inputSchema: jsonSchema
    .refine((schema) => schema.type === 'object', 'MCP tool schema must be an object')
    // Broker validation is synchronous; an async validator's Promise is not proof of valid input.
    .refine(
      (schema) => !Object.hasOwn(schema, '$async'),
      'MCP asynchronous schemas ($async) are unsupported',
    ),
  // Server annotations, including readOnlyHint, are deliberately not policy
  // inputs: the operator's policy sets each tool's effect. A declared
  // readOnlyHint only lets a read whose answer never came be settled as failed
  // rather than asked about, which never widens what a tool may do.
  annotations: z
    .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
    .optional(),
  // Read for the MCP Apps page a tool names (`toolPageUri`), from the live
  // session only, like `readOnlyHint`; never recorded with an installation.
  _meta: z.record(z.string(), z.unknown()).optional(),
});
/** A tool whose definition is larger than this is never offered: no schema that size fits a turn. */
export const MAX_TOOL_DEFINITION_BYTES = 64 * 1024;
/** All of a server's tool list, every page together. */
const MAX_TOOL_LIST_BYTES = 4 * 1024 * 1024;
const toolPage = z.object({
  tools: z.array(z.unknown()).max(256),
  nextCursor: z.string().min(1).max(2048).optional(),
});

/** A server's own account of one tool, as `tools/list` gave it. */
export const mcpToolDefinition = serverTool;
export type McpToolDefinition = z.infer<typeof serverTool>;

/** The service supplies audience and scopes from current authority, never the model payload. */
export type McpExecutionContext = ConnectorContext & {
  audience: string;
  scopes: readonly string[];
  /** Melete's own `_meta` entries for this call: a page's report ticket. */
  meta?: JsonObject;
  /** Melete's own request headers for this call (the identity assertion); only HTTP sends them. */
  headers?: Record<string, string>;
  /**
   * Called once the call succeeded with the page its tool shows, read from the
   * server. What it answers is what the receipt says about the page.
   */
  opened?: (page: OpenedPage) => Promise<JsonObject>;
};
/** A page a call opened, with the call's own arguments and result for the page to read. */
export type OpenedPage = PageSource & { arguments: JsonObject; result: JsonObject };
export type McpWorker = {
  tools: ConnectorTool[];
  /** The server's definitions of the tools the policy names, from which `tools` was built. */
  definitions: McpToolDefinition[];
  /**
   * Tools the running server declares read-only (`readOnlyHint`), by brokered
   * name. Read from the live session only: the hint is never recorded with the
   * installed definitions, so a worker with no session yet declares none.
   */
  readonly readOnly: string[];
  /**
   * The MCP Apps page a tool shows (its `ui://` resource), by brokered name,
   * from the live session only. Null without a session or for a tool without one.
   */
  pageUri(kind: string): string | null;
  /** The server's own name for each brokered tool, by brokered name. */
  rawNames?: ReadonlyMap<string, string>;
  /**
   * The running server's notes on using its tools, bounded, from the live
   * session only: null without a session or when the server gave none.
   */
  readonly instructions: string | null;
  catalog: { source: 'mcp' };
  execute(action: Action, context: McpExecutionContext): Promise<DispatchResult>;
  verify(): Promise<VerifyResult>;
  health(): Promise<ConnectorHealth>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
};
type McpSession = Omit<McpWorker, 'reconnect' | 'pageUri'> & {
  pages: ReadonlyMap<string, string>;
};

export type McpWorkerOptions = McpTransportOptions & {
  transport?: McpTransport;
  transportFactory?: () => Promise<McpTransport>;
  checkCredential?: () => Promise<void>;
  /**
   * The definitions recorded when the server was installed. With them the
   * worker exists before any session does, and the first `reconnect` opens one
   * only if the server still describes exactly these tools.
   */
  pinned?: McpToolDefinition[];
  /**
   * Told each time a session is accepted (its catalog matched the approved
   * one), with the server's notes on using its tools, so the connection can
   * keep them. A session refused for a changed catalog is never told, so the
   * kept notes stay as they were. Its failure never fails the session.
   */
  onSession?: (opened: { instructions: string | null }) => Promise<void> | void;
};

/** A tool the installation names that the server does not list. */
export class McpToolMissingError extends Error {
  constructor(readonly tool: string) {
    super(`Configured MCP tool is unavailable: ${tool}`);
    this.name = 'McpToolMissingError';
  }
}

/** How much of a server's own words a failed call keeps for the agent, in UTF-8 bytes. */
export const SERVER_SAID_BYTES = 2048;

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** A server saying it has no such tool, whatever code it used. */
const TOOL_MISSING = /\b(not found|unknown tool|no such tool|does not exist|disabled)\b/i;
/** A server saying it turned the input down before running the tool. */
const INPUT_REJECTED =
  /\binvalid (arguments?|parameters?|input)\b|\binput (validation|schema)\b|\bvalidation (error|failed)\b.*\b(arguments?|input|params|parameters?)\b|\bmissing required\b/i;
/**
 * Words about a tool's output, or about access. An error in these words says
 * nothing about the arguments, and an output check runs after the tool has.
 */
const NOT_ABOUT_INPUT =
  /\boutput (schema|validation)\b|\bstructured ?content\b|\bauth\w*|\bpermission|\bforbidden\b|\bunauthori[sz]ed\b|\bcredential|\bapi key\b|\btoken\b|\bscopes?\b|\bquota\b|\brate limit/i;

/**
 * How a JSON-RPC error to `tools/call` settles the call. A malformed request
 * (-32600) or an unknown method (-32601) was answered before anything ran.
 * -32602 is sent both for refused input and, by some servers, for an output
 * check after the tool ran, so it is definite only when its words say the
 * tool is missing or the input was refused; otherwise whether it ran is not known.
 */
function rpcRefusal(error: McpProtocolError): 'request' | 'missing' | 'input' | null {
  // A 5xx came from something that may have passed the call on already.
  if (error.status !== undefined && (error.status < 400 || error.status >= 500)) return null;
  const said = rpcText(error);
  if (error.code === METHOD_NOT_FOUND) return 'missing';
  if (error.code === INVALID_REQUEST) return 'request';
  if (error.code !== INVALID_PARAMS || NOT_ABOUT_INPUT.test(said)) return null;
  if (TOOL_MISSING.test(said)) return 'missing';
  return INPUT_REJECTED.test(said) ? 'input' : null;
}

/** Argument nouns a tool's own error uses when it turned the arguments down. */
const ARGUMENT_NOUNS = /\b(arguments?|params|parameters?|fields?|inputs?|propert(y|ies))\b/i;

/**
 * Whether a tool's own error is about its arguments: it names an argument
 * noun or one of the tool's own parameters, and is not about access or output.
 */
function aboutArguments(said: string, schema: Record<string, unknown>): boolean {
  if (!said || NOT_ABOUT_INPUT.test(said)) return false;
  if (ARGUMENT_NOUNS.test(said)) return true;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  return Object.keys(properties).some((name) =>
    new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`, 'i').test(
      said,
    ),
  );
}

/** How long a failed call may spend reading the server's catalog again, in all. */
export const CATALOG_RECHECK_MS = 3_000;

/** `work`, or a rejection once `ms` have passed. The work itself is left to its own limits. */
async function withinTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}

/** At most `limit` UTF-8 bytes of `text`, cut on a character, marked when cut. */
function withinBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let kept = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit - 3) break;
    kept += character;
    bytes += size;
  }
  return `${kept}…`;
}

/**
 * A server's notes on using its tools (`instructions` from `initialize`, or
 * from `server/discover`), trimmed and kept to a bounded length. Null when it
 * gave none.
 */
export function serverNotes(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= SERVER_NOTES_MAX) return trimmed;
  // Cut on a character, never inside a surrogate pair.
  const kept = trimmed.slice(0, SERVER_NOTES_MAX - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${kept}…`;
}

/** The text a tool's result carries, as the server wrote it. */
function resultText(result: JsonObject): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .flatMap((item) =>
      item && typeof item === 'object' && !Array.isArray(item) && typeof item.text === 'string'
        ? [item.text]
        : [],
    )
    .join('\n')
    .trim();
  if (text) return text;
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return content.length ? JSON.stringify(content) : '';
}

/** What a JSON-RPC error said: its message, then its data. */
function rpcText(error: McpProtocolError): string {
  const data =
    error.data === undefined
      ? ''
      : typeof error.data === 'string'
        ? error.data
        : JSON.stringify(error.data);
  return [error.serverMessage?.trim() ?? '', data].filter(Boolean).join('\n');
}

/** Transport failures that mean nothing answered, or nothing answered in time. */
const UNANSWERED = new Set([
  'MCP server did not answer in time',
  'MCP server stopped sending before it answered',
]);

/**
 * Why opening an MCP server failed, in the terms a person can act on: it
 * could not be reached, what answered is not an MCP server, or it lacks a tool
 * the installation names. Anything else (a refused credential included) is
 * left to the caller.
 */
export function mcpOpenFailure(error: unknown): 'unreachable' | 'not_mcp' | 'tool_missing' | null {
  if (error instanceof McpToolMissingError) return 'tool_missing';
  const fault = asConnectorFault(error);
  if (fault)
    return fault.kind === 'transient_before_dispatch' || fault.kind === 'unsupported_route'
      ? 'unreachable'
      : null;
  if (!(error instanceof Error)) return null;
  if (UNANSWERED.has(error.message)) return 'unreachable';
  // A socket, DNS or TLS failure from the request itself.
  const code = (error as { code?: unknown }).code;
  if (error.name === 'TypeError' || 'syscall' in error || (typeof code === 'string' && code))
    return 'unreachable';
  if (
    error instanceof McpProtocolError ||
    error instanceof SyntaxError ||
    error instanceof z.ZodError ||
    /^(Unsupported MCP response content type|Invalid MCP|Empty MCP response|MCP response id mismatch|MCP stream ended|MCP server negotiated)/.test(
      error.message,
    )
  )
    return 'not_mcp';
  return null;
}

const notRunning = () =>
  new ConnectorFaultError({
    kind: 'transient_before_dispatch',
    detail: 'MCP session is not open before dispatch',
  });

/** Transport and operator policy stay outside the runtime cell. */
export async function openMcpWorker(
  input: McpServerConfig,
  binding: { connectionId: string; spaceId: string },
  options: McpWorkerOptions = {},
): Promise<McpWorker> {
  /**
   * Hands an accepted session's notes to the connection. Only a session whose
   * catalog is the approved one gets here, so a server that changed its tools
   * never replaces the notes kept with them.
   */
  const accepted = async (session: McpSession) => {
    try {
      await options.onSession?.({ instructions: session.instructions });
    } catch (error) {
      console.error(
        `mcp notes: ${input.id} were not kept: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  let current: McpSession | undefined = options.pinned
    ? undefined
    : await openMcpSession(input, binding, options);
  if (current) await accepted(current);
  const initial = current ?? {
    ...policyTools(
      mcpServerConfig.parse(input),
      new Map(options.pinned?.map((tool) => [tool.name, mcpToolDefinition.parse(tool)])),
    ),
  };
  const pinned = canonicalizePayload({ tools: initial.tools }).hash;
  let closed = false;
  let reopening: Promise<void> | undefined;
  return {
    tools: structuredClone(initial.tools),
    definitions: structuredClone(initial.definitions),
    rawNames: new Map(initial.rawNames),
    get readOnly() {
      return [...(current?.readOnly ?? [])];
    },
    get instructions() {
      return current?.instructions ?? null;
    },
    pageUri: (kind) => current?.pages.get(kind) ?? null,
    catalog: { source: 'mcp' },
    execute: (action, context) =>
      current ? current.execute(action, context) : Promise.reject(notRunning()),
    verify: async () => ({
      decision: 'unsupported',
      reason: 'MCP has no general effect verification protocol; unknown calls are not replayed',
    }),
    health: async () =>
      current
        ? current.health()
        : {
            status: 'failing',
            detail: 'MCP server is not running',
            checked_at: new Date().toISOString(),
          },
    async reconnect() {
      if (closed) throw new Error('MCP worker is closed');
      reopening ??= (async () => {
        const previous = current;
        current = undefined;
        await previous?.close();
        if (options.transport && !options.transportFactory)
          throw new Error('MCP test transport has no reconnect factory');
        const next = await openMcpSession(input, binding, { ...options, transport: undefined });
        // Reconnection cannot silently replace an approved tool's schema or policy.
        if (closed || canonicalizePayload({ tools: next.tools }).hash !== pinned) {
          await next.close();
          throw new Error('MCP catalog changed during reconnect');
        }
        current = next;
        await accepted(next);
      })()
        .catch((error: unknown) => {
          if (error instanceof ConnectorFaultError) throw error;
          throw new ConnectorFaultError({
            kind: 'transient_before_dispatch',
            detail: 'MCP session could not be safely re-established before dispatch',
          });
        })
        .finally(() => {
          reopening = undefined;
        });
      await reopening;
    },
    async close() {
      closed = true;
      await reopening?.catch(() => {});
      await current?.close();
    },
  };
}

/**
 * Composio's meta tools (`COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_SEARCH_TOOLS`,
 * `COMPOSIO_MANAGE_CONNECTIONS` and the rest), whatever server lists them.
 */
export const COMPOSIO_META_TOOL = /^composio_/i;

/** The broker's tools, built only from the policy's names and the server's schemas for them. */
function policyTools(config: McpServerConfig, discovered: Map<string, McpToolDefinition>) {
  const healthNotes: string[] = [];
  const rawNames = new Map<string, string>();
  const definitions: McpToolDefinition[] = [];
  const readOnly: string[] = [];
  const pages = new Map<string, string>();
  const tools = config.tools
    .flatMap((policy) => {
      const definition = discovered.get(policy.name);
      if (!definition) throw new McpToolMissingError(policy.name);
      // What is recorded is the tool, never the server's own annotations or `_meta`.
      const { annotations, _meta, ...recorded } = definition;
      definitions.push(recorded);
      const name = `mcp_${config.id}.${policy.alias}`;
      const inputSchema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...definition.inputSchema,
      };
      // MCP Apps: a tool only its page may call is never offered to the model.
      // Melete's pages call no tools, so such a tool is not used at all.
      if (appOnly(definition)) {
        healthNotes.push(`${policy.name}: the server offers it to its page only`);
        return [];
      }
      if (!toolSchemaFits(inputSchema)) {
        healthNotes.push(`${policy.name}: schema exceeds ${MAX_TOOL_SCHEMA_BYTES} UTF-8 bytes`);
        return [];
      }
      rawNames.set(name, policy.name);
      if (annotations?.readOnlyHint === true) readOnly.push(name);
      const page = toolPageUri(definition);
      if (page) pages.set(name, page);
      return connectorTool.parse({
        name,
        description:
          (definition.description ?? policy.name).replace(/\s+/g, ' ').trim().slice(0, 400) ||
          policy.name,
        // MCP's unspecified dialect is 2020-12. Preserve it explicitly for the
        // broker so newer constraints cannot be silently treated as draft-07.
        input_schema: inputSchema,
        effect_class: policy.effect_class,
        required_scopes: [...new Set(policy.required_scopes)].sort(),
        requires_approval: policy.effect_class !== 'read',
        verify: false,
      });
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  definitions.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { tools, definitions, readOnly: readOnly.sort(), pages, rawNames, healthNotes };
}

/**
 * Meets a server and reads its tools: a stateless server (2026-07-28) is found
 * by asking it, and any other is spoken to with the handshake, at whichever
 * revision it settles on. Over HTTP a tool's parameters may ask to be mirrored
 * into headers; a tool whose annotations break the rules is not offered at all.
 */
async function introduce(transport: McpTransport) {
  const statelessServer = transport.discover ? await transport.discover() : null;
  const stateless = statelessServer !== null;
  let capabilities: JsonObject;
  let instructions: string | null;
  if (statelessServer) {
    capabilities = statelessServer.capabilities;
    instructions = serverNotes(statelessServer.instructions);
  } else {
    const initialized = jsonObject.parse(
      await transport.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: mcpClientCapabilities(),
        clientInfo: { ...MCP_CLIENT_INFO },
      }),
    );
    const agreed = initialized.protocolVersion;
    if (typeof agreed !== 'string' || !MCP_HANDSHAKE_VERSIONS.includes(agreed)) {
      throw new Error('MCP server negotiated an unsupported protocol version');
    }
    transport.agreed?.(agreed);
    capabilities = jsonObject.parse(initialized.capabilities);
    instructions = serverNotes(initialized.instructions);
  }
  if (!capabilities.tools) throw new Error('MCP server does not expose tools');
  if (!stateless) await transport.notify('notifications/initialized');
  const discovered = await readServerTools(transport);
  const paramHeaders = new Map<string, McpParamHeader[]>();
  for (const [name, definition] of discovered) {
    const annotated = mcpParamHeaders(definition.inputSchema);
    if (annotated === null && stateless) discovered.delete(name);
    else if (annotated?.length) paramHeaders.set(name, annotated);
  }
  return { stateless, discovered, paramHeaders, capabilities, instructions };
}

/** Every tool the server lists now, every page read, held to the same limits as discovery. */
async function readServerTools(
  transport: McpTransport,
  signal?: AbortSignal,
): Promise<Map<string, McpToolDefinition>> {
  const discovered = new Map<string, McpToolDefinition>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let listBytes = 0;
  for (let pageNumber = 0; ; pageNumber++) {
    if (pageNumber >= 16) throw new Error('MCP catalog page limit exceeded');
    const page = toolPage.parse(
      await transport.request('tools/list', cursor ? { cursor } : {}, signal),
    );
    for (const raw of page.tools) {
      const size = Buffer.byteLength(JSON.stringify(raw) ?? '');
      listBytes += size;
      if (listBytes > MAX_TOOL_LIST_BYTES) throw new Error('MCP tool list is too large');
      if (size > MAX_TOOL_DEFINITION_BYTES) continue;
      const tool = serverTool.parse(raw);
      // A provider's meta tools run whichever action they are told to, under
      // one name, so what a call does could not be known or approved. Never offered.
      if (COMPOSIO_META_TOOL.test(tool.name)) continue;
      if (discovered.has(tool.name)) throw new Error('Duplicate MCP server tool');
      discovered.set(tool.name, tool);
    }
    if (discovered.size > 256) throw new Error('MCP catalog tool limit exceeded');
    cursor = page.nextCursor;
    if (!cursor) break;
    if (cursors.has(cursor)) throw new Error('Repeated MCP pagination cursor');
    cursors.add(cursor);
  }
  return discovered;
}

/**
 * The tools a remote server offers now, as it describes them, read once and
 * let go. Its own hints come back too, for suggesting where each starts; they
 * are never recorded with an installation.
 */
export async function discoverMcpServerTools(
  endpoint: { transport: 'http'; url: string },
  options: McpTransportOptions = {},
): Promise<McpToolDefinition[]> {
  const transport = openHttpMcpTransport(
    { transport: 'http', url: mcpHttpUrl.parse(endpoint.url) },
    options,
  );
  try {
    return [...(await introduce(transport)).discovered.values()];
  } finally {
    await transport.close();
  }
}

/**
 * The names of the tools a remote server offers now, read once and let go.
 * Connecting an app from the catalog installs only the tools its server has.
 */
export async function listMcpServerTools(
  endpoint: { transport: 'http'; url: string },
  options: McpTransportOptions = {},
): Promise<string[]> {
  return (await discoverMcpServerTools(endpoint, options)).map((tool) => tool.name);
}

async function openMcpSession(
  input: McpServerConfig,
  binding: { connectionId: string; spaceId: string },
  options: McpWorkerOptions,
): Promise<McpSession> {
  const config = mcpServerConfig.parse(input);
  const transport =
    options.transport ??
    (await options.transportFactory?.()) ??
    (config.endpoint.transport === 'stdio'
      ? await openStdioMcpTransport(config.endpoint, options)
      : config.endpoint.transport === 'http'
        ? openHttpMcpTransport(config.endpoint, options)
        : undefined);
  if (!transport) throw new Error('A container MCP server needs its isolating launcher');
  try {
    const { stateless, discovered, paramHeaders, capabilities, instructions } =
      await introduce(transport);
    const { tools, definitions, readOnly, pages, rawNames, healthNotes } = policyTools(
      config,
      discovered,
    );
    // A page is read only from a server that says it has resources.
    if (!capabilities.resources) pages.clear();
    // A caller receives a copy; mutating presentation cannot alter execution policy.
    const authoritative = new Map(tools.map((tool) => [tool.name, structuredClone(tool)]));
    /**
     * A refusal's account for the agent: the server's own words, bounded and
     * marked as content from outside, as a successful result's are. Empty when
     * the server gave no words; Melete's own are never put in its mouth.
     */
    const serverAccount = (action: Action, said: string, extra: JsonObject = {}): JsonObject => ({
      server_id: config.id,
      tool: rawNames.get(action.kind) as string,
      server_said: withinBytes(said, SERVER_SAID_BYTES),
      origin_trust: 'external_content',
      evidence_handle: `mcp:${config.id}:${action.id}`,
      ...extra,
    });
    /** The server's tools read again, within one overall time limit; why not, when it fails. */
    const relisted = async (
      signal?: AbortSignal,
    ): Promise<Map<string, McpToolDefinition> | { failed: string }> => {
      try {
        return await withinTime(readServerTools(transport, signal), CATALOG_RECHECK_MS);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        console.error(`mcp recheck: ${config.id} tools/list could not be read again: ${why}`);
        return { failed: withinBytes(why, 200) };
      }
    };
    /**
     * The schema the broker checks the tool's calls against: the approved one,
     * never the server's live one. The live listing only says whether the
     * server has changed it since it was approved.
     */
    const approvedSchema = async (kind: string, signal?: AbortSignal): Promise<JsonObject> => {
      const raw = rawNames.get(kind) as string;
      const approved = definitions.find((definition) => definition.name === raw)?.inputSchema;
      const schema = authoritative.get(kind)?.input_schema;
      const out: JsonObject = schema ? { input_schema: jsonObject.parse(schema) } : {};
      const listed = await relisted(signal);
      if ('failed' in listed) return { ...out, catalog_check: `not read again: ${listed.failed}` };
      const live = listed.get(raw)?.inputSchema;
      if (!live) return { ...out, schema_changed: true };
      if (approved && canonicalizePayload(live).hash !== canonicalizePayload(approved).hash)
        return { ...out, schema_changed: true };
      return out;
    };
    /** The brokered tools of this connection the server still lists, read again now. */
    const offeredNow = async (signal?: AbortSignal): Promise<JsonObject> => {
      const listed = await relisted(signal);
      if ('failed' in listed) return { catalog_check: `not read again: ${listed.failed}` };
      return {
        tools_offered: [...rawNames]
          .filter(([, raw]) => listed.has(raw))
          .map(([name]) => name)
          .sort(),
      };
    };
    return {
      tools,
      definitions,
      readOnly,
      pages,
      rawNames,
      instructions,
      catalog: { source: 'mcp' },
      async execute(action, context) {
        const tool = authoritative.get(action.kind);
        if (
          !tool ||
          action.connection_id !== binding.connectionId ||
          context.space_id !== binding.spaceId ||
          context.job_id !== action.job_id ||
          // The operator's own audience, or a room's space where its owners added
          // the server; the connector has already held the call to this connection's
          // own space and refused it to a public compartment.
          (context.audience !== config.audience && context.audience !== 'space') ||
          !tool.required_scopes.every(
            (item) => context.scopes.includes(item) && config.allowed_scopes.includes(item),
          ) ||
          action.effect_class !== tool.effect_class ||
          action.status !== 'dispatched' ||
          action.idempotency_key !== action.id ||
          context.idempotency_key !== action.id ||
          canonicalizePayload(action.canonical_payload).hash !== action.payload_hash
        ) {
          return {
            outcome: 'failed',
            reason: 'MCP execution authority mismatch',
            retryable: false,
          };
        }
        context.signal?.throwIfAborted();
        try {
          await options.checkCredential?.();
          const raw = rawNames.get(action.kind) as string;
          const annotated = stateless ? paramHeaders.get(raw) : undefined;
          const result = jsonObject.parse(
            await transport.request(
              'tools/call',
              {
                name: raw,
                arguments: action.canonical_payload,
                _meta: {
                  ...context.meta,
                  'melete/action_id': action.id,
                  'melete/idempotency_key': action.id,
                },
              },
              context.signal,
              annotated || context.headers
                ? {
                    ...(annotated ? mcpParamHeaderValues(annotated, action.canonical_payload) : {}),
                    // Melete's own last, so no mirrored argument can stand in for one.
                    ...context.headers,
                  }
                : undefined,
            ),
          );
          // A stateless server that needs more input before it acts has not acted.
          // Melete gives servers nothing beyond the call itself, so the call fails.
          if (result.resultType === 'input_required') {
            return {
              outcome: 'failed',
              reason: 'MCP server asked for more input before acting; nothing was done',
              retryable: false,
            };
          }
          if (result.isError === true) {
            // The server's own account of what went wrong is what lets the
            // agent correct the call; without it the agent can only give up.
            const said = resultText(result);
            return {
              outcome: 'failed',
              reason: 'MCP tool returned an error',
              retryable: false,
              evidence: serverAccount(
                action,
                said,
                aboutArguments(said, tool.input_schema)
                  ? await approvedSchema(action.kind, context.signal)
                  : {},
              ),
            };
          }
          if (!Array.isArray(result.content)) throw new Error('Invalid MCP tool acknowledgement');
          const detail: JsonObject = {
            server_id: config.id,
            tool: rawNames.get(action.kind) as string,
            result,
            origin_trust: 'external_content',
            evidence_handle: `mcp:${config.id}:${action.id}`,
          };
          const pageUri = pages.get(action.kind);
          if (pageUri && context.opened) {
            // The call itself succeeded whatever happens to its page: a page
            // that cannot be read is said so, and the call is not repeated.
            try {
              const source = await readPageResource(
                (method, params) => transport.request(method, params, context.signal),
                pageUri,
              );
              detail.page = await context.opened({
                ...source,
                arguments: action.canonical_payload,
                result,
              });
            } catch (error) {
              // Not even a transport fault goes further: the call has been made,
              // and a fault here would let a repair send it a second time.
              console.error(
                `mcp page: ${config.id} ${pageUri} was not shown: ${error instanceof Error ? error.message : String(error)}`,
              );
              detail.page = {
                shown: false,
                note: 'The server said this tool shows a page, but it could not be shown, so the person has not seen it.',
              };
            }
          }
          return {
            outcome: 'succeeded',
            receipt: {
              action_id: action.id,
              connection_id: action.connection_id,
              external_ref: `mcp:${config.id}:${action.id}`,
              detail,
              received_at: new Date().toISOString(),
              late: false,
            },
          };
        } catch (error) {
          if (error instanceof ConnectorFaultError) throw error;
          if (error instanceof McpProtocolError) {
            const said = rpcText(error);
            const code: JsonObject = error.code === undefined ? {} : { error_code: error.code };
            const refusal = rpcRefusal(error);
            // The server answered before anything ran: the call did not happen.
            if (refusal === 'missing')
              return {
                outcome: 'failed',
                reason: 'MCP server does not offer this tool now; nothing was done',
                // Sent again as it is, it would meet the same answer.
                retryable: false,
                evidence: serverAccount(action, said, {
                  ...code,
                  ...(await offeredNow(context.signal)),
                }),
              };
            if (refusal === 'input')
              return {
                outcome: 'failed',
                reason: 'MCP server refused the arguments; nothing was done',
                retryable: true,
                evidence: serverAccount(action, said, {
                  ...code,
                  ...(await approvedSchema(action.kind, context.signal)),
                }),
              };
            if (refusal === 'request')
              return {
                outcome: 'failed',
                reason: 'MCP server refused the request; nothing was done',
                retryable: true,
                evidence: serverAccount(action, said, code),
              };
            // An error that does not prove the tool did not run, such as an
            // output check after it ran: what it said still reaches the agent.
            if (said)
              return {
                outcome: 'unknown',
                reason:
                  'MCP server answered with an error that does not say whether the tool ran; the call was not replayed',
                evidence: serverAccount(action, said, code),
              };
          }
          // No answer, or an answer cut off after the call went out.
          return {
            outcome: 'unknown',
            reason:
              'MCP server did not return a confirmed acknowledgement; the call was not replayed',
          };
        }
      },
      async verify() {
        return {
          decision: 'unsupported',
          reason: 'MCP has no general effect verification protocol; unknown calls are not replayed',
        };
      },
      async health() {
        try {
          // The stateless revision has no ping; asking a server about itself is its check.
          await transport.request(stateless ? 'server/discover' : 'ping');
          return {
            status: healthNotes.length ? 'degraded' : 'ok',
            detail: ['MCP server answered ping', ...healthNotes].join('; '),
            checked_at: new Date().toISOString(),
          };
        } catch {
          return {
            status: 'failing',
            detail: 'MCP server did not answer ping',
            checked_at: new Date().toISOString(),
          };
        }
      },
      close: () => transport.close(),
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
}
