/**
 * One client for the whole app. The address is the only thing this client is
 * told; everything else it learns from the API.
 */
import { createMeleteClient, errorMessage } from '@melete/client';

export const API_BASE_URL: string =
  (import.meta.env.VITE_MELETE_API as string | undefined) ?? 'http://localhost:3190';

export const client = createMeleteClient({ baseUrl: API_BASE_URL });

export { errorMessage };

/** Throw the API's own message, so a screen never has to invent one. */
export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.data === undefined) throw new Error(errorMessage(result.error));
  return result.data;
}
