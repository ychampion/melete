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
import type { Env } from '../env.ts';
import { configuredProviders } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import { createModelGateway, type GatewayOptions } from '../gateway/index.ts';
import {
  type ModelSettingsService,
  type ServiceModel,
  type ServiceModelSource,
  serviceModelSource,
} from '../gateway/model-settings.ts';
import { modelApiMode, protocolForApiMode } from '../gateway/providers.ts';
import {
  type ModelRouting,
  NO_ROUTING,
  routingFromEnv,
  serviceFallback,
} from '../gateway/routing.ts';
import { replyOf, StructuredAnswerError, withStructuredOutput } from '../gateway/structured.ts';
import { type GatewayBudget, GatewayError, type GatewayPrincipal } from '../gateway/types.ts';
import { MemoryError, type MemorySql } from './db.ts';
import type { ExtractionCall, ExtractionGateway } from './extract.ts';
import { EXTRACTION_LIMITS } from './work.ts';

const INPUT_TOKENS = 12_000;

/**
 * What asks a provider's chat models to answer without reasoning first.
 * Reading a message into memory needs no reasoning, and a model that reasons by
 * default can spend the whole output budget thinking and return nothing. A
 * model that cannot stop thinking refuses the field, and is asked again as it is.
 */
const ANSWER_DIRECTLY: Record<string, Record<string, unknown>> = {
  fireworks: { reasoning_effort: 'none' },
};

export type MemoryGatewayOptions = {
  sql: MemorySql;
  provider: string;
  model: string;
  providers: NonNullable<GatewayOptions['providers']>;
  /**
   * The model and keys each call uses, read per call. Left out, every call
   * uses `provider`, `model` and `providers` as given.
   */
  source?: ServiceModelSource;
  dailyCalls: number;
  fake?: GatewayOptions['fake'];
  fetch?: GatewayOptions['fetch'];
  /** How long one call may take; the extraction limit unless a test shortens it. */
  timeoutMs?: number;
  /** The service's privacy router; what the person wrote is redacted before it is read. */
  privacy: GatewayOptions['privacy'];
  /** The installation's spending caps. */
  spending?: GatewayOptions['spending'];
  /** The operator's fallbacks for a provider that limits or fails. */
  routing?: ModelRouting;
  /** How hard a reasoning model thinks on a memory read. */
  reasoningEffort?: GatewayOptions['reasoningEffort'];
};

