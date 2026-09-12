/**
 * One client for the whole app. The address is the only thing this client is
 * told; everything else it learns from the API.
 */
import { createMeleteClient, errorMessage } from '@melete/client';

const MOCK_API_BASE = 'http://localhost:3190';

// The typed client and event stream helpers require an absolute URL. Resolve
// the deployment's /api prefix against the page, including an SSH tunnel port.
export const API_BASE_URL: string = new URL(
  (import.meta.env.VITE_MELETE_API as string | undefined) ?? MOCK_API_BASE,
  typeof window === 'undefined' ? MOCK_API_BASE : window.location.origin,
)
  .toString()
  .replace(/\/+$/, '');

export const client = createMeleteClient({ baseUrl: API_BASE_URL });

export { errorMessage };

/** Throw the API's own message, so a screen never has to invent one. */
export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.data === undefined) throw new Error(errorMessage(result.error));
  return result.data;
}
