import type { Sql } from 'postgres';
import type { Env } from '../env.ts';
import { type IssuerSource, PostgresCredentialRepository, ProviderSignIn } from './credentials.ts';
import { fakeProvider } from './fake.ts';
import { chatgptIssuer, credentialEndpoint, discoverIssuer, type OAuthIssuer } from './oauth.ts';
import {
  CHATGPT_PROVIDER,
  OPENAI_COMPATIBLE,
  providerAddressProblem,
  providerKeyProblem,
  providerSelectionProblem,
  providersFromEnv,
} from './providers.ts';
import type { GatewayProvider } from './types.ts';

const OAUTH_SETTINGS = [
  'OPENAI_COMPAT_OAUTH_ISSUER',
  'OPENAI_COMPAT_OAUTH_AUTHORIZE_URL',
  'OPENAI_COMPAT_OAUTH_TOKEN_URL',
  'OPENAI_COMPAT_OAUTH_REVOKE_URL',
  'OPENAI_COMPAT_OAUTH_CLIENT_ID',
  'OPENAI_COMPAT_OAUTH_CLIENT_SECRET',
  'OPENAI_COMPAT_OAUTH_SCOPES',
  'OPENAI_COMPAT_OAUTH_REDIRECT_URL',
] as const;

/** Whether the OpenAI-compatible endpoint is reached with a signed-in token instead of a key. */
export const compatibleOAuth = (env: Env): boolean =>
  OAUTH_SETTINGS.some((name) => Boolean(env[name]));

/**
 * The providers the owner can sign in to. ChatGPT always; the OpenAI-compatible
 * endpoint when its OAuth settings are given. A partial or unsafe setting stops
 * start-up with the name of what is missing.
 */
export function signInIssuers(env: Env): Record<string, IssuerSource> {
  const issuers: Record<string, IssuerSource> = {
    [CHATGPT_PROVIDER]: chatgptIssuer({ clientId: env.MELETE_CHATGPT_CLIENT_ID }),
  };
  if (!compatibleOAuth(env)) return issuers;
  const missing = [
    ...(env.OPENAI_COMPAT_BASE_URL ? [] : ['OPENAI_COMPAT_BASE_URL']),
    ...(env.OPENAI_COMPAT_OAUTH_CLIENT_ID ? [] : ['OPENAI_COMPAT_OAUTH_CLIENT_ID']),
    ...(env.OPENAI_COMPAT_OAUTH_REDIRECT_URL ? [] : ['OPENAI_COMPAT_OAUTH_REDIRECT_URL']),
    ...(env.OPENAI_COMPAT_OAUTH_ISSUER ||
    (env.OPENAI_COMPAT_OAUTH_AUTHORIZE_URL && env.OPENAI_COMPAT_OAUTH_TOKEN_URL)
      ? []
      : [
          'OPENAI_COMPAT_OAUTH_ISSUER, or both OPENAI_COMPAT_OAUTH_AUTHORIZE_URL and OPENAI_COMPAT_OAUTH_TOKEN_URL',
        ]),
  ];
  if (missing.length)
    throw new Error(
      `OAuth for the OpenAI-compatible endpoint also needs ${missing.join(' and ')}.`,
    );
  for (const name of [
    'OPENAI_COMPAT_OAUTH_ISSUER',
    'OPENAI_COMPAT_OAUTH_AUTHORIZE_URL',
    'OPENAI_COMPAT_OAUTH_TOKEN_URL',
    'OPENAI_COMPAT_OAUTH_REVOKE_URL',
  ] as const) {
    const value = env[name];
    if (value && !credentialEndpoint(value))
      throw new Error(
        `${name} must be an https:// address without credentials (http:// only on localhost).`,
      );
  }
  let redirect: URL | undefined;
  try {
    redirect = new URL(env.OPENAI_COMPAT_OAUTH_REDIRECT_URL ?? '');
  } catch {
    // Reported below with the setting's name.
  }
  if (!redirect || !['http:', 'https:'].includes(redirect.protocol))
    throw new Error(
      'OPENAI_COMPAT_OAUTH_REDIRECT_URL must be the http:// or https:// address registered with the issuer.',
    );
  const base = {
    provider: OPENAI_COMPATIBLE,
    clientId: env.OPENAI_COMPAT_OAUTH_CLIENT_ID ?? '',
    clientSecret: env.OPENAI_COMPAT_OAUTH_CLIENT_SECRET,
    scopes: env.OPENAI_COMPAT_OAUTH_SCOPES ?? '',
    redirectUri: redirect.href,
    refreshEncoding: 'form' as const,
  };
  const authorizeUrl = env.OPENAI_COMPAT_OAUTH_AUTHORIZE_URL;
  const tokenUrl = env.OPENAI_COMPAT_OAUTH_TOKEN_URL;
  issuers[OPENAI_COMPATIBLE] =
    authorizeUrl && tokenUrl
      ? { ...base, authorizeUrl, tokenUrl, revokeUrl: env.OPENAI_COMPAT_OAUTH_REVOKE_URL }
      : async (): Promise<OAuthIssuer> => {
          const found = await discoverIssuer(env.OPENAI_COMPAT_OAUTH_ISSUER ?? '', (request) =>
            fetch(request),
          );
          return {
            ...base,
            ...found,
            revokeUrl: env.OPENAI_COMPAT_OAUTH_REVOKE_URL ?? found.revokeUrl,
          };
        };
  return issuers;
}

