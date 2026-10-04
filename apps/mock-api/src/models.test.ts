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

test('a secondary model is optional, keeps its uses, and labels the usage it served', async () => {
  const app = new Hono();
  mountModelsMock(app, { connected: true });
  const send = async (path: string, method: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const secondaryOf = async () =>
    modelSettingsResponse.parse((await send('/model-settings', 'GET')).body).secondary;
  const small = 'accounts/fireworks/models/llama-v3p1-8b-instruct';

  expect(await secondaryOf()).toMatchObject({
    model: null,
    uses: { side_tasks: 'secondary', scheduled: 'primary' },
  });
  // A provider with no key cannot be chosen.
  expect(
    (await send('/model-settings/secondary', 'PUT', { provider: 'anthropic', model: 'x' })).status,
  ).toBe(409);
  expect(
    (await send('/model-settings/secondary', 'PUT', { provider: 'fireworks', model: small }))
      .status,
  ).toBe(200);
  await send('/model-settings/secondary/uses', 'PUT', { scheduled: 'secondary' });
  expect(await secondaryOf()).toMatchObject({
    model: { provider: 'fireworks', model: small, connected: true },
    uses: { side_tasks: 'secondary', scheduled: 'secondary' },
  });
  const usage = (await send('/usage', 'GET')).body as {
    models: { model: string; role: string | null }[];
  };
  expect(usage.models.map((row) => row.role)).toEqual(['primary', 'secondary']);

  await send('/model-settings/secondary', 'DELETE');
  expect((await secondaryOf()).model).toBeNull();
});
