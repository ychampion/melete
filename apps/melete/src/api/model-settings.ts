/**
 * The installation's model, connected from the app. Any signed-in account can
 * see which model is active; only the setup owner can change a key or the
 * model, since both serve every space on the installation. No response
 * carries a key, and no request body is logged.
 */
import {
  modelSettingsResponse,
  saveModelKeyRequest,
  setDefaultModelRequest,
  setModelVisionRequest,
  testModelConnectionRequest,
  testModelConnectionResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Database } from '../db/client.ts';
import { owner } from '../db/schema.ts';
import type { ModelSettingsService } from '../gateway/model-settings.ts';
import { ServiceError } from './errors.ts';

export function mountModelSettings(
  app: Hono,
  deps: { db: Database; settings: ModelSettingsService },
): void {
  const { db, settings } = deps;

  async function isOwner(c: Context): Promise<boolean> {
    const actor = c.get('owner')?.id;
    if (!actor) return false;
    const [installation] = await db.select({ id: owner.id }).from(owner).limit(1);
    return installation?.id === actor;
  }

  async function requireOwner(c: Context): Promise<string> {
    if (!(await isOwner(c)))
      throw new ServiceError(
        'owner_required',
        'Only the owner of this installation can change its model.',
        403,
      );
    return c.get('owner')?.id as string;
  }

  const view = async (c: Context) =>
    c.json(modelSettingsResponse.parse(await settings.view(await isOwner(c))));

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

  app.delete('/model-settings/default', async (c) => {
    await requireOwner(c);
    await settings.clearDefault();
    return view(c);
  });
}
