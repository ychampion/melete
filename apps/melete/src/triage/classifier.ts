/**
 * The model sorting reads with. It is the service's own model gateway, as
 * memory's and the companies scan's are, so the provider key never leaves it,
 * every call passes the privacy router, and every call is metered and charged
 * to the person whose items it reads (`purpose: 'triage'`, a background call
 * on the `t1` step).
 *
 * A call carries no tools and asks for one JSON document. There is nothing
 * here that could act: what comes back is text, read into labels by
 * `parseLabels`, and nothing else.
 *
 * Which model: MELETE_MODEL_TRIAGE when the operator names one (`off` turns
 * sorting off); otherwise the space owner's secondary model when they moved
 * scheduled work to it; otherwise the fast model for short side calls; otherwise
 * the model chosen in the app. A model on the owner's own machine keeps the
 * calls on it, at no cost.
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
  parseModelChoice,
  routingFromEnv,
  serviceFallback,
} from '../gateway/routing.ts';
import { replyOf, withStructuredOutput } from '../gateway/structured.ts';
import { type GatewayBudget, GatewayError, type GatewayPrincipal } from '../gateway/types.ts';
import { TRIAGE_FORMAT, TRIAGE_INSTRUCTIONS } from './rules.ts';

export const TRIAGE_LIMITS = {
  input_tokens: 16_000,
  output_tokens: 3_000,
  timeout_ms: 60_000,
} as const;

/** Reasoning is not needed to label mail; a model that reasons by default is asked not to. */
const ANSWER_DIRECTLY: Record<string, Record<string, unknown>> = {
  fireworks: { reasoning_effort: 'none' },
};

/** Whose items one call reads. */
export type TriageCall = { principalId: string; spaceId: string; batchId: string };

/**
 * Why a call gave no labels:
 * - `kept_private`: the space is private (or the items read as sensitive) and
 *   no local model can take them; they are not sent anywhere.
 * - `limit_reached`: a spending limit is reached; sorting waits for it to reset.
 * - `failed`: the provider failed, refused or answered with something unusable.
 */
export type TriageFailure = 'kept_private' | 'limit_reached' | 'failed';

export type TriageAnswer =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: TriageFailure };

export interface TriageClassifier {
  /** One call over one group of items, all from one space and for one person. */
  label(call: TriageCall, input: string): Promise<TriageAnswer>;
  close(): Promise<void>;
}

/** Where the model for one space's calls comes from. Null: sorting is off. */
export type TriageModelSource = {
  current(spaceId: string): Promise<ServiceModel | null>;
  providers: ServiceModelSource['providers'];
};

export type TriageGatewayOptions = {
  source: TriageModelSource;
  providers: NonNullable<GatewayOptions['providers']>;
  privacy: GatewayOptions['privacy'];
  spending?: GatewayOptions['spending'];
  routing?: ModelRouting;
  fake?: GatewayOptions['fake'];
  fetch?: GatewayOptions['fetch'];
  reasoningEffort?: GatewayOptions['reasoningEffort'];
  timeoutMs?: number;
};

export function failureOf(body: string): TriageFailure {
  if (/privacy_confirmation_required|privacy_scope_/.test(body)) return 'kept_private';
  if (body.includes('spending_limit_reached')) return 'limit_reached';
  return 'failed';
}

