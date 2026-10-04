import type { Hono } from 'hono';
import type { TriageService } from './service.ts';

/** What needs the signed-in person. Every route is the caller's own; none of them acts. */
export function mountNeedsYou(app: Hono, service: TriageService) {
  app.get('/needs-you', async (c) => c.json(await service.needsYou(c.get('owner').id)));
  app.post('/needs-you/:id/ack', async (c) =>
    c.json({ item: await service.ack(c.get('owner').id, c.req.param('id')) }),
  );
  app.post('/needs-you/:id/dismiss', async (c) =>
    c.json({ item: await service.dismiss(c.get('owner').id, c.req.param('id')) }),
  );
}