/** Sign-in for this installation, or none when there is no key to seal tokens with. */
export function providerSignIn(sql: Sql, env: Env): ProviderSignIn | undefined {
  const masterKey = env.MELETE_MASTER_KEY;
  if (!masterKey) return undefined;
  return new ProviderSignIn({
    repository: new PostgresCredentialRepository(sql),
    issuers: signInIssuers(env),
    labels: {
      [CHATGPT_PROVIDER]: 'ChatGPT',
      [OPENAI_COMPATIBLE]: env.OPENAI_COMPAT_OAUTH_LABEL ?? 'your model provider',
    },
    masterKey: () => masterKey,
  });
}

/** Gives each provider the owner can sign in to its signed-in credential. */
export function withSignIn(
  providers: GatewayProvider[],
  signIn: ProviderSignIn | undefined,
): GatewayProvider[] {
  return providers.map((provider) =>
    signIn?.handles(provider.name)
      ? // A signed-in provider sends its token and never a configured key.
        { ...provider, apiKey: undefined, signedIn: signIn.credential(provider.name) }
      : provider,
  );
}

/**
 * The providers this service will route to. A selection that can never answer
 * stops start-up here, in the operator's terms; otherwise the first sign is a
 * refused model call inside an attempt.
 */
export function configuredProviders(
  env: Env,
  warn: (message: string) => void = (message) => process.stderr.write(`WARNING: ${message}\n`),
  signIn?: ProviderSignIn,
): GatewayProvider[] {
  const providers = [
    ...withSignIn(
      providersFromEnv({
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY,
        OPENAI_API_KEY: env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        GOOGLE_API_KEY: env.GOOGLE_API_KEY,
        OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
        OPENAI_COMPAT_API_KEY: env.OPENAI_COMPAT_API_KEY,
      }),
      signIn,
    ),
    ...(env.MELETE_ENABLE_FAKE_PROVIDER ? [fakeProvider] : []),
  ];
  const problem =
    providerSelectionProblem(env.MELETE_DEFAULT_PROVIDER, providers) ??
    providers.map(providerAddressProblem).find((found) => found !== null);
  if (problem) throw new Error(problem);
  const missingKey = providerKeyProblem(env.MELETE_DEFAULT_PROVIDER, providers);
  if (missingKey) warn(missingKey);
  return providers;
}
