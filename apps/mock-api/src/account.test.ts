/**
 * The mock serves both first screens: a fresh install that still needs its
 * first account, and an installation that signs in with a password.
 */
import { expect, test } from 'bun:test';
import { errorResponse, ownerResponse, setupStatusResponse } from '@melete/contracts';
import { createMock } from './index.ts';

const post = (app: ReturnType<typeof createMock>['app'], path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a fresh install asks for its first account, then signs in with it', async () => {
  const { app } = createMock({ speed: 0, setupNeeded: true });
  expect(setupStatusResponse.parse(await (await app.request('/setup')).json())).toEqual({
    needed: true,
    multiplayer: false,
    features: expect.any(Object),
    code_required: false,
    email_sign_in: false,
    instance_name: 'Melete',
    assistant_name: 'Melete',
    signin: { password: true, oidc: null },
  });
  expect((await app.request('/profile')).status).toBe(401);

  const short = await post(app, '/setup', { email: 'sam@example.com', password: 'short' });
  expect(short.status).toBe(400);

  const made = await post(app, '/setup', { email: 'Sam@Example.com', password: 'a long password' });
  expect(made.status).toBe(201);
  expect(ownerResponse.parse(await made.json()).owner.email).toBe('sam@example.com');
  expect((await app.request('/profile')).status).toBe(200);
  expect(await (await app.request('/setup')).json()).toEqual({
    needed: false,
    multiplayer: false,
    features: expect.any(Object),
    code_required: false,
    email_sign_in: false,
    instance_name: 'Melete',
    assistant_name: 'Melete',
    signin: { password: true, oidc: null },
  });

  // As the service does, the assistant takes the installation's name when only that is set.
  const named = createMock({ speed: 0, instanceName: 'Riverside' }).app;
  expect(await (await named.request('/setup')).json()).toMatchObject({
    instance_name: 'Riverside',
    assistant_name: 'Riverside',
  });

  const again = await post(app, '/setup', {
    email: 'sam@example.com',
    password: 'a long password',
  });
  expect(again.status).toBe(409);

  expect((await post(app, '/signout', {})).status).toBe(200);
  expect((await app.request('/profile')).status).toBe(401);

  const wrong = await post(app, '/login', {
    email: 'sam@example.com',
    password: 'not the password',
  });
  expect(wrong.status).toBe(401);
  expect(errorResponse.parse(await wrong.json()).error.message).toBe('Email or password is wrong.');

  const back = await post(app, '/login', { email: 'sam@example.com', password: 'a long password' });
  expect(back.status).toBe(200);
  expect((await app.request('/profile')).status).toBe(200);
});

test('by default the demo account exists and setup is not needed', async () => {
  const { app } = createMock({ speed: 0 });
  expect(await (await app.request('/setup')).json()).toEqual({
    needed: false,
    multiplayer: false,
    features: expect.any(Object),
    code_required: false,
    email_sign_in: false,
    instance_name: 'Melete',
    assistant_name: 'Melete',
    signin: { password: true, oidc: null },
  });
  expect((await app.request('/profile')).status).toBe(200);
});
