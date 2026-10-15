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
 * MELETE_MODEL_ROUTES sends each kind of agent work to a model of its own
 * (`work-routes.ts`). Two of its routes fill the roles above, so there is one
 * setting for each role and one order between them:
 *
 * - `side` fills the `fast` role. MELETE_MODEL_FAST is the same role written
 *   on its own: it wins over the `recommended` preset's `side`, and naming
 *   both MELETE_MODEL_FAST and `side=` stops start-up.
 * - `background` fills the `background` role, which nothing else names.
 *
 * For a side call the order is: a model pinned for that use, then the space
 * owner's secondary, then the fast role, then the model in use. For background
 * work: the owner's secondary, then the `background` route, then the routes of
 * its other kinds, then the model in use. A default on the owner's own machine
 * keeps every turn but those on the owner's secondary.
 *
 * The gateway relays the request as the engine wrote it, so an alternative
 * model is only ever taken when it speaks the same protocol as the request.
 */
import { localHostLiteral } from '../privacy/local.ts';
import { PriceTable, parseModelPrices } from './prices.ts';
import {
  CHATGPT_PROVIDER,
  modelApiMode,
  PROVIDER_NAMES,
  providerKeyVariables,
} from './providers.ts';
import type { GatewayRoutes } from './types.ts';
import {
  RECOMMENDED,
  RECOMMENDED_ROUTES,
  ROUTE_KINDS,
  type RouteKind,
  SIDE,
  WORK_KINDS,
  type WorkRoutes,
} from './work-routes.ts';

export type ModelChoice = { provider: string; model: string };

export type ModelRouting = {
  fast: ModelChoice | null;
  vision: ModelChoice | null;
  fallback: ModelChoice[];
  /** Scheduled and repeating work. Unset, it runs on the primary. */
  background?: ModelChoice | null;
  /** Each kind of agent work's models (MELETE_MODEL_ROUTES). Unset, one model serves all. */
  work?: WorkRoutes;
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
  MELETE_MODEL_FAST?: string | undefined;
  MELETE_MODEL_VISION?: string | undefined;
  MELETE_MODEL_FALLBACK?: string | undefined;
  MELETE_MODEL_ROUTES?: string | undefined;
  [name: string]: unknown;
}): ModelRouting {
  const one = (value: string | undefined, setting: string) =>
    value?.trim() ? parseModelChoice(value, setting) : null;
  const work = env.MELETE_MODEL_ROUTES?.trim()
    ? parseWorkRoutes(env.MELETE_MODEL_ROUTES, { keyed: keyedIn(env) }).routes
    : undefined;
  return {
    // MELETE_MODEL_FAST, else the `side` route (the start-up check refuses both written out).
    fast: one(env.MELETE_MODEL_FAST, 'MELETE_MODEL_FAST') ?? work?.side?.[0] ?? null,
    vision: one(env.MELETE_MODEL_VISION, 'MELETE_MODEL_VISION'),
    fallback: (env.MELETE_MODEL_FALLBACK ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => parseModelChoice(entry, 'MELETE_MODEL_FALLBACK')),
    ...(work ? { work } : {}),
    ...(work?.background?.[0] ? { background: work.background[0] } : {}),
  };
}

const ROUTES_SETTING = 'MELETE_MODEL_ROUTES';
const KINDS_LIST = ROUTE_KINDS.join(', ');

/** Whether some route sends agent turns a person may wait on to a model of their own. */
export function routesAgentTurns(routing: ModelRouting): boolean {
  return WORK_KINDS.some((kind) => kind !== 'background' && routing.work?.[kind]?.length);
}

/**
 * The start-up check of MELETE_MODEL_ROUTES beside the other settings: the
 * fast role is named in one place only. Throws a message naming both.
 */
export function checkRouteSettings(env: {
  MELETE_MODEL_FAST?: string | undefined;
  MELETE_MODEL_ROUTES?: string | undefined;
}): void {
  if (!env.MELETE_MODEL_ROUTES?.trim()) return;
  const { named } = parseWorkRoutes(env.MELETE_MODEL_ROUTES);
  if (env.MELETE_MODEL_FAST?.trim() && named.includes(SIDE))
    throw new Error(
      `${ROUTES_SETTING} names a ${SIDE} route and MELETE_MODEL_FAST is set too; both name the model for the service's short calls. Keep one.`,
    );
}

