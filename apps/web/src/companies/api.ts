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
import type { Result } from '../experience/adapter.ts';
import { call } from '../experience/call.ts';
import { markValueMoment } from '../experience/push.ts';
import type {
  CompanyMap,
  LedgerDetail,
  LedgerItem,
  LedgerItemStatus,
  ScanProgress,
  ScanStarted,
  WaitingOn,
} from '../experience/types.ts';

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
  setStatus: async (id: string, status: Extract<LedgerItemStatus, 'dropped' | 'settled'>) => {
    const result = await call<LedgerItem>(`/ledger/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { status },
    });
    // Money back is the first moment Melete was worth hearing from.
    if (result.data !== null && status === 'settled') markValueMoment();
    return result;
  },
  /** Start handling an item; for one a connection added, `action` names which of its steps. */
  handle: (id: string, action?: string) =>
    call<{ job_id: string }>(`/ledger/${encodeURIComponent(id)}/handle`, {
      method: 'POST',
      ...(action ? { body: { action } } : {}),
    }),
  /** Stop the job handling an item: the item goes back to found, with no job. */
  stop: (id: string) =>
    call<LedgerItem>(`/ledger/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  /** Money owed to the person and replies they are waiting on, in one view; one space when named. */
  waitingOn: (spaceId?: string) =>
    call<WaitingOn>(
      spaceId ? `/waiting-on?space_id=${encodeURIComponent(spaceId)}` : '/waiting-on',
    ),
  /** Start chasing a reply the person is waiting on. */
  chaseReply: (id: string) =>
    call<{ job_id: string }>(`/waiting-on/replies/${encodeURIComponent(id)}/chase`, {
      method: 'POST',
    }),
  /** Dismiss a reply the person is no longer waiting on; a chase on it stops. */
  dropReply: (id: string) =>
    call<{ id: string; status: LedgerItemStatus }>(
      `/waiting-on/replies/${encodeURIComponent(id)}/drop`,
      { method: 'POST' },
    ),
};
