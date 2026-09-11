import { jobScheduling } from '@melete/contracts';
import type { Hono } from 'hono';
import type { AttentionService } from '../jobs/attention.ts';
import { jobView } from '../jobs/service.ts';

export function mountAttention(app: Hono, attention: AttentionService) {
  app.get('/jobs/:id/responsibility', async (c) =>
    c.json(jobView(await attention.jobs.get(c.req.param('id')))),
  );
  app.post('/jobs/:id/scheduling', async (c) =>
    c.json(
      jobView(
        await attention.configure(c.req.param('id'), jobScheduling.parse(await c.req.json())),
      ),
    ),
  );
  app.post('/jobs/:id/read', async (c) =>
    c.json(jobView(await attention.markRead(c.req.param('id')))),
  );
}
