/**
 * The model automatic memory reads chat with. It is the service's own model
 * gateway, as the learning proposer's and the companies scan's are, with a
 * memory-sized ledger: the provider key never leaves the gateway, and each
 * person's memory is held to a daily number of extraction calls. A refusal or a
 * provider failure only means a message is not read this time; it is never a
 * failure of the conversation it came from.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Env } from '../env.ts';
import { configuredProviders } from '../gateway/configured.ts';
import { createModelGateway, type GatewayOptions } from '../gateway/index.ts';
import { modelApiMode, protocolForApiMode } from '../gateway/providers.ts';
import { type GatewayBudget, GatewayError, type GatewayPrincipal } from '../gateway/types.ts';
import { MemoryError, type MemorySql } from './db.ts';
import type { ExtractionCall, ExtractionGateway } from './extract.ts';
import { EXTRACTION_LIMITS } from './work.ts';

const INPUT_TOKENS = 12_000;

const responsesReply = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string() })).optional(),
    }),
  ),
});
const messagesReply = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
const chatReply = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export type MemoryGatewayOptions = {
  sql: MemorySql;
  provider: string;
  model: string;
  providers: NonNullable<GatewayOptions['providers']>;
  dailyCalls: number;
  fake?: GatewayOptions['fake'];
  fetch?: GatewayOptions['fetch'];
};

export async function openMemoryGateway(options: MemoryGatewayOptions) {
  const tokens = new Map<string, ExtractionCall>();
  const principals = new WeakMap<GatewayPrincipal, ExtractionCall>();
  const budget: GatewayBudget = {
    async reserve(request) {
      const call = principals.get(request.principal);
      if (!call || request.provider !== options.provider || request.model !== options.model)
        throw new GatewayError(403, 'memory_principal_denied');
      if (
        request.estimatedTokens > INPUT_TOKENS + EXTRACTION_LIMITS.output_tokens ||
        request.maxOutputTokens > EXTRACTION_LIMITS.output_tokens
      )
        throw new GatewayError(429, 'memory_call_too_large');
      return options.sql.begin(async (tx) => {
        // One person's calls are counted under one lock, so two workers cannot
        // both take the last call of the day.
        await tx`select pg_advisory_xact_lock(hashtext(${`memory-calls:${call.ownerId}`}))`;
        const [used] = await tx`select count(*)::int as calls from memory_model_calls
          where owner_id = ${call.ownerId} and created_at > clock_timestamp() - interval '1 day'`;
        if (Number(used?.calls ?? 0) >= options.dailyCalls)
          throw new GatewayError(429, 'memory_daily_budget');
        const id = randomUUID();
        await tx`insert into memory_model_calls (id, owner_id, space_id, work_id, provider, model, reserved_tokens)
          values (${id}, ${call.ownerId}, ${call.spaceId}, ${call.workId}, ${options.provider}, ${options.model}, ${request.estimatedTokens})`;
        return { id };
      });
    },
    async settle(reservation, settlement) {
      await options.sql`update memory_model_calls set settlement = ${JSON.stringify(settlement)}::text::jsonb
        where id = ${reservation.id}`;
    },
  };
  const server = createModelGateway({
    budget,
    providers: options.providers,
    fake: options.fake,
    fetch: options.fetch,
    defaultProvider: options.provider,
    timeoutMs: EXTRACTION_LIMITS.timeout_ms,
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 128 * 1024,
    async authenticate(token) {
      const call = tokens.get(token);
      if (!call) throw new GatewayError(401, 'memory_principal_denied');
      const principal: GatewayPrincipal = {
        jobId: `memory:${call.spaceId}`,
        attemptId: `memory:${call.workId}`,
        epoch: 0,
        revision: 0,
        maxRequests: 1,
        maxTokens: INPUT_TOKENS + EXTRACTION_LIMITS.output_tokens,
        allowedModels: [{ provider: options.provider, model: options.model }],
      };
      principals.set(principal, call);
      return principal;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const protocol = protocolForApiMode(modelApiMode(options.provider, options.model));

  const gateway: ExtractionGateway = {
    async chat({ messages, max_tokens, signal }, call) {
      if (!call) throw new MemoryError('extraction_call_unattributed');
      const token = randomUUID();
      tokens.set(token, call);
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const body =
        protocol === 'responses'
          ? { model: options.model, input: messages, max_output_tokens: max_tokens }
          : protocol === 'messages'
            ? {
                model: options.model,
                system,
                messages: messages.filter((message) => message.role !== 'system'),
                max_tokens,
              }
            : { model: options.model, messages, max_tokens };
      try {
        const response = await fetch(`${base}/providers/${options.provider}/v1/${protocol}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-melete-capability': token,
            ...(protocol === 'messages'
              ? { 'x-api-key': 'melete-surrogate-memory' }
              : { authorization: 'Bearer melete-surrogate-memory' }),
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal,
        });
        if (response.status === 429) {
          const text = await response.text();
          throw new MemoryError(
            text.includes('memory_daily_budget')
              ? 'memory_daily_budget'
              : 'extraction_gateway_failure',
          );
        }
        if (!response.ok) throw new MemoryError('extraction_gateway_failure');
        const result = await response.json();
        return protocol === 'responses'
          ? responsesReply
              .parse(result)
              .output.flatMap((item) => item.content ?? [])
              .filter((item) => item.type === 'output_text')
              .map((item) => item.text)
              .join('')
          : protocol === 'messages'
            ? messagesReply
                .parse(result)
                .content.filter((item) => item.type === 'text')
                .map((item) => item.text ?? '')
                .join('')
            : (chatReply.parse(result).choices[0]?.message.content ?? '');
      } finally {
        tokens.delete(token);
      }
    },
  };
  return {
    gateway,
    async close() {
      tokens.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * The memory gateway this deployment runs, or none when the operator turned
 * model extraction off. Structured observations are read without a model either way.
 */
export async function configuredMemoryGateway(
  sql: MemorySql,
  env: Env,
  fake?: GatewayOptions['fake'],
) {
  const setting = env.MELETE_MEMORY_MODEL?.trim();
  if (setting === 'off') return null;
  return openMemoryGateway({
    sql,
    provider: env.MELETE_MEMORY_PROVIDER?.trim() || env.MELETE_DEFAULT_PROVIDER,
    model: setting || env.MELETE_DEFAULT_MODEL,
    providers: configuredProviders(env, () => {}),
    dailyCalls: env.MELETE_MEMORY_DAILY_CALLS,
    fake,
  });
}
