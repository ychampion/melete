import { createReactionRequest } from '@melete/contracts';
import type { Hono } from 'hono';
import type { ReactionService } from '../jobs/reactions.ts';

export function mountReactions(app: Hono, reactions: ReactionService): void {
  app.post('/messages/:id/reactions', async (c) => {
    const text = await c.req.text();
    const input = createReactionRequest.parse(text ? JSON.parse(text) : {});
    return c.json({ reaction: await reactions.add(c.req.param('id'), input) }, 201);
  });
  app.get('/messages/:id/reactions', async (c) =>
    c.json({ reactions: await reactions.list(c.req.param('id')) }),
  );
  app.get('/jobs/:id/reactions', async (c) =>
    c.json({ reactions: await reactions.listForJob(c.req.param('id')) }),
  );
}
