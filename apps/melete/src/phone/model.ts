/**
 * The model that answers a phone turn.
 *
 * A job attempt is far too slow for a phone turn, so a call is answered by the
 * gateway model directly: one request per turn, with the call's context, what
 * memory recalls for the person, and a small set of call tools. It is the
 * service's own model gateway with a call-sized ledger, as memory's and the
 * company scan's are: the provider key never leaves it.
 *
 * The request is written in whichever protocol the configured model speaks
 * (chat completions, responses or messages), and the reply is read back to one
 * shape: what to say, and which call tools the model asked for.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Env } from '../env.ts';
import { configuredProviders } from '../gateway/configured.ts';
import { createModelGateway, type GatewayOptions } from '../gateway/index.ts';
import { modelApiMode, protocolForApiMode } from '../gateway/providers.ts';
import { GatewayError, type GatewayProtocol } from '../gateway/types.ts';

export type TurnMessage = { role: 'user' | 'assistant'; content: string };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelTurn = { system: string; messages: TurnMessage[]; tools: ToolSpec[] };
export type ToolRequest = { name: string; arguments: Record<string, unknown> };
export type ModelReply = { text: string; calls: ToolRequest[] };

export interface CallModel {
  reply(turn: ModelTurn, signal?: AbortSignal): Promise<ModelReply>;
}

export const CALL_LIMITS = {
  /** A spoken reply is a few sentences. */
  output_tokens: 400,
  input_tokens: 24_000,
  timeout_ms: 12_000,
} as const;

/** The body for one turn, in the protocol the model is served over. */
export function turnRequest(
  protocol: GatewayProtocol,
  model: string,
  turn: ModelTurn,
): Record<string, unknown> {
  if (protocol === 'responses')
    return {
      model,
      input: [{ role: 'system', content: turn.system }, ...turn.messages],
      max_output_tokens: CALL_LIMITS.output_tokens,
      ...(turn.tools.length
        ? {
            tools: turn.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
    };
  if (protocol === 'messages')
    return {
      model,
      system: turn.system,
      messages: alternating(turn.messages),
      max_tokens: CALL_LIMITS.output_tokens,
      ...(turn.tools.length
        ? {
            tools: turn.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
    };
  return {
    model,
    messages: [{ role: 'system', content: turn.system }, ...turn.messages],
    max_tokens: CALL_LIMITS.output_tokens,
    ...(turn.tools.length
      ? {
          tools: turn.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
  };
}

/**
 * The messages protocol wants turns that alternate and start with the other
 * party. A call Melete opened starts with Melete, so a marker turn goes first,
 * and two lines from the same side are joined.
 */
function alternating(messages: TurnMessage[]): TurnMessage[] {
  const out: TurnMessage[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last && last.role === message.role) last.content = `${last.content}\n${message.content}`;
    else out.push({ ...message });
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: '(The call connected.)' });
  return out;
}

const argumentsOf = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const chatReply = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(z.object({ function: z.object({ name: z.string(), arguments: z.unknown() }) }))
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
});
const responsesReply = z.object({
  output: z.array(
    z.looseObject({
      type: z.string(),
      name: z.string().optional(),
      arguments: z.unknown().optional(),
      content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
});
const messagesReply = z.object({
  content: z.array(
    z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      name: z.string().optional(),
      input: z.unknown().optional(),
    }),
  ),
});

/** What the model said and asked for, whatever protocol it answered in. */
export function readReply(protocol: GatewayProtocol, body: unknown): ModelReply {
  if (protocol === 'responses') {
    const output = responsesReply.parse(body).output;
    return {
      text: output
        .flatMap((item) => (item.type === 'message' ? (item.content ?? []) : []))
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join(''),
      calls: output
        .filter((item) => item.type === 'function_call' && item.name)
        .map((item) => ({ name: item.name ?? '', arguments: argumentsOf(item.arguments) })),
    };
  }
  if (protocol === 'messages') {
    const content = messagesReply.parse(body).content;
    return {
      text: content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(''),
      calls: content
        .filter((part) => part.type === 'tool_use' && part.name)
        .map((part) => ({ name: part.name ?? '', arguments: argumentsOf(part.input) })),
    };
  }
  const message = chatReply.parse(body).choices[0]?.message;
  return {
    text: message?.content ?? '',
    calls: (message?.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      arguments: argumentsOf(call.function.arguments),
    })),
  };
}

export type CallGatewayOptions = {
  provider: string;
  model: string;
  providers: NonNullable<GatewayOptions['providers']>;
  fake?: GatewayOptions['fake'];
  fetch?: GatewayOptions['fetch'];
};

/**
 * A gateway for phone turns. Each turn gets a token good for one request of
 * call size; the listener is on loopback and does not keep the process alive.
 */
export async function openCallGateway(options: CallGatewayOptions) {
  const tokens = new Set<string>();
  const server = createModelGateway({
    budget: {
      async reserve(request) {
        if (request.provider !== options.provider || request.model !== options.model)
          throw new GatewayError(403, 'call_model_denied');
        if (
          request.estimatedTokens > CALL_LIMITS.input_tokens + CALL_LIMITS.output_tokens ||
          request.maxOutputTokens > CALL_LIMITS.output_tokens
        )
          throw new GatewayError(429, 'call_turn_too_large');
        return { id: randomUUID() };
      },
      async settle() {},
    },
    providers: options.providers,
    fake: options.fake,
    fetch: options.fetch,
    defaultProvider: options.provider,
    timeoutMs: CALL_LIMITS.timeout_ms,
    maxRequestBytes: 512 * 1024,
    maxResponseBytes: 128 * 1024,
    async authenticate(token) {
      if (!tokens.has(token)) throw new GatewayError(401, 'call_principal_denied');
      return {
        jobId: 'phone-call',
        attemptId: `turn:${token.slice(0, 8)}`,
        epoch: 0,
        revision: 0,
        maxRequests: 1,
        maxTokens: CALL_LIMITS.input_tokens + CALL_LIMITS.output_tokens,
        allowedModels: [{ provider: options.provider, model: options.model }],
      };
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const protocol = protocolForApiMode(modelApiMode(options.provider, options.model));
  const model: CallModel = {
    async reply(turn, signal) {
      const token = randomUUID();
      tokens.add(token);
      try {
        const response = await fetch(`${base}/providers/${options.provider}/v1/${protocol}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-melete-capability': token,
            ...(protocol === 'messages'
              ? { 'x-api-key': 'melete-surrogate-phone' }
              : { authorization: 'Bearer melete-surrogate-phone' }),
          },
          body: JSON.stringify(turnRequest(protocol, options.model, turn)),
          redirect: 'error',
          signal: signal ?? AbortSignal.timeout(CALL_LIMITS.timeout_ms + 1000),
        });
        if (!response.ok) throw new Error(`call model refused with ${response.status}`);
        return readReply(protocol, await response.json());
      } finally {
        tokens.delete(token);
      }
    },
  };
  return {
    model,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** The call model this deployment uses, opened the first time a call needs it. */
export function configuredCallModel(env: Env): () => Promise<CallModel> {
  let opened: Promise<CallModel> | undefined;
  return () => {
    opened ??= openCallGateway({
      provider: env.MELETE_PHONE_PROVIDER?.trim() || env.MELETE_DEFAULT_PROVIDER,
      model: env.MELETE_PHONE_MODEL?.trim() || env.MELETE_DEFAULT_MODEL,
      providers: configuredProviders(env, () => {}),
    })
      .then((gateway) => gateway.model)
      .catch((error) => {
        opened = undefined;
        throw error;
      });
    return opened;
  };
}
