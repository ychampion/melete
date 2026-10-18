/**
 * The installation's features, each of which an operator can turn on or off
 * as a whole: `MELETE_FEATURE_<NAME>=on|off` (docs/DEPLOYMENT.md, "Turn
 * features on or off").
 *
 * Every feature keeps today's default, so an installation that sets nothing
 * behaves as before. Multiplayer is the one that starts off, and it keeps its
 * own switch, `MELETE_PREVIEW_MULTIPLAYER`; `MELETE_FEATURE_MULTIPLAYER` wins
 * over it when both are set.
 *
 * A feature that is off is refused by the service, not only hidden: its routes
 * answer 404 `not_available` with a plain sentence before anything is read or
 * written, and the parts behind it are not started. The web reads the same
 * values from the setup status and leaves the surfaces out.
 *
 * A person can also have a feature turned off for them alone, through a
 * {@link PersonFeatureSource}. The installation value is the ceiling: a
 * per-person value can turn a feature off, never on where the installation has
 * it off.
 */
import type { Context, Hono } from 'hono';
import { MULTIPLAYER_UNAVAILABLE, multiplayerEnabled, multiplayerPath } from './rooms/preview.ts';
import { PREVIEW_PREFIX } from './sandbox/preview-path.ts';

type Feature = {
  /** What the feature is, for the docs and the setup status. */
  about: string;
  /** Whether it is on when nothing is set. */
  default: boolean;
  /** Whether a per-person value is read for it. */
  perPerson: boolean;
  /** The service routes that belong to it. */
  path: (method: string, path: string) => boolean;
  /** The refusal, said of the whole installation. */
  off: string;
  /** The refusal, said of one person's account. */
  offForYou: string;
};

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export const FEATURES = {
  multiplayer: {
    about: 'Rooms, shared spaces, guests, hand-offs and linked chat platform accounts.',
    default: false,
    // Rooms reach the agent's tools and a guest's sign-in, which a route gate
    // alone does not cover; it is switched for the whole installation only.
    perPerson: false,
    path: multiplayerPath,
    off: MULTIPLAYER_UNAVAILABLE.message,
    offForYou: MULTIPLAYER_UNAVAILABLE.message,
  },
  voice: {
    about: 'Talking to the agent: push-to-talk, voice mode, calls and replies read aloud.',
    default: true,
    perPerson: true,
    // `/conversations/:id/call` and `/voice/call/…` are a call's.
    path: (_method, path) =>
      under(path, '/voice') || /^\/conversations\/[^/]+\/(voice|call)(\/|$)/.test(path),
    off: 'Voice is turned off on this server.',
    offForYou: 'Voice is turned off for your account.',
  },
  phone: {
    about:
      'Texts and calls to a person’s own verified number when something they set is about to be missed.',
    default: true,
    perPerson: true,
    path: (_method, path) => under(path, '/reach'),
    off: 'Texts and calls to your phone are turned off on this server.',
    offForYou: 'Texts and calls to your phone are turned off for your account.',
  },
  sms: {
    about: 'Texting the agent through a connected phone number.',
    default: true,
    perPerson: true,
    path: (_method, path) => under(path, '/sms') || /^\/connections\/[^/]+\/texts$/.test(path),
    off: 'Texting your agent is turned off on this server.',
    offForYou: 'Texting your agent is turned off for your account.',
  },
  browser: {
    about: 'The agent’s own browser, and the sites it is signed in to.',
    default: true,
    perPerson: true,
    path: (_method, path) => under(path, '/browser'),
    off: 'The agent’s browser is turned off on this server.',
    offForYou: 'The agent’s browser is turned off for your account.',
  },
  computer: {
    about:
      'The agent’s own computer: its desktop, terminal and programs, and watching it and taking it over.',
    default: true,
    perPerson: true,
    path: (_method, path) =>
      under(path, '/sandbox') ||
      path.startsWith(PREVIEW_PREFIX) ||
      /^\/conversations\/[^/]+\/computer$/.test(path),
    off: 'The agent’s computer is turned off on this server.',
    offForYou: 'The agent’s computer is turned off for your account.',
  },
  companies: {
    about:
      'The companies a person deals with: the money and paperwork found in their mail, and the replies they wait on.',
    default: true,
    perPerson: true,
    path: (_method, path) =>
      /^\/spaces\/[^/]+\/companies(\/|$)/.test(path) ||
      under(path, '/ledger') ||
      under(path, '/waiting-on'),
    off: 'Companies is turned off on this server.',
    offForYou: 'Companies is turned off for your account.',
  },
} as const satisfies Record<string, Feature>;

