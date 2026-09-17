import { GatewayError, type GatewayProtocol, type GatewayProvider } from './types.ts';

export const PROVIDER_HOSTS = [
  'api.fireworks.ai',
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
] as const;

/** The name an operator-configured OpenAI-compatible endpoint is selected by. */
export const OPENAI_COMPATIBLE = 'openai-compatible';

/** The protocols each upstream is served over. Routing and runtime API modes both read this. */
const PROVIDER_PROTOCOLS = {
  fireworks: ['chat/completions'],
  openai: ['chat/completions', 'responses'],
  anthropic: ['messages'],
  google: ['chat/completions'],
  [OPENAI_COMPATIBLE]: ['chat/completions', 'responses'],
} as const satisfies Record<string, readonly GatewayProtocol[]>;

/** How the pinned engine is told to speak to the gateway. */
export type ModelApiMode = 'anthropic_messages' | 'codex_responses' | 'chat_completions';

const API_MODE_PROTOCOLS: Record<ModelApiMode, GatewayProtocol> = {
  anthropic_messages: 'messages',
  codex_responses: 'responses',
  chat_completions: 'chat/completions',
};

export const protocolForApiMode = (mode: ModelApiMode): GatewayProtocol => API_MODE_PROTOCOLS[mode];

/** Models the gateway serves over the responses protocol and no other. */
export const requiresResponsesProtocol = (model: string): boolean => model.startsWith('gpt-6');

/**
 * The one provider-to-mode mapping. Every launcher reads it, so a runtime is
 * never started speaking a protocol the gateway refuses for its provider.
 */
export function modelApiMode(provider: string, model: string): ModelApiMode {
  const protocols: readonly GatewayProtocol[] = Object.hasOwn(PROVIDER_PROTOCOLS, provider)
    ? PROVIDER_PROTOCOLS[provider as keyof typeof PROVIDER_PROTOCOLS]
    : ['chat/completions'];
  if (!protocols.includes('chat/completions') && protocols.includes('messages'))
    return 'anthropic_messages';
  if (
    protocols.includes('responses') &&
    (provider === 'openai' || requiresResponsesProtocol(model))
  )
    return 'codex_responses';
  return 'chat_completions';
}

export function providersFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayProvider[] {
  const providers: GatewayProvider[] = [
    {
      name: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
      apiKey: env.FIREWORKS_API_KEY,
      protocols: [...PROVIDER_PROTOCOLS.fireworks],
    },
    {
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: env.OPENAI_API_KEY,
      protocols: [...PROVIDER_PROTOCOLS.openai],
    },
    {
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/',
      apiKey: env.ANTHROPIC_API_KEY,
      protocols: [...PROVIDER_PROTOCOLS.anthropic],
    },
    {
      name: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: env.GOOGLE_API_KEY,
      protocols: [...PROVIDER_PROTOCOLS.google],
    },
  ];
  if (env.OPENAI_COMPAT_BASE_URL) {
    providers.push({
      name: OPENAI_COMPATIBLE,
      baseUrl: `${env.OPENAI_COMPAT_BASE_URL.replace(/\/+$/, '')}/`,
      // Compose passes an unset variable as an empty string, which is not a key.
      apiKey: env.OPENAI_COMPAT_API_KEY || env.OPENAI_API_KEY,
      protocols: [...PROVIDER_PROTOCOLS[OPENAI_COMPATIBLE]],
      // The operator chose this address, and it may be a model server on their
      // own network. Every built-in upstream stays HTTPS.
      allowHttp: true,
    });
  }
  return providers;
}

export function providerUrl(provider: GatewayProvider, protocol: GatewayProtocol): URL {
  if (!provider.protocols.includes(protocol)) throw new GatewayError(400, 'protocol_not_supported');
  const base = new URL(provider.baseUrl);
  const schemes = provider.allowHttp ? ['https:', 'http:'] : ['https:'];
  if ((!provider.fake && !schemes.includes(base.protocol)) || base.username || base.password) {
    throw new Error(
      provider.allowHttp
        ? 'OPENAI_COMPAT_BASE_URL must be an http:// or https:// URL without credentials'
        : 'provider base URL must use HTTPS without credentials',
    );
  }
  if (base.search || base.hash || !base.pathname.endsWith('/')) {
    throw new Error('provider base URL must end at a path prefix');
  }
  return new URL(protocol, base);
}

/** The variables that can hold each provider's key, in the order they are read. */
export const PROVIDER_KEY_VARIABLES = {
  fireworks: ['FIREWORKS_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY'],
  [OPENAI_COMPATIBLE]: ['OPENAI_COMPAT_API_KEY', 'OPENAI_API_KEY'],
} as const satisfies Record<keyof typeof PROVIDER_PROTOCOLS, readonly string[]>;

