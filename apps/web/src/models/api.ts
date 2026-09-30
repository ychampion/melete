/**
 * The model calls: which model is active, connecting a provider by key or by
 * ChatGPT sign-in, testing it, and choosing the model. Made the way the rest
 * of the application makes them: the shared client's base URL and session
 * cookie, and a { data, error, unavailable } result instead of a throw.
 *
 * The shapes are the generated ones from openapi.json, so a change to the
 * contract stops this compiling. No call here ever receives a key back.
 */
import type { paths } from '@melete/client';
import { API_BASE_URL, client, type Result } from '../experience/adapter.ts';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;

export type ModelSettings = Json<paths['/model-settings']['get']['responses'][200]>;
export type ModelProviderStatus = ModelSettings['providers'][number];
export type ModelProvider = ModelProviderStatus['provider'];
export type ConnectionTest = Json<paths['/model-settings/test']['post']['responses'][200]>;
export type SignInStatus = Json<
  paths['/model-providers/{provider}/sign-in']['get']['responses'][200]
>;
export type SignInStart = Json<
  paths['/model-providers/{provider}/sign-in']['post']['responses'][201]
>;

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

const provider = (name: string) => encodeURIComponent(name);

export const models = {
  settings: () => call<ModelSettings>('/model-settings'),
  test: (input: { provider: ModelProvider; api_key?: string; base_url?: string }) =>
    call<ConnectionTest>('/model-settings/test', { method: 'POST', body: input }),
  saveKey: (name: ModelProvider, input: { api_key: string; base_url?: string }) =>
    call<ModelSettings>(`/model-settings/keys/${provider(name)}`, { method: 'PUT', body: input }),
  removeKey: (name: ModelProvider) =>
    call<ModelSettings>(`/model-settings/keys/${provider(name)}`, { method: 'DELETE' }),
  choose: (name: ModelProvider, model: string) =>
    call<ModelSettings>('/model-settings/default', {
      method: 'PUT',
      body: { provider: name, model },
    }),
  restoreServerDefault: () => call<ModelSettings>('/model-settings/default', { method: 'DELETE' }),

  /* ChatGPT sign-in, over the existing model-provider sign-in routes. */
  signInStatus: (name: string) => call<SignInStatus>(`/model-providers/${provider(name)}/sign-in`),
  startSignIn: (name: string, method: 'device' | 'browser') =>
    call<SignInStart>(`/model-providers/${provider(name)}/sign-in`, {
      method: 'POST',
      body: { method },
    }),
  completeSignIn: (name: string, input: { sign_in_id: string; callback_url?: string }) =>
    call<SignInStatus | { state: 'pending'; interval: number }>(
      `/model-providers/${provider(name)}/sign-in/complete`,
      { method: 'POST', body: input },
    ),
  signOut: (name: string) =>
    call<SignInStatus>(`/model-providers/${provider(name)}/sign-in`, { method: 'DELETE' }),
};

/** The provider's name for the active model, for a short line of text. */
export function providerLabel(settings: ModelSettings, name: string): string {
  return settings.providers.find((entry) => entry.provider === name)?.label ?? name;
}
