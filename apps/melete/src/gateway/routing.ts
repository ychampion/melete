/**
 * Which model serves which call.
 *
 * The operator may name a small set of models besides the default:
 *
 * - MELETE_MODEL_FAST: the service's own short calls (reading chat into
 *   memory, voice-mode asides, the auto-review classifier, the companies
 *   scan) use it instead of the default model.
 * - MELETE_MODEL_VISION: an agent turn's request that carries a picture goes
 *   to it when the model the turn runs on does not read images.
 * - MELETE_MODEL_FALLBACK: tried in order when the provider rate-limits,
 *   fails or cannot be reached, before any of the reply has been sent.
 *
 * Two of these roles may be filled by the installation owner's secondary
 * model, chosen in Settings, for the work in the spaces they own: `fast` for
 * short side calls, and `background` for scheduled and repeating work, which
 * otherwise runs on the primary. With no secondary set, the operator's roles
 * apply as they are. Vision and fallback stay the operator's.
 *
 * Each is written `provider/model`, the provider name before the first slash.
 * A model the owner chose in the app always wins for agent turns: those turns
 * are never rerouted or sent elsewhere on failure. A model the operator pinned
 * for one use (MELETE_MEMORY_MODEL and the like) wins over the fast model.
 *
 * The gateway relays the request as the engine wrote it, so an alternative
 * model is only ever taken when it speaks the same protocol as the request.
 */
import { localHostLiteral } from '../privacy/local.ts';
import {
  CHATGPT_PROVIDER,
  modelApiMode,
  PROVIDER_NAMES,
  providerKeyVariables,
} from './providers.ts';
import type { GatewayRoutes } from './types.ts';

export type ModelChoice = { provider: string; model: string };

export type ModelRouting = {
  fast: ModelChoice | null;
  vision: ModelChoice | null;
  fallback: ModelChoice[];
  /** Scheduled and repeating work. Unset, it runs on the primary. */
  background?: ModelChoice | null;
};

/** The roles a person's secondary model may fill. */
export type PersonRoles = { fast?: ModelChoice; background?: ModelChoice };

/** The operator's routing with the roles a person's secondary fills put in. */
export function withPersonRoles(routing: ModelRouting, roles: PersonRoles): ModelRouting {
  return {
    ...routing,
    ...(roles.fast ? { fast: roles.fast } : {}),
    ...(roles.background ? { background: roles.background } : {}),
  };
}

export const NO_ROUTING: ModelRouting = { fast: null, vision: null, fallback: [] };

/** `provider/model`, split at the first slash. Throws a message naming the setting. */
export function parseModelChoice(value: string, setting: string): ModelChoice {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  const provider = slash > 0 ? trimmed.slice(0, slash) : '';
  const model = slash > 0 ? trimmed.slice(slash + 1) : '';
  if (!/^[a-z0-9-]{1,40}$/.test(provider) || !model || model.length > 300 || /\s/.test(model))
    throw new Error(
      `${setting} must be written provider/model, for example fireworks/accounts/fireworks/models/llama-v3p1-8b-instruct`,
    );
  return { provider, model };
}

export function routingFromEnv(env: {
  MELETE_MODEL_FAST?: string;
  MELETE_MODEL_VISION?: string;
  MELETE_MODEL_FALLBACK?: string;
}): ModelRouting {
  const one = (value: string | undefined, setting: string) =>
    value?.trim() ? parseModelChoice(value, setting) : null;
  return {
    fast: one(env.MELETE_MODEL_FAST, 'MELETE_MODEL_FAST'),
    vision: one(env.MELETE_MODEL_VISION, 'MELETE_MODEL_VISION'),
    fallback: (env.MELETE_MODEL_FALLBACK ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => parseModelChoice(entry, 'MELETE_MODEL_FALLBACK')),
  };
}

/** Whether an endpoint address is on this machine or the person's network. */
export function addressIsLocal(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return localHostLiteral(new URL(baseUrl).hostname) === true;
  } catch {
    return false;
  }
}