export async function openTriageGateway(options: TriageGatewayOptions): Promise<TriageClassifier> {
  type Bound = TriageCall & ServiceModel;
  const tokens = new Map<string, Bound>();
  /** Each principal's capability token, so a settlement finds the call it was for. */
  const principals = new WeakMap<GatewayPrincipal, string>();
  /** What the provider answered for each call, read back when the call fails. */
  const upstream = new Map<string, number | null>();
  const reservations = new Map<string, string>();
  const budget: GatewayBudget = {
    async reserve(request) {
      if (
        !principals.has(request.principal) ||
        !request.principal.allowedModels.some(
          (allowed) => allowed.provider === request.provider && allowed.model === request.model,
        )
      )
        throw new GatewayError(403, 'triage_principal_denied');
      if (
        request.estimatedTokens > TRIAGE_LIMITS.input_tokens + TRIAGE_LIMITS.output_tokens ||
        request.maxOutputTokens > TRIAGE_LIMITS.output_tokens
      )
        throw new GatewayError(429, 'triage_call_too_large');
      const id = randomUUID();
      const token = principals.get(request.principal);
      if (token) reservations.set(id, token);
      return { id };
    },
    async settle(reservation, settlement) {
      const token = reservations.get(reservation.id);
      reservations.delete(reservation.id);
      if (token) upstream.set(token, settlement.httpStatus);
    },
  };
  const server = createModelGateway({
    budget,
    providers: options.providers,
    currentProviders: options.source.providers,
    fake: options.fake,
    fetch: options.fetch,
    privacy: options.privacy,
    spending: options.spending,
    reasoningEffort: options.reasoningEffort,
    timeoutMs: options.timeoutMs ?? TRIAGE_LIMITS.timeout_ms,
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 128 * 1024,
    async authenticate(token) {
      const call = tokens.get(token);
      if (!call) throw new GatewayError(401, 'triage_principal_denied');
      const fallback = serviceFallback(options.routing ?? NO_ROUTING, call);
      const principal: GatewayPrincipal = {
        // The person whose items are read: the call is charged to them, and
        // counts against their background limits.
        actor: call.principalId,
        jobId: `triage:${call.spaceId}`,
        attemptId: `triage:${call.batchId}`,
        // The space's privacy applies: a private space's items go only to the
        // person's local model, or nowhere.
        privacy: { kind: 'service', purpose: 'triage', spaceId: call.spaceId, sourceJobId: null },
        epoch: 0,
        revision: 0,
        maxRequests: 1,
        maxTokens: TRIAGE_LIMITS.input_tokens + TRIAGE_LIMITS.output_tokens,
        allowedModels: [{ provider: call.provider, model: call.model }, ...fallback],
        ...(fallback.length ? { routes: { fallback } } : {}),
      };
      principals.set(principal, token);
      return principal;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    async label(call, input) {
      const target = await options.source.current(call.spaceId);
      if (!target) return { ok: false, reason: 'failed' };
      const protocol = protocolForApiMode(modelApiMode(target.provider, target.model));
      const messages = [
        { role: 'system', content: TRIAGE_INSTRUCTIONS },
        { role: 'user', content: input },
      ];
      // No tools: the only thing a call can return is text.
      const plain: Record<string, unknown> =
        protocol === 'responses'
          ? { model: target.model, input: messages, max_output_tokens: TRIAGE_LIMITS.output_tokens }
          : protocol === 'messages'
            ? {
                model: target.model,
                system: TRIAGE_INSTRUCTIONS,
                messages: [{ role: 'user', content: input }],
                max_tokens: TRIAGE_LIMITS.output_tokens,
              }
            : { model: target.model, messages, max_tokens: TRIAGE_LIMITS.output_tokens };
      const body = withStructuredOutput(plain, target, protocol, TRIAGE_FORMAT);
      const direct = protocol === 'chat/completions' ? ANSWER_DIRECTLY[target.provider] : undefined;
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
                ? { 'x-api-key': 'melete-surrogate-triage' }
                : { authorization: 'Bearer melete-surrogate-triage' }),
            },
            body: JSON.stringify({ ...body, ...extra }),
            redirect: 'error',
            signal: AbortSignal.timeout((options.timeoutMs ?? TRIAGE_LIMITS.timeout_ms) + 2_000),
          });
          if (response.ok) return { ok: true as const, result: await response.json() };
          return {
            ok: false as const,
            text: await response.text(),
            provider: upstream.get(token),
          };
        } finally {
          tokens.delete(token);
          upstream.delete(token);
        }
      };
      try {
        let reply = await ask(direct);
        if (!reply.ok && direct && reply.provider === 400) reply = await ask(undefined);
        if (!reply.ok) return { ok: false, reason: failureOf(reply.text) };
        const answer = replyOf(protocol, reply.result);
        if (answer.end !== 'complete') return { ok: false, reason: 'failed' };
        return { ok: true, text: answer.text, model: `${target.provider}/${target.model}` };
      } catch {
        // No answer, an envelope that was not the protocol's, or a timeout:
        // nothing to read, and the items are asked about again later.
        return { ok: false, reason: 'failed' };
      }
    },
    async close() {
      tokens.clear();
      // An idle kept-alive connection would hold the listener open.
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * The model one space's sorting uses, read for each call so a model or key
 * connected in the app applies at once. See the module comment for the order.
 */
export function triageModelSource(options: {
  env: Pick<Env, 'MELETE_DEFAULT_PROVIDER' | 'MELETE_DEFAULT_MODEL' | 'MELETE_MODEL_TRIAGE'> & {
    OPENAI_COMPAT_BASE_URL?: string;
  };
  settings?: ModelSettingsService;
  routing: ModelRouting;
}): TriageModelSource {
  const setting = options.env.MELETE_MODEL_TRIAGE?.trim();
  const pinned =
    setting && setting !== 'off' ? parseModelChoice(setting, 'MELETE_MODEL_TRIAGE') : null;
  const side = serviceModelSource({
    env: options.env,
    settings: options.settings,
    fast: options.routing.fast,
  });
  return {
    async current(spaceId) {
      if (setting === 'off') return null;
      if (pinned) return pinned;
      if (options.settings) {
        const chosen = await options.settings.activeChoice();
        if (!(await side.local(chosen.provider))) {
          const background = (await options.settings.routingFor(spaceId, options.routing))
            .background;
          if (background) return { provider: background.provider, model: background.model };
        }
      }
      return side.current({ spaceId });
    },
    providers: side.providers,
  };
}

/** The sorting gateway this deployment runs, or none when the operator turned sorting off. */
export async function configuredTriageGateway(
  env: Env,
  privacy: GatewayOptions['privacy'],
  connected: {
    settings?: ModelSettingsService;
    signIn?: ProviderSignIn;
    fake?: GatewayOptions['fake'];
    fetch?: GatewayOptions['fetch'];
    spending?: GatewayOptions['spending'];
  } = {},
): Promise<TriageClassifier | null> {
  if (env.MELETE_MODEL_TRIAGE?.trim() === 'off') return null;
  const routing = routingFromEnv(env);
  return openTriageGateway({
    source: triageModelSource({ env, settings: connected.settings, routing }),
    providers: configuredProviders(env, () => {}, connected.signIn),
    privacy,
    spending: connected.spending,
    routing,
    reasoningEffort: env.MELETE_REASONING_EFFORT_SIDE,
    ...(connected.fake ? { fake: connected.fake } : {}),
    ...(connected.fetch ? { fetch: connected.fetch } : {}),
  });
}
