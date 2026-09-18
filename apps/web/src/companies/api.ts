/**
 * The companies calls, made the same way the rest of the application makes
 * them: one base URL, the session cookie, and a { data, error, unavailable }
 * result rather than a thrown exception.
 *
 * The shapes below are the generated ones, from openapi.json through
 * `experience/types.ts`, so a change to the contract stops this compiling. The
 * calls themselves still go through `fetch` on the shared client's options
 * rather than through `api.GET`, because each of these answers a plain body and
 * has no `not_available` arm to unwrap. The space id is read from `GET /spaces`,
 * which is the one place the interface learns which space it is looking at.
 */
import { API_BASE_URL, client, type Result } from '../experience/adapter.ts';
import type {
  CompanyMap,
  LedgerDetail,
  LedgerItem,
  LedgerItemStatus,
  ScanProgress,
  ScanStarted,
} from '../experience/types.ts';

const OFFLINE = 'Couldn’t reach Melete. Check that the service is running.';

type Failure = { error?: { message?: string } };

async function call<T>(
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

/** Which space this browser is looking at. The map and the scan are scoped to it. */
export async function currentSpaceId(): Promise<Result<string>> {
  const result = await call<{ spaces: { id: string }[] }>('/spaces');
  if (result.data === null) return result;
  const first = result.data.spaces[0];
  if (!first) return { data: null, error: null, unavailable: 'This instance has no space yet.' };
  return { data: first.id, error: null, unavailable: null };
}

export const companiesApi = {
  map: (spaceId: string) => call<CompanyMap>(`/spaces/${encodeURIComponent(spaceId)}/companies`),
  startScan: (spaceId: string) =>
    call<ScanStarted>(`/spaces/${encodeURIComponent(spaceId)}/companies/scan`, { method: 'POST' }),
  scan: (spaceId: string, scanId: string) =>
    call<ScanProgress>(
      `/spaces/${encodeURIComponent(spaceId)}/companies/scan/${encodeURIComponent(scanId)}`,
    ),
  item: (id: string) => call<LedgerDetail>(`/ledger/${encodeURIComponent(id)}`),
  setStatus: (id: string, status: Extract<LedgerItemStatus, 'dropped' | 'settled'>) =>
    call<LedgerItem>(`/ledger/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }),
  handle: (id: string) =>
    call<{ job_id: string }>(`/ledger/${encodeURIComponent(id)}/handle`, { method: 'POST' }),
};
