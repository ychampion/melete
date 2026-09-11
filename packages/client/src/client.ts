/**
 * The client is thin on purpose. It adds a base URL, a cookie credential mode,
 * and nothing else to `openapi-fetch`, so the types a caller sees are the types
 * in openapi.json and there is no second place for the contract to live.
 */
import createFetchClient, { type Client } from 'openapi-fetch';
import type { paths } from './schema.d.ts';

/** The `credentials` modes fetch accepts. Named here because the workspace
 *  compiles without the DOM library. */
export type FetchCredentials = 'omit' | 'same-origin' | 'include';

export type MeleteClientOptions = {
  /** For example `http://localhost:8787`. A trailing slash is trimmed. */
  baseUrl: string;
  /** Injected so tests can run without a socket and so a host app can wrap it. */
  fetch?: typeof globalThis.fetch;
  /** Sent on every request, including the event stream. */
  headers?: Record<string, string>;
  /**
   * Melete authenticates the owner with a session cookie, so the default is
   * `include`: a client served from a different origin than the API still sends
   * it. Set `omit` when the caller carries its own header credential instead.
   */
  credentials?: FetchCredentials;
};

export type ResolvedClientOptions = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  headers: Record<string, string>;
  credentials: FetchCredentials;
};

export type MeleteClient = {
  /** The generated, fully typed surface: `client.api.GET('/jobs', …)`. */
  readonly api: Client<paths>;
  /** What the stream helpers need, kept beside the client rather than re-derived. */
  readonly options: ResolvedClientOptions;
};

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

export function createMeleteClient(options: MeleteClientOptions): MeleteClient {
  const resolved: ResolvedClientOptions = {
    baseUrl: trimSlash(options.baseUrl),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    headers: { ...options.headers },
    credentials: options.credentials ?? 'include',
  };

  const api = createFetchClient<paths>({
    baseUrl: resolved.baseUrl,
    fetch: resolved.fetch,
    headers: resolved.headers,
    credentials: resolved.credentials,
  });

  return { api, options: resolved };
}

export type QueryValue = string | number | boolean | undefined | null | readonly string[];

/**
 * Absolute URL for a path, used by the event stream and by download links.
 * Arrays are repeated (`types=a&types=b`), which is what the document means by
 * leaving a query parameter at the OpenAPI default of form style, exploded.
 */
export function meleteUrl(
  client: MeleteClient,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const url = new URL(`${client.options.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * The error body every failing endpoint returns. `openapi-fetch` hands it back
 * as `error`; this narrows it so a caller can show the message without casting.
 */
export function errorMessage(error: unknown, fallback = 'The request failed.'): string {
  if (typeof error === 'object' && error !== null && 'error' in error) {
    const inner = (error as { error: unknown }).error;
    if (typeof inner === 'object' && inner !== null && 'message' in inner) {
      const message = (inner as { message: unknown }).message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  }
  return fallback;
}
