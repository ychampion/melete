/**
 * The Apps routes, through the typed client. Each call settles to a Result,
 * as every other call in the interface does.
 */
import { errorMessage, type paths } from '@melete/client';
import { API_BASE_URL, client, type Result } from '../experience/adapter.ts';
import { plainError } from '../experience/plain.ts';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<P, M extends keyof P> = P[M] extends { responses: infer R }
  ? R extends Record<200, unknown>
    ? Json<R[200]>
    : never
  : never;

export type AppList = Ok<paths['/apps'], 'get'>;
export type AppSummary = AppList['apps'][number];
export type AppDetail = Ok<paths['/apps/{id}'], 'get'>;
export type AppVersion = NonNullable<AppDetail['versions']>[number];
export type AppGrant = NonNullable<AppDetail['grants']>[number];
export type AppView = Ok<paths['/apps/{id}/views'], 'post'>;
export type AppDataValue = Ok<paths['/apps/{id}/data/{name}'], 'get'>;
export type AppDataUpdates = Ok<paths['/apps/{id}/data-updates'], 'get'>;
export type AppDataUpdate = AppDataUpdates['updates'][number];
export type AppSubmissionList = Ok<paths['/apps/{id}/submissions'], 'get'>;
export type AppSubmission = AppSubmissionList['submissions'][number];
export type GrantRequest = NonNullable<
  paths['/apps/{id}/grants']['put']['requestBody']
>['content']['application/json']['grants'][number];

const OFFLINE = 'Couldn’t reach Melete. Check that the service is running.';

async function call<T>(
  run: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
): Promise<Result<T>> {
  try {
    const outcome = await run();
    if (outcome.data !== undefined)
      return { data: outcome.data as T, error: null, unavailable: null };
    return {
      data: null,
      error: plainError(errorMessage(outcome.error, OFFLINE)),
      unavailable: null,
      unauthorized: outcome.response?.status === 401,
    };
  } catch {
    return { data: null, error: OFFLINE, unavailable: null };
  }
}

const api = client.api;
const byId = (id: string) => ({ params: { path: { id } } });

export const appsApi = {
  list: () => call<AppList>(() => api.GET('/apps')),
  get: (id: string) => call<AppDetail>(() => api.GET('/apps/{id}', byId(id))),
  view: (id: string) => call<AppView>(() => api.POST('/apps/{id}/views', byId(id))),
  chooseVersion: (id: string, versionId: string) =>
    call<AppDetail>(() =>
      api.POST('/apps/{id}/current', { ...byId(id), body: { version_id: versionId } }),
    ),
  setGrants: (id: string, grants: GrantRequest[]) =>
    call<AppDetail>(() => api.PUT('/apps/{id}/grants', { ...byId(id), body: { grants } })),
  remove: (id: string) =>
    call<{ id: string; deleted: true }>(() => api.DELETE('/apps/{id}', byId(id))),
  dataUpdates: (id: string) =>
    call<AppDataUpdates>(() => api.GET('/apps/{id}/data-updates', byId(id))),
  release: (id: string, binding: string, artifactId: string) =>
    call<AppDataUpdates>(() =>
      api.POST('/apps/{id}/data-updates', {
        ...byId(id),
        body: { binding, artifact_id: artifactId },
      }),
    ),
  submissions: (id: string, query: { collection?: string; before?: string } = {}) =>
    call<AppSubmissionList>(() =>
      api.GET('/apps/{id}/submissions', { params: { path: { id }, query } }),
    ),
  deleteSubmissionsFrom: (id: string, principalId: string) =>
    call<{ from: string; deleted: number }>(() =>
      api.DELETE('/apps/{id}/submissions', {
        params: { path: { id }, query: { from: principalId } },
      }),
    ),
  deleteSubmission: (id: string, submissionId: string) =>
    call<{ id: string; deleted: true }>(() =>
      api.DELETE('/apps/{id}/submissions/{submission_id}', {
        params: { path: { id, submission_id: submissionId } },
      }),
    ),
};

/** Where a view's page loads: the API's own address, then the view's path. */
export const viewSource = (view: AppView): string => `${API_BASE_URL}${view.view_path}`;

/**
 * What the bridge fetches for a framed app, with this viewer's session. Both
 * read routes the publish approval described; the service decides what each
 * returns, and refuses anything the app's version does not declare.
 */
async function forViewer(
  route: string,
  init: RequestInit,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status?: number }> {
  try {
    const response = await client.options.fetch(`${API_BASE_URL}${route}`, {
      ...init,
      credentials: client.options.credentials,
      headers: { ...client.options.headers, ...(init.headers as Record<string, string>) },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        error:
          response.status === 404
            ? 'This app has nothing by that name.'
            : plainError(errorMessage(body, OFFLINE)),
      };
    return { ok: true, value: body };
  } catch {
    return { ok: false, error: OFFLINE };
  }
}

/** One data name as an app gets it: only the value, with when it was written kept for the screen. */
export type DataAnswer =
  | { ok: true; value: unknown; updatedAt: string | null }
  | { ok: false; error: string; status?: number };

export const appBridgeCalls = (appId: string) => ({
  data: async (name: string): Promise<DataAnswer> => {
    const result = await forViewer(
      `/apps/${encodeURIComponent(appId)}/data/${encodeURIComponent(name)}`,
      { method: 'GET' },
    );
    if (!result.ok) return result;
    const body = result.value as Partial<AppDataValue> | null;
    return { ok: true, value: body?.value ?? null, updatedAt: body?.updated_at ?? null };
  },
  submit: (collection: string, record: Record<string, unknown>) =>
    forViewer(`/apps/${encodeURIComponent(appId)}/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection, record }),
    }),
  /** What the app keeps for this viewer: the collection's one record, replaced each time. */
  save: (collection: string, record: Record<string, unknown>) =>
    forViewer(`/apps/${encodeURIComponent(appId)}/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection, record, replace: true }),
    }),
  /** What this viewer last saved in the collection: the record itself, or null. */
  load: async (
    collection: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status?: number }> => {
    const result = await forViewer(
      `/apps/${encodeURIComponent(appId)}/submissions/mine?collection=${encodeURIComponent(collection)}`,
      { method: 'GET' },
    );
    if (!result.ok) return result;
    const body = result.value as { record?: unknown } | null;
    return { ok: true, value: body?.record ?? null };
  },
});
