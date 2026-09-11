import { prefixedId } from '@melete/contracts';
import type { Hono } from 'hono';
import type { EpisodeService } from './episodes.ts';

export function mountLearning(app: Hono, service: EpisodeService) {
  const spaceId = (raw: unknown) => prefixedId('sp').parse(raw);
  app.get('/episodes', async (c) =>
    c.json({ episodes: await service.list(c.get('owner').id, spaceId(c.req.query('space_id'))) }),
  );
  app.delete('/episodes/:id', async (c) =>
    c.json(
      await service.remove(
        c.get('owner').id,
        spaceId(c.req.query('space_id')),
        prefixedId('ep').parse(c.req.param('id')),
      ),
    ),
  );
  app.put('/jobs/:id/learning-scope', async (c) =>
    c.json(await service.setScope(c.get('owner').id, c.req.param('id'), await c.req.json())),
  );
  app.post('/jobs/:id/interventions', async (c) =>
    c.json(
      {
        episode: await service.intervene(c.get('owner').id, c.req.param('id'), await c.req.json()),
      },
      201,
    ),
  );
}
