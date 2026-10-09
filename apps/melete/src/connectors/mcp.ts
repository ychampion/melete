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
  openHttpMcpTransport,
  openStdioMcpTransport,
} from './mcp-transport.ts';
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
};
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
  catalog: { source: 'mcp' };
  execute(action: Action, context: McpExecutionContext): Promise<DispatchResult>;
  verify(): Promise<VerifyResult>;
  health(): Promise<ConnectorHealth>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
};
type McpSession = Omit<McpWorker, 'reconnect'>;

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
};

/** A tool the installation names that the server does not list. */
export class McpToolMissingError extends Error {
  constructor(readonly tool: string) {
    super(`Configured MCP tool is unavailable: ${tool}`);
    this.name = 'McpToolMissingError';
  }
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
  let current: McpSession | undefined = options.pinned
    ? undefined
    : await openMcpSession(input, binding, options);
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
    get readOnly() {
      return [...(current?.readOnly ?? [])];
    },
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
  const tools = config.tools
    .flatMap((policy) => {
      const definition = discovered.get(policy.name);
      if (!definition) throw new McpToolMissingError(policy.name);
      // What is recorded is the tool, never the server's own annotations.
      const { annotations, ...recorded } = definition;
      definitions.push(recorded);
      const name = `mcp_${config.id}.${policy.alias}`;
      const inputSchema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...definition.inputSchema,
      };
      if (!toolSchemaFits(inputSchema)) {
        healthNotes.push(`${policy.name}: schema exceeds ${MAX_TOOL_SCHEMA_BYTES} UTF-8 bytes`);
        return [];
      }
      rawNames.set(name, policy.name);
      if (annotations?.readOnlyHint === true) readOnly.push(name);
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
  return { tools, definitions, readOnly: readOnly.sort(), rawNames, healthNotes };
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
  if (statelessServer) capabilities = statelessServer.capabilities;
  else {
    const initialized = jsonObject.parse(
      await transport.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { ...MCP_CLIENT_INFO },
      }),
    );
    const agreed = initialized.protocolVersion;
    if (typeof agreed !== 'string' || !MCP_HANDSHAKE_VERSIONS.includes(agreed)) {
      throw new Error('MCP server negotiated an unsupported protocol version');
    }
    transport.agreed?.(agreed);
    capabilities = jsonObject.parse(initialized.capabilities);
  }
  if (!capabilities.tools) throw new Error('MCP server does not expose tools');
  if (!stateless) await transport.notify('notifications/initialized');
  const discovered = new Map<string, McpToolDefinition>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let listBytes = 0;
  for (let pageNumber = 0; ; pageNumber++) {
    if (pageNumber >= 16) throw new Error('MCP catalog page limit exceeded');
    const page = toolPage.parse(await transport.request('tools/list', cursor ? { cursor } : {}));
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
  const paramHeaders = new Map<string, McpParamHeader[]>();
  for (const [name, definition] of discovered) {
    const annotated = mcpParamHeaders(definition.inputSchema);
    if (annotated === null && stateless) discovered.delete(name);
    else if (annotated?.length) paramHeaders.set(name, annotated);
  }
  return { stateless, discovered, paramHeaders };
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
    const { stateless, discovered, paramHeaders } = await introduce(transport);
    const { tools, definitions, readOnly, rawNames, healthNotes } = policyTools(config, discovered);
    // A caller receives a copy; mutating presentation cannot alter execution policy.
    const authoritative = new Map(tools.map((tool) => [tool.name, structuredClone(tool)]));
    return {
      tools,
      definitions,
      readOnly,
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
                _meta: { 'melete/action_id': action.id, 'melete/idempotency_key': action.id },
              },
              context.signal,
              annotated ? mcpParamHeaderValues(annotated, action.canonical_payload) : undefined,
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
            return { outcome: 'failed', reason: 'MCP tool returned an error', retryable: false };
          }
          if (!Array.isArray(result.content)) throw new Error('Invalid MCP tool acknowledgement');
          const detail: JsonObject = {
            server_id: config.id,
            tool: rawNames.get(action.kind) as string,
            result,
            origin_trust: 'external_content',
            evidence_handle: `mcp:${config.id}:${action.id}`,
          };
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
