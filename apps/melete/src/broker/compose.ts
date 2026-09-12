import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import {
  type Action,
  type CapabilityClaims,
  canonicalizePayload,
  type JsonObject,
  type JsonValue,
  jsonObject,
  type ProposeActionRequest,
  receipt,
  type ToolSpec,
} from '@melete/contracts';
import { z } from 'zod';
import { accountToolName, schemaFingerprint } from './catalog.ts';
import { BrokerFault } from './errors.ts';

export type ComposeLimits = {
  max_reads: number;
  max_script_bytes: number;
  max_argument_bytes: number;
  max_input_bytes: number;
  max_result_bytes: number;
  max_wall_ms: number;
};

export const COMPOSE_LIMITS: Readonly<ComposeLimits> = Object.freeze({
  max_reads: 8,
  max_script_bytes: 8_192,
  max_argument_bytes: 16_384,
  max_input_bytes: 1_048_576,
  max_result_bytes: 32_768,
  max_wall_ms: 5_000,
});

/**
 * W10a supplies this implementation inside the cell. It must isolate the script,
 * bound memory/CPU, and terminate on abort. Only JSON data crosses this seam;
 * no broker client, token, credentials, callbacks, or host objects are passed in.
 */
export interface ComposeExecutor {
  execute(
    request: { script: string; data: JsonObject; limits: Readonly<ComposeLimits> },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface ComposeBroker {
  authorize(claims: CapabilityClaims): Promise<void>;
  /** The read-only classification is rechecked inside the broker's proposal transaction. */
  proposeRead(
    claims: CapabilityClaims,
    request: ProposeActionRequest,
  ): Promise<{ action_id: string; status: string; effect_class: string }>;
  get(claims: CapabilityClaims, id: string): Promise<Action>;
}

export type ComposeOptions = {
  broker: ComposeBroker;
  /** Full current scope, supplied by the trusted service rather than the caller or executor. */
  catalog: (claims: CapabilityClaims) => Promise<readonly ToolSpec[]>;
  executor?: ComposeExecutor;
  /** Service policy may lower these bounds. Tool arguments cannot change them. */
  limits?: Partial<ComposeLimits>;
};

const readRequest = z
  .object({
    as: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .refine((name) => name !== 'constructor' && name !== 'prototype'),
    name: z.string().min(1).max(300),
    arguments: jsonObject.default({}),
  })
  .strict();
const requestSchema = z
  .object({
    reads: z.array(readRequest).max(COMPOSE_LIMITS.max_reads),
    script: z.string().min(1).max(COMPOSE_LIMITS.max_script_bytes),
  })
  .strict();
type ComposeRead = z.infer<typeof readRequest>;

export const COMPOSE_TOOL: ToolSpec = {
  name: 'compose',
  description:
    'Join, filter or loop over predeclared read tools. Return compact JSON and evidence.',
  input_schema: {
    type: 'object',
    properties: {
      reads: {
        type: 'array',
        maxItems: COMPOSE_LIMITS.max_reads,
        items: {
          type: 'object',
          properties: {
            as: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
            name: { type: 'string', minLength: 1, maxLength: 300 },
            arguments: { type: 'object' },
          },
          required: ['as', 'name'],
          additionalProperties: false,
        },
      },
      script: {
        type: 'string',
        maxLength: COMPOSE_LIMITS.max_script_bytes,
        description:
          'JavaScript function body. Read data[as] and return JSON; no tool or host access.',
      },
    },
    required: ['reads', 'script'],
    additionalProperties: false,
  },
  effect_class: 'read',
  connection_id: null,
};

export type ComposeEvidence = {
  as: string;
  handle: string;
  action_id: string;
  connection_id: string;
  kind: string;
  payload_hash: string;
  receipt_hash: string;
  /** Receipt contents remain external data, including any self-declared origin fields. */
  origin_trust: 'external_content';
};
export type ComposeResult = {
  result: JsonValue;
  evidence: ComposeEvidence[];
  /** A computed result never upgrades its inputs to owner or verified-connector authority. */
  origin_trust: 'inferred';
};

function boundedJson(value: unknown, maxBytes: number, label: string) {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (
        item === undefined ||
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        typeof item === 'bigint' ||
        (typeof item === 'number' && !Number.isFinite(item))
      ) {
        throw new Error('Not JSON');
      }
      return item;
    });
  } catch {
    throw new BrokerFault('payload_invalid', `Compose ${label} must be JSON`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new BrokerFault('payload_invalid', `Compose ${label} exceeds the byte limit`);
  }
  return { value: JSON.parse(encoded) as JsonValue, encoded };
}