export const PROVIDER_NAMES: readonly string[] = Object.keys(PROVIDER_PROTOCOLS);

/**
 * Why the selected provider can never serve a request, in the operator's
 * terms. Without this the first sign is a refused model call inside an attempt.
 */
export function providerSelectionProblem(
  selected: string,
  providers: readonly GatewayProvider[],
): string | null {
  const provider = providers.find((candidate) => candidate.name === selected);
  if (!provider) {
    if (selected === OPENAI_COMPATIBLE)
      return `MELETE_DEFAULT_PROVIDER is "${OPENAI_COMPATIBLE}", but OPENAI_COMPAT_BASE_URL is empty. Set it to the endpoint's version prefix, for example https://models.example.net/v1.`;
    if (selected === 'fake')
      return 'MELETE_DEFAULT_PROVIDER is "fake", but the scripted provider is off. Set MELETE_ENABLE_FAKE_PROVIDER=true, or select a real provider.';
    return `MELETE_DEFAULT_PROVIDER is "${selected}", which is not a provider the gateway has. Use one of: ${PROVIDER_NAMES.join(', ')}. An OpenAI-compatible endpoint is always selected by the exact name "${OPENAI_COMPATIBLE}", whatever serves it, and its address goes in OPENAI_COMPAT_BASE_URL.`;
  }
  return providerAddressProblem(provider);
}

/** A configured address the gateway would refuse on every request. */
export function providerAddressProblem(provider: GatewayProvider): string | null {
  try {
    for (const protocol of provider.protocols) providerUrl(provider, protocol);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'it is not a usable URL';
    return provider.allowHttp
      ? `OPENAI_COMPAT_BASE_URL cannot be used: ${reason}. Give the endpoint's version prefix, for example https://models.example.net/v1.`
      : `The ${provider.name} provider cannot be used: ${reason}.`;
  }
  return null;
}

/** The selected provider exists but has no key, so the gateway would refuse each call. */
export function providerKeyProblem(
  selected: string,
  providers: readonly GatewayProvider[],
): string | null {
  const provider = providers.find((candidate) => candidate.name === selected);
  if (!provider || provider.fake || provider.apiKey) return null;
  const variables: readonly string[] = Object.hasOwn(PROVIDER_KEY_VARIABLES, selected)
    ? PROVIDER_KEY_VARIABLES[selected as keyof typeof PROVIDER_KEY_VARIABLES]
    : [];
  return `MELETE_DEFAULT_PROVIDER is "${selected}", but ${variables.join(' and ')} ${variables.length > 1 ? 'are' : 'is'} empty. Every model call is refused with provider_key_unavailable until a key is set. A model server that checks no key still needs any non-empty value.`;
}

/** HTTP absolute-form requests may only address the exact inference endpoints. */
export function resolveRoute(
  target: string,
  providers: readonly GatewayProvider[],
  defaultProvider: string,
): { provider: GatewayProvider; protocol: GatewayProtocol; upstream: URL } {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target);
    if (url.username || url.password || url.search || url.hash) {
      throw new GatewayError(403, 'destination_denied');
    }
    for (const provider of providers) {
      if (provider.fake) continue;
      for (const protocol of provider.protocols) {
        const upstream = providerUrl(provider, protocol);
        if (url.href === upstream.href) return { provider, protocol, upstream };
      }
    }
    throw new GatewayError(403, 'destination_denied');
  }

  const match = /^(?:\/providers\/([a-z0-9-]+))?\/v1\/(chat\/completions|responses|messages)$/.exec(
    target,
  );
  if (!match) throw new GatewayError(404, 'endpoint_not_found');
  const protocol = match[2] as GatewayProtocol;
  const name = match[1] ?? (protocol === 'messages' ? 'anthropic' : defaultProvider);
  const provider = providers.find((candidate) => candidate.name === name);
  if (!provider) throw new GatewayError(403, 'provider_denied');
  return { provider, protocol, upstream: providerUrl(provider, protocol) };
}

/** CONNECT's destination check runs even though unmeterable encrypted tunnels are refused. */
export function checkConnectTarget(target: string, allowedHosts: ReadonlySet<string>): void {
  const match = /^([a-z0-9.-]+):443$/i.exec(target);
  if (!match?.[1] || !allowedHosts.has(match[1].toLowerCase())) {
    throw new GatewayError(403, 'destination_denied');
  }
}
