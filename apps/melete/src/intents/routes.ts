import type { Hono } from 'hono';
import type { IntentService } from './service.ts';

/** What the signed-in person asked Melete to see through. Every route is the caller's own. */
export function mountIntents(app: Hono, service: IntentService) {
  app.get('/intents', async (c) => c.json({ intents: await service.list(c.get('owner').id) }));
  app.patch('/intents/:id', async (c) =>
    c.json({
      intent: await service.edit(c.get('owner').id, c.req.param('id'), await c.req.json()),
    }),
  );
  app.post('/intents/:id/cancel', async (c) =>
    c.json(await service.cancel(c.get('owner').id, c.req.param('id'))),
  );
}