function selectRead(tools: readonly ToolSpec[], read: ComposeRead): ToolSpec {
  const matches = tools.filter((tool) => tool.name === read.name);
  if (matches.length !== 1) throw new BrokerFault('unknown_tool', 'Compose tool is unavailable');
  const tool = matches[0];
  if (
    !tool?.connection_id ||
    ['compose', 'search_tools', 'load_tool'].includes(tool.name) ||
    tool.effect_class !== 'read'
  ) {
    throw new BrokerFault('scope_denied', 'Compose accepts connector read tools only');
  }
  return tool;
}

/**
 * The wrapper plans reads but never authorizes them. Every read still reserves
 * its own broker budget and receives its own durable action and receipt.
 */
export class ComposeService {
  private readonly limits: Readonly<ComposeLimits>;

  constructor(private readonly options: ComposeOptions) {
    this.limits = Object.freeze({ ...COMPOSE_LIMITS, ...options.limits });
    for (const key of Object.keys(COMPOSE_LIMITS) as Array<keyof ComposeLimits>) {
      const value = this.limits[key];
      if (!Number.isSafeInteger(value) || value <= 0 || value > COMPOSE_LIMITS[key]) {
        throw new Error(`Invalid compose policy bound: ${key}`);
      }
    }
  }

  async run(claims: CapabilityClaims, args: unknown): Promise<ComposeResult> {
    const executor = this.options.executor;
    if (!executor) {
      throw new BrokerFault('connector_unavailable', 'Compose requires a configured cell executor');
    }
    const parsed = requestSchema.safeParse(args);
    if (!parsed.success) throw new BrokerFault('payload_invalid', 'Invalid compose request');
    const request = parsed.data;
    if (
      request.reads.length > this.limits.max_reads ||
      Buffer.byteLength(request.script, 'utf8') > this.limits.max_script_bytes ||
      new Set(request.reads.map((read) => read.as)).size !== request.reads.length
    ) {
      throw new BrokerFault('payload_invalid', 'Compose limits or unique input names required');
    }
    boundedJson(request.reads, this.limits.max_argument_bytes, 'arguments');
    const controller = new AbortController();
    const deadline = Date.now() + this.limits.max_wall_ms;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) {
        controller.abort();
        throw new BrokerFault('budget_exceeded', 'Compose deadline exceeded');
      }
      return ms;
    };
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const ms = remaining();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new BrokerFault('budget_exceeded', 'Compose deadline exceeded'));
        }, ms);
      });
      try {
        const value = await Promise.race([operation(), timeout]);
        remaining();
        return value;
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      await bounded(() => this.options.broker.authorize(claims));
      const tools = await bounded(() => this.options.catalog(claims));
      // Preflight the entire plan so a later write cannot hide behind earlier reads.
      const planned = request.reads.map((read) => structuredClone(selectRead(tools, read)));
      const data: JsonObject = {};
      const evidence: ComposeEvidence[] = [];
      for (const [index, read] of request.reads.entries()) {
        const original = planned[index];
        const current = selectRead(await bounded(() => this.options.catalog(claims)), read);
        if (
          !original ||
          original.connection_id !== current.connection_id ||
          schemaFingerprint(original.input_schema) !== schemaFingerprint(current.input_schema)
        ) {
          throw new BrokerFault('scope_denied', 'Compose tool changed after preflight');
        }
        const connectionId = current.connection_id;
        if (!connectionId) throw new BrokerFault('unknown_connection');
        const proposal = await bounded(() =>
          this.options.broker.proposeRead(claims, {
            kind: current.name,
            connection_id: connectionId,
            payload: read.arguments,
          }),
        );
        if (proposal.effect_class !== 'read' || proposal.status !== 'succeeded') {
          throw new BrokerFault('action_not_admissible', 'Compose requires a successful read');
        }
        const action = await bounded(() => this.options.broker.get(claims, proposal.action_id));
        if (
          action.id !== proposal.action_id ||
          action.job_id !== claims.job_id ||
          action.connection_id !== connectionId ||
          (action.kind !== current.name &&
            accountToolName(action.kind, connectionId) !== current.name) ||
          action.payload_hash !== canonicalizePayload(read.arguments).hash ||
          action.effect_class !== 'read' ||
          action.status !== 'succeeded'
        ) {
          throw new BrokerFault('action_not_admissible', 'Compose action does not match its read');
        }
        const stored = boundedJson(action.receipt, this.limits.max_input_bytes, 'input');
        const parsedReceipt = receipt.safeParse(stored.value);
        if (
          !parsedReceipt.success ||
          parsedReceipt.data.action_id !== action.id ||
          parsedReceipt.data.connection_id !== action.connection_id
        ) {
          throw new BrokerFault('action_not_admissible', 'Compose requires a matching receipt');
        }
        data[read.as] = parsedReceipt.data.detail;
        boundedJson(data, this.limits.max_input_bytes, 'input');
        evidence.push({
          as: read.as,
          handle: `action:${action.id}`,
          action_id: action.id,
          connection_id: action.connection_id,
          kind: action.kind,
          payload_hash: action.payload_hash,
          receipt_hash: createHash('sha256').update(stored.encoded).digest('hex'),
          origin_trust: 'external_content',
        });
      }
      // The final read may have raced a revocation. Recheck before exposing its
      // data to execution and again before returning the derived result.
      await bounded(() => this.options.broker.authorize(claims));
      for (const item of evidence) {
        await bounded(() => this.options.broker.get(claims, item.action_id));
      }
      let result: unknown;
      try {
        result = await bounded(() =>
          executor.execute(
            { script: request.script, data, limits: { ...this.limits, max_wall_ms: remaining() } },
            controller.signal,
          ),
        );
      } catch (error) {
        if (error instanceof BrokerFault) throw error;
        throw new BrokerFault('payload_invalid', 'Compose script failed');
      }
      const output = boundedJson(result, this.limits.max_result_bytes, 'result').value;
      await bounded(() => this.options.broker.authorize(claims));
      for (const item of evidence) {
        await bounded(() => this.options.broker.get(claims, item.action_id));
      }
      const response: ComposeResult = { result: output, evidence, origin_trust: 'inferred' };
      boundedJson(response, this.limits.max_result_bytes, 'response');
      return response;
    } finally {
      controller.abort();
    }
  }
}

/**
 * In-process fallback for deterministic tests only. node:vm is NOT a security
 * boundary and cannot impose a heap limit. Service startup never selects this
 * implementation; production must supply the W10a cell executor.
 */
export function createTestComposeExecutor(): ComposeExecutor {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('The in-process compose executor is only available in tests');
  }
  return {
    async execute(request, signal) {
      if (process.env.NODE_ENV !== 'test') throw new Error('Test executor is disabled');
      signal.throwIfAborted();
      // JSON text creates fresh values in the test context, never host references.
      const data = JSON.stringify(JSON.stringify(request.data));
      const program = new Script(`"use strict";
const data = JSON.parse(${data});
const result = (() => { ${request.script}\n})();
if (result && typeof result.then === 'function') throw new Error('Return synchronous JSON');
JSON.stringify(result, (_key, value) => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
      typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('Return JSON');
  }
  return value;
});`);
      const result: unknown = program.runInNewContext(Object.create(null), {
        timeout: request.limits.max_wall_ms,
        contextCodeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate',
      });
      signal.throwIfAborted();
      if (typeof result !== 'string') throw new Error('Return JSON');
      return JSON.parse(result) as JsonValue;
    },
  };
}