/**
 * A provider the operator or owner pointed at a model server on their own
 * machine or network. Its calls never move to another model, and cost nothing
 * unless the operator prices it.
 */
export function providerIsLocal(provider: {
  baseUrl: string;
  allowHttp?: boolean;
  fake?: boolean;
}): boolean {
  return !provider.fake && provider.allowHttp === true && addressIsLocal(provider.baseUrl);
}

export const sameModel = (a: ModelChoice, b: ModelChoice) =>
  a.provider === b.provider && a.model === b.model;

/** Whether a request written for one model can be sent to the other as it is. */
export const sameProtocol = (a: ModelChoice, b: ModelChoice) =>
  modelApiMode(a.provider, a.model) === modelApiMode(b.provider, b.model);

/**
 * The routes an agent turn on `primary` may take. None when the owner chose
 * the model in the app. `primaryReadsImages` is whether the turn's own model
 * reads pictures, the owner's word on it included; a vision route is only
 * offered when it does not.
 */
export function agentRoutes(
  routing: ModelRouting,
  primary: ModelChoice,
  options: { ownerChose: boolean; primaryReadsImages: boolean },
): GatewayRoutes | undefined {
  if (options.ownerChose) return undefined;
  const vision =
    routing.vision &&
    !options.primaryReadsImages &&
    !sameModel(routing.vision, primary) &&
    sameProtocol(routing.vision, primary)
      ? routing.vision
      : undefined;
  const fallback = serviceFallback(routing, primary);
  if (!vision && !fallback.length) return undefined;
  return { ...(vision ? { vision } : {}), ...(fallback.length ? { fallback } : {}) };
}

/** The fallbacks a call to `primary` may take: those that speak its protocol. */
export function serviceFallback(routing: ModelRouting, primary: ModelChoice): ModelChoice[] {
  return routing.fallback.filter(
    (choice) => !sameModel(choice, primary) && sameProtocol(choice, primary),
  );
}

/** Every model a principal may be served with: the one it asked for and its routes. */
export function allowedWithRoutes(
  primary: ModelChoice,
  routes: GatewayRoutes | undefined,
): ModelChoice[] {
  const all = [primary, ...(routes?.vision ? [routes.vision] : []), ...(routes?.fallback ?? [])];
  return all.filter(
    (choice, index) => all.findIndex((other) => sameModel(other, choice)) === index,
  );
}

/**
 * What the operator should hear at start-up about the routing models: one the
 * gateway has no provider for, or one with no key in the environment, would
 * make every call routed to it fail.
 */
export function routingWarnings(
  env: Record<string, string | undefined>,
  routing: ModelRouting,
): string[] {
  const named: [string, ModelChoice][] = [
    ...(routing.fast ? [['MELETE_MODEL_FAST', routing.fast] as [string, ModelChoice]] : []),
    ...(routing.vision ? [['MELETE_MODEL_VISION', routing.vision] as [string, ModelChoice]] : []),
    ...routing.fallback.map((choice) => ['MELETE_MODEL_FALLBACK', choice] as [string, ModelChoice]),
  ];
  const warnings: string[] = [];
  for (const [setting, { provider }] of named) {
    if (provider === 'fake' || provider === CHATGPT_PROVIDER) continue;
    if (!PROVIDER_NAMES.includes(provider)) {
      warnings.push(
        `${setting} names the provider "${provider}", which the gateway does not have; calls routed to it will fail. Use one of: ${PROVIDER_NAMES.join(', ')}.`,
      );
      continue;
    }
    const keys = providerKeyVariables(provider, env.OPENAI_COMPAT_BASE_URL);
    if (!keys.some((name) => env[name]))
      warnings.push(
        `${setting} names ${provider}, but ${keys.join(' and ') || 'its key'} is empty; calls routed to it fail unless a key is connected in Settings › Models.`,
      );
  }
  return warnings;
}
