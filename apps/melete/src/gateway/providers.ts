import { GatewayError, type GatewayProtocol, type GatewayProvider } from './types.ts';

export const PROVIDER_HOSTS = [
  'api.fireworks.ai',
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
] as const;

export function providersFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayProvider[] {
  const providers: GatewayProvider[] = [
    {
      name: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
      apiKey: env.FIREWORKS_API_KEY,
      protocols: ['chat/completions'],
    },
    {
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: env.OPENAI_API_KEY,
      protocols: ['chat/completions', 'responses'],
    },
    {
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/',
      apiKey: env.ANTHROPIC_API_KEY,
      protocols: ['messages'],
    },
    {
      name: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: env.GOOGLE_API_KEY,
      protocols: ['chat/completions'],
    },
  ];
  if (env.OPENAI_COMPAT_BASE_URL) {
    providers.push({
      name: 'openai-compatible',
      baseUrl: `${env.OPENAI_COMPAT_BASE_URL.replace(/\/+$/, '')}/`,
      apiKey: env.OPENAI_COMPAT_API_KEY ?? env.OPENAI_API_KEY,
      protocols: ['chat/completions', 'responses'],
    });
  }
  return providers;
}

export function providerUrl(provider: GatewayProvider, protocol: GatewayProtocol): URL {
  if (!provider.protocols.includes(protocol)) throw new GatewayError(400, 'protocol_not_supported');
  const base = new URL(provider.baseUrl);
  if ((!provider.fake && base.protocol !== 'https:') || base.username || base.password) {
    throw new Error('provider base URL must use HTTPS without credentials');
  }
  if (base.search || base.hash || !base.pathname.endsWith('/')) {
    throw new Error('provider base URL must end at a path prefix');
  }
  return new URL(protocol, base);
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
