import { readFile } from 'node:fs/promises';
import {
  type Action,
  type ConnectorHealth,
  type ConnectorTool,
  canonicalizePayload,
  connectorTool,
  type DispatchResult,
  effectClass,
  type JsonObject,
  jsonObject,
  jsonSchema,
  type VerifyResult,
} from '@melete/contracts';
import { z } from 'zod';
import {
  MCP_PROTOCOL_VERSION,
  type McpTransport,
  openHttpMcpTransport,
  openStdioMcpTransport,
} from './mcp-transport.ts';
import type { ConnectorContext } from './types.ts';

const scope = z.string().min(1).max(160);
const operatorTool = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    alias: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80),
    required_scopes: z.array(scope).min(1).max(32),
    effect_class: effectClass.default('write_external'),
  })
  .strict();
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
      url: z.url().refine((value) => {
        const parsed = new URL(value);
        return (
          ['http:', 'https:'].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password &&
          !parsed.hash
        );
      }, 'MCP endpoint must be HTTP(S), without credentials or fragments'),
    })
    .strict(),
]);

/** Parsed only from an operator-owned file, never from a tool call or server response. */
export const mcpServerConfig = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(40),
    endpoint,
    allowed_scopes: z.array(scope).min(1).max(64),
    audience: z.literal('owner'),
    tools: z.array(operatorTool).min(1).max(256),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const field of ['name', 'alias'] as const) {
      if (new Set(config.tools.map((tool) => tool[field])).size !== config.tools.length) {
        ctx.addIssue({ code: 'custom', message: `MCP tool ${field} must be unique` });
      }
    }
    for (const tool of config.tools) {
      if (!tool.required_scopes.every((item) => config.allowed_scopes.includes(item))) {
        ctx.addIssue({ code: 'custom', message: 'MCP tool scopes exceed operator allowed_scopes' });
      }
    }
  });
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
  close(): Promise<void>;
};

/** Transport and operator policy stay outside the runtime cell. */
export async function openMcpWorker(
  input: McpServerConfig,
  binding: { connectionId: string; spaceId: string },
  options: { transport?: McpTransport; timeoutMs?: number } = {},
): Promise<McpWorker> {
  const config = mcpServerConfig.parse(input);
  const transport =
    options.transport ??
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
    const rawNames = new Map<string, string>();
    const tools = config.tools
      .map((policy) => {
        const definition = discovered.get(policy.name);
        if (!definition) throw new Error(`Configured MCP tool is unavailable: ${policy.name}`);
        const name = `mcp_${config.id}.${policy.alias}`;
        rawNames.set(name, policy.name);
        return connectorTool.parse({
          name,
          description:
            (definition.description ?? policy.name).replace(/\s+/g, ' ').trim().slice(0, 400) ||
            policy.name,
          // MCP's unspecified dialect is 2020-12. Preserve it explicitly for the
          // broker so newer constraints cannot be silently treated as draft-07.
          input_schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            ...definition.inputSchema,
          },
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
        } catch {
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
            status: 'ok',
            detail: 'MCP server answered ping',
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
