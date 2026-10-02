/**
 * Settings → Privacy and the per-answer summary, for the signed-in person's
 * own space. The settings belong to the space's owner; a member of a shared
 * space sees only the conversations that are theirs.
 *
 * The reveal is the one response that carries values. It is answered only to
 * the person's own session, never cached, and drawn only in their browser.
 */
import {
  conversationPrivacyUpdate,
  localModelCheckRequest,
  PRIVACY_CATEGORIES,
  type PrivacySettings,
  type PrivacySettingsUpdate,
  privacyPreviewRequest,
  privacyRevealRequest,
  privacySettingsUpdate,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import { assertLocalEndpoint, checkLocalModel, isLocalUrl, PrivacyError } from './local.ts';
import type { PrivacyRouter } from './router.ts';
import { newKnownId, type PlainSettings, type SealedSettings, sameAddress } from './store.ts';

export type PrivacyRouteOptions = {
  router: () => PrivacyRouter;
  /** The configured provider's address, which the owner may confirm is a model they run. */
  providerUrl?: string;
};

function spaceOf(c: Context): string {
  const spaceId = c.get('experienceSpaceId');
  if (!spaceId) throw new ServiceError('not_found', 'Your personal space is not ready.', 404);
  return spaceId;
}

function ownerOnly(c: Context): string {
  const spaceId = spaceOf(c);
  if (c.get('sessionSpace')?.role === 'member')
    throw new ServiceError('scope_denied', 'Only the owner of this space can do that.', 403);
  return spaceId;
}

const hint = (value: string) => `•••${value.trim().slice(-2)}`;

export async function settingsView(
  router: PrivacyRouter,
  spaceId: string,
  providerUrl?: string,
): Promise<PrivacySettings> {
  const stored = await router.store.settings(spaceId);
  const settings = await router.settingsFor(spaceId);
  const addressLocal = providerUrl ? await router.isLocal(providerUrl) : false;
  return {
    enabled: PRIVACY_CATEGORIES.filter((category) => settings.enabled.has(category)),
    sensitive_topics: settings.topics,
    private_space: settings.privateSpace,
    private_agent_ids: [...settings.privateAgents],
    local_model: settings.local
      ? {
          base_url: settings.local.baseUrl,
          model: settings.local.model,
          has_key: !!settings.local.apiKey,
        }
      : null,
    local_detection: settings.localDetection,
    known_values: (stored.sealed?.known ?? []).map((known) => ({
      id: known.id,
      label: known.label,
      category: known.category,
      hint: hint(known.value),
    })),
    model_address_local: addressLocal,
    model_address: addressLocal ? (providerUrl ?? null) : null,
    model_on_device:
      addressLocal &&
      !!providerUrl &&
      !!settings.onDeviceUrl &&
      sameAddress(settings.onDeviceUrl, providerUrl),
    sealed_vault: router.store.sealing,
    screenshots_own_computer: settings.screenshotsOwn,
    screenshots_paired_devices: settings.screenshotsDevices,
  };
}

/** Apply one change from Settings → Privacy. Listed values and a key are sealed. */
export async function updateSettings(
  router: PrivacyRouter,
  spaceId: string,
  input: PrivacySettingsUpdate,
  providerUrl?: string,
): Promise<void> {
  const stored = await router.store.settings(spaceId);
  const wasPrivateSpace = stored.plain.private_space === true;
  const wasPrivateAgents = new Set(stored.plain.private_agent_ids ?? []);
  const plain: PlainSettings = { ...stored.plain };
  const sealed: SealedSettings = {
    known: [...(stored.sealed?.known ?? [])],
    ...(stored.sealed?.local_api_key ? { local_api_key: stored.sealed.local_api_key } : {}),
  };
  if (input.enabled) plain.enabled = [...new Set(input.enabled)];
  if (input.sensitive_topics) plain.sensitive_topics = [...new Set(input.sensitive_topics)];
  if (input.private_space !== undefined) plain.private_space = input.private_space;
  if (input.private_agent_ids) plain.private_agent_ids = [...new Set(input.private_agent_ids)];
  if (input.local_detection !== undefined) plain.local_detection = input.local_detection;
  if (input.screenshots_own_computer !== undefined)
    plain.screenshots_own_computer = input.screenshots_own_computer;
  if (input.screenshots_paired_devices !== undefined)
    plain.screenshots_paired_devices = input.screenshots_paired_devices;
  if (input.model_on_device === false) plain.model_on_device_url = null;
  else if (input.model_on_device === true) {
    // Only the address the service is set to use now, and only while it is local.
    if (!providerUrl || !(await isLocalUrl(providerUrl, router.options.resolve)))
      throw new PrivacyError(
        'model_not_local',
        'Your model’s address is not on this machine or your network, so it can’t be marked as yours.',
      );
    plain.model_on_device_url = providerUrl;
  }
  if (input.local_model === null) {
    plain.local_model = null;
    delete sealed.local_api_key;
  } else if (input.local_model) {
    await assertLocalEndpoint(input.local_model.base_url, router.options.resolve);
    plain.local_model = { base_url: input.local_model.base_url, model: input.local_model.model };
    if (input.local_model.api_key === null) delete sealed.local_api_key;
    else if (input.local_model.api_key) sealed.local_api_key = input.local_model.api_key;
  }
  const removing = new Set(input.remove_known_values ?? []);
  sealed.known = sealed.known.filter((known) => !removing.has(known.id));
  if (input.add_known_values?.length) {
    if (!router.store.sealing)
      throw new PrivacyError(
        'master_key_required',
        'This service has no master key, so it cannot keep private values. Set MELETE_MASTER_KEY and start it again.',
        409,
      );
    for (const added of input.add_known_values) sealed.known.push({ id: newKnownId(), ...added });
  }
  if (sealed.local_api_key && !router.store.sealing)
    throw new PrivacyError(
      'master_key_required',
      'This service has no master key, so it cannot keep a key. Set MELETE_MASTER_KEY and start it again.',
      409,
    );
  // "Send a redacted version" was an answer about the reason it was asked for.
  // A space or agent marked private since then is a new reason, so it asks
  // again. Withdrawn first, so no request sees the new setting with the old answer.
  if (!wasPrivateSpace && plain.private_space === true)
    await router.store.revokeConsent(spaceId, null);
  else {
    const added = (plain.private_agent_ids ?? []).filter((id) => !wasPrivateAgents.has(id));
    if (added.length) await router.store.revokeConsent(spaceId, added);
  }
  await router.store.saveSettings(spaceId, plain, sealed);
  router.invalidate(spaceId);
}

export function mountPrivacy(app: Hono, options: PrivacyRouteOptions) {
  app.get('/privacy/settings', async (c) =>
    c.json(await settingsView(options.router(), ownerOnly(c), options.providerUrl)),
  );

  app.put('/privacy/settings', async (c) => {
    const spaceId = ownerOnly(c);
    const input = privacySettingsUpdate.parse(await c.req.json());
    const router = options.router();
    try {
      await updateSettings(router, spaceId, input, options.providerUrl);
    } catch (error) {
      if (error instanceof PrivacyError)
        throw new ServiceError(error.code, error.message, error.status === 409 ? 409 : 400);
      throw error;
    }
    return c.json(await settingsView(router, spaceId, options.providerUrl));
  });

  app.post('/privacy/preview', async (c) => {
    const spaceId = ownerOnly(c);
    const input = privacyPreviewRequest.parse(await c.req.json());
    c.header('cache-control', 'no-store');
    return c.json(await options.router().preview(spaceId, input.text, input.agent_id));
  });

  app.post('/privacy/local-model/check', async (c) => {
    const spaceId = ownerOnly(c);
    const input = localModelCheckRequest.parse(await c.req.json().catch(() => ({})));
    const router = options.router();
    const saved = (await router.settingsFor(spaceId)).local;
    const baseUrl = input.base_url ?? saved?.baseUrl;
    const model = input.model ?? saved?.model;
    if (!baseUrl || !model)
      return c.json({ ok: false, message: 'Add the address and model name first.', models: [] });
    const apiKey = input.api_key ?? (input.base_url ? undefined : saved?.apiKey);
    return c.json(
      await checkLocalModel(
        { baseUrl, model, ...(apiKey ? { apiKey } : {}) },
        router.options.fetch,
      ),
    );
  });

  const conversation = async (c: Context) => {
    const spaceId = spaceOf(c);
    const id = c.req.param('id') ?? '';
    const member = c.get('sessionSpace')?.role === 'member';
    const router = options.router();
    if (
      !(await router.store.ownsConversation(spaceId, id, member ? c.get('owner')?.id : undefined))
    )
      throw new ServiceError('not_found', 'That conversation was not found.', 404);
    return { spaceId, id, router };
  };

  app.get('/conversations/:id/privacy', async (c) => {
    const { id, router } = await conversation(c);
    const state = await router.store.conversation(id);
    return c.json({ sensitive: state.sensitive, turns: await router.conversationTurns(id) });
  });

  // The person clears a verdict they say is wrong, or marks the conversation
  // themselves. Clearing also withdraws an open privacy question's premise, so
  // the next request is not held for it. Only the person whose conversation it
  // is may clear it: the space's owner may see a member's conversation, but
  // saying it is not sensitive sends what the member wrote to a cloud model
  // without asking them.
  app.put('/conversations/:id/privacy', async (c) => {
    const { spaceId, id, router } = await conversation(c);
    const input = conversationPrivacyUpdate.parse(await c.req.json());
    if (input.sensitive === null) {
      const person = await router.store.conversationPerson(id);
      if (!person || person !== c.get('owner')?.id)
        throw new ServiceError(
          'scope_denied',
          'Only the person whose conversation this is can say it is not sensitive.',
          403,
        );
    }
    await router.store.markConversation(id, spaceId, input.sensitive);
    const state = await router.store.conversation(id);
    return c.json({ sensitive: state.sensitive, turns: await router.conversationTurns(id) });
  });

  app.post('/conversations/:id/privacy/reveal', async (c) => {
    const { spaceId, id, router } = await conversation(c);
    const input = privacyRevealRequest.parse(await c.req.json());
    c.header('cache-control', 'no-store');
    return c.json(await router.reveal(id, spaceId, input.turn_id));
  });
}
