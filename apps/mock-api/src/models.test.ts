/**
 * The mock answers whether the active model reads images as the service does:
 * from the catalog until the owner says otherwise, and back to the catalog
 * when they clear their answer or choose another model.
 */
import { expect, test } from 'bun:test';
import { modelSettingsResponse } from '@melete/contracts';
import { Hono } from 'hono';
import { mountModelsMock } from './models.ts';

test("the owner's answer on images is kept with the model, and cleared with it", async () => {
  const app = new Hono();
  mountModelsMock(app, { connected: true });
  const call = async (method: string, body?: unknown) => {
    const response = await app.request('/model-settings/default', {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(200);
    return modelSettingsResponse.parse(await response.json()).active;
  };
  const read = async () =>
    modelSettingsResponse.parse(await (await app.request('/model-settings')).json()).active;
  const model = 'accounts/fireworks/models/deepseek-v4p1-flash';

  expect(await read()).toMatchObject({ vision: false, vision_source: 'catalog' });
  expect(await call('PUT', { provider: 'fireworks', model, supports_vision: true })).toMatchObject({
    vision: true,
    vision_source: 'app',
    source: 'app',
  });
  expect(await call('PUT', { provider: 'fireworks', model, supports_vision: null })).toMatchObject({
    vision: false,
    vision_source: 'catalog',
  });
  await call('PUT', { provider: 'fireworks', model, supports_vision: true });
  // Choosing a model again without an answer starts from the catalog.
  expect(await call('PUT', { provider: 'fireworks', model })).toMatchObject({
    vision: false,
    vision_source: 'catalog',
  });
  expect(await call('DELETE')).toMatchObject({ vision: false, source: 'operator' });
});
