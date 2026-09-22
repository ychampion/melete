/**
 * Model-provider sign-in over OAuth 2.0 with PKCE. Two kinds of issuer are
 * spoken to: ChatGPT's, over the same endpoints the open-source Codex CLI uses,
 * and one the operator configures for an OpenAI-compatible endpoint.
 *
 * Nothing here stores or logs a token. Every failure is a fixed code; a token
 * endpoint's own error text is never carried, because it can echo the grant.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Milliseconds since the epoch, when the issuer said or the token carries it. */
  expiresAt?: number;
  /** When the pair was received, so a short-lived token is not refreshed on every use. */
  issuedAt?: number;
}

/** How one issuer is reached. Every URL is HTTPS, or plain HTTP on loopback. */
export interface OAuthIssuer {
  /** The gateway provider this credential serves. */
  provider: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  clientId: string;
  clientSecret?: string;
  scopes: string;
  redirectUri: string;
  extraAuthorizeParams?: Record<string, string>;
  /** ChatGPT's token endpoint takes a JSON refresh body; RFC 6749 issuers take a form. */
  refreshEncoding: 'json' | 'form';
  /** A device-code sign-in, for an issuer whose redirect address is fixed to loopback. */
  device?: { userCodeUrl: string; tokenUrl: string; verificationUrl: string; redirectUri: string };
  /** Headers the provider needs beside the bearer token. */
  requestHeaders?: (tokens: OAuthTokens) => Record<string, string>;
  /** A label for the signed-in account, shown to the owner. Never a token. */
  account?: (tokens: OAuthTokens) => string | null;
}

export type OAuthFetch = (request: Request) => Promise<Response>;

/**
 * A refused or failed OAuth call. `permanent` means the grant itself is gone
 * (expired, reused, revoked or invalid) and only a new sign-in helps.
 */
export class OAuthFailure extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code);
  }
}

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 65_536;

/** The Codex CLI's public client and endpoints (openai/codex, codex-rs/login). */
export const CHATGPT = {
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  /** The only redirect addresses registered for that client are loopback ones. */
  redirectUri: 'http://localhost:1455/auth/callback',
  scopes: 'openid profile email offline_access',
} as const;

/** True for an address a credential may travel to: HTTPS, or HTTP on loopback. */
export function credentialEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/** The claims of a JWT, read without verifying it: it came straight from the issuer over TLS. */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split('.')[1];
  if (!payload) return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The ChatGPT account a token pair belongs to, from the id token's OpenAI claim. */
