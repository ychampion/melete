import { pushSettingsUpdate, pushSubscriptionRequest } from '@melete/contracts';
import type { Hono } from 'hono';
import type { PushService } from './service.ts';

/** A person's devices and what Melete may push to them. Every route is the caller's own. */
export function mountPush(app: Hono, service: PushService) {
  app.get('/push/public-key', (c) => c.json({ public_key: service.publicKey() }));
  app.get('/push/subscriptions', async (c) =>
    c.json({ subscriptions: await service.list(c.get('owner').id) }),
  );
  app.post('/push/subscriptions', async (c) => {
    const input = pushSubscriptionRequest.parse(await c.req.json());
    return c.json({ subscription: await service.subscribe(c.get('owner').id, input) }, 201);
  });
  app.delete('/push/subscriptions/:id', async (c) =>
    c.json({ subscription: await service.remove(c.get('owner').id, c.req.param('id')) }),
  );
  app.get('/push/settings', async (c) =>
    c.json({ settings: await service.settings(c.get('owner').id) }),
  );
  app.patch('/push/settings', async (c) => {
    const input = pushSettingsUpdate.parse(await c.req.json());
    return c.json({ settings: await service.updateSettings(c.get('owner').id, input) });
  });
}