export async function openMemoryGateway(options: MemoryGatewayOptions) {
  type Call = ExtractionCall & ServiceModel;
  const tokens = new Map<string, Call>();
  const principals = new WeakMap<GatewayPrincipal, Call & { token: string }>();
  const reservations = new Map<string, string>();
  /** What the provider answered for each call, read back when the call fails. */
  const upstream = new Map<string, number | null>();
  const budget: GatewayBudget = {
    async reserve(request) {
      const call = principals.get(request.principal);
      if (
        !call ||
        !request.principal.allowedModels.some(
          (allowed) => allowed.provider === request.provider && allowed.model === request.model,
        )
      )
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
        // A call the provider answered with an error generated nothing and is
        // not a read. Every other call that was sent counts, a timeout included:
        // the provider may have done the work.
        const [used] = await tx`select count(*)::int as calls from memory_model_calls
          where owner_id = ${call.ownerId} and created_at > clock_timestamp() - interval '1 day'
            and coalesce(settlement->>'status', '') <> 'failed'`;
        if (Number(used?.calls ?? 0) >= options.dailyCalls)
          throw new GatewayError(429, 'memory_daily_budget');
        const id = randomUUID();
        await tx`insert into memory_model_calls (id, owner_id, space_id, work_id, provider, model, reserved_tokens)
          values (${id}, ${call.ownerId}, ${call.spaceId}, ${call.workId}, ${request.provider}, ${request.model}, ${request.estimatedTokens})`;
        reservations.set(id, call.token);
        return { id };
      });
    },
    async settle(reservation, settlement) {
      const token = reservations.get(reservation.id);
      reservations.delete(reservation.id);
      if (token) upstream.set(token, settlement.httpStatus);
      await options.sql`update memory_model_calls set settlement = ${JSON.stringify(settlement)}::text::jsonb
        where id = ${reservation.id}`;
    },
  };
  const server = createModelGateway({
    budget,
    providers: options.providers,
    ...(options.source ? { currentProviders: options.source.providers } : {}),
    fake: options.fake,
    fetch: options.fetch,
    privacy: options.privacy,
    spending: options.spending,
    reasoningEffort: options.reasoningEffort,
    defaultProvider: options.provider,
    timeoutMs: options.timeoutMs ?? EXTRACTION_LIMITS.timeout_ms,
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 128 * 1024,
    async authenticate(token) {
      const call = tokens.get(token);
      if (!call) throw new GatewayError(401, 'memory_principal_denied');
      const fallback = serviceFallback(options.routing ?? NO_ROUTING, call);
      const principal: GatewayPrincipal = {
        // The person whose words are read: the reads count against their limits.
        actor: call.ownerId,
        jobId: `memory:${call.spaceId}`,
        attemptId: `memory:${call.workId}`,
        // The message's own conversation decides where it may be read: a
        // private or sensitive one stays on the local model, or is not read.
        privacy: {
          kind: 'service',
          purpose: 'memory',
          spaceId: call.spaceId,
          sourceJobId: call.sourceJobId,
        },
        epoch: 0,
        revision: 0,
        maxRequests: 1,
        maxTokens: INPUT_TOKENS + EXTRACTION_LIMITS.output_tokens,
        allowedModels: [{ provider: call.provider, model: call.model }, ...fallback],
        ...(fallback.length ? { routes: { fallback } } : {}),
      };
      principals.set(principal, { ...call, token });
      return principal;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const gateway: ExtractionGateway = {
    async chat({ messages, max_tokens, signal, format }, call) {
      if (!call) throw new MemoryError('extraction_call_unattributed');
      // The model is read for each call, so one connected in the app applies at once;
      // the space owner's secondary model takes it when they chose one for side tasks.
      const target = options.source
        ? await options.source.current({ principalId: call.ownerId })
        : { provider: options.provider, model: options.model };
      const protocol = protocolForApiMode(modelApiMode(target.provider, target.model));
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const plain: Record<string, unknown> =
        protocol === 'responses'
          ? { model: target.model, input: messages, max_output_tokens: max_tokens }
          : protocol === 'messages'
            ? {
                model: target.model,
                system,
                messages: messages.filter((message) => message.role !== 'system'),
                max_tokens,
              }
            : { model: target.model, messages, max_tokens };
      // The schema goes where the provider reads one; elsewhere the prompt asks.
      const body = format ? withStructuredOutput(plain, target, protocol, format) : plain;
      const direct = protocol === 'chat/completions' ? ANSWER_DIRECTLY[target.provider] : undefined;
      // Each request is its own capability, so a second ask is a second read.
      const ask = async (extra: Record<string, unknown> | undefined) => {
        const token = randomUUID();
        tokens.set(token, { ...call, ...target });
        try {
          const response = await fetch(`${base}/providers/${target.provider}/v1/${protocol}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-melete-capability': token,
              ...(protocol === 'messages'
                ? { 'x-api-key': 'melete-surrogate-memory' }
                : { authorization: 'Bearer melete-surrogate-memory' }),
            },
            body: JSON.stringify({ ...body, ...extra }),
            redirect: 'error',
            signal,
          });
          if (response.ok) return { ok: true as const, result: await response.json() };
          return {
            ok: false as const,
            status: response.status,
            text: await response.text(),
            provider: upstream.get(token),
          };
        } finally {
          tokens.delete(token);
          upstream.delete(token);
        }
      };
      let reply = await ask(direct);
      if (!reply.ok && direct && reply.provider === 400) reply = await ask(undefined);
      if (!reply.ok) throw new MemoryError(failureCode(reply.status, reply.text, reply.provider));
      let answer: ReturnType<typeof replyOf>;
      try {
        answer = replyOf(protocol, reply.result);
      } catch (error) {
        if (error instanceof StructuredAnswerError) throw new MemoryError('extraction_unreadable');
        throw error;
      }
      // A document cut off at the output limit can still parse as a shorter
      // one, so it is never read; a refusal is not an answer to read either.
      if (answer.end === 'cut_off') throw new MemoryError('extraction_cut_off');
      if (answer.end === 'refused') throw new MemoryError('extraction_answer_refused');
      return answer.text;
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
 * Why a call failed, in the three kinds the worker treats differently:
 * - `memory_daily_budget`: the person's reads are spent; wait for tomorrow's;
 * - `spending_limit_reached`: a spending limit is reached; wait for it to reset;
 * - `extraction_call_refused` / `extraction_provider_refused`: asking again
 *   cannot succeed (the call is too large for the gateway or the model, or the
 *   provider rejected the request itself, a wrong model name for one); stop;
 * - `extraction_provider_auth`: the provider refused the key (401 or 403);
 *   stop, and health names it, since only a working key helps;
 * - `extraction_gateway_failure`: the provider is failing, limiting or out of
 *   reach, or the call timed out; wait and try again;
 * - `extraction_kept_private`: the message came from a private conversation
 *   and there is no local model to read it on (or the person said to keep it
 *   private); it is not read, now or later.
 */
export function failureCode(status: number, body: string, provider: number | null | undefined) {
  if (body.includes('memory_daily_budget')) return 'memory_daily_budget';
  if (body.includes('spending_limit_reached')) return 'spending_limit_reached';
  if (/privacy_confirmation_required|privacy_scope_/.test(body)) return 'extraction_kept_private';
  if (status === 504 && body.includes('request_aborted')) return 'extraction_gateway_timeout';
  if (status === 413 || /memory_call_too_large|input_context_exceeded/.test(body))
    return 'extraction_call_refused';
  if (provider === 401 || provider === 403) return 'extraction_provider_auth';
  // A provider that timed out the request or is rate limiting may answer next time.
  if (
    typeof provider === 'number' &&
    provider >= 400 &&
    provider < 500 &&
    ![408, 429].includes(provider)
  )
    return 'extraction_provider_refused';
  return 'extraction_gateway_failure';
}

/**
 * The memory gateway this deployment runs, or none when the operator turned
 * model extraction off. Structured observations are read without a model either way.
 *
 * MELETE_MEMORY_PROVIDER and MELETE_MEMORY_MODEL, when set, name the model
 * outright. Otherwise memory reads with the model new chats use, the one chosen
 * in the app included, and with the keys connected there.
 */
export async function configuredMemoryGateway(
  sql: MemorySql,
  env: Env,
  fake: GatewayOptions['fake'] | undefined,
  privacy: GatewayOptions['privacy'],
  connected: {
    settings?: ModelSettingsService;
    signIn?: ProviderSignIn;
    /** The upstream transport; tests pass a stand-in provider. */
    fetch?: GatewayOptions['fetch'];
    spending?: GatewayOptions['spending'];
  } = {},
) {
  const setting = env.MELETE_MEMORY_MODEL?.trim();
  if (setting === 'off') return null;
  const pinned = { provider: env.MELETE_MEMORY_PROVIDER?.trim(), model: setting };
  const routing = routingFromEnv(env);
  return openMemoryGateway({
    sql,
    provider: pinned.provider || env.MELETE_DEFAULT_PROVIDER,
    model: pinned.model || env.MELETE_DEFAULT_MODEL,
    providers: configuredProviders(env, () => {}, connected.signIn),
    // Reading a message into memory is a short call: the fast model, unless one is pinned.
    source: serviceModelSource({ env, settings: connected.settings, pinned, fast: routing.fast }),
    dailyCalls: env.MELETE_MEMORY_DAILY_CALLS,
    fake,
    privacy,
    spending: connected.spending,
    routing,
    reasoningEffort: env.MELETE_REASONING_EFFORT_SIDE,
    ...(connected.fetch ? { fetch: connected.fetch } : {}),
  });
}