export function chatgptAccountId(tokens: OAuthTokens): string | undefined {
  const auth = jwtClaims(tokens.idToken)['https://api.openai.com/auth'];
  const id =
    auth && typeof auth === 'object'
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

export function chatgptIssuer(overrides: { issuer?: string; clientId?: string } = {}): OAuthIssuer {
  const issuer = (overrides.issuer ?? CHATGPT.issuer).replace(/\/+$/, '');
  return {
    provider: 'chatgpt',
    authorizeUrl: `${issuer}/oauth/authorize`,
    tokenUrl: `${issuer}/oauth/token`,
    revokeUrl: `${issuer}/oauth/revoke`,
    clientId: overrides.clientId ?? CHATGPT.clientId,
    scopes: CHATGPT.scopes,
    redirectUri: CHATGPT.redirectUri,
    extraAuthorizeParams: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' },
    refreshEncoding: 'json',
    device: {
      userCodeUrl: `${issuer}/api/accounts/deviceauth/usercode`,
      tokenUrl: `${issuer}/api/accounts/deviceauth/token`,
      verificationUrl: `${issuer}/codex/device`,
      redirectUri: `${issuer}/deviceauth/callback`,
    },
    requestHeaders: (tokens): Record<string, string> => {
      const account = chatgptAccountId(tokens);
      return account ? { 'chatgpt-account-id': account } : {};
    },
    account: (tokens) => {
      const email = jwtClaims(tokens.idToken).email;
      return typeof email === 'string' ? email : null;
    },
  };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const randomState = () => randomBytes(32).toString('base64url');

export function authorizeUrl(issuer: OAuthIssuer, state: string, challenge: string): string {
  const url = new URL(issuer.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', issuer.clientId);
  url.searchParams.set('redirect_uri', issuer.redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (issuer.scopes) url.searchParams.set('scope', issuer.scopes);
  for (const [name, value] of Object.entries(issuer.extraAuthorizeParams ?? {}))
    url.searchParams.set(name, value);
  return url.href;
}

const tokenResponse = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384).optional(),
  id_token: z.string().min(1).max(16_384).optional(),
  token_type: z
    .string()
    .refine((value) => value.toLowerCase() === 'bearer')
    .optional(),
  expires_in: z.number().int().positive().max(31_536_000).optional(),
});

async function call(
  fetcher: OAuthFetch,
  url: string,
  body: URLSearchParams | Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  if (!credentialEndpoint(url)) throw new OAuthFailure('endpoint_not_allowed', false);
  const form = body instanceof URLSearchParams;
  let response: Response;
  try {
    response = await fetcher(
      new Request(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
          accept: 'application/json',
        },
        body: form ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
  } catch {
    throw new OAuthFailure('issuer_unreachable', false);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  try {
    for (;;) {
      if (!reader) break;
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new OAuthFailure('issuer_response_too_large', false);
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OAuthFailure) throw error;
    throw new OAuthFailure('issuer_unreachable', false);
  } finally {
    await reader?.cancel().catch(() => {});
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // An empty or non-JSON body is judged by its status alone.
  }
  return { status: response.status, body: parsed };
}

function tokens(body: unknown, now: number): OAuthTokens {
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) throw new OAuthFailure('issuer_response_invalid', false);
  const exp = jwtClaims(parsed.data.access_token).exp;
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    idToken: parsed.data.id_token,
    issuedAt: now,
    expiresAt: parsed.data.expires_in
      ? now + parsed.data.expires_in * 1000
      : typeof exp === 'number'
        ? exp * 1000
        : undefined,
  };
}

/** The error code an OAuth error body names, if it names one. */
function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>).error;
  if (typeof value === 'string') return value.toLowerCase();
  if (value && typeof value === 'object') {
    const code = (value as Record<string, unknown>).code;
    if (typeof code === 'string') return code.toLowerCase();
  }
  return undefined;
}

/** Only these reasons are ever stored or shown; anything else is `refresh_refused`. */
const REFRESH_REASONS: Record<string, string> = {
  refresh_token_expired: 'refresh_expired',
  refresh_token_reused: 'refresh_reused',
  refresh_token_invalidated: 'refresh_revoked',
  invalid_grant: 'refresh_revoked',
};

export async function exchangeCode(
  issuer: OAuthIssuer,
  grant: { code: string; verifier: string; redirectUri: string },
  fetcher: OAuthFetch,
  now = Date.now(),
): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: grant.redirectUri,
    client_id: issuer.clientId,
    code_verifier: grant.verifier,
  });
  if (issuer.clientSecret) form.set('client_secret', issuer.clientSecret);
  const answer = await call(fetcher, issuer.tokenUrl, form);
  if (answer.status < 200 || answer.status >= 300)
    throw new OAuthFailure('code_exchange_refused', true);
  return tokens(answer.body, now);
}

export async function refreshTokens(
  issuer: OAuthIssuer,
  refreshToken: string,
  fetcher: OAuthFetch,
  now = Date.now(),
): Promise<OAuthTokens> {
  const fields: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: issuer.clientId,
    ...(issuer.clientSecret ? { client_secret: issuer.clientSecret } : {}),
  };
  const answer = await call(
    fetcher,
    issuer.tokenUrl,
    issuer.refreshEncoding === 'json' ? fields : new URLSearchParams(fields),
  );
  if (answer.status >= 200 && answer.status < 300) return tokens(answer.body, now);
  const code = errorCode(answer.body);
  const reason = code ? REFRESH_REASONS[code] : undefined;
  // As the Codex CLI decides it: a 401, or a grant the issuer named as gone,
  // needs a new sign-in; anything else may pass.
  if (reason || answer.status === 401) throw new OAuthFailure(reason ?? 'refresh_refused', true);
  throw new OAuthFailure('refresh_unavailable', false);
}

