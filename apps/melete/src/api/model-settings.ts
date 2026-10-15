/**
 * The installation's model, connected from the app. Any signed-in account can
 * see which model is active; only the setup owner, or an account they made an
 * admin, can change a key or the model, since both serve every space on the
 * installation. The setup owner may also set a secondary model, from the providers connected here, and which of the
 * work in their spaces runs on it; each account reads only its own. No
 * response carries a key, and no request body is logged.
 */
import {
  modelSettingsResponse,
  saveModelKeyRequest,
  setDefaultModelRequest,
  setModelVisionRequest,
  setSecondaryModelRequest,
  setSecondaryUsesRequest,
  testModelConnectionRequest,
  testModelConnectionResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Database } from '../db/client.ts';
import { owner } from '../db/schema.ts';
import type { ModelSettingsService } from '../gateway/model-settings.ts';
import { isAdmin } from '../principals/admin.ts';
import { ServiceError } from './errors.ts';

export function mountModelSettings(
  app: Hono,
  deps: { db: Database; settings: ModelSettingsService },
): void {
  const { db, settings } = deps;

  /** The setup owner, or an admin: whoever may change the installation's keys and model. */
  const mayEdit = (c: Context) => isAdmin(db, c.get('owner')?.id);

  async function requireOwner(c: Context): Promise<string> {
    if (!(await mayEdit(c)))
      throw new ServiceError(
        'owner_required',
        'Only the owner of this installation, or an admin, can change its model.',
        403,
      );
    return c.get('owner')?.id as string;
  }

  /** The secondary model is the setup owner's own, so only they set it. */
  async function requireSetupOwner(c: Context): Promise<string> {
    const actor = c.get('owner')?.id;
    const [installation] = await db.select({ id: owner.id }).from(owner).limit(1);
    if (!actor || installation?.id !== actor)
      throw new ServiceError(
        'owner_required',
        'Only the owner of this installation sets its secondary model.',
        403,
      );
    return actor;
  }

  /** The signed-in account, for its own secondary model. */
  const person = (c: Context) => {
    const actor = c.get('owner') as { id?: string; kind?: string } | undefined;
    return actor?.id ? { id: actor.id, guest: actor.kind === 'guest' } : null;
  };

  const view = async (c: Context) =>
    c.json(modelSettingsResponse.parse(await settings.view(await mayEdit(c), person(c))));

  app.get('/model-settings', view);

  app.post('/model-settings/test', async (c) => {
    await requireOwner(c);
    const input = testModelConnectionRequest.parse(await c.req.json());
    return c.json(testModelConnectionResponse.parse(await settings.test(input)));
  });

  app.put('/model-settings/keys/:provider', async (c) => {
    const ownerId = await requireOwner(c);
    const input = saveModelKeyRequest.parse(await c.req.json());
    await settings.saveKey(c.req.param('provider'), ownerId, input);
    return view(c);
  });

  app.delete('/model-settings/keys/:provider', async (c) => {
    await requireOwner(c);
    await settings.removeKey(c.req.param('provider'));
    return view(c);
  });

  app.put('/model-settings/default', async (c) => {
    const ownerId = await requireOwner(c);
    const input = setDefaultModelRequest.parse(await c.req.json());
    await settings.setDefault(input.provider, input.model, ownerId, input.supports_vision ?? null);
    return view(c);
  });

  app.put('/model-settings/vision', async (c) => {
    const ownerId = await requireOwner(c);
    const input = setModelVisionRequest.parse(await c.req.json());
    await settings.setVision(input.provider, input.model, ownerId, input.supports_vision);
    return view(c);
  });

  app.put('/model-settings/secondary', async (c) => {
    const principalId = await requireSetupOwner(c);
    const input = setSecondaryModelRequest.parse(await c.req.json());
    await settings.setSecondary(principalId, input.provider, input.model);
    return view(c);
  });

  app.delete('/model-settings/secondary', async (c) => {
    await settings.clearSecondary(await requireSetupOwner(c));
    return view(c);
  });

  app.put('/model-settings/secondary/uses', async (c) => {
    const principalId = await requireSetupOwner(c);
    const input = setSecondaryUsesRequest.parse(await c.req.json());
    await settings.setSecondaryUses(principalId, input);
    return view(c);
  });

  app.delete('/model-settings/default', async (c) => {
    await requireOwner(c);
    await settings.clearDefault();
    return view(c);
  });
}
