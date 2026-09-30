/** The mock serves the push routes the web app uses, in the contract's shapes. */
import { expect, test } from 'bun:test';
import {
  pushPublicKeyResponse,
  pushSettingsResponse,
  pushSubscriptionList,
  pushSubscriptionResponse,
} from '@melete/contracts';
import { createMock } from './index.ts';

test('a device subscribes, is listed, and is removed; settings read the day hours', async () => {
  const { app } = createMock({ speed: 0 });
  const key = pushPublicKeyResponse.parse(await (await app.request('/push/public-key')).json());
  expect(key.public_key).toMatch(/^[A-Za-z0-9_-]{87}$/);
  const made = await app.request('/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: key.public_key, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
      device_label: 'Android · Chrome',
    }),
  });
  expect(made.status).toBe(201);
  const { subscription } = pushSubscriptionResponse.parse(await made.json());
  const listed = pushSubscriptionList.parse(
    await (await app.request('/push/subscriptions')).json(),
  );
  expect(listed.subscriptions.map((d) => d.device_label)).toEqual(['Android · Chrome']);
  expect(
    (await app.request(`/push/subscriptions/${subscription.id}`, { method: 'DELETE' })).status,
  ).toBe(200);
  expect(
    (await app.request(`/push/subscriptions/${subscription.id}`, { method: 'DELETE' })).status,
  ).toBe(404);

  const settings = pushSettingsResponse.parse(await (await app.request('/push/settings')).json());
  expect(settings.settings.quiet_hours).toMatchObject({ from: '22:00', until: '08:00' });
  const changed = await app.request('/push/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ daily_cap: 2, weekly_summary: false }),
  });
  expect(pushSettingsResponse.parse(await changed.json()).settings).toMatchObject({
    daily_cap: 2,
    weekly_summary: false,
  });
});
