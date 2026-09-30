/**
 * Settings → Privacy and the per-answer summary, served by the service's own
 * privacy router over an in-memory store, so the preview shows exactly what the
 * real detectors do. The mock has no model gateway: a conversation's summary is
 * worked out from what the person wrote in each turn, as the gateway would have
 * swapped it before sending.
 */
import * as C from '@melete/contracts';
import type { Hono } from 'hono';
import type { z } from 'zod';
import { PrivacyError } from '../../melete/src/privacy/local.ts';
import { Redactor } from '../../melete/src/privacy/redact.ts';
import { PrivacyRouter } from '../../melete/src/privacy/router.ts';
import { settingsView, updateSettings } from '../../melete/src/privacy/routes.ts';
import { MemoryPrivacyStore } from '../../melete/src/privacy/store.ts';
import { Vault } from '../../melete/src/privacy/vault.ts';
import type { AppDeps } from './app.ts';

type Turns = () => Map<string, { turns: z.infer<typeof C.conversationTurn>[] }>;

export function mountPrivacyMock(app: Hono, deps: AppDeps, conversations: Turns): void {
  const router = new PrivacyRouter({
    store: new MemoryPrivacyStore(),
    // The mock's local model answers on the usual Ollama port and nowhere else.
    resolve: async () => [{ address: '203.0.113.10' }],
  });
  const vaults = new Map<string, Vault>();

  /** Each turn as the gateway would have sent it: placeholders per turn, one vault per conversation. */
  const summary = async (id: string) => {
    const chat = conversations().get(id);
    if (!chat) return null;
    const settings = await router.settingsFor(deps.spaceId);
    const vault = vaults.get(id) ?? new Vault();
    vaults.set(id, vault);
    return chat.turns.map((turn) => {
      const redactor = new Redactor(vault, { enabled: settings.enabled, known: settings.known });
      redactor.text(`${turn.text}\n${turn.answer}`);
      return { turn, placeholders: [...redactor.used], vault };
    });
  };

  const fail = (code: string, message: string, status: 400 | 404 | 409) =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  app.get('/privacy/settings', async (c) =>
    c.json(C.privacySettings.parse(await settingsView(router, deps.spaceId))),
  );

  app.put('/privacy/settings', async (c) => {
    const input = C.privacySettingsUpdate.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return fail('invalid_request', 'Check the information and try again.', 400);
    try {
      await updateSettings(router, deps.spaceId, input.data);
    } catch (error) {
      if (error instanceof PrivacyError)
        return fail(error.code, error.message, error.status === 409 ? 409 : 400);
      throw error;
    }
    return c.json(C.privacySettings.parse(await settingsView(router, deps.spaceId)));
  });

  app.post('/privacy/preview', async (c) => {
    const input = C.privacyPreviewRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return fail('invalid_request', 'Add some text to preview.', 400);
    return c.json(
      C.privacyPreview.parse(
        await router.preview(deps.spaceId, input.data.text, input.data.agent_id),
      ),
    );
  });

  app.post('/privacy/local-model/check', async (c) => {
    const input = C.localModelCheckRequest.safeParse(await c.req.json().catch(() => ({})));
    const saved = (await router.settingsFor(deps.spaceId)).local;
    const base = (input.success ? input.data.base_url : undefined) ?? saved?.baseUrl;
    const model = (input.success ? input.data.model : undefined) ?? saved?.model;
    if (!base || !model)
      return c.json({ ok: false, message: 'Add the address and model name first.', models: [] });
    const reachable = /^http:\/\/(?:127\.0\.0\.1|localhost):11434\b/.test(base);
    return c.json(
      C.localModelCheck.parse(
        reachable
          ? { ok: true, message: `Connected to ${model}.`, models: [model, 'qwen3:8b'] }
          : { ok: false, message: 'Couldn’t reach a model server at that address.', models: [] },
      ),
    );
  });

  app.get('/conversations/:id/privacy', async (c) => {
    const turns = await summary(c.req.param('id'));
    if (!turns) return fail('not_found', 'That conversation was not found.', 404);
    const settings = await router.settingsFor(deps.spaceId);
    return c.json(
      C.conversationPrivacy.parse({
        sensitive: null,
        turns: turns
          .filter((entry) => entry.turn.answer)
          .map(({ turn, placeholders, vault }) => {
            const counts = new Map<C.PrivacyCategory, number>();
            for (const placeholder of placeholders) {
              const category = vault.entry(placeholder)?.category;
              if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
            }
            return {
              turn_id: turn.id,
              protected: placeholders.length,
              categories: [...counts].map(([category, count]) => ({ category, count })),
              route: settings.privateSpace && settings.local ? 'local' : 'cloud',
            };
          }),
      }),
    );
  });

  app.post('/conversations/:id/privacy/reveal', async (c) => {
    const input = C.privacyRevealRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return fail('invalid_request', 'Choose an answer.', 400);
    const turns = await summary(c.req.param('id'));
    if (!turns) return fail('not_found', 'That conversation was not found.', 404);
    const entry = turns.find((item) => item.turn.id === input.data.turn_id);
    c.header('cache-control', 'no-store');
    return c.json(
      C.privacyReveal.parse({
        items: (entry?.placeholders ?? []).flatMap((placeholder) => {
          const found = entry?.vault.entry(placeholder);
          return found ? [{ placeholder, category: found.category, value: found.value }] : [];
        }),
      }),
    );
  });
}