/** RFC 7009, best effort: a failure never keeps a credential the owner removed. */
export async function revokeToken(
  issuer: OAuthIssuer,
  token: { value: string; hint: 'refresh_token' | 'access_token' },
  fetcher: OAuthFetch,
): Promise<boolean> {
  if (!issuer.revokeUrl) return false;
  const fields: Record<string, string> = {
    token: token.value,
    token_type_hint: token.hint,
    client_id: issuer.clientId,
    ...(issuer.clientSecret ? { client_secret: issuer.clientSecret } : {}),
  };
  try {
    const answer = await call(
      fetcher,
      issuer.revokeUrl,
      issuer.refreshEncoding === 'json' ? fields : new URLSearchParams(fields),
    );
    return answer.status >= 200 && answer.status < 300;
  } catch {
    return false;
  }
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

const userCodeResponse = z.object({
  device_auth_id: z.string().min(1).max(1024),
  user_code: z.string().min(1).max(64).optional(),
  usercode: z.string().min(1).max(64).optional(),
  interval: z.union([z.string(), z.number()]).optional(),
});

export async function requestDeviceCode(
  issuer: OAuthIssuer,
  fetcher: OAuthFetch,
): Promise<DeviceCode> {
  if (!issuer.device) throw new OAuthFailure('device_sign_in_unavailable', false);
  const answer = await call(fetcher, issuer.device.userCodeUrl, { client_id: issuer.clientId });
  if (answer.status === 404) throw new OAuthFailure('device_sign_in_unavailable', false);
  const parsed = userCodeResponse.safeParse(answer.body);
  const userCode = parsed.data?.user_code ?? parsed.data?.usercode;
  if (answer.status < 200 || answer.status >= 300 || !parsed.success || !userCode)
    throw new OAuthFailure('device_code_refused', false);
  const interval = Number(parsed.data.interval ?? 5);
  return {
    deviceAuthId: parsed.data.device_auth_id,
    userCode,
    intervalSeconds: Number.isInteger(interval) && interval > 0 && interval <= 60 ? interval : 5,
  };
}

const deviceGrant = z.object({
  authorization_code: z.string().min(1).max(4096),
  code_verifier: z.string().min(43).max(128),
  code_challenge: z.string().min(1).max(128),
});

/**
 * One poll. `null` while the person has not finished at the verification page.
 * ChatGPT's device endpoint hands back the authorization code together with the
 * PKCE pair it generated, and the code is then exchanged like a browser one.
 */
export async function pollDeviceCode(
  issuer: OAuthIssuer,
  device: DeviceCode,
  fetcher: OAuthFetch,
  now = Date.now(),
): Promise<OAuthTokens | null> {
  if (!issuer.device) throw new OAuthFailure('device_sign_in_unavailable', false);
  const answer = await call(fetcher, issuer.device.tokenUrl, {
    device_auth_id: device.deviceAuthId,
    user_code: device.userCode,
  });
  if (answer.status === 403 || answer.status === 404) return null;
  const parsed = deviceGrant.safeParse(answer.body);
  if (answer.status < 200 || answer.status >= 300 || !parsed.success)
    throw new OAuthFailure('device_code_refused', true);
  const challenge = createHash('sha256').update(parsed.data.code_verifier).digest('base64url');
  if (challenge !== parsed.data.code_challenge)
    throw new OAuthFailure('issuer_response_invalid', true);
  return exchangeCode(
    issuer,
    {
      code: parsed.data.authorization_code,
      verifier: parsed.data.code_verifier,
      redirectUri: issuer.device.redirectUri,
    },
    fetcher,
    now,
  );
}

const discovery = z.object({
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
});

/** RFC 8414 metadata, then OpenID discovery, for an operator who named only the issuer. */
export async function discoverIssuer(
  issuer: string,
  fetcher: OAuthFetch,
): Promise<{ authorizeUrl: string; tokenUrl: string; revokeUrl?: string }> {
  const base = issuer.replace(/\/+$/, '');
  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ]) {
    if (!credentialEndpoint(base + path)) break;
    try {
      const response = await fetcher(
        new Request(base + path, {
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const parsed = discovery.safeParse(await response.json());
      if (!parsed.success) continue;
      const found = {
        authorizeUrl: parsed.data.authorization_endpoint,
        tokenUrl: parsed.data.token_endpoint,
        revokeUrl: parsed.data.revocation_endpoint,
      };
      if (
        credentialEndpoint(found.authorizeUrl) &&
        credentialEndpoint(found.tokenUrl) &&
        (!found.revokeUrl || credentialEndpoint(found.revokeUrl))
      )
        return found;
    } catch {
      // Try the next document; the caller reports one fixed failure.
    }
  }
  throw new OAuthFailure('issuer_discovery_failed', false);
}
