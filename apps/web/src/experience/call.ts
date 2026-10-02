/**
 * A JSON call made the way the rest of the application makes them: the shared
 * client's base URL and session cookie, and a { data, error, unavailable }
 * result rather than a thrown exception. For routes that answer a plain body
 * with no `not_available` arm to unwrap.
 */
import { API_BASE_URL, client, type Result } from './adapter.ts';

const OFFLINE = 'Couldn’t reach Melete. Check that the service is running.';

type Failure = { error?: { message?: string } };

export async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Result<T>> {
  try {
    const response = await client.options.fetch(`${API_BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...client.options.headers,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      credentials: client.options.credentials,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const said = (body as Failure | null)?.error?.message;
      return { data: null, error: said ?? OFFLINE, unavailable: null };
    }
    return { data: body as T, error: null, unavailable: null };
  } catch {
    return { data: null, error: OFFLINE, unavailable: null };
  }
}
