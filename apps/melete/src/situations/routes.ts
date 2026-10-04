import type { Hono } from 'hono';
import type { SituationService } from './service.ts';

/** What Melete noticed for the signed-in person. Every route is the caller's own. */
export function mountSituations(app: Hono, service: SituationService) {
  app.get('/situations', async (c) =>
    c.json({ situations: await service.list(c.get('owner').id) }),
  );
  app.post('/situations/:id/ack', async (c) =>
    c.json({ situation: await service.ack(c.get('owner').id, c.req.param('id')) }),
  );
  app.post('/situations/:id/dismiss', async (c) =>
    c.json({ situation: await service.dismiss(c.get('owner').id, c.req.param('id')) }),
  );
}
