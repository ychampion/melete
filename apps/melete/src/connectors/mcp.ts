import { readFile } from 'node:fs/promises';
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
  type VerifyResult,
} from '@melete/contracts';
import { z } from 'zod';
import { ConnectorFaultError } from './faults.ts';
import {
  MCP_PROTOCOL_VERSION,
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
]);

/** Parsed from authenticated operator installation or configuration, never a tool call. */
export const mcpServerConfig = mcpOperatorPolicy.safeExtend({ endpoint });
export type McpServerConfig = z.infer<typeof mcpServerConfig>;

export async function readMcpConfig(path?: string): Promise<McpServerConfig[]> {
  if (!path) return [];
  const config = z
    .array(mcpServerConfig)
    .max(64)
    .parse(JSON.parse(await readFile(path, 'utf8')));
  if (new Set(config.map((server) => server.id)).size !== config.length) {
    throw new Error('Duplicate MCP installation id');
  }
  return config;
}

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
  // Server annotations, including readOnlyHint, are deliberately not policy inputs.
});
const toolPage = z.object({
  tools: z.array(serverTool).max(256),
  nextCursor: z.string().min(1).max(2048).optional(),
});

/** The service supplies audience and scopes from current authority, never the model payload. */
export type McpExecutionContext = ConnectorContext & {
  audience: string;
  scopes: readonly string[];
};
export type McpWorker = {
  tools: ConnectorTool[];
  catalog: { source: 'mcp' };
  execute(action: Action, context: McpExecutionContext): Promise<DispatchResult>;
  verify(): Promise<VerifyResult>;
  health(): Promise<ConnectorHealth>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
};

export type McpWorkerOptions = McpTransportOptions & {
  transport?: McpTransport;
  transportFactory?: () => Promise<McpTransport>;
  checkCredential?: () => Promise<void>;
};

/** Transport and operator policy stay outside the runtime cell. */
export async function openMcpWorker(
  input: McpServerConfig,
  binding: { connectionId: string; spaceId: string },
  options: McpWorkerOptions = {},
): Promise<McpWorker> {
  let current = await openMcpSession(input, binding, options);
  const pinned = canonicalizePayload({ tools: current.tools }).hash;
  let closed = false;
  let reopening: Promise<void> | undefined;
  return {
    tools: structuredClone(current.tools),
    catalog: current.catalog,
    execute: (action, context) => current.execute(action, context),
    verify: () => current.verify(),
    health: () => current.health(),
    async reconnect() {
      if (closed) throw new Error('MCP worker is closed');
      reopening ??= (async () => {
        await current.close();
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
      await current.close();
    },
  };
}

async function openMcpSession(
  input: McpServerConfig,
  binding: { connectionId: string; spaceId: string },
  options: McpWorkerOptions,
): Promise<Omit<McpWorker, 'reconnect'>> {
  const config = mcpServerConfig.parse(input);
  const transport =
    options.transport ??
    (await options.transportFactory?.()) ??
    (config.endpoint.transport === 'stdio'
      ? await openStdioMcpTransport(config.endpoint, options)
      : openHttpMcpTransport(config.endpoint, options));
  try {
    const initialized = jsonObject.parse(
      await transport.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'melete', version: '0.1.0' },
      }),
    );
    if (initialized.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error('MCP server negotiated an unsupported protocol version');
    }
    const capabilities = jsonObject.parse(initialized.capabilities);
    if (!capabilities.tools) throw new Error('MCP server does not expose tools');
    await transport.notify('notifications/initialized');
    const discovered = new Map<string, z.infer<typeof serverTool>>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= 16) throw new Error('MCP catalog page limit exceeded');
      const page = toolPage.parse(await transport.request('tools/list', cursor ? { cursor } : {}));
      for (const tool of page.tools) {
        if (discovered.has(tool.name)) throw new Error('Duplicate MCP server tool');
        discovered.set(tool.name, tool);
      }
      if (discovered.size > 256) throw new Error('MCP catalog tool limit exceeded');
      cursor = page.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('Repeated MCP pagination cursor');
      cursors.add(cursor);
    }
    const healthNotes: string[] = [];
    const rawNames = new Map<string, string>();
    const tools = config.tools
      .flatMap((policy) => {
        const definition = discovered.get(policy.name);
        if (!definition) throw new Error(`Configured MCP tool is unavailable: ${policy.name}`);
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
    // A caller receives a copy; mutating presentation cannot alter execution policy.
    const authoritative = new Map(tools.map((tool) => [tool.name, structuredClone(tool)]));
    return {
      tools,
      catalog: { source: 'mcp' },
      async execute(action, context) {
        const tool = authoritative.get(action.kind);
        if (
          !tool ||
          action.connection_id !== binding.connectionId ||
          context.space_id !== binding.spaceId ||
          context.job_id !== action.job_id ||
          context.audience !== config.audience ||
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
          const result = jsonObject.parse(
            await transport.request(
              'tools/call',
              {
                name: rawNames.get(action.kind) as string,
                arguments: action.canonical_payload,
                _meta: { 'melete/action_id': action.id, 'melete/idempotency_key': action.id },
              },
              context.signal,
            ),
          );
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
          await transport.request('ping');
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