/**
 * Whether the environment holds a key for this provider. A provider signed in
 * to rather than keyed, and the test provider, are judged when a call is made.
 */
function keyedIn(env: Record<string, unknown>): (provider: string) => boolean {
  return (provider) => {
    if (provider === 'fake' || provider === CHATGPT_PROVIDER) return true;
    const address =
      typeof env.OPENAI_COMPAT_BASE_URL === 'string' ? env.OPENAI_COMPAT_BASE_URL : undefined;
    return providerKeyVariables(provider, address).some(
      (name) => typeof env[name] === 'string' && Boolean(env[name]),
    );
  };
}

/**
 * MELETE_MODEL_ROUTES: entries separated by `;` or new lines, each
 * `kind=provider/model`, optionally followed by `,provider/model` fallbacks.
 * `recommended`, alone or as the first entry, starts from the preset; the
 * entries after it replace the preset's for their kind. For each kind the
 * preset's first model whose provider has a key (`keyed`) is used, with the
 * later ones on its protocol as fallbacks; a kind with no keyed model is left
 * out and its models returned in `dropped`.
 * Throws a message naming the setting and the kinds.
 */
export function parseWorkRoutes(
  value: string,
  options: {
    keyed?: (provider: string) => boolean;
    preset?: Readonly<Partial<Record<RouteKind, readonly string[]>>>;
  } = {},
): {
  routes: WorkRoutes;
  dropped: { kind: RouteKind; choice: ModelChoice }[];
  /** The kinds written out after `=`, as opposed to taken from the preset. */
  named: RouteKind[];
} {
  const entries = value
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const routes: WorkRoutes = {};
  const dropped: { kind: RouteKind; choice: ModelChoice }[] = [];
  const named = new Set<RouteKind>();
  entries.forEach((entry, index) => {
    if (entry.toLowerCase() === RECOMMENDED) {
      if (index !== 0)
        throw new Error(
          `${ROUTES_SETTING} takes "${RECOMMENDED}" only as its first entry. Kinds: ${KINDS_LIST}.`,
        );
      const preset = options.preset ?? RECOMMENDED_ROUTES;
      for (const kind of ROUTE_KINDS) {
        const models = (preset[kind] ?? []).map((model) =>
          parseModelChoice(model, `${ROUTES_SETTING} (${RECOMMENDED}, ${kind})`),
        );
        // The preset lists models in order of preference, for installs with different keys: the first
        // with a key is used, and the later ones that speak its protocol are its fallbacks. The others
        // are alternatives for an install without it, so they are left out here without a warning.
        const keyed = models.filter((choice) => options.keyed?.(choice.provider) ?? true);
        const first = keyed[0];
        if (!first) {
          for (const choice of models) dropped.push({ kind, choice });
          continue;
        }
        routes[kind] = keyed.filter((choice) => sameProtocol(choice, first));
      }
      return;
    }
    const equals = entry.indexOf('=');
    if (equals < 0)
      throw new Error(
        `${ROUTES_SETTING} entries are written kind=provider/model, with kind one of: ${KINDS_LIST}. "${entry}" is not.`,
      );
    const kind = entry.slice(0, equals).trim().toLowerCase();
    if (!(ROUTE_KINDS as readonly string[]).includes(kind))
      throw new Error(
        `${ROUTES_SETTING} names the kind "${kind}", which is not one of: ${KINDS_LIST}.`,
      );
    const workKind = kind as RouteKind;
    if (named.has(workKind))
      throw new Error(`${ROUTES_SETTING} names the kind "${kind}" twice. Kinds: ${KINDS_LIST}.`);
    named.add(workKind);
    routes[workKind] = entry
      .slice(equals + 1)
      .split(',')
      .map((model) => {
        try {
          return parseModelChoice(model, `${ROUTES_SETTING} (${kind})`);
        } catch (error) {
          throw new Error(`${(error as Error).message}. Kinds: ${KINDS_LIST}.`);
        }
      });
  });
  return { routes, dropped, named: [...named] };
}

/**
 * The models a routed attempt on `primary` falls back to: the rest of every
 * route whose first model it is, in precedence order.
 */
