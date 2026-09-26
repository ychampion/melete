/**
 * Phone presence in the mock: a real VAPID public key so a browser can
 * subscribe, devices kept per mock, and the settings with quiet hours read
 * from the mock's profile. Nothing is sent from here; the service does that.
 */
import {
  pushSettingsResponse,
  pushSettingsUpdate,
  pushSubscriptionList,
  pushSubscriptionRequest,
  pushSubscriptionResponse,
} from '@melete/contracts';
import type { Hono } from 'hono';
import { generateVapidKeys } from '../../melete/src/push/webpush.ts';
import { newId } from './store.ts';

type Device = { id: string; endpoint: string; device_label: string; created_at: string };

const fail = (code: string, message: string) => ({ error: { code, message } });

export function mountPushMock(
  app: Hono,
  profile: () => { time_zone: string; day_hours: { start: string; end: string } },
): void {
  // Made once per mock; the handler waits for it the first time it is asked.
  const keys = generateVapidKeys();
  const devices: Device[] = [];
  const settings = {
    decisions: true,
    settled: true,
    weekly_summary: true,
    daily_cap: 4,
    batch_minutes: 10,
  };
  const view = (device: Device) => ({
    id: device.id,
    device_label: device.device_label,
    created_at: device.created_at,
    last_used_at: null,
  });
  const current = () => {
    const { time_zone, day_hours } = profile();
    return pushSettingsResponse.parse({
      settings: {
        ...settings,
        quiet_hours: { from: day_hours.end, until: day_hours.start, time_zone },
      },
    });
  };

  app.get('/push/public-key', async (c) => c.json({ public_key: (await keys).publicKey }));
  app.get('/push/subscriptions', (c) =>
    c.json(pushSubscriptionList.parse({ subscriptions: devices.map(view) })),
  );
  app.post('/push/subscriptions', async (c) => {
    const parsed = pushSubscriptionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail('invalid_request', 'That is not a subscription.'), 400);
    const existing = devices.find((d) => d.endpoint === parsed.data.endpoint);
    const device = existing ?? {
      id: newId('psub'),
      endpoint: parsed.data.endpoint,
      device_label: parsed.data.device_label,
      created_at: new Date().toISOString(),
    };
    device.device_label = parsed.data.device_label;
    if (!existing) devices.push(device);
    return c.json(pushSubscriptionResponse.parse({ subscription: view(device) }), 201);
  });
  app.delete('/push/subscriptions/:id', (c) => {
    const index = devices.findIndex((d) => d.id === c.req.param('id'));
    const [removed] = index >= 0 ? devices.splice(index, 1) : [];
    if (!removed) return c.json(fail('not_found', 'No such device.'), 404);
    return c.json(pushSubscriptionResponse.parse({ subscription: view(removed) }));
  });
  app.get('/push/settings', (c) => c.json(current()));
  app.patch('/push/settings', async (c) => {
    const parsed = pushSettingsUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail('invalid_request', 'Those settings don’t fit.'), 400);
    Object.assign(settings, parsed.data);
    return c.json(current());
  });
}
