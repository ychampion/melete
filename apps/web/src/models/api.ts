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
import { call } from '../experience/call.ts';

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

const provider = (name: string) => encodeURIComponent(name);

export const models = {
  settings: () => call<ModelSettings>('/model-settings'),
  test: (input: { provider: ModelProvider; api_key?: string; base_url?: string }) =>
    call<ConnectionTest>('/model-settings/test', { method: 'POST', body: input }),
  saveKey: (name: ModelProvider, input: { api_key: string; base_url?: string }) =>
    call<ModelSettings>(`/model-settings/keys/${provider(name)}`, { method: 'PUT', body: input }),
  removeKey: (name: ModelProvider) =>
    call<ModelSettings>(`/model-settings/keys/${provider(name)}`, { method: 'DELETE' }),
  /**
   * Use a model. `supportsVision` is the owner's word on whether it reads
   * images; null hands it back to Melete's list, and leaving it out does too.
   */
  choose: (name: ModelProvider, model: string, supportsVision?: boolean | null) =>
    call<ModelSettings>('/model-settings/default', {
      method: 'PUT',
      body: {
        provider: name,
        model,
        ...(supportsVision === undefined ? {} : { supports_vision: supportsVision }),
      },
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