export type FeatureName = keyof typeof FEATURES;
export type Features = Record<FeatureName, boolean>;
export const FEATURE_NAMES = Object.keys(FEATURES) as FeatureName[];

/** The environment name that switches a feature: `MELETE_FEATURE_VOICE` for `voice`. */
export const featureEnvName = (name: FeatureName) => `MELETE_FEATURE_${name.toUpperCase()}`;

/** A person's own values, from wherever the installation keeps them; any left out follow the installation. */
export type PersonFeatureSource = (principalId: string) => Promise<Partial<Features>>;

/**
 * Which features the installation has on, read from parsed settings or raw
 * environment strings. Anything other than `on` or `off` is left at the
 * default; the settings schema refuses such a value at start.
 */
export function installationFeatures(env: object | undefined): Features {
  const values = (env ?? {}) as Record<string, unknown>;
  const features = {} as Features;
  for (const name of FEATURE_NAMES) {
    const set = values[featureEnvName(name)];
    features[name] =
      name === 'multiplayer'
        ? multiplayerEnabled(values as Parameters<typeof multiplayerEnabled>[0])
        : set === 'on'
          ? true
          : set === 'off'
            ? false
            : FEATURES[name].default;
  }
  return features;
}

/**
 * One person's features: the installation's, with the person's own values
 * applied where the feature takes them. A person's value can only turn a
 * feature off; where the installation has it off, it stays off.
 */
export function personFeatures(installation: Features, own: Partial<Features> = {}): Features {
  const features = { ...installation };
  for (const name of FEATURE_NAMES)
    if (FEATURES[name].perPerson && own[name] === false) features[name] = false;
  return features;
}

/**
 * The feature a kind of connection belongs to, if any. Off, the kind is not
 * offered or installed, and a connection of it already made offers the agent
 * no tool (`ConnectorFactory.open`). The browser and rooms have no kind a
 * person installs: the operator's file names a browser, and rooms are defaults.
 */
export function featureOfConnectionKind(kind: string): FeatureName | null {
  if (kind === 'sms') return 'sms';
  if (kind === 'sandbox') return 'computer';
  return null;
}

/** The feature a route belongs to, if any. */
export function featureOfPath(method: string, path: string): FeatureName | null {
  for (const name of FEATURE_NAMES) if (FEATURES[name].path(method, path)) return name;
  return null;
}

const refuse = (c: Context, message: string) =>
  c.json({ error: { code: 'not_available', message } }, 404);

/**
 * Refuses the routes of every feature the installation has off, before
 * sign-in, so a link and a signed-in request meet the same answer. Mounted
 * before every route it covers.
 */
export function mountFeatureGate(app: Hono, installation: Features): void {
  if (FEATURE_NAMES.every((name) => installation[name])) return;
  app.use('*', async (c, next) => {
    const name = featureOfPath(c.req.method, c.req.path);
    if (name && !installation[name]) return refuse(c, FEATURES[name].off);
    return next();
  });
}

/**
 * Refuses the routes of a feature turned off for the signed-in person. Mounted
 * after sign-in has named the person and before the routes it covers. With no
 * source of per-person values, nothing is mounted. A request with no signed-in
 * person, such as a provider's webhook, is left to the route.
 */
export function mountPersonFeatureGate(
  app: Hono,
  installation: Features,
  source: PersonFeatureSource | undefined,
): void {
  if (!source) return;
  app.use('*', async (c, next) => {
    const name = featureOfPath(c.req.method, c.req.path);
    if (!name || !installation[name] || !FEATURES[name].perPerson) return next();
    const owner = (c.get as (key: string) => unknown)('owner') as { id?: string } | undefined;
    if (!owner?.id) return next();
    if (!personFeatures(installation, await source(owner.id))[name])
      return refuse(c, FEATURES[name].offForYou);
    return next();
  });
}