export function routeFallbacks(routing: ModelRouting, primary: ModelChoice): ModelChoice[] {
  return ROUTE_KINDS.flatMap((kind) => {
    const models = routing.work?.[kind];
    return models?.[0] && sameModel(models[0], primary) ? models.slice(1) : [];
  });
}

/** Whether some route sends work to `choice` first, so an attempt on it may be a routed one. */
export function isRouteModel(routing: ModelRouting, choice: ModelChoice): boolean {
  return WORK_KINDS.some((kind) => {
    const first = routing.work?.[kind]?.[0];
    return Boolean(first && sameModel(first, choice));
  });
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

/**
 * The fallbacks a call to `primary` may take: those that speak its protocol.
 * A model a route sends work to falls back to that route's own fallbacks
 * first, then to MELETE_MODEL_FALLBACK.
 */
export function serviceFallback(routing: ModelRouting, primary: ModelChoice): ModelChoice[] {
  const all = [...routeFallbacks(routing, primary), ...routing.fallback];
  return all.filter(
    (choice, index) =>
      !sameModel(choice, primary) &&
      sameProtocol(choice, primary) &&
      all.findIndex((other) => sameModel(other, choice)) === index,
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
  // A fast model taken from the `side` route is named under MELETE_MODEL_ROUTES below.
  const side = routing.work?.side?.[0];
  const fastFromSide =
    !env.MELETE_MODEL_FAST?.trim() &&
    Boolean(side && routing.fast && sameModel(side, routing.fast));
  const named: [string, ModelChoice][] = [
    ...(routing.fast && !fastFromSide
      ? [['MELETE_MODEL_FAST', routing.fast] as [string, ModelChoice]]
      : []),
    ...(routing.vision ? [['MELETE_MODEL_VISION', routing.vision] as [string, ModelChoice]] : []),
    ...routing.fallback.map((choice) => ['MELETE_MODEL_FALLBACK', choice] as [string, ModelChoice]),
    ...ROUTE_KINDS.flatMap((kind) =>
      (routing.work?.[kind] ?? []).map(
        (choice) => [`${ROUTES_SETTING} (${kind})`, choice] as [string, ModelChoice],
      ),
    ),
  ];
  const warnings: string[] = workRouteWarnings(env, routing);
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

/**
 * What the operator should hear about MELETE_MODEL_ROUTES beyond its keys:
 * the preset's models left out for want of a key, a route's fallbacks that
 * speak another protocol than its first model, which are never taken, and a
 * routed model with no price of its own, whose spending is only a guess.
 */
function workRouteWarnings(
  env: Record<string, string | undefined>,
  routing: ModelRouting,
): string[] {
  const warnings: string[] = [];
  const value = env.MELETE_MODEL_ROUTES;
  if (value?.trim())
    for (const { kind, choice } of parseWorkRoutes(value, { keyed: keyedIn(env) }).dropped)
      warnings.push(
        `${ROUTES_SETTING} (${RECOMMENDED}) leaves out ${choice.provider}/${choice.model} for ${kind}: ${choice.provider} has no key in the environment.`,
      );
  for (const kind of ROUTE_KINDS) {
    const [first, ...rest] = routing.work?.[kind] ?? [];
    if (!first) continue;
    for (const choice of rest)
      if (!sameProtocol(choice, first))
        warnings.push(
          `${ROUTES_SETTING} (${kind}) falls back to ${choice.provider}/${choice.model}, which speaks another protocol than ${first.provider}/${first.model}; it is never taken.`,
        );
  }
  const prices = new PriceTable(safePrices(env.MELETE_MODEL_PRICES));
  const unpriced = new Set<string>();
  for (const kind of ROUTE_KINDS)
    for (const { provider, model } of routing.work?.[kind] ?? []) {
      if (provider === 'fake' || provider === CHATGPT_PROVIDER) continue;
      const { entry } = prices.priceFor(provider, model);
      if (entry === '*' || entry === `${provider}/*`) unpriced.add(`${provider}/${model}`);
    }
  for (const name of unpriced)
    warnings.push(
      `${ROUTES_SETTING} sends work to ${name}, which has no price of its own; its spending is counted at a rough estimate. Give its price in MELETE_MODEL_PRICES.`,
    );
  return warnings;
}

/** The operator's prices, or none when they do not parse (the start-up check names that). */
function safePrices(value: string | undefined) {
  try {
    return parseModelPrices(value);
  } catch {
    return {};
  }
}
